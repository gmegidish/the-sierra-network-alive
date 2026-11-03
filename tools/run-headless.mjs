#!/usr/bin/env node
// Run the LSCI VM headless on the installed CC world.
// Usage: node tools/run-headless.mjs [frames=600] [instructionsPerFrame=20000] [screenshotEvery=60] [input]
// input: semicolon-separated "frame@x,y" (mouse click), "frame@key:code"
// (key press) or "frame@text:abc" (typed text), e.g. "650@282,66;900@key:13".
// SEED=n picks the Random kernel seed (default 1), so runs repeat exactly.
// Writes out/run/frameNNNN.png, out/run/kernels.txt, out/run/log.txt, out/run/tsn.txt.
// Virtual time: every frame advances the clock by 1/60 s.
import { writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVmFromDirectory } from '../src/vm/node-loader.mjs';
import { nextProgramVm } from '../src/vm/programs.js';
import { EVENT_TYPE } from '../src/vm/events.js';
import { encodePng } from './png.mjs';
import { drawCursor } from '../src/gfx/cursor.js';
import { createRandom } from '../src/vm/random.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_DIR = join(ROOT, 'installed', 'INN');
const OUT_DIR = join(ROOT, 'out', 'run');
const MS_PER_FRAME = 1000 / 60;

/** Random kernel seed; override with SEED=n for a different (still repeatable) run. */
const DEFAULT_SEED = 1;

function parseArgs() {
  const [frames = '600', budget = '20000', every = '60', input = ''] = process.argv.slice(2);
  return { frames: Number(frames), budget: Number(budget), every: Number(every), input: parseInput(input) };
}

/** @returns {Map<number, string[]>} frame -> actions */
function parseInput(text) {
  const byFrame = new Map();
  for (const item of text.split(';').filter(Boolean)) {
    const [frame, action] = item.split('@');
    byFrame.set(Number(frame), [...(byFrame.get(Number(frame)) ?? []), action]);
  }
  return byFrame;
}

function pressKey(vm, message) {
  vm.events.push({ type: EVENT_TYPE.KEY_DOWN, message });
  vm.events.push({ type: EVENT_TYPE.KEY_UP, message });
}

function injectInput(vm, actions = []) {
  for (const action of actions) {
    if (action.startsWith('text:')) {
      [...action.slice('text:'.length)].forEach((ch) => pressKey(vm, ch.charCodeAt(0)));
      continue;
    }
    if (action.startsWith('key:')) {
      const message = Number(action.slice('key:'.length));
      vm.events.push({ type: EVENT_TYPE.KEY_DOWN, message });
      vm.events.push({ type: EVENT_TYPE.KEY_UP, message });
      continue;
    }
    const [x, y] = action.split(',').map(Number);
    vm.events.push({ type: EVENT_TYPE.MOUSE_DOWN, message: 0, x, y });
    vm.events.push({ type: EVENT_TYPE.MOUSE_UP, message: 0, x, y });
  }
}

function saveScreenshot(vm, frame) {
  const { width, height, rgba } = vm.screen.toRgba();
  drawCursor(vm.graphics, vm.cursor, vm.events.mouse, rgba);
  writeFileSync(join(OUT_DIR, `frame${String(frame).padStart(4, '0')}.png`), encodePng(width, height, rgba));
}

function writeReports(vm, frame) {
  writeFileSync(join(OUT_DIR, 'kernels.txt'), `${vm.trace.kernelReport()}\n`);
  writeFileSync(join(OUT_DIR, 'log.txt'), `${vm.trace.lines.join('\n')}\n`);
  writeFileSync(join(OUT_DIR, 'tsn.txt'), `${vm.server.report()}\n`);
  writeFileSync(join(OUT_DIR, 'stack.txt'), `frame ${frame}\n${describeFrames(vm).join('\n')}\nrecent kernels:\n${vm.trace.recentCalls.join('\n')}\n`);
}

function describeFrames(vm) {
  return vm.interp.frames.map((f) => {
    if (f.type === 'send') {
      return `send to $${f.lookup.toString(16)} ${vm.interp.objectName(f.lookup)}`;
    }
    const owner = vm.memory.isValid(f.self) ? vm.interp.objectName(f.self) : '-';
    return `code $${f.codeId.toString(16)} pc ${f.pc.toString(16)} self ${owner}`;
  });
}

/** TSNEXEC: when the interpreter quit after TSN(9, program), boot that program. */
function chainIfQuit(vm, options, frame) {
  if (!vm.interp.halted) {
    return vm;
  }
  const next = nextProgramVm(vm, options);
  if (!next) {
    return vm;
  }
  writeFileSync(join(OUT_DIR, `program-${frame}.txt`), `${vm.tsnProgram} (${next.program.directory || 'root'})\n`);
  next.trace.recordCalls = true;
  next.boot();
  return next;
}

/** Delete frameNNNN.png from earlier runs; other files in out/run are kept. */
function removeOldFrames() {
  readdirSync(OUT_DIR).filter((name) => /^frame\d+\.png$/.test(name)).forEach((name) => rmSync(join(OUT_DIR, name)));
}

function main() {
  const { frames, budget, every, input } = parseArgs();
  mkdirSync(OUT_DIR, { recursive: true });
  removeOldFrames();
  let clock = Date.UTC(1993, 0, 15, 20); // headless wall clock: a 1993 evening (DOS dates start in 1980)
  const seen = new Set();
  const options = {
    now: () => clock,
    random: createRandom(Number(process.env.SEED ?? DEFAULT_SEED)),
    onLog: (kind, message) => {
      if (kind === 'error' && !seen.has(message)) {
        seen.add(message);
        process.stderr.write(`[${kind}] ${message}\n`);
      }
    },
  };
  let vm = createVmFromDirectory(INSTALL_DIR, options);
  vm.trace.recordCalls = true;
  vm.boot();
  let frame = 0;
  try {
    for (; frame < frames && !(vm.interp.halted && !vm.tsnProgram); frame++) {
      vm = chainIfQuit(vm, options, frame);
      injectInput(vm, input.get(frame));
      vm.runSlice(budget);
      vm.graphics.present?.();
      clock += MS_PER_FRAME;
      if (frame % every === 0) {
        saveScreenshot(vm, frame);
      }
    }
  } catch (error) {
    process.stderr.write(`VM exception at frame ${frame}: ${error.stack}\n`);
    vm.trace.log('exception', error.stack);
  }
  saveScreenshot(vm, frame);
  writeReports(vm, frame);
  process.stdout.write(`ran ${frame} frames, ${vm.interp.instructionCount} instructions, halted=${vm.interp.halted}, errors=${vm.trace.errorCount}\n`);
}

main();
