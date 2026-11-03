// Integration: boot the installed CC world headless with virtual time, click
// "Play" on the player screen and check that the fake host login leads to
// the TSN map (pic 50). Skipped when installed/TSN is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVmFromDirectory } from './node-loader.mjs';
import { EVENT_TYPE } from './events.js';
import { drawCursor } from '../gfx/cursor.js';

const INSTALL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'installed', 'TSN');
const MS_PER_FRAME = 1000 / 60;
const INSTRUCTIONS_PER_FRAME = 20000;
const PLAY_BUTTON = Object.freeze({ x: 282, y: 66 });
const PLAYER_SCREEN_FRAME = 650;
const MAP_FRAME = 2400;
const MAP_PIC = 50;
const STATUS_BAR_ROWS = 10;
const BLACK = 0;
const ARROW_CURSOR_VIEW = 897;
const CURSOR_SPOT = Object.freeze({ x: 120, y: 120 });
const CARD = Object.freeze({
  FACE: { top: 40, left: 40, bottom: 80, right: 70 },
  NAME_STRIP: { top: 85, left: 28, bottom: 95, right: 82 },
  ABOVE_CARD_ROW: 12,
  YELLOW: 31, SKIN: 70, STRIP_COLOR: 28,
});

function bootHeadless() {
  let clock = Date.UTC(1993, 0, 15, 20); // headless wall clock: a 1993 evening (DOS dates start in 1980)
  const vm = createVmFromDirectory(INSTALL_DIR, { now: () => clock });
  const drawnPics = [];
  const drawPic = vm.graphics.drawPic.bind(vm.graphics);
  vm.graphics.drawPic = (number, clear) => {
    drawnPics.push(number);
    drawPic(number, clear);
  };
  vm.boot();
  const runFrames = (count) => {
    for (let i = 0; i < count; i++) {
      vm.runSlice(INSTRUCTIONS_PER_FRAME);
      clock += MS_PER_FRAME;
    }
  };
  return { vm, drawnPics, runFrames };
}

function clickAt(vm, { x, y }) {
  vm.events.push({ type: EVENT_TYPE.MOUSE_DOWN, message: 0, x, y });
  vm.events.push({ type: EVENT_TYPE.MOUSE_UP, message: 0, x, y });
}

/** Palette indices of one screen row. */
function pixelsOfRow(vm, y) {
  return Array.from(vm.screen.visual.subarray(y * vm.screen.width, (y + 1) * vm.screen.width));
}

/** True when every pixel of the row has the same, non-black colour. */
function isSolidLightRow(pixels) {
  return pixels[0] !== BLACK && pixels.every((color) => color === pixels[0]);
}

function packetTypesSent(vm) {
  return [...vm.server.packetTypes.keys()].map((key) => Number(key.split('/')[0]));
}

test('the CC world boots, logs in through the fake host and reaches the TSN map', { skip: !existsSync(INSTALL_DIR) }, () => {
  const { vm, drawnPics, runFrames } = bootHeadless();
  runFrames(PLAYER_SCREEN_FRAME);
  assert.equal(vm.interp.halted, false);
  assert.ok(vm.trace.kernels.get('GetEvent')?.count > 0, 'the game loop polls for events');

  clickAt(vm, PLAY_BUTTON);
  runFrames(MAP_FRAME - PLAYER_SCREEN_FRAME);

  assert.equal(vm.interp.halted, false);
  assert.ok(packetTypesSent(vm).includes(53), 'login (53) was sent');
  assert.ok(packetTypesSent(vm).includes(7), 'joinNet (7) was sent');
  assert.equal(drawnPics.at(-1), MAP_PIC);
});

test('the status bar is drawn through the screen port at rows 0-9, solid and full width', { skip: !existsSync(INSTALL_DIR) }, () => {
  const { vm, runFrames } = bootHeadless();
  runFrames(PLAYER_SCREEN_FRAME);
  clickAt(vm, PLAY_BUTTON);
  runFrames(MAP_FRAME - PLAYER_SCREEN_FRAME);

  const topRow = pixelsOfRow(vm, 0);
  const barRows = Array.from({ length: STATUS_BAR_ROWS }, (_, y) => pixelsOfRow(vm, y));
  assert.ok(isSolidLightRow(topRow), 'row 0 is the bar background, not a black band');
  assert.ok(barRows.every((row) => !row.includes(BLACK)), 'no black in rows 0-9');
  assert.ok(barRows.every((row) => row[0] === topRow[0] && row.at(-1) === topRow[0]), 'the bar spans the full width');
  assert.notDeepEqual(pixelsOfRow(vm, STATUS_BAR_ROWS), topRow, 'the picture starts at row 10');
});

/** Palette indices inside a screen rect. */
function pixelsInside(vm, { top, left, bottom, right }) {
  return Array.from({ length: bottom - top }, (_, row) => pixelsOfRow(vm, top + row).slice(left, right)).flat();
}

function fractionOf(pixels, color) {
  return pixels.filter((pixel) => pixel === color).length / pixels.length;
}

test('the Select Player card shows the composed face and the "Gil" name strip', { skip: !existsSync(INSTALL_DIR) }, () => {
  const { vm, runFrames } = bootHeadless();
  runFrames(PLAYER_SCREEN_FRAME);

  const face = pixelsInside(vm, CARD.FACE);
  const strip = pixelsInside(vm, CARD.NAME_STRIP);
  assert.ok(fractionOf(face, CARD.YELLOW) < 0.2, 'the face area is covered by face cels, not the empty card');
  assert.ok(face.includes(CARD.SKIN) && face.includes(BLACK), 'skin and the black beard are drawn');
  assert.ok(fractionOf(strip, CARD.STRIP_COLOR) > 0.5, 'the name strip is filled');
  assert.ok(strip.includes(BLACK), 'the name "Gil" is written on the strip');
  assert.equal(pixelsOfRow(vm, CARD.ABOVE_CARD_ROW)[45], pixelsOfRow(vm, CARD.ABOVE_CARD_ROW)[150], 'nothing of the face peeks out above the card');
});

/** RGBA output of the screen with the cursor composited at `mouse`. */
function frameWithCursorAt(vm, mouse) {
  const { rgba } = vm.screen.toRgba();
  drawCursor(vm.graphics, vm.cursor, mouse, rgba);
  return rgba;
}

test('the game cursor is the view the scripts set, drawn as an overlay outside the framebuffer', { skip: !existsSync(INSTALL_DIR) }, () => {
  const { vm, runFrames } = bootHeadless();
  runFrames(PLAYER_SCREEN_FRAME);
  const framebufferBefore = Uint8Array.from(vm.screen.visual);

  const withCursor = frameWithCursorAt(vm, CURSOR_SPOT);
  const withoutCursor = vm.screen.toRgba().rgba;

  assert.equal(vm.cursor.view, ARROW_CURSOR_VIEW);
  assert.notDeepEqual(withCursor, withoutCursor, 'the arrow is visible at the mouse position');
  assert.deepEqual(vm.screen.visual, framebufferBefore, 'the framebuffer itself is untouched');
});
