// TSNEXEC program chaining. TSN(9, name) picks the next program from
// TSN.PRG ("program LLand / cd LL / ..\lscitv.exe"); the interpreter then
// quits and TSNEXEC starts LSCITV again in that directory. Here the front end
// calls nextProgramVm() when a VM halts: same files, same host connection,
// same shared buffer (TSN 1/2), new resources and current directory.
import { createResourceManager } from '../resource/index.js';
import { Vm } from './vm.js';
import { FileSystem } from './filesystem.js';

/**
 * @typedef {Object} Program
 * @property {string} name  as written in TSN.PRG
 * @property {string} directory  install-relative, '' for the root
 */

const PROGRAM_FILE = 'TSN.PRG';
const PATCH_PATTERN = /^\d+\.(SO|SCR)$/i;
const PROGRAM_LINE = /^\s*program\s+(\S+)/i;
const CD_LINE = /^\s*cd\s+(\S+)/i;

/** @param {string} text TSN.PRG @returns {Map<string, Program>} keyed by upper-case name */
export function parseProgramFile(text) {
  const programs = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const start = PROGRAM_LINE.exec(line);
    if (start) {
      current = { name: start[1], directory: '' };
      programs.set(current.name.toUpperCase(), current);
      continue;
    }
    const cd = CD_LINE.exec(line);
    if (cd && current) {
      current.directory = cd[1];
    }
  }
  return programs;
}

/** @param {import('./filesystem.js').FileSystem} fs @param {string} name @returns {Program | null} */
export function findProgram(fs, name) {
  const text = fs.inDirectory('').readText(PROGRAM_FILE);
  if (!text) {
    return null;
  }
  return parseProgramFile(text).get(name.toUpperCase()) ?? null;
}

const MAP_FILE = 'RESOURCE.MAP';
/** Each world's map indexes volume 1 (its own RESOURCE.001) and volume 2 (the shared root RESOURCE.002). */
const LOCAL_VOLUME = 'RESOURCE.001';
const SHARED_VOLUME = 'RESOURCE.002';
/** TSNEXEC runs this program first (the Clubhouse, cd CC). */
export const DEFAULT_PROGRAM = 'DEFAULT';

/** Compiled NNN.SO / NNN.SCR patches directly in `fs`'s current directory (sources like 913.SO are skipped by the parser). */
function patchesIn(fs) {
  return fs.list('*').filter((name) => !name.includes('\\') && PATCH_PATTERN.test(name))
    .map((name) => ({ name, bytes: fs.read(name) }));
}

/**
 * Resources of a program directory, like LSCI.CFG "resource = .\;..\": the
 * directory's map over its RESOURCE.001 and the root's RESOURCE.002, with
 * patches from the directory first, then the root.
 * @param {import('./filesystem.js').FileSystem} fs @param {string} directory
 */
export function createProgramResources(fs, directory) {
  const root = fs.inDirectory('');
  const world = fs.inDirectory(directory);
  return createResourceManager({
    map: world.read(MAP_FILE),
    volumes: { 1: world.read(LOCAL_VOLUME), 2: root.read(SHARED_VOLUME) },
    patches: [...patchesIn(root), ...patchesIn(world)],
  });
}

/**
 * The first VM TSNEXEC starts: program DEFAULT of TSN.PRG.
 * @param {Map<string, Uint8Array>} files install-relative paths -> bytes
 * @param {Omit<import('./vm.js').VmOptions, 'resources' | 'files'>} [options]
 * @returns {Vm}
 */
export function createInstallVm(files, options = {}) {
  const root = new FileSystem(files);
  const program = findProgram(root, DEFAULT_PROGRAM);
  if (!program) {
    throw new Error(`${PROGRAM_FILE} has no program ${DEFAULT_PROGRAM}`);
  }
  const vm = new Vm({ ...options, resources: createProgramResources(root, program.directory), fileSystem: root.inDirectory(program.directory) });
  vm.program = program;
  return vm;
}

/**
 * The VM TSNEXEC would start after `vm` quits, or null when no program was chosen.
 * @param {Vm} vm a halted VM
 * @param {Omit<import('./vm.js').VmOptions, 'resources' | 'files'>} [options]
 * @returns {Vm | null}
 */
export function nextProgramVm(vm, options = {}) {
  const program = vm.tsnProgram ? findProgram(vm.fs, vm.tsnProgram) : null;
  if (!program) {
    return null;
  }
  const fs = vm.fs.inDirectory(program.directory);
  const next = new Vm({
    now: vm.now, random: vm.random, ...options, resources: createProgramResources(vm.fs, program.directory), fileSystem: fs, server: vm.server,
  });
  next.tsnBuffer = vm.tsnBuffer;
  next.program = program;
  return next;
}
