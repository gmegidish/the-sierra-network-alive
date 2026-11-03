// Land switching: TSN.PRG programs, per-directory files, edit fields, the
// raw Array copy the network messages rely on, and an end-to-end run that
// picks CasinoLand on the Winter Map and lands on CasinoLand's player screen,
// and SierraLand's and a Clubhouse room's waiting rooms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { parseProgramFile } from './programs.js';
import { FileSystem } from './filesystem.js';
import { applyKey } from './kernel/edit.js';
import { Memory } from './memory.js';
import { newArray, arraySet, arrayKernels } from './kernel/arrays.js';
import {
  INSTALL_DIR, startSession, playUntil, addToScript, toTheWinterMapAs, toTheSierraLandWaitingRoomAs, toTheClubhouseWaitingRoomAs,
  CASINOLAND_PLAYER_SCREEN_FRAME, SIERRALAND_WAITING_ROOM_FRAME, CLUBHOUSE_WAITING_ROOM_FRAME,
} from './headless-session.mjs';

const CASINOLAND_ON_MAP = Object.freeze([9300, [55, 40]]);
const NO_ACCESS_PASSWORD = Object.freeze([9600, [219, 115]]);
const CHOOSER_FRAME = 9800;
const FIRST_CASINO_IN_CHOOSER = Object.freeze([9900, [80, 96]]);
const CASINOLAND_PLAYER_PIC = 1010;
const SIERRALAND_WAITING_ROOM_PIC = 120;
const CLUBHOUSE_WAITING_ROOM_PIC = 100;
/** "Please select where you would like to go:" in the land chooser. */
const CHOOSER_PROMPT = Object.freeze({ top: 76, left: 40, bottom: 85, right: 230 });
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

/** @returns {number[]} the client message types the fake host has seen */
function packetTypesSent(vm) {
  return [...vm.server.packetTypes.keys()].map((key) => Number(key.split('/')[0]));
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

test('choosing CasinoLand on the map quits to TSNEXEC and boots CasinoLand from installed/INN/LL', { skip: !existsSync(INSTALL_DIR) }, () => {
  const session = startSession({ script: [...toTheWinterMapAs('Gil'), CASINOLAND_ON_MAP, NO_ACCESS_PASSWORD] });
  playUntil(session, CHOOSER_FRAME);
  assert.ok(colorsIn(session.vm, CHOOSER_PROMPT).has(PEN_WHITE), 'the chooser prompt is drawn with the window pen (white)');
  assert.ok(!colorsIn(session.vm, CHOOSER_PROMPT).has(BLACK), 'no black prompt text');
  addToScript(session, [FIRST_CASINO_IN_CHOOSER]);
  playUntil(session, CASINOLAND_PLAYER_SCREEN_FRAME);

  assert.deepEqual(session.programs, ['LLand']);
  assert.equal(session.vm.fs.cwd, 'LL');
  assert.equal(session.vm.interp.halted, false);
  assert.equal(session.pics.at(-1), CASINOLAND_PLAYER_PIC);
});

test('SierraLand boots from installed/INN/SL and a new persona reaches its waiting room', { skip: !existsSync(INSTALL_DIR) }, () => {
  const session = startSession({ script: toTheSierraLandWaitingRoomAs('Gil') });
  playUntil(session, SIERRALAND_WAITING_ROOM_FRAME);

  assert.deepEqual(session.programs, ['SLand']);
  assert.equal(session.vm.fs.cwd, 'SL');
  assert.equal(session.pics.at(-1), SIERRALAND_WAITING_ROOM_PIC);
});

test('a Clubhouse room is entered without leaving the Clubhouse program', { skip: !existsSync(INSTALL_DIR) }, () => {
  const session = startSession({ script: toTheClubhouseWaitingRoomAs('Gil') });
  playUntil(session, CLUBHOUSE_WAITING_ROOM_FRAME);

  assert.deepEqual(session.programs, []);
  assert.equal(session.pics.at(-1), CLUBHOUSE_WAITING_ROOM_PIC);
  assert.ok(packetTypesSent(session.vm).includes(10), 'the room was joined (10)');
});

test('a freed block keeps its contents for reads until its ID is reused, as a freed DOS hunk does', () => {
  const memory = new Memory();
  const locals = memory.alloc(6, 4);
  memory.writeWord(locals, 2, 0x1234);
  memory.free(locals);
  assert.equal(memory.readWord(locals, 2), 0x1234, 'WhoUAre::dispose reads its locals after its module is gone');
  memory.writeWord(locals, 2, 0x5678);
  assert.equal(memory.readWord(locals, 2), 0x1234, 'writes to a freed block are dropped');
  const reused = memory.alloc(6, 4);
  assert.equal(reused, locals);
  assert.equal(memory.readWord(reused, 2), 0, 'the new owner starts clean');
});
