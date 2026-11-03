import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoundSystem } from './sound-system.js';
import { SIGNAL_END, STATUS } from './sound-entry.js';
import { renderSound, waveformStats } from './offline-render.js';
import { openWorld } from './installed-worlds.mjs';

const SOUND = 1;
const MUSIC = 2;
const DEFAULTS = Object.freeze({ loop: 1, priority: 0, volume: 127, playBed: false });
const MINIMUM_RMS = 0.01;

function playOnFreshSystem(world, number, settings = {}) {
  const writes = [];
  const sink = { write: (tick, reg, value) => writes.push({ tick, reg, value }), playSample() {}, stopSample() {} };
  const system = new SoundSystem({ resources: openWorld(world), sink });
  system.init(SOUND, number, { ...DEFAULTS, ...settings });
  const entry = system.play(SOUND, { ...DEFAULTS, ...settings });
  return { system, entry, writes };
}

/** Advance tick by tick and record every change of the entry's signal. */
function signalTimeline(system, entry, ticks) {
  const timeline = [];
  let last = 0;
  for (let tick = 1; tick <= ticks; tick += 1) {
    system.advanceTo(tick);
    if (entry.signal !== last && entry.signal) {
      timeline.push([tick, entry.signal]);
    }
    last = entry.signal;
  }
  return timeline;
}

const keyOnWrites = (writes) => writes.filter((w) => w.reg >= 0xb0 && w.reg <= 0xb8 && (w.value & 0x20));

test('CC music 201 renders as audible, unclipped OPL2 audio', () => {
  const stats = waveformStats(renderSound({ resources: openWorld('CC'), number: 201, seconds: 10 }).samples);
  assert.ok(stats.rms > MINIMUM_RMS, `rms ${stats.rms}`);
  assert.ok(stats.nonSilent > 0.5);
  assert.equal(stats.clipped, 0);
});

test('CC sound 100 plays its 11 kHz digital sample instead of the FM track', () => {
  const result = renderSound({ resources: openWorld('CC'), number: 100, seconds: 2 });
  assert.ok(waveformStats(result.samples).peak > 0.1);
  assert.ok(result.ended);
});

test('LarryLand sound 512 raises cues 10, 20, 30 and then the end signal at fixed ticks', () => {
  const { system, entry } = playOnFreshSystem('LL', 512);
  assert.deepEqual(signalTimeline(system, entry, 500), [[240, 10], [367, 20], [418, 30], [448, SIGNAL_END]]);
});

test('playing a sound twice gives identical signal timing (no audio device involved)', () => {
  const first = playOnFreshSystem('LL', 512);
  const second = playOnFreshSystem('LL', 512);
  assert.deepEqual(signalTimeline(first.system, first.entry, 500), signalTimeline(second.system, second.entry, 500));
});

test('loop 2 plays the song twice before signalling the end', () => {
  const { system, entry } = playOnFreshSystem('CC', 505, { loop: 2 });
  const ends = signalTimeline(system, entry, 200).filter(([, signal]) => signal === SIGNAL_END);
  assert.deepEqual(ends.map(([tick]) => tick), [42]);
});

test('notes are keyed on through the AdLib driver once the sound starts', () => {
  const { system, writes } = playOnFreshSystem('CC', 201);
  system.advanceTo(60);
  assert.ok(keyOnWrites(writes).length > 0);
});

test('a fade to 0 with stop completes and stops the music', () => {
  const { system, entry } = playOnFreshSystem('CC', 201);
  system.advanceTo(10);
  entry.startFade(0, 1, 16, true);
  system.advanceTo(40);
  assert.equal(entry.volume, 0);
  assert.equal(entry.fadeCompleted, true);
});

test('pausing stops time for a sound and resuming continues it', () => {
  const { system, entry } = playOnFreshSystem('CC', 201);
  system.advanceTo(30);
  system.pause(SOUND, true);
  const pausedAt = entry.ticker;
  system.advanceTo(90);
  assert.equal(entry.ticker, pausedAt);
  system.pause(SOUND, false);
  system.advanceTo(100);
  assert.ok(entry.ticker > pausedAt);
});

test('a second song takes free device channels instead of evicting the first', () => {
  const { system } = playOnFreshSystem('CC', 201);
  system.init(MUSIC, 504, DEFAULTS);
  system.play(MUSIC, DEFAULTS);
  const owners = new Set(system.deviceMap.filter(Boolean).map((slot) => slot.entry.object));
  assert.deepEqual([...owners].sort(), [SOUND, MUSIC]);
});

test('stopping a sound releases its device channels', () => {
  const { system } = playOnFreshSystem('CC', 201);
  system.stop(SOUND);
  assert.equal(system.entry(SOUND).status, STATUS.STOPPED);
  assert.ok(system.deviceMap.every((slot) => slot === null));
});
