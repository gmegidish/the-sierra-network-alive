// SCI1 AdLib MIDI driver: maps MIDI channels onto the 9 OPL2 voices using the
// instruments of patch resource 3. Port of ScummVM's MidiDriver_AdLib
// (engines/sci/sound/drivers/adlib.cpp, GPL-2.0-or-later) in its SCI1, mono
// (single OPL2) configuration: voice mapping via controller 0x4B, round-robin
// voice search per channel, velocity/volume tables, pitch wheel. Not ported:
// the SCI1.1 rhythm key map (patch size 5382) and dual-OPL2 stereo panning.

const VOICE_COUNT = 9;
const MIDI_CHANNELS = 16;
const MASTER_VOLUME_MAX = 15;
const PITCH_CENTER = 0x2000;
const PITCH_STEP = 171;
const MAX_NOTE_INDEX = 0x1fc;
const MAX_OCTAVE = 7;
const LOWEST_NOTE = 12;
const HIGHEST_NOTE = 107;
const CONTROLLER = Object.freeze({ VOLUME: 0x07, PAN: 0x0a, HOLD: 0x40, VOICES: 0x4b, VELOCITY: 0x4e, NOTES_OFF: 0x7b });

const REGISTER_OFFSET = Object.freeze([0x00, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x10, 0x11, 0x12]);
const VELOCITY_MAP_1 = Object.freeze([
  0x00, 0x0c, 0x0d, 0x0e, 0x0f, 0x11, 0x12, 0x13, 0x14, 0x16, 0x17, 0x18, 0x1a, 0x1b, 0x1c, 0x1d,
  0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2d, 0x2d, 0x2e,
  0x2f, 0x30, 0x31, 0x32, 0x32, 0x33, 0x34, 0x34, 0x35, 0x36, 0x36, 0x37, 0x38, 0x38, 0x39, 0x3a,
  0x3b, 0x3b, 0x3b, 0x3c, 0x3c, 0x3c, 0x3d, 0x3d, 0x3d, 0x3e, 0x3e, 0x3e, 0x3e, 0x3f, 0x3f, 0x3f]);
const VELOCITY_MAP_2 = Object.freeze([
  0x00, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x21,
  0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x2f, 0x30,
  0x31, 0x32, 0x32, 0x33, 0x34, 0x34, 0x35, 0x36, 0x36, 0x37, 0x38, 0x38, 0x39, 0x39, 0x3a, 0x3a,
  0x3b, 0x3b, 0x3b, 0x3c, 0x3c, 0x3c, 0x3d, 0x3d, 0x3d, 0x3e, 0x3e, 0x3e, 0x3e, 0x3f, 0x3f, 0x3f]);
// One octave with three pitch wheel positions after each note.
const FREQUENCIES = Object.freeze([
  0x157, 0x15c, 0x161, 0x166, 0x16b, 0x171, 0x176, 0x17b, 0x181, 0x186, 0x18c, 0x192,
  0x198, 0x19e, 0x1a4, 0x1aa, 0x1b0, 0x1b6, 0x1bd, 0x1c3, 0x1ca, 0x1d0, 0x1d7, 0x1de,
  0x1e5, 0x1ec, 0x1f3, 0x1fa, 0x202, 0x209, 0x211, 0x218, 0x220, 0x228, 0x230, 0x238,
  0x241, 0x249, 0x252, 0x25a, 0x263, 0x26c, 0x275, 0x27e, 0x287, 0x290, 0x29a, 0x2a4]);

/**
 * @typedef {import('../resource/sound.js').AdlibInstrument} AdlibInstrument
 * @typedef {import('../resource/sound.js').AdlibOperator} AdlibOperator
 * @typedef {(reg: number, value: number) => void} RegisterWriter
 */

const newChannel = () => ({ patch: 0, volume: 63, pan: 64, holdPedal: 0, extraVoices: 0, pitchWheel: PITCH_CENTER, lastVoice: 0, voices: 0, mappedVoices: 0 });
const newVoice = () => ({ channel: -1, mappedChannel: -1, note: -1, patch: -1, velocity: 0, isSustained: false, age: 0 });

export class AdlibDriver {
  /** @param {AdlibInstrument[]} patches @param {RegisterWriter} writeRegister */
  constructor(patches, writeRegister) {
    this.patches = patches;
    this.writeRegister = writeRegister;
    this.masterVolume = MASTER_VOLUME_MAX;
    this.playSwitchOn = true;
    this.channels = Array.from({ length: MIDI_CHANNELS }, newChannel);
    this.voices = Array.from({ length: VOICE_COUNT }, newVoice);
    this.writeRegister(0xbd, 0);
    this.writeRegister(0x08, 0);
    this.writeRegister(0x01, 0x20);
  }

  get polyphony() {
    return VOICE_COUNT;
  }

  /** Called once per 60 Hz tick: ages playing notes. */
  onTimer() {
    this.voices.forEach((voice) => {
      if (voice.note !== -1) {
        voice.age += 1;
      }
    });
  }

  setMasterVolume(volume) {
    this.masterVolume = volume;
    this.renewNotes(-1, true);
  }

  playSwitch(on) {
    this.playSwitchOn = on;
    this.renewNotes(-1, on);
  }

  /** Send one MIDI message (status, data1, data2). */
  send(status, data1, data2) {
    const channel = status & 0x0f;
    switch (status & 0xf0) {
      case 0x80:
        this.noteOff(channel, data1);
        break;
      case 0x90:
        this.noteOn(channel, data1, data2);
        break;
      case 0xb0:
        this.controlChange(channel, data1, data2);
        break;
      case 0xc0:
        this.channels[channel].patch = data1;
        break;
      case 0xe0:
        this.channels[channel].pitchWheel = (data1 & 0x7f) | ((data2 & 0x7f) << 7);
        this.renewNotes(channel, true);
        break;
      default:
        break;
    }
  }

  controlChange(channel, controller, value) {
    const state = this.channels[channel];
    if (controller === CONTROLLER.VOLUME) {
      state.volume = value >> 1;
      this.renewNotes(channel, true);
    } else if (controller === CONTROLLER.PAN) {
      state.pan = value;
    } else if (controller === CONTROLLER.HOLD) {
      state.holdPedal = value;
      if (value === 0) {
        this.voices.forEach((voice, i) => {
          if (voice.channel === channel && voice.isSustained) {
            this.voiceOff(i);
          }
        });
      }
    } else if (controller === CONTROLLER.VOICES) {
      this.voiceMapping(channel, value);
    } else if (controller === CONTROLLER.NOTES_OFF) {
      this.voices.forEach((voice, i) => {
        if (voice.channel === channel && voice.note !== -1) {
          this.voiceOff(i);
        }
      });
    }
  }

  voiceMapping(channel, wanted) {
    const mapped = this.voices.filter((voice) => voice.mappedChannel === channel).length;
    const current = mapped + this.channels[channel].extraVoices;
    if (current < wanted) {
      this.assignVoices(channel, wanted - current);
    } else if (current > wanted) {
      this.releaseVoices(channel, current - wanted);
      this.donateVoices();
    }
  }

  assignVoices(channel, count) {
    let remaining = count;
    for (let i = 0; i < VOICE_COUNT && remaining > 0; i += 1) {
      const voice = this.voices[i];
      if (voice.mappedChannel === -1) {
        if (voice.note !== -1) {
          this.voiceOff(i);
        }
        voice.mappedChannel = channel;
        this.channels[channel].mappedVoices += 1;
        remaining -= 1;
      }
    }
    this.channels[channel].extraVoices += remaining;
  }

  releaseVoices(channel, count) {
    const state = this.channels[channel];
    if (state.extraVoices >= count) {
      state.extraVoices -= count;
      return;
    }
    let remaining = count - state.extraVoices;
    state.extraVoices = 0;
    remaining = this.unmapVoices(channel, remaining, (voice) => voice.note === -1);
    this.unmapVoices(channel, remaining, () => true);
  }

  unmapVoices(channel, count, accept) {
    let remaining = count;
    for (let i = 0; i < VOICE_COUNT && remaining > 0; i += 1) {
      const voice = this.voices[i];
      if (voice.mappedChannel === channel && accept(voice)) {
        if (voice.note !== -1) {
          this.voiceOff(i);
        }
        voice.mappedChannel = -1;
        this.channels[channel].mappedVoices -= 1;
        remaining -= 1;
      }
    }
    return remaining;
  }

  donateVoices() {
    let free = this.voices.filter((voice) => voice.mappedChannel === -1).length;
    for (const [i, state] of this.channels.entries()) {
      if (free === 0) {
        return;
      }
      if (state.extraVoices >= free) {
        const extra = state.extraVoices;
        this.assignVoices(i, free);
        state.extraVoices = extra - free;
        return;
      }
      if (state.extraVoices > 0) {
        const extra = state.extraVoices;
        state.extraVoices = 0;
        this.assignVoices(i, extra);
        free -= extra;
      }
    }
  }

  renewNotes(channel, key) {
    this.voices.forEach((voice, i) => {
      if ((channel === -1 || voice.channel === channel) && voice.note !== -1) {
        this.setNote(i, voice.note, key);
      }
    });
  }

  noteOn(channel, note, velocity) {
    if (velocity === 0) {
      this.noteOff(channel, note);
      return;
    }
    if (note < LOWEST_NOTE || note > HIGHEST_NOTE) {
      return;
    }
    const same = this.voices.findIndex((voice) => voice.channel === channel && voice.note === note);
    if (same !== -1) {
      this.voiceOff(same);
      this.voiceOn(same, note, velocity >> 1);
      return;
    }
    const voice = this.findVoice(channel);
    if (voice !== -1) {
      this.voiceOn(voice, note, velocity >> 1);
    }
  }

  findVoice(channel) {
    let found = -1;
    let oldest = -1;
    let oldestAge = 0;
    for (let i = 0; i < VOICE_COUNT; i += 1) {
      const v = (this.channels[channel].lastVoice + i + 1) % VOICE_COUNT;
      const voice = this.voices[v];
      if (voice.mappedChannel !== channel) {
        continue;
      }
      if (voice.note === -1) {
        found = v;
        break;
      }
      if (voice.age >= oldestAge) {
        oldestAge = voice.age;
        oldest = v;
      }
    }
    if (found === -1) {
      if (!oldestAge) {
        return -1;
      }
      this.voiceOff(oldest);
      found = oldest;
    }
    this.voices[found].channel = channel;
    this.channels[channel].lastVoice = found;
    return found;
  }

  noteOff(channel, note) {
    const index = this.voices.findIndex((voice) => voice.channel === channel && voice.note === note);
    if (index === -1) {
      return;
    }
    if (this.channels[channel].holdPedal) {
      this.voices[index].isSustained = true;
    } else {
      this.voiceOff(index);
    }
  }

  voiceOn(index, note, velocity) {
    const voice = this.voices[index];
    const patch = this.channels[voice.channel].patch;
    voice.age = 0;
    this.channels[voice.channel].voices += 1;
    if (patch !== voice.patch && this.playSwitchOn) {
      this.setPatch(index, patch);
    }
    voice.velocity = velocity;
    this.setNote(index, note, true);
  }

  voiceOff(index) {
    const voice = this.voices[index];
    voice.isSustained = false;
    this.setNote(index, voice.note, false);
    voice.note = -1;
    voice.age = 0;
    if (voice.channel !== -1) {
      this.channels[voice.channel].voices -= 1;
    }
  }

  /** Index into FREQUENCIES (note * 4 plus pitch wheel quarter steps). */
  noteIndex(note, pitchWheel) {
    const bend = Math.trunc(Math.abs(pitchWheel - PITCH_CENTER) / PITCH_STEP);
    const index = (note << 2) + (pitchWheel >= PITCH_CENTER ? bend : -bend);
    return Math.max(0, Math.min(MAX_NOTE_INDEX, index));
  }

  setNote(index, note, key) {
    const voice = this.voices[index];
    if (voice.patch === -1) {
      return;
    }
    voice.note = note;
    const noteIndex = this.noteIndex(note, this.channels[voice.channel].pitchWheel);
    const frequency = FREQUENCIES[noteIndex % 48];
    const octave = Math.min(MAX_OCTAVE, Math.max(0, Math.floor(noteIndex / 48) - 1));
    this.writeRegister(0xa0 + index, frequency & 0xff);
    this.writeRegister(0xb0 + index, ((key ? 1 : 0) << 5) | (octave << 2) | (frequency >> 8));
    this.setVelocity(index);
  }

  setVelocity(index) {
    const voice = this.voices[index];
    const patch = this.patches[voice.patch];
    this.setVelocityRegister(REGISTER_OFFSET[index] + 3, this.calcVelocity(voice, 1), patch.op[1].kbScaleLevel);
    if (patch.algorithm === 1) {
      this.setVelocityRegister(REGISTER_OFFSET[index], this.calcVelocity(voice, 0), patch.op[0].kbScaleLevel);
    }
  }

  calcVelocity(voice, operator) {
    const op = this.patches[voice.patch].op[operator];
    let velocity = this.channels[voice.channel].volume + 1;
    velocity = Math.trunc((velocity * (VELOCITY_MAP_1[voice.velocity] + 1)) / 64);
    velocity = Math.trunc((velocity * (this.masterVolume + 1)) / 16) - 1;
    velocity = Math.max(0, velocity);
    return Math.trunc((VELOCITY_MAP_2[velocity] * (63 - op.totalLevel)) / 63);
  }

  setVelocityRegister(offset, velocity, kbScaleLevel) {
    const level = this.playSwitchOn ? velocity : 0;
    this.writeRegister(0x40 + offset, (kbScaleLevel << 6) | (63 - level));
  }

  setPatch(index, requested) {
    const patch = requested >= 0 && requested < this.patches.length ? requested : 0;
    this.voices[index].patch = patch;
    const instrument = this.patches[patch];
    this.setOperator(REGISTER_OFFSET[index], instrument.op[0]);
    this.setOperator(REGISTER_OFFSET[index] + 3, instrument.op[1]);
    this.writeRegister(0xc0 + index, (instrument.feedback << 1) | instrument.algorithm);
  }

  /** @param {number} reg @param {AdlibOperator} op */
  setOperator(reg, op) {
    this.writeRegister(0x40 + reg, (op.kbScaleLevel << 6) | op.totalLevel);
    this.writeRegister(0x60 + reg, (op.attackRate << 4) | op.decayRate);
    this.writeRegister(0x80 + reg, (op.sustainLevel << 4) | op.releaseRate);
    this.writeRegister(0x20 + reg, (op.amplitudeMod << 7) | (op.vibrato << 6) | (op.envelopeType << 5)
      | (op.kbScaleRate << 4) | op.frequencyMult);
    this.writeRegister(0xe0 + reg, op.waveForm);
  }

  /** Silence every voice (used when the sound system is torn down). */
  allOff() {
    this.voices.forEach((voice, i) => {
      if (voice.note !== -1) {
        this.voiceOff(i);
      }
    });
  }
}
