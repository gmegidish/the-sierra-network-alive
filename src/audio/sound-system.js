// The SCI1 music system for one VM: the play list, the AdLib driver, channel
// remapping between sounds, digital samples and the 60 Hz sound clock.
// Modelled on ScummVM's SciMusic (engines/sci/sound/music.cpp, GPL-2.0-or-later);
// determineChannelMap/remapChannels are simplified (see docs/audio.md).
//
// The clock is the VM's tick counter: advanceTo(vm.ticks()) runs every timer
// tick up to "now", so cues and signals fire at the same VM tick whether or not
// any audio is being produced (headless runs use a null sink).
import { RESOURCE_TYPE } from '../resource/types.js';
import { parseSound, findTrack, decodeAdlibPatch, SOUND_DEVICE, CONTROL_CHANNEL } from '../resource/sound.js';
import { AdlibDriver } from './adlib-driver.js';
import { SoundEntry, STATUS, VOLUME_MAX } from './sound-entry.js';

export const MASTER_VOLUME_MAX = 15;
const ADLIB_PATCH = 3;
const DEVICE_CHANNELS = 16;
const MAX_CATCH_UP_TICKS = 60 * 60;
const PRIORITY_SLOTS = 16;
const OPL_REGISTERS = 256;

/**
 * @typedef {{ write(tick: number, reg: number, value: number): void,
 *   playSample(tick: number, id: number, sample: import('../resource/sound.js').DigitalSample, loops: number, volume: number): void,
 *   stopSample(tick: number, id: number): void }} AudioSink
 * @typedef {{ get(type: number, number: number): Uint8Array, has(type: number, number: number): boolean }} Resources
 * @typedef {{ resources: Resources, sink?: AudioSink | null, startTick?: number }} SoundSystemOptions
 */

/** Sink that discards everything (headless runs, no audio device). */
export const NULL_SINK = Object.freeze({ write() {}, playSample() {}, stopSample() {} });

function loadPatches(resources) {
  if (!resources.has(RESOURCE_TYPE.PATCH, ADLIB_PATCH)) {
    return null;
  }
  return decodeAdlibPatch(resources.get(RESOURCE_TYPE.PATCH, ADLIB_PATCH));
}

export class SoundSystem {
  /** @param {SoundSystemOptions} options */
  constructor({ resources, sink = null, startTick = 0 }) {
    this.resources = resources;
    this.sink = sink ?? NULL_SINK;
    this.tick = startTick;
    this.timeCounter = 0;
    this.masterVolume = MASTER_VOLUME_MAX;
    this.soundOn = true;
    this.entries = new Map();
    this.deviceMap = Array.from({ length: DEVICE_CHANNELS }, () => null);
    this.needsRemap = false;
    this.registers = new Uint8Array(OPL_REGISTERS);
    const patches = loadPatches(resources);
    this.driver = patches ? new AdlibDriver(patches, (reg, value) => this.writeRegister(reg, value)) : null;
  }

  writeRegister(reg, value) {
    this.registers[reg] = value;
    this.sink.write(this.tick, reg, value);
  }

  /** Swap the output (e.g. when the browser's audio starts) and replay the chip state into it. */
  setSink(sink) {
    this.sink = sink ?? NULL_SINK;
    const keyRegisters = (reg) => reg >= 0xb0 && reg <= 0xb8;
    this.registers.forEach((value, reg) => {
      if (!keyRegisters(reg)) {
        this.sink.write(this.tick, reg, value);
      }
    });
    this.registers.forEach((value, reg) => {
      if (keyRegisters(reg)) {
        this.sink.write(this.tick, reg, value);
      }
    });
  }

  /** Run timer ticks until the sound clock reaches `tick`. */
  advanceTo(tick) {
    const target = Math.min(tick, this.tick + MAX_CATCH_UP_TICKS);
    while (this.tick < target) {
      this.onTimer();
      this.tick += 1;
    }
    this.tick = Math.max(this.tick, tick);
  }

  onTimer() {
    for (const entry of this.playList()) {
      entry.onTimer();
      this.needsRemap = this.needsRemap || Boolean(entry.voicesChanged);
      entry.voicesChanged = false;
    }
    if (this.needsRemap) {
      this.remapChannels();
    }
    this.driver?.onTimer();
  }

  /** Entries in descending priority, newest first among equals (sortPlayList). */
  playList() {
    return [...this.entries.values()].sort((a, b) => b.priority - a.priority || b.time - a.time);
  }

  hasSound(number) {
    return this.resources.has(RESOURCE_TYPE.SOUND, number);
  }

  entry(object) {
    return this.entries.get(object);
  }

  /** kDoSound init: (re)create the slot for `object` playing resource `number`. */
  init(object, number, { loop, priority, volume }) {
    if (this.entries.has(object)) {
      this.dispose(object);
    }
    const entry = this.createEntry(object, number);
    entry.loop = loop;
    entry.priority = priority & 0xff;
    entry.volume = Math.max(0, Math.min(VOLUME_MAX, volume));
    this.entries.set(object, entry);
    return entry;
  }

  createEntry(object, number) {
    const send = (status, data1, data2) => this.driver?.send(status, data1, data2);
    if (!this.resources.has(RESOURCE_TYPE.SOUND, number)) {
      return new SoundEntry({ object, number, send });
    }
    const sound = parseSound(this.resources.get(RESOURCE_TYPE.SOUND, number));
    const track = findTrack(sound, SOUND_DEVICE.ADLIB) ?? sound.tracks.find((t) => t.digital) ?? null;
    const sample = track?.digital ?? null;
    return new SoundEntry({ object, number, track, sample, resourcePriority: sound.priority, send });
  }

  /** kDoSound play. Returns the entry. */
  play(object, { loop, priority, volume, playBed }) {
    const entry = this.entries.get(object);
    entry.loop = loop;
    entry.priority = entry.resourcePriority !== 0xff ? entry.resourcePriority : priority;
    entry.volume = Math.max(0, Math.min(VOLUME_MAX, volume));
    entry.hold = -1;
    entry.playBed = playBed;
    if (playBed) {
      this.stopOtherBeds(entry);
    }
    entry.time = ++this.timeCounter;
    if (entry.status !== STATUS.STOPPED) {
      this.stop(object);
    }
    this.releaseChannels(entry);
    entry.start();
    if (entry.isSample) {
      this.sink.playSample(this.tick, entry.object, entry.sample, entry.loop > 1 ? entry.loop : 1, this.sampleVolume(entry));
    }
    this.remapChannels();
    return entry;
  }

  sampleVolume(entry) {
    return this.soundOn ? (entry.volume / VOLUME_MAX) * (this.masterVolume / MASTER_VOLUME_MAX) : 0;
  }

  stopOtherBeds(entry) {
    for (const other of this.entries.values()) {
      if (other !== entry && other.playBed && other.status === STATUS.PLAYING) {
        this.stop(other.object);
        return;
      }
    }
  }

  stop(object) {
    const entry = this.entries.get(object);
    if (!entry) {
      return;
    }
    const wasPlaying = entry.status === STATUS.PLAYING;
    entry.stop();
    if (entry.isSample && wasPlaying) {
      this.sink.stopSample(this.tick, entry.object);
    }
    this.remapChannels();
  }

  dispose(object) {
    this.stop(object);
    this.entries.delete(object);
    this.remapChannels();
  }

  /** Pause or resume one sound, or every sound when `object` is null. */
  pause(object, shouldPause) {
    const targets = object === null ? [...this.entries.values()] : [this.entries.get(object)].filter(Boolean);
    for (const entry of targets) {
      if (shouldPause) {
        entry.pause();
      } else {
        entry.resume();
      }
    }
    this.remapChannels();
  }

  setMasterVolume(volume) {
    this.masterVolume = Math.max(0, Math.min(MASTER_VOLUME_MAX, volume));
    this.driver?.setMasterVolume(this.masterVolume);
  }

  setSoundOn(on) {
    this.soundOn = on;
    this.driver?.playSwitch(on);
  }

  get polyphony() {
    return this.driver?.polyphony ?? 0;
  }

  /** Silence everything (the VM is going away). */
  shutdown() {
    for (const object of [...this.entries.keys()]) {
      this.dispose(object);
    }
    this.driver?.allOff();
  }

  /** Decide which (sound, channel) owns each device channel, by priority and voice budget. */
  determineChannelMap() {
    const map = Array.from({ length: DEVICE_CHANNELS }, () => null);
    let freeVoices = this.polyphony;
    const playing = this.playList().filter((entry) => entry.status === STATUS.PLAYING && entry.hasMidi);
    playing.forEach((entry, songIndex) => {
      const backup = { map: [...map], freeVoices };
      const ok = entry.usedChannels.every((channel) => {
        const result = this.mapChannel(map, entry, channel, songIndex, freeVoices);
        freeVoices = result.freeVoices;
        return result.ok;
      });
      if (!ok) {
        backup.map.forEach((slot, i) => {
          map[i] = slot;
        });
        freeVoices = backup.freeVoices;
      }
    });
    return map;
  }

  mapChannel(map, entry, channel, songIndex, freeVoices) {
    const info = entry.channelInfo.get(channel);
    if (channel === CONTROL_CHANNEL || info.dontMap || info.mute) {
      return { ok: true, freeVoices };
    }
    const prio = info.prio > 0 ? PRIORITY_SLOTS - info.prio + PRIORITY_SLOTS * songIndex : 0;
    const voices = entry.channelState[channel].voices;
    let device = this.pickDeviceChannel(map, entry, channel, info.dontRemap || entry.playBed);
    if (device === -1 && prio > 0) {
      return { ok: true, freeVoices };
    }
    if (device === -1) {
      device = lowestPriorityChannel(map);
      if (device === -1) {
        return { ok: false, freeVoices };
      }
      freeVoices += map[device].voices;
      map[device] = null;
    }
    if (freeVoices < voices && (prio > 0 || entry.playBed)) {
      return { ok: true, freeVoices };
    }
    map[device] = { entry, channel, prio, voices };
    return { ok: true, freeVoices: freeVoices - voices };
  }

  pickDeviceChannel(map, entry, channel, dontRemap) {
    if (dontRemap) {
      return map[channel] ? -1 : channel;
    }
    const previous = entry.remap[channel];
    if (previous !== -1 && !map[previous]) {
      return previous;
    }
    for (let device = CONTROL_CHANNEL - 1; device >= 0; device -= 1) {
      if (!map[device]) {
        return device;
      }
    }
    return -1;
  }

  /** Apply a new channel map: release channels that move, then restore state on new ones. */
  remapChannels() {
    this.needsRemap = false;
    const map = this.determineChannelMap();
    for (const entry of this.entries.values()) {
      for (const channel of entry.usedChannels) {
        const target = map.findIndex((slot) => slot?.entry === entry && slot.channel === channel);
        if (target !== entry.remap[channel] && entry.remap[channel] !== -1) {
          this.resetDeviceChannel(entry.remap[channel]);
          entry.remapChannel(channel, -1);
        }
      }
    }
    map.forEach((slot, device) => {
      if (slot && slot.entry.remap[slot.channel] !== device) {
        this.resetDeviceChannel(device);
        slot.entry.remapChannel(slot.channel, device);
      }
    });
    this.deviceMap = map;
  }

  releaseChannels(entry) {
    entry.remap.forEach((device) => {
      if (device !== -1) {
        this.resetDeviceChannel(device);
      }
    });
  }

  resetDeviceChannel(device) {
    this.driver?.send(0xb0 | device, 0x40, 0);
    this.driver?.send(0xb0 | device, 0x7b, 0);
    this.driver?.send(0xb0 | device, 0x4b, 0);
  }
}

function lowestPriorityChannel(map) {
  let max = 0;
  let found = -1;
  map.forEach((slot, device) => {
    if (slot && slot.prio > max) {
      max = slot.prio;
      found = device;
    }
  });
  return found;
}
