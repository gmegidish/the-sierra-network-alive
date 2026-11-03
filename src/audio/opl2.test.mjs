import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Opl2, OPL_RATE } from './opl2.js';

const A440_FNUM = 580;
const A440_BLOCK = 4;
const FULL_SCALE = 4084;
const KEY_ON = 0x20;

/** Channel 0: silent modulator, full-level sine carrier with a fast attack. */
function chipWithSineOnChannelZero() {
  const chip = new Opl2();
  chip.write(0x01, 0x20);
  [[0x20, 0x01], [0x40, 0x3f], [0x60, 0xf0], [0x80, 0x0f]].forEach(([reg, value]) => chip.write(reg, value));
  [[0x23, 0x01], [0x43, 0x00], [0x63, 0xf4], [0x83, 0x05], [0xc0, 0x00]].forEach(([reg, value]) => chip.write(reg, value));
  return chip;
}

function pressKey(chip, on) {
  chip.write(0xa0, A440_FNUM & 0xff);
  chip.write(0xb0, (on ? KEY_ON : 0) | (A440_BLOCK << 2) | (A440_FNUM >> 8));
}

function runOneSecond(chip) {
  let crossings = 0;
  let peak = 0;
  let previous = 0;
  for (let i = 0; i < OPL_RATE; i += 1) {
    const sample = chip.generate();
    crossings += previous < 0 && sample >= 0 ? 1 : 0;
    peak = Math.max(peak, Math.abs(sample));
    previous = sample;
  }
  return { crossings, peak };
}

test('fnum 580 block 4 plays a 440 Hz sine at full scale', () => {
  const chip = chipWithSineOnChannelZero();
  pressKey(chip, true);
  const { crossings, peak } = runOneSecond(chip);
  assert.ok(Math.abs(crossings - 440) <= 2, `${crossings} Hz`);
  assert.ok(peak >= FULL_SCALE - 2 && peak <= FULL_SCALE + 2, `peak ${peak}`);
});

test('key off releases the note to silence', () => {
  const chip = chipWithSineOnChannelZero();
  pressKey(chip, true);
  runOneSecond(chip);
  pressKey(chip, false);
  runOneSecond(chip);
  assert.ok(runOneSecond(chip).peak < 16);
});

test('a chip that was never keyed on is silent', () => {
  assert.equal(runOneSecond(new Opl2()).peak, 0);
});

test('feedback on the modulator changes the waveform but keeps it bounded', () => {
  const chip = chipWithSineOnChannelZero();
  chip.write(0x40, 0x00);
  chip.write(0xc0, 0x0e);
  pressKey(chip, true);
  const { peak } = runOneSecond(chip);
  assert.ok(peak > 0 && peak <= FULL_SCALE + 2);
});
