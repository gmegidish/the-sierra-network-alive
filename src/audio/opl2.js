// Compact YM3812 (OPL2) emulator in plain JS.
//
// This is a JavaScript re-implementation of the operator, envelope and phase
// logic of Nuked-OPL3 by Nuke.YKT (https://github.com/nukeykt/Nuked-OPL3,
// LGPL-2.1-or-later), reduced to OPL2 mode: 9 two-operator channels, waveforms
// 0-3 (gated by the waveform-select bit of register 0x01), tremolo, vibrato,
// key scaling and the native 49716 Hz sample clock. The log-sine and
// exponent ROMs are generated from their closed forms instead of being copied.
// Not emulated: rhythm (percussion) mode, the timers and the status register,
// CSM mode, OPL3 extensions. Because the original algorithm is LGPL, this file
// is offered under LGPL-2.1-or-later as well.

export const OPL_RATE = 49716;

const SLOT_COUNT = 18;
const CHANNEL_COUNT = 9;
const ENVELOPE_MAX = 0x1ff;
const EG = Object.freeze({ ATTACK: 0, DECAY: 1, SUSTAIN: 2, RELEASE: 3 });
const MULTIPLIER_X2 = Object.freeze([1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30]);
const KSL_ROM = Object.freeze([0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64]);
const KSL_SHIFT = Object.freeze([8, 1, 2, 0]);
const EG_INCREMENT_STEP = Object.freeze([[0, 0, 0, 0], [1, 0, 0, 0], [1, 0, 1, 0], [1, 1, 1, 0]]);
// Register offset (low 5 bits of 0x20..0xF5) -> slot number, -1 for gaps.
const SLOT_OF_OFFSET = Object.freeze([0, 1, 2, 3, 4, 5, -1, -1, 6, 7, 8, 9, 10, 11, -1, -1,
  12, 13, 14, 15, 16, 17, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
const TREMOLO_STEPS = 210;
const SILENT_ATTENUATION = 0x1000;
const WAVEFORM_SELECT_BIT = 0x20;

const LOG_SIN = Uint16Array.from({ length: 256 },
  (_, i) => Math.round(-Math.log2(Math.sin(((i + 0.5) * Math.PI) / 512)) * 256));
const EXP = Uint16Array.from({ length: 256 }, (_, i) => Math.round(1024 * 2 ** ((255 - i) / 256)));

/** Attenuation (1/256 octave units) -> linear amplitude, like envelope_calcexp. */
function attenuationToLevel(level) {
  const clamped = level > 0x1fff ? 0x1fff : level;
  return (EXP[clamped & 0xff] << 1) >> (clamped >> 8);
}

/** Waveforms 0-3: sine, half sine, absolute sine, pulse (quarter) sine. */
function waveOutput(waveform, phase, envelope) {
  const p = phase & 0x3ff;
  const attenuation = envelope << 3;
  const quarter = p & 0x100 ? LOG_SIN[(p & 0xff) ^ 0xff] : LOG_SIN[p & 0xff];
  switch (waveform) {
    case 1:
      return p & 0x200 ? 0 : attenuationToLevel(quarter + attenuation);
    case 2:
      return attenuationToLevel(quarter + attenuation);
    case 3:
      return p & 0x100 ? 0 : attenuationToLevel(LOG_SIN[p & 0xff] + attenuation);
    default: {
      const level = attenuationToLevel(quarter + attenuation);
      return p & 0x200 ? ~level : level;
    }
  }
}

class Slot {
  constructor(channel) {
    this.channel = channel;
    this.out = 0;
    this.previousOut = 0;
    this.feedbackMod = 0;
    this.egRout = ENVELOPE_MAX;
    this.egOut = ENVELOPE_MAX;
    this.egGen = EG.RELEASE;
    this.egKsl = 0;
    this.key = false;
    this.phase = 0;
    this.phaseOut = 0;
    this.phaseReset = false;
    this.am = false;
    this.vib = false;
    this.sustainType = false;
    this.ksr = false;
    this.mult = 0;
    this.ksl = 0;
    this.tl = 0;
    this.ar = 0;
    this.dr = 0;
    this.sl = 0;
    this.rr = 0;
    this.waveform = 0;
  }

  updateKsl() {
    const ksl = (KSL_ROM[this.channel.fnum >> 6] << 2) - ((8 - this.channel.block) << 5);
    this.egKsl = ksl < 0 ? 0 : ksl;
  }
}

class Channel {
  constructor() {
    this.fnum = 0;
    this.block = 0;
    this.ksv = 0;
    this.feedback = 0;
    this.additive = false;
    this.slots = [];
  }
}

/** One OPL2 chip at its native sample rate. */
export class Opl2 {
  constructor() {
    this.channels = Array.from({ length: CHANNEL_COUNT }, () => new Channel());
    this.slots = Array.from({ length: SLOT_COUNT }, (_, s) => new Slot(this.channels[(s % 3) + 3 * Math.floor(s / 6)]));
    this.slots.forEach((slot, s) => {
      slot.channel.slots[Math.floor(s / 3) % 2] = slot;
    });
    this.waveformSelect = false;
    this.noteSelect = 0;
    this.tremoloPos = 0;
    this.tremolo = 0;
    this.tremoloShift = 4;
    this.vibratoPos = 0;
    this.vibratoShift = 1;
    this.timer = 0;
    this.egTimer = 0;
    this.egState = 0;
    this.egAdd = 0;
    this.egTimerLow = 0;
  }

  /** Write `value` to register `reg` (0x00-0xFF). */
  write(reg, value) {
    const group = reg & 0xe0;
    if (group >= 0x20 && group <= 0x80 || group === 0xe0) {
      this.writeSlotRegister(group, SLOT_OF_OFFSET[reg & 0x1f], value);
      return;
    }
    this.writeChipRegister(reg, value);
  }

  writeSlotRegister(group, slotIndex, value) {
    const slot = this.slots[slotIndex];
    if (!slot) {
      return;
    }
    if (group === 0x20) {
      slot.am = (value & 0x80) !== 0;
      slot.vib = (value & 0x40) !== 0;
      slot.sustainType = (value & 0x20) !== 0;
      slot.ksr = (value & 0x10) !== 0;
      slot.mult = value & 0x0f;
    } else if (group === 0x40) {
      slot.ksl = value >> 6;
      slot.tl = value & 0x3f;
    } else if (group === 0x60) {
      slot.ar = value >> 4;
      slot.dr = value & 0x0f;
    } else if (group === 0x80) {
      slot.sl = value >> 4 === 0x0f ? 0x1f : value >> 4;
      slot.rr = value & 0x0f;
    } else {
      slot.waveform = value & 0x03;
    }
  }

  writeChipRegister(reg, value) {
    if (reg === 0x01) {
      this.waveformSelect = (value & WAVEFORM_SELECT_BIT) !== 0;
    } else if (reg === 0x08) {
      this.noteSelect = (value >> 6) & 1;
    } else if (reg === 0xbd) {
      this.tremoloShift = value & 0x80 ? 2 : 4;
      this.vibratoShift = value & 0x40 ? 0 : 1;
    } else if (reg >= 0xa0 && reg <= 0xa8) {
      const channel = this.channels[reg - 0xa0];
      this.setFrequency(channel, (channel.fnum & 0x300) | value, channel.block);
    } else if (reg >= 0xb0 && reg <= 0xb8) {
      const channel = this.channels[reg - 0xb0];
      this.setFrequency(channel, (channel.fnum & 0xff) | ((value & 3) << 8), (value >> 2) & 7);
      this.setKey(channel, (value & 0x20) !== 0);
    } else if (reg >= 0xc0 && reg <= 0xc8) {
      const channel = this.channels[reg - 0xc0];
      channel.feedback = (value >> 1) & 7;
      channel.additive = (value & 1) !== 0;
    }
  }

  setFrequency(channel, fnum, block) {
    channel.fnum = fnum;
    channel.block = block;
    channel.ksv = (block << 1) | ((fnum >> (9 - this.noteSelect)) & 1);
    channel.slots.forEach((slot) => slot.updateKsl());
  }

  setKey(channel, on) {
    channel.slots.forEach((slot) => {
      slot.key = on;
    });
  }

  /** Generate one sample at OPL_RATE. Output is roughly +-36000 (9 voices x 4084). */
  generate() {
    let sum = 0;
    for (const channel of this.channels) {
      sum += this.generateChannel(channel);
    }
    this.advanceClocks();
    return sum;
  }

  generateChannel(channel) {
    const [modulator, carrier] = channel.slots;
    this.processSlot(modulator, modulator.feedbackMod, true);
    this.processSlot(carrier, channel.additive ? 0 : modulator.out, false);
    return channel.additive ? modulator.out + carrier.out : carrier.out;
  }

  processSlot(slot, modulation, isModulator) {
    if (isModulator) {
      const fb = slot.channel.feedback;
      slot.feedbackMod = fb ? (slot.previousOut + slot.out) >> (9 - fb) : 0;
      slot.previousOut = slot.out;
      modulation = slot.feedbackMod;
    }
    this.calculateEnvelope(slot);
    this.advancePhase(slot);
    const waveform = this.waveformSelect ? slot.waveform : 0;
    slot.out = waveOutput(waveform, slot.phaseOut + modulation, slot.egOut);
  }

  advancePhase(slot) {
    let fnum = slot.channel.fnum;
    if (slot.vib) {
      let range = (fnum >> 7) & 7;
      const pos = this.vibratoPos;
      if (!(pos & 3)) {
        range = 0;
      } else if (pos & 1) {
        range >>= 1;
      }
      range >>= this.vibratoShift;
      fnum += pos & 4 ? -range : range;
    }
    const baseFrequency = (fnum << slot.channel.block) >> 1;
    slot.phaseOut = (slot.phase >>> 9) & 0x3ff;
    if (slot.phaseReset) {
      slot.phase = 0;
    }
    slot.phase = (slot.phase + ((baseFrequency * MULTIPLIER_X2[slot.mult]) >> 1)) % 0x40000000;
  }

  envelopeRate(slot) {
    if (slot.key && slot.egGen === EG.RELEASE) {
      return { rate: slot.ar, reset: true };
    }
    switch (slot.egGen) {
      case EG.ATTACK:
        return { rate: slot.ar, reset: false };
      case EG.DECAY:
        return { rate: slot.dr, reset: false };
      case EG.SUSTAIN:
        return { rate: slot.sustainType ? 0 : slot.rr, reset: false };
      default:
        return { rate: slot.rr, reset: false };
    }
  }

  envelopeShift(slot, rateRegister) {
    if (rateRegister === 0) {
      return { shift: 0, rateHigh: 0 };
    }
    const ks = slot.channel.ksv >> (slot.ksr ? 0 : 2);
    const rate = ks + (rateRegister << 2);
    const rateHigh = Math.min(rate >> 2, 0x0f);
    const rateLow = rate & 3;
    if (rateHigh < 12) {
      return { shift: this.egState ? this.slowRateShift(rateHigh + this.egAdd, rateLow) : 0, rateHigh };
    }
    let shift = (rateHigh & 3) + EG_INCREMENT_STEP[rateLow][this.egTimerLow];
    if (shift & 4) {
      shift = 3;
    }
    return { shift: shift || this.egState, rateHigh };
  }

  slowRateShift(egShift, rateLow) {
    if (egShift === 12) {
      return 1;
    }
    if (egShift === 13) {
      return (rateLow >> 1) & 1;
    }
    return egShift === 14 ? rateLow & 1 : 0;
  }

  calculateEnvelope(slot) {
    const tremolo = slot.am ? this.tremolo : 0;
    const level = slot.egRout + (slot.tl << 2) + (slot.egKsl >> KSL_SHIFT[slot.ksl]) + tremolo;
    slot.egOut = level > ENVELOPE_MAX ? ENVELOPE_MAX : level;
    const { rate, reset } = this.envelopeRate(slot);
    slot.phaseReset = reset;
    const { shift, rateHigh } = this.envelopeShift(slot, rate);
    let rout = slot.egRout;
    let increment = 0;
    if (reset && rateHigh === 0x0f) {
      rout = 0;
    }
    const off = (slot.egRout & 0x1f8) === 0x1f8;
    if (slot.egGen !== EG.ATTACK && !reset && off) {
      rout = ENVELOPE_MAX;
    }
    if (slot.egGen === EG.ATTACK) {
      if (slot.egRout === 0) {
        slot.egGen = EG.DECAY;
      } else if (slot.key && shift > 0 && rateHigh !== 0x0f) {
        increment = (~slot.egRout) >> (4 - shift);
      }
    } else if (slot.egGen === EG.DECAY && (slot.egRout >> 4) === slot.sl) {
      slot.egGen = EG.SUSTAIN;
    } else if (!off && !reset && shift > 0) {
      increment = 1 << (shift - 1);
    }
    slot.egRout = (rout + increment) & ENVELOPE_MAX;
    if (reset) {
      slot.egGen = EG.ATTACK;
    }
    if (!slot.key) {
      slot.egGen = EG.RELEASE;
    }
  }

  advanceClocks() {
    if ((this.timer & 0x3f) === 0x3f) {
      this.tremoloPos = (this.tremoloPos + 1) % TREMOLO_STEPS;
    }
    const half = TREMOLO_STEPS / 2;
    this.tremolo = (this.tremoloPos < half ? this.tremoloPos : TREMOLO_STEPS - this.tremoloPos) >> this.tremoloShift;
    if ((this.timer & 0x3ff) === 0x3ff) {
      this.vibratoPos = (this.vibratoPos + 1) & 7;
    }
    this.timer = (this.timer + 1) & 0xffff;
    this.advanceEnvelopeTimer();
  }

  advanceEnvelopeTimer() {
    if (this.egState) {
      let shift = 0;
      while (shift < 13 && ((this.egTimer / 2 ** shift) & 1) === 0) {
        shift += 1;
      }
      this.egAdd = shift > 12 ? 0 : shift + 1;
      this.egTimerLow = this.egTimer & 3;
      this.egTimer = this.egTimer >= 0xfffffffff ? 0 : this.egTimer + 1;
    }
    this.egState ^= 1;
  }
}
