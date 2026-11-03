import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESOURCE_TYPE } from './types.js';
import { decodePalette } from './palette.js';
import { decodeView } from './view.js';
import { renderPic, PIC_WIDTH, PIC_HEIGHT } from './pic.js';
import { decodeFont, measureText } from './font.js';
import { WHITE } from './pic-canvas.js';
import { openCcWorld, resourcesOfType, countDistinctValues } from './test-helpers.mjs';

const SYSTEM_PALETTE = 999;
const MIN_COLORS_IN_A_SCENE = 32;

function renderEveryPic(rm) {
  return resourcesOfType(rm, RESOURCE_TYPE.PIC).map((r) => ({ number: r.number, pic: renderPic(rm.get(RESOURCE_TYPE.PIC, r.number)) }));
}

function fractionOfPixelsPainted(pic) {
  return pic.visual.filter((value) => value !== WHITE).length / pic.visual.length;
}

test('system palette 999 decodes with white at index 255 and black at 0', () => {
  const palette = decodePalette(openCcWorld().get(RESOURCE_TYPE.PALETTE, SYSTEM_PALETTE));
  assert.deepEqual([...palette.rgb.subarray(0, 3)], [0, 0, 0]);
  assert.deepEqual([...palette.rgb.subarray(255 * 3, 256 * 3)], [255, 255, 255]);
});

test('every pic renders to a 320x190 picture that is mostly painted', () => {
  for (const { number, pic } of renderEveryPic(openCcWorld())) {
    assert.equal(pic.width, PIC_WIDTH, `pic ${number}`);
    assert.equal(pic.height, PIC_HEIGHT, `pic ${number}`);
    assert.ok(fractionOfPixelsPainted(pic) > 0.9, `pic ${number} is mostly blank`);
  }
});

test('every pic carries its own palette and priority bands', () => {
  for (const { number, pic } of renderEveryPic(openCcWorld())) {
    assert.ok(pic.palette, `pic ${number} palette`);
    assert.equal(pic.priorityBands.length, 14, `pic ${number} bands`);
  }
});

test('the CC world map (pic 50) is a detailed multi-color scene', () => {
  const pic = renderPic(openCcWorld().get(RESOURCE_TYPE.PIC, 50));
  assert.ok(countDistinctValues(pic.visual) >= MIN_COLORS_IN_A_SCENE);
});

test('pic 101 draws a non-trivial priority plane', () => {
  const pic = renderPic(openCcWorld().get(RESOURCE_TYPE.PIC, 101));
  assert.ok(countDistinctValues(pic.priority) > 2);
});

test('every view decodes and every cel has width*height pixels', () => {
  const rm = openCcWorld();
  for (const { number } of resourcesOfType(rm, RESOURCE_TYPE.VIEW)) {
    const view = decodeView(rm.get(RESOURCE_TYPE.VIEW, number));
    assert.ok(view.loops.length > 0, `view ${number}`);
    for (const cel of view.loops.flatMap((loop) => loop.cels)) {
      assert.equal(cel.pixels.length, cel.width * cel.height, `view ${number}`);
    }
  }
});

test('view 0 is a single 8x8 fully transparent cel', () => {
  const view = decodeView(openCcWorld().get(RESOURCE_TYPE.VIEW, 0));
  const cel = view.loops[0].cels[0];
  assert.deepEqual([cel.width, cel.height], [8, 8]);
  assert.ok(cel.pixels.every((value) => value === cel.clearKey));
});

test('every font has 128 glyphs and a sensible line height', () => {
  const rm = openCcWorld();
  for (const { number } of resourcesOfType(rm, RESOURCE_TYPE.FONT)) {
    const font = decodeFont(rm.get(RESOURCE_TYPE.FONT, number));
    assert.equal(font.glyphs.length, 128, `font ${number}`);
    assert.ok(font.lineHeight >= 6 && font.lineHeight <= 16, `font ${number}`);
  }
});

test('font 0 measures "TSN" wider than a single character', () => {
  const font = decodeFont(openCcWorld().get(RESOURCE_TYPE.FONT, 0));
  assert.ok(measureText(font, 'TSN') > measureText(font, 'T'));
});
