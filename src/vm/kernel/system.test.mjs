import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemKernels } from './system.js';

const MODE_DOS_TIME = 2;
const MODE_DOS_DATE = 3;

function machineFrozenAt(date) {
  return { now: () => date.getTime(), ticks: () => 4920 };
}

function askTime(date, mode) {
  return systemKernels.GetTime(machineFrozenAt(date), mode === undefined ? [] : [mode]);
}

function unpackDosTime(packed) {
  return { hours: packed >> 11, minutes: (packed >> 5) & 63, seconds: (packed & 31) * 2 };
}

function unpackDosDate(packed) {
  return { year: (packed >> 9) + 1980, month: (packed >> 5) & 15, day: packed & 31 };
}

test('the LarryLand clock (GetTime 2) shows the local wall-clock time, not elapsed ticks', () => {
  const lateEvening = new Date(2026, 10, 3, 19, 51, 14);
  assert.deepEqual(unpackDosTime(askTime(lateEvening, MODE_DOS_TIME)), { hours: 19, minutes: 51, seconds: 14 });
});

test('GetTime 3 returns the local date in DOS packed format', () => {
  const day = new Date(2026, 10, 3, 7, 0, 0);
  assert.deepEqual(unpackDosDate(askTime(day, MODE_DOS_DATE)), { year: 2026, month: 11, day: 3 });
});

test('GetTime with no mode still returns the tick counter', () => {
  assert.equal(askTime(new Date(), undefined), 4920);
});
