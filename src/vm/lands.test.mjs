// Land switching: TSN.PRG programs, per-directory files, edit fields, the
// raw Array copy the network messages rely on, and an end-to-end run that
// picks LarryLand on the TSN map and lands on LarryLand's player screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProgramFile, nextProgramVm } from './programs.js';
import { FileSystem } from './filesystem.js';
import { applyKey } from './kernel/edit.js';
import { Memory } from './memory.js';
import { newArray, arraySet, arrayKernels } from './kernel/arrays.js';
import { createVmFromDirectory } from './node-loader.mjs';
import { EVENT_TYPE } from './events.js';

const INSTALL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'installed', 'TSN');
const MS_PER_FRAME = 1000 / 60;
const INSTRUCTIONS_PER_FRAME = 20000;
const PLAY_BUTTON = Object.freeze({ x: 282, y: 66 });
const LARRYLAND_ON_MAP = Object.freeze({ x: 80, y: 30 });
const FIRST_LAND_IN_CHOOSER = Object.freeze({ x: 80, y: 90 });
const LARRYLAND_PLAYER_PIC = 1010;
/** "Please select where you would like to go:" in the land chooser. */
const CHOOSER_PROMPT = Object.freeze({ top: 72, left: 40, bottom: 79, right: 230 });
const PEN_WHITE = 7;
const BLACK = 0;
const BYTE_ARRAY = 2;
const WORD_ARRAY = 0;
const ARRAY_COPY = 6;
const ARRAY_AT = 2;

/** Just enough of a VM for the Array kernel. */
function arrayOnlyVm() {
  return { memory: new Memory(), trace: { log: () => {} } };
}
const BACKSPACE = 8;
const LEFT_ARROW = 0x4b00;

const PROGRAMS = `program DEFAULT
\t\t  lscitv.exe -cLSCI.CFG
program LLand
        cd LL
        ..\\lscitv.exe
`;

test('TSN.PRG programs map to the directory they cd into', () => {
  const programs = parseProgramFile(PROGRAMS);
  assert.equal(programs.get('LLAND').directory, 'LL');
  assert.equal(programs.get('DEFAULT').directory, '');
});

test('a land directory sees its own files and climbs to the root with ..\\', () => {
  const root = new FileSystem(new Map([['LL/RESOURCE.MAP', Uint8Array.of(1)], ['GIL.DTA', Uint8Array.of(2)]]));
  const land = root.inDirectory('LL');
  assert.deepEqual(Array.from(land.read('RESOURCE.MAP')), [1]);
  assert.deepEqual(Array.from(land.read('..\\GIL.DTA')), [2]);
  land.write('NEW.DTA', Uint8Array.of(3));
  assert.ok(root.exists('LL\\NEW.DTA'), 'writes are shared with the root view');
});

test('typing into an edit field inserts at the cursor, backspaces and respects max', () => {
  const typed = [...'Gil'].reduce((state, ch) => applyKey(state, ch.charCodeAt(0), 3), { text: '', cursor: 0 });
  assert.deepEqual(typed, { text: 'Gil', cursor: 3 });
  assert.equal(applyKey(typed, 'x'.charCodeAt(0), 3).text, 'Gil', 'a full field ignores more letters');
  const movedLeft = applyKey(typed, LEFT_ARROW, 3);
  assert.deepEqual(applyKey(movedLeft, BACKSPACE, 3), { text: 'Gl', cursor: 1 });
});

test('Array copy moves raw bytes, so a byte message becomes little-endian words', () => {
  const vm = arrayOnlyVm();
  const message = newArray(vm, 2, BYTE_ARRAY);
  arraySet(vm, message, 0, 0x04);
  arraySet(vm, message, 1, 0x01);
  const words = newArray(vm, 0, WORD_ARRAY);
  arrayKernels.Array(vm, [ARRAY_COPY, words, 0, message, 0, 2]);
  assert.equal(arrayKernels.Array(vm, [ARRAY_AT, words, 0]), 0x104);
});

/** Append every picture `vm` draws to `pics`. */
function recordPictures(vm, pics) {
  const drawPic = vm.graphics.drawPic.bind(vm.graphics);
  vm.graphics.drawPic = (number, clear) => {
    pics.push(number);
    drawPic(number, clear);
  };
}

function runFrames(state, count) {
  for (let i = 0; i < count; i++) {
    if (state.vm.interp.halted) {
      state.vm = nextProgramVm(state.vm) ?? state.vm;
      recordPictures(state.vm, state.pics);
      state.vm.boot();
      state.programs.push(state.vm.program?.name);
    }
    state.vm.runSlice(INSTRUCTIONS_PER_FRAME);
    state.clock.ms += MS_PER_FRAME;
  }
}

/** Screen colours inside a rectangle. */
function colorsIn(vm, { top, left, bottom, right }) {
  const { visual, width } = vm.graphics.screen;
  const colors = new Set();
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      colors.add(visual[y * width + x]);
    }
  }
  return colors;
}

function clickAt(state, { x, y }) {
  state.vm.events.push({ type: EVENT_TYPE.MOUSE_DOWN, message: 0, x, y });
  state.vm.events.push({ type: EVENT_TYPE.MOUSE_UP, message: 0, x, y });
}

test('choosing LarryLand on the map quits to TSNEXEC and boots LarryLand from installed/TSN/LL', { skip: !existsSync(INSTALL_DIR) }, () => {
  const clock = { ms: Date.UTC(1993, 0, 15, 20) }; // headless wall clock: a 1993 evening (DOS dates start in 1980)
  const state = { clock, vm: createVmFromDirectory(INSTALL_DIR, { now: () => clock.ms }), programs: [], pics: [] };
  state.vm.boot();
  runFrames(state, 650);
  clickAt(state, PLAY_BUTTON);
  runFrames(state, 1800);
  clickAt(state, LARRYLAND_ON_MAP);
  runFrames(state, 150);
  assert.ok(colorsIn(state.vm, CHOOSER_PROMPT).has(PEN_WHITE), 'the chooser prompt is drawn with the window pen (white)');
  assert.ok(!colorsIn(state.vm, CHOOSER_PROMPT).has(BLACK), 'no black prompt text');
  clickAt(state, FIRST_LAND_IN_CHOOSER);
  runFrames(state, 900);

  assert.deepEqual(state.programs, ['LLand']);
  assert.equal(state.vm.fs.cwd, 'LL');
  assert.equal(state.vm.interp.halted, false);
  assert.equal(state.pics.at(-1), LARRYLAND_PLAYER_PIC);
});
