// Kernel Sound (#52), LSCI's kDoSound. The sub-function numbering is the
// SCI1-early table (ScummVM kernel_tables.h, SIG_SOUNDSCI1EARLY), confirmed by
// the Sound class (module 60049): init 5, dispose 6, play 7 (self, bed), stop 8,
// pause 9, fade 10 (self, to, ticks, step, stop), check 11 (UpdateCues),
// send 12 (SendMidi), hold 14, changeState 4 (Update); 0 MasterVolume,
// 2 Restore and 3 GetPolyphony come from modules 105, 60023 and 900.
// Selector writes follow ScummVM's SoundCommandParser (soundcmd.cpp).
import { SoundSystem } from '../../audio/sound-system.js';
import { SIGNAL_END, STATUS } from '../../audio/sound-entry.js';
import { currentAudioSink } from '../../audio/output.js';

const SUB = Object.freeze({
  MASTER_VOLUME: 0, MUTE: 1, RESTORE: 2, GET_POLYPHONY: 3, UPDATE: 4, INIT: 5, DISPOSE: 6, PLAY: 7,
  STOP: 8, PAUSE: 9, FADE: 10, UPDATE_CUES: 11, SEND_MIDI: 12, GLOBAL_REVERB: 13, SET_HOLD: 14,
});
const CUE_SIGNAL_BASE = 127;
const VOLUME_MAX = 127;
const PITCH_CONTROLLER = 0xff;
const PITCH_CENTER = 0x2000;
const PITCH_MAX = 0x3fff;
const TICKS_PER_MINUTE = 3600;
const TICKS_PER_SECOND = 60;
const FRAME_TICKS = 2;

const toSigned = (value) => (value & 0x8000 ? value - 0x10000 : value);

/** The VM's sound system, created on first use and advanced to the VM clock. */
export function soundSystemOf(vm) {
  if (!vm.soundSystem) {
    vm.soundSystem = new SoundSystem({ resources: vm.resources, sink: currentAudioSink(), startTick: vm.ticks() });
  }
  vm.soundSystem.advanceTo(vm.ticks());
  return vm.soundSystem;
}

function readSettings(vm, object) {
  return {
    loop: vm.prop(object, 'loop') & 0xffff,
    priority: vm.prop(object, 'priority'),
    volume: Math.max(0, Math.min(VOLUME_MAX, toSigned(vm.prop(object, 'vol')))),
  };
}

function initSound(vm, system, object) {
  if (!vm.objects.isObject(object)) {
    return;
  }
  if (system.entry(object)) {
    system.dispose(object);
  }
  // Like SSCI (and unlike ScummVM's empty slot), a missing resource gets no node,
  // so later calls on the object are ignored instead of signalling "stopped".
  if (!system.hasSound(vm.prop(object, 'number'))) {
    return;
  }
  system.init(object, vm.prop(object, 'number'), readSettings(vm, object));
  vm.setProp(object, 'nodePtr', object);
}

function playSound(vm, system, object, playBed) {
  const entry = system.entry(object);
  if (!entry || entry.number !== vm.prop(object, 'number')) {
    initSound(vm, system, object);
  }
  if (!system.entry(object)) {
    return;
  }
  vm.setProp(object, 'handle', object);
  vm.setProp(object, 'nodePtr', object);
  ['min', 'sec', 'frame', 'signal'].forEach((name) => vm.setProp(object, name, 0));
  system.play(object, { ...readSettings(vm, object), playBed: Boolean(playBed) });
}

function stopSound(vm, system, object) {
  const entry = system.entry(object);
  if (!entry) {
    return;
  }
  vm.setProp(object, 'handle', 0);
  vm.setProp(object, 'signal', SIGNAL_END);
  entry.dataInc = 0;
  entry.signal = SIGNAL_END;
  system.stop(object);
}

function disposeSound(vm, system, object) {
  if (!system.entry(object)) {
    return;
  }
  stopSound(vm, system, object);
  system.dispose(object);
  vm.setProp(object, 'handle', 0);
  vm.setProp(object, 'nodePtr', 0);
}

function updateSound(vm, system, object) {
  const entry = system.entry(object);
  if (!entry) {
    return;
  }
  const settings = readSettings(vm, object);
  entry.loop = settings.loop;
  if (settings.volume !== entry.volume) {
    entry.setVolume(settings.volume);
  }
  if (settings.priority !== entry.priority) {
    entry.priority = settings.priority;
    system.remapChannels();
  }
}

function fadeSound(vm, system, [object, to, ticks, step, stopAfter]) {
  const entry = system.entry(object);
  if (!entry || to === undefined) {
    return;
  }
  const target = Math.max(0, Math.min(VOLUME_MAX, to));
  const shouldStop = Boolean(stopAfter);
  if (entry.volume === target && !shouldStop) {
    return;
  }
  entry.startFade(target, ticks ?? 0, step || 1, shouldStop);
}

/** UpdateCues: copy cue/signal/position from the sound into the object (processUpdateCues). */
function updateCues(vm, system, object) {
  const entry = system.entry(object);
  if (!entry) {
    return;
  }
  if (entry.isSample) {
    updateSampleCues(vm, system, entry);
  } else if (entry.hasMidi) {
    updateMidiCues(vm, system, entry);
  } else {
    stopSound(vm, system, object);
  }
  if (entry.fadeCompleted) {
    entry.fadeCompleted = false;
    vm.setProp(object, 'signal', SIGNAL_END);
    if (entry.stopAfterFading) {
      stopSound(vm, system, object);
    }
  }
  entry.signal = 0;
  vm.setProp(object, 'min', Math.floor(entry.ticker / TICKS_PER_MINUTE));
  vm.setProp(object, 'sec', Math.floor((entry.ticker % TICKS_PER_MINUTE) / TICKS_PER_SECOND));
  vm.setProp(object, 'frame', Math.floor((entry.ticker % TICKS_PER_SECOND) / FRAME_TICKS));
}

function updateMidiCues(vm, system, entry) {
  const object = entry.object;
  if (entry.signal === 0) {
    if (entry.dataInc !== vm.prop(object, 'dataInc')) {
      vm.setProp(object, 'dataInc', entry.dataInc);
      vm.setProp(object, 'signal', entry.dataInc + CUE_SIGNAL_BASE);
    }
    return;
  }
  vm.setProp(object, 'signal', entry.signal);
  if (entry.signal === SIGNAL_END) {
    stopSound(vm, system, object);
  }
}

function updateSampleCues(vm, system, entry) {
  if (entry.status === STATUS.PLAYING && entry.isSampleDone()) {
    stopSound(vm, system, entry.object);
  }
}

function sendMidi(vm, system, args) {
  const [object, channelArg] = args;
  const entry = system.entry(object);
  if (!entry) {
    return;
  }
  let command = args.length === 5 ? args[2] & 0xff : 0xb0;
  let data1 = args.length === 5 ? args[3] : args[2];
  let data2 = args.length === 5 ? args[4] : args[3];
  if (args.length === 4 && data1 === PITCH_CONTROLLER) {
    const pitch = Math.max(0, Math.min(PITCH_MAX, toSigned(data2) + PITCH_CENTER));
    command = 0xe0;
    data1 = pitch & 0x7f;
    data2 = pitch >> 7;
  }
  const channel = channelArg ? (channelArg - 1) & 0x0f : 0;
  if (entry.channelInfo.has(channel)) {
    entry.sendToDriver(command | channel, data1 & 0x7f, data2 & 0x7f);
  }
}

function masterVolume(system, [volume]) {
  const previous = system.masterVolume;
  if (volume !== undefined) {
    system.setMasterVolume(toSigned(volume));
  }
  return previous;
}

function mute(system, [on]) {
  const previous = system.soundOn ? 1 : 0;
  if (on !== undefined) {
    system.setSoundOn(Boolean(on));
  }
  return previous;
}

const HANDLERS = Object.freeze({
  [SUB.MASTER_VOLUME]: (vm, system, args) => masterVolume(system, args),
  [SUB.MUTE]: (vm, system, args) => mute(system, args),
  [SUB.RESTORE]: () => 0,
  [SUB.GET_POLYPHONY]: (vm, system) => system.polyphony,
  [SUB.UPDATE]: (vm, system, [object]) => updateSound(vm, system, object),
  [SUB.INIT]: (vm, system, [object]) => initSound(vm, system, object),
  [SUB.DISPOSE]: (vm, system, [object]) => disposeSound(vm, system, object),
  [SUB.PLAY]: (vm, system, [object, bed]) => playSound(vm, system, object, bed),
  [SUB.STOP]: (vm, system, [object]) => stopSound(vm, system, object),
  [SUB.PAUSE]: (vm, system, [object, flag]) => system.pause(object ? object : null, Boolean(flag)),
  [SUB.FADE]: (vm, system, args) => fadeSound(vm, system, args),
  [SUB.UPDATE_CUES]: (vm, system, [object]) => updateCues(vm, system, object),
  [SUB.SEND_MIDI]: (vm, system, args) => sendMidi(vm, system, args),
  [SUB.GLOBAL_REVERB]: () => 0,
  [SUB.SET_HOLD]: (vm, system, [object, hold]) => {
    const entry = system.entry(object);
    if (entry) {
      entry.hold = toSigned(hold);
    }
  },
});

/** Sound(subFunction, ...args) */
function sound(vm, [subFunction, ...args]) {
  const handler = HANDLERS[subFunction];
  if (!handler) {
    vm.trace.log('todo', `Sound(${subFunction}) unknown sub-function`);
    return 0;
  }
  // undefined leaves the accumulator alone, as ScummVM's handlers return s->r_acc.
  return handler(vm, soundSystemOf(vm), args);
}

export const soundKernels = Object.freeze({ Sound: sound });
