#!/usr/bin/env node
// Render a TSN sound resource to a WAV file with the AdLib (OPL2) emulator,
// no audio device needed. Writes out/sound/<world>-<number>.wav and prints
// waveform stats (peak, RMS, non-silent fraction, clipped samples).
// Usage: node tools/render-sound.mjs [world=CC|LL|SL] [number|all] [seconds=30] [loops=1]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWorld, soundNumbersOf } from '../src/audio/installed-worlds.mjs';
import { renderSound, waveformStats, encodeWav } from '../src/audio/offline-render.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'out', 'sound');

function renderOne(resources, world, number, seconds, loops) {
  const result = renderSound({ resources, number, seconds, loop: loops });
  const stats = waveformStats(result.samples);
  const file = join(OUT_DIR, `${world.toLowerCase()}-${number}.wav`);
  writeFileSync(file, encodeWav(result.samples, result.rate));
  const signals = result.signals.map((s) => `${s.signal}@${s.tick}`).join(' ');
  process.stdout.write(`${file}  ${(result.ticks / 60).toFixed(1)}s ended=${result.ended} peak=${stats.peak.toFixed(3)} `
    + `rms=${stats.rms.toFixed(4)} nonSilent=${(stats.nonSilent * 100).toFixed(0)}% clipped=${stats.clipped}`
    + `${signals ? ` signals=${signals}` : ''}\n`);
}

function main() {
  const [world = 'CC', which = 'all', seconds = '30', loops = '1'] = process.argv.slice(2);
  const resources = openWorld(world.toUpperCase());
  mkdirSync(OUT_DIR, { recursive: true });
  const numbers = which === 'all' ? soundNumbersOf(resources) : [Number(which)];
  numbers.forEach((number) => renderOne(resources, world.toUpperCase(), number, Number(seconds), Number(loops)));
}

main();
