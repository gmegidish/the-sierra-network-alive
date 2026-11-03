// Render a sound resource to PCM without an audio device, through the same
// SoundSystem, AdLib driver and OPL2 emulator the browser uses.
// Used by tools/render-sound.mjs and the audio tests.
import { SoundSystem } from './sound-system.js';
import { OplRenderer } from './opl-renderer.js';
import { STATUS } from './sound-entry.js';

const TICKS_PER_SECOND = 60;
const DEFAULT_RATE = 22050;
const SOUND_OBJECT = 1;
const TAIL_TICKS = 30;

/**
 * @typedef {{ resources: import('./sound-system.js').Resources, number: number, seconds?: number,
 *   rate?: number, loop?: number }} RenderOptions
 * @typedef {{ samples: Float32Array, rate: number, ticks: number, ended: boolean, signals: { tick: number, signal: number }[] }} RenderResult
 */

/** Sink that applies writes straight to an OplRenderer (the caller renders tick by tick). */
export function createDirectSink(renderer) {
  return {
    write: (_tick, reg, value) => renderer.write(reg, value),
    playSample: (_tick, id, sample, loops, volume) => renderer.playSample(id, sample.samples, sample.rate, loops, volume),
    stopSample: (_tick, id) => renderer.stopSample(id),
  };
}

/** @param {RenderOptions} options @returns {RenderResult} */
export function renderSound({ resources, number, seconds = 30, rate = DEFAULT_RATE, loop = 1 }) {
  const renderer = new OplRenderer(rate);
  const system = new SoundSystem({ resources, sink: createDirectSink(renderer) });
  system.init(SOUND_OBJECT, number, { loop, priority: 0, volume: 127 });
  const entry = system.play(SOUND_OBJECT, { loop, priority: 0, volume: 127, playBed: false });
  const maxTicks = Math.round(seconds * TICKS_PER_SECOND);
  const samples = new Float32Array(Math.ceil((maxTicks * rate) / TICKS_PER_SECOND) + rate);
  const signals = [];
  let written = 0;
  let endedAt = -1;
  let lastSignal = 0;
  for (let tick = 0; tick < maxTicks; tick += 1) {
    system.advanceTo(tick + 1);
    if (entry.signal && entry.signal !== lastSignal) {
      signals.push({ tick, signal: entry.signal });
    }
    lastSignal = entry.signal;
    const done = entry.finished || entry.status === STATUS.STOPPED || (entry.isSample && entry.isSampleDone());
    if (done && endedAt === -1) {
      endedAt = tick;
    }
    const until = Math.floor(((tick + 1) * rate) / TICKS_PER_SECOND);
    renderer.render(samples, written, until - written);
    written = until;
    if (endedAt !== -1 && tick - endedAt >= TAIL_TICKS) {
      break;
    }
  }
  return { samples: samples.subarray(0, written), rate, ticks: Math.round((written * TICKS_PER_SECOND) / rate), ended: endedAt !== -1, signals };
}

/** Peak, RMS, fraction of non-silent samples and clipped sample count. */
export function waveformStats(samples) {
  const SILENCE = 1 / 1024;
  let peak = 0;
  let sumSquares = 0;
  let loud = 0;
  let clipped = 0;
  for (const value of samples) {
    const magnitude = Math.abs(value);
    peak = Math.max(peak, magnitude);
    sumSquares += value * value;
    loud += magnitude > SILENCE ? 1 : 0;
    clipped += magnitude >= 1 ? 1 : 0;
  }
  const count = Math.max(1, samples.length);
  return { peak, rms: Math.sqrt(sumSquares / count), nonSilent: loud / count, clipped };
}

/** 16-bit mono PCM WAV file bytes. */
export function encodeWav(samples, rate) {
  const HEADER = 44;
  const bytes = new Uint8Array(HEADER + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, i) => view.setInt16(HEADER + i * 2, Math.round(value * 32767), true));
  return bytes;
}
