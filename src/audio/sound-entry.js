// One playing SCI sound: the merged MIDI event list of its device track, played
// at one MIDI tick per 60 Hz timer tick, with SCI control-channel semantics
// (loop marker, cues, signals, hold), loops, volume and fades.
// Port of the SCI1 paths of ScummVM's MidiParser_SCI and MusicEntry
// (engines/sci/sound/midiparser_sci.cpp, music.cpp; GPL-2.0-or-later).
import { CONTROL_CHANNEL, CHANNEL_FLAG, mixTrack } from '../resource/sound.js';

export const SIGNAL_END = 0xffff;
export const VOLUME_MAX = 127;
export const STATUS = Object.freeze({ STOPPED: 'stopped', PLAYING: 'playing', PAUSED: 'paused' });

const LOOP_MARKER = 127;
const CONTROLLER = Object.freeze({
  VOLUME: 0x07, PAN: 0x0a, MOD_WHEEL: 0x01, HOLD_PEDAL: 0x40, VOICES: 0x4b, MUTE: 0x4e,
  RESET_ON_PAUSE: 0x4c, REVERB: 0x50, HOLD: 0x52, CUE: 0x60, NOTES_OFF: 0x7b,
});
const PITCH_CENTER = 0x2000;
const PAN_CENTER = 64;
const MIDI_CHANNELS = 16;
const TICKS_PER_SECOND = 60;

/**
 * @typedef {import('../resource/sound.js').SoundTrack} SoundTrack
 * @typedef {import('../resource/sound.js').DigitalSample} DigitalSample
 * @typedef {(status: number, data1: number, data2: number) => void} MidiOut
 * @typedef {{ voices: number, prio: number, dontMap: boolean, dontRemap: boolean, mute: boolean }} ChannelInfo
 * @typedef {{ object: number, number: number, track?: SoundTrack | null, sample?: DigitalSample | null,
 *   resourcePriority?: number, send: MidiOut }} SoundEntryOptions
 */

const freshChannelState = () => ({ note: -1, modWheel: 0, pan: PAN_CENTER, patch: 0, sustain: false, pitchWheel: PITCH_CENTER, voices: 0 });

function describeChannels(track) {
  const info = new Map();
  for (const channel of track?.channels ?? []) {
    info.set(channel.number, Object.freeze({
      voices: channel.voices,
      prio: channel.prio,
      dontMap: (channel.flags & CHANNEL_FLAG.DONT_MAP) !== 0,
      dontRemap: (channel.flags & CHANNEL_FLAG.DONT_REMAP) !== 0,
      mute: (channel.flags & CHANNEL_FLAG.START_MUTED) !== 0,
    }));
  }
  return info;
}

/** Ticks a digital sample lasts once (rounded up). */
export function sampleTicks(sample) {
  return Math.max(1, Math.ceil((sample.samples.length * TICKS_PER_SECOND) / Math.max(1, sample.rate)));
}

export class SoundEntry {
  /** @param {SoundEntryOptions} options */
  constructor({ object, number, track = null, sample = null, resourcePriority = 0xff, send }) {
    this.object = object;
    this.number = number;
    this.sample = sample;
    this.isSample = Boolean(sample);
    this.hasMidi = Boolean(track) && !sample;
    this.resourcePriority = resourcePriority;
    this.sendRaw = send;
    const mixed = this.hasMidi ? mixTrack(track) : { events: [], endTick: 0, channelsUsed: new Set() };
    this.events = mixed.events;
    this.endTick = mixed.endTick;
    this.channelInfo = describeChannels(this.hasMidi ? track : null);
    this.usedChannels = [...this.channelInfo.keys()];
    this.status = STATUS.STOPPED;
    this.priority = 0;
    this.volume = VOLUME_MAX;
    this.loop = 1;
    this.hold = -1;
    this.playBed = false;
    this.time = 0;
    this.resetPlayback();
  }

  resetPlayback() {
    this.signal = 0;
    this.dataInc = 0;
    this.ticker = 0;
    this.position = 0;
    this.playTick = 0;
    this.loopTick = 0;
    this.loopPosition = 0;
    this.finished = false;
    this.fadeStep = 0;
    this.fadeCompleted = false;
    this.stopAfterFading = false;
    this.remap = new Int8Array(MIDI_CHANNELS).fill(-1);
    this.channelState = Array.from({ length: MIDI_CHANNELS }, freshChannelState);
    this.channelVolume = new Uint8Array(MIDI_CHANNELS).fill(VOLUME_MAX);
    this.activeNotes = new Set();
  }

  /** Start from the beginning (MidiParser_SCI::sendInitCommands + jumpToTick(0)). */
  start() {
    this.resetPlayback();
    for (const [number, info] of this.channelInfo) {
      this.channelState[number].voices = info.voices;
    }
    this.status = STATUS.PLAYING;
  }

  /** Whether a sample has finished all of its loops. */
  isSampleDone() {
    const loops = this.loop > 1 ? this.loop : 1;
    return this.ticker >= sampleTicks(this.sample) * loops;
  }

  /** One 60 Hz timer tick (MusicEntry::onTimer). */
  onTimer() {
    if (this.status !== STATUS.PLAYING || !this.loop) {
      return;
    }
    if (this.fadeStep) {
      this.doFade();
    }
    if (this.isSample) {
      this.ticker += 1;
      return;
    }
    if (this.hasMidi && !this.finished) {
      this.parserTick();
      this.ticker = this.playTick & 0xffff;
    }
  }

  doFade() {
    if (this.fadeTicker) {
      this.fadeTicker -= 1;
      return;
    }
    this.fadeTicker = this.fadeTickerStep;
    this.volume += this.fadeStep;
    if ((this.fadeStep > 0 && this.volume >= this.fadeTo) || (this.fadeStep < 0 && this.volume <= this.fadeTo)) {
      this.volume = this.fadeTo;
      this.fadeStep = 0;
      this.fadeCompleted = true;
    }
    this.setVolume(this.volume);
  }

  /** @param {number} to @param {number} ticks @param {number} step @param {boolean} stopAfter */
  startFade(to, ticks, step, stopAfter) {
    this.fadeTo = to;
    this.fadeStep = this.volume > to ? -step : step;
    this.fadeTickerStep = ticks;
    this.fadeTicker = 0;
    this.stopAfterFading = stopAfter;
  }

  parserTick() {
    while (this.position < this.events.length && this.events[this.position].tick <= this.playTick) {
      const event = this.events[this.position];
      this.position += 1;
      this.processEvent(event);
      if (this.finished) {
        return;
      }
    }
    if (this.position >= this.events.length && this.playTick >= this.endTick) {
      this.endOfTrack();
      return;
    }
    this.playTick += 1;
  }

  endOfTrack() {
    if (this.loop) {
      this.loop -= 1;
    }
    if (this.loop || this.hold > 0) {
      this.jumpToLoop(true);
      return;
    }
    this.signal = SIGNAL_END;
    this.allNotesOff();
    this.finished = true;
  }

  jumpToLoop(stopNotes) {
    if (stopNotes) {
      this.allNotesOff();
    }
    this.position = this.loopPosition;
    this.playTick = this.loopTick;
  }

  processEvent(event) {
    const command = event.status & 0xf0;
    if ((event.status & 0x0f) === CONTROL_CHANNEL) {
      this.processControlEvent(command, event);
      return;
    }
    this.sendToDriver(event.status, event.data1, event.data2);
  }

  processControlEvent(command, event) {
    if (command === 0xc0) {
      if (event.data1 === LOOP_MARKER) {
        this.loopTick = event.tick;
        this.loopPosition = this.position;
      } else if (event.tick !== 0) {
        this.signal = event.data1;
      }
      return;
    }
    if (command !== 0xb0) {
      return;
    }
    if (event.data1 === CONTROLLER.CUE) {
      this.dataInc += 1;
    } else if (event.data1 === CONTROLLER.HOLD && event.data2 === this.hold) {
      this.jumpToLoop(false);
    } else if (event.data1 === CONTROLLER.RESET_ON_PAUSE) {
      this.resetOnPause = event.data2 !== 0;
    }
  }

  /** State tracking, volume scaling and channel remapping (MidiParser_SCI::sendToDriver). */
  sendToDriver(status, data1, data2) {
    const channel = status & 0x0f;
    const command = status & 0xf0;
    const info = this.channelInfo.get(channel);
    if (!info?.dontMap) {
      this.trackState(command, channel, data1, data2);
    }
    if (command === 0xb0 && data1 === CONTROLLER.MUTE) {
      return;
    }
    let value = data2;
    if (command === 0xb0 && data1 === CONTROLLER.VOLUME) {
      value = Math.trunc((data2 * this.volume) / VOLUME_MAX) & 0xff;
    }
    const device = info?.dontMap ? channel : this.remap[channel];
    if (device === -1) {
      return;
    }
    this.trackActiveNote(command, channel, data1, data2);
    this.sendRaw(command | device, data1, value);
  }

  trackActiveNote(command, channel, note, velocity) {
    const key = (channel << 8) | note;
    if (command === 0x90 && velocity > 0) {
      this.activeNotes.add(key);
    } else if (command === 0x80 || command === 0x90) {
      this.activeNotes.delete(key);
    }
  }

  trackState(command, channel, data1, data2) {
    const state = this.channelState[channel];
    if (command === 0x90 && data2 !== 0) {
      state.note = data1;
    } else if ((command === 0x80 || command === 0x90) && state.note === data1) {
      state.note = -1;
    } else if (command === 0xb0) {
      this.trackController(state, channel, data1, data2);
    } else if (command === 0xc0) {
      state.patch = data1;
    } else if (command === 0xe0) {
      state.pitchWheel = (data2 << 7) | data1;
    }
  }

  trackController(state, channel, controller, value) {
    if (controller === CONTROLLER.MOD_WHEEL) {
      state.modWheel = value;
    } else if (controller === CONTROLLER.VOLUME) {
      this.channelVolume[channel] = value;
    } else if (controller === CONTROLLER.PAN) {
      state.pan = value;
    } else if (controller === CONTROLLER.HOLD_PEDAL) {
      state.sustain = value !== 0;
    } else if (controller === CONTROLLER.VOICES) {
      this.voicesChanged = this.voicesChanged || state.voices !== value;
      state.voices = value;
    }
  }

  /** Point `channel` at device channel `device` (-1 = unmapped), restoring its state. */
  remapChannel(channel, device) {
    if (this.remap[channel] === device) {
      return;
    }
    this.remap[channel] = device;
    if (device === -1) {
      return;
    }
    const state = this.channelState[channel];
    const volume = Math.trunc((this.channelVolume[channel] * this.volume) / VOLUME_MAX) & 0xff;
    this.sendRaw(0xb0 | device, CONTROLLER.HOLD_PEDAL, 0);
    this.sendRaw(0xb0 | device, CONTROLLER.VOICES, state.voices);
    this.sendRaw(0xc0 | device, state.patch, 0);
    this.sendRaw(0xb0 | device, CONTROLLER.VOLUME, volume);
    this.sendRaw(0xb0 | device, CONTROLLER.PAN, state.pan);
    this.sendRaw(0xb0 | device, CONTROLLER.MOD_WHEEL, state.modWheel);
    this.sendRaw(0xb0 | device, CONTROLLER.HOLD_PEDAL, state.sustain ? 0x7f : 0);
    this.sendRaw(0xe0 | device, state.pitchWheel & 0x7f, (state.pitchWheel >> 7) & 0x7f);
  }

  setVolume(volume) {
    this.volume = volume;
    for (let channel = 0; channel < CONTROL_CHANNEL; channel += 1) {
      if (this.remap[channel] !== -1) {
        this.sendToDriver(0xb0 | channel, CONTROLLER.VOLUME, this.channelVolume[channel]);
      }
    }
  }

  allNotesOff() {
    for (const key of this.activeNotes) {
      const device = this.remap[key >> 8];
      if (device !== -1) {
        this.sendRaw(0x80 | device, key & 0xff, 0);
      }
    }
    this.activeNotes.clear();
    for (let channel = 0; channel < MIDI_CHANNELS; channel += 1) {
      const device = this.remap[channel];
      if (device !== -1) {
        this.sendRaw(0xb0 | device, CONTROLLER.NOTES_OFF, 0);
        this.sendRaw(0xb0 | device, CONTROLLER.HOLD_PEDAL, 0);
      }
    }
  }

  stop() {
    if (this.status === STATUS.PLAYING) {
      this.allNotesOff();
    }
    this.status = STATUS.STOPPED;
    this.fadeStep = 0;
  }

  pause() {
    if (this.status === STATUS.PLAYING) {
      this.allNotesOff();
      this.status = STATUS.PAUSED;
    }
  }

  resume() {
    if (this.status === STATUS.PAUSED) {
      this.status = STATUS.PLAYING;
    }
  }
}
