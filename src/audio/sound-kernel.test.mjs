import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVmFromDirectory } from '../vm/node-loader.mjs';
import { INSTALL_DIR } from './installed-worlds.mjs';
import { SIGNAL_END } from './sound-entry.js';

const MS_PER_FRAME = 1000 / 60;
const INSTRUCTIONS_PER_FRAME = 20000;
/** Before the welcome dialog opens (frame 423): its modal loop skips Sound::check. */
const FRAMES_TO_WINTER_MAP = 400;
const SOUND_FX_GLOBAL = 138;
const PAGE_SOUND = 505;
const PAGE_SOUND_TICKS = 20;
const ALLOWED_CHECK_DELAY = 12;

/** A headless CC VM on virtual time, booted to the Winter Map. */
function bootToWinterMap() {
  let clock = Date.UTC(1993, 0, 15, 20); // headless wall clock: a 1993 evening (DOS dates start in 1980)
  const vm = createVmFromDirectory(INSTALL_DIR, { now: () => clock });
  const runFrames = (count) => {
    for (let i = 0; i < count; i += 1) {
      vm.runSlice(INSTRUCTIONS_PER_FRAME);
      clock += MS_PER_FRAME;
    }
  };
  vm.boot();
  runFrames(FRAMES_TO_WINTER_MAP);
  return { vm, runFrames };
}

function soundEffectsObject(vm) {
  return vm.memory.readWord(vm.interp.globals, SOUND_FX_GLOBAL * 2);
}

/** Play `number` on the game's soundFX object and return the ticks until the script saw the end signal. */
function ticksUntilScriptSeesEnd(number) {
  const { vm, runFrames } = bootToWinterMap();
  const sound = soundEffectsObject(vm);
  vm.send(sound, vm.sel('number'), [number]);
  vm.send(sound, vm.sel('play'), []);
  const started = vm.ticks();
  for (let frame = 0; frame < 120; frame += 1) {
    runFrames(1);
    if (vm.prop(sound, 'prevSignal') === SIGNAL_END) {
      return { ticks: vm.ticks() - started, vm, sound };
    }
  }
  return { ticks: -1, vm, sound };
}

test('the game creates its soundFX object and sets the master volume at boot', () => {
  const { vm } = bootToWinterMap();
  assert.equal(vm.interp.objectName(soundEffectsObject(vm)), 'soundFX');
  assert.ok(vm.soundSystem, 'Sound was called');
  assert.ok(vm.soundSystem.masterVolume > 0);
});

test('soundFX play: gets nodePtr and handle, and Sound::check sees the end signal after the song', () => {
  const { ticks, vm, sound } = ticksUntilScriptSeesEnd(PAGE_SOUND);
  assert.ok(ticks >= PAGE_SOUND_TICKS && ticks <= PAGE_SOUND_TICKS + ALLOWED_CHECK_DELAY, `ended after ${ticks} ticks`);
  assert.equal(vm.prop(sound, 'handle'), 0, 'stopped sounds clear their handle');
  assert.equal(vm.prop(sound, 'nodePtr'), sound, 'the node stays until dispose');
});

test('signal timing is identical on every headless run', () => {
  assert.equal(ticksUntilScriptSeesEnd(PAGE_SOUND).ticks, ticksUntilScriptSeesEnd(PAGE_SOUND).ticks);
});
