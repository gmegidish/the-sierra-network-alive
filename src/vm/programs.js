// TSNEXEC program chaining. TSN(9, name) picks the next program from
// TSN.PRG ("program LLand / cd LL / ..\lscitv.exe"); the interpreter then
// quits and TSNEXEC starts LSCITV again in that directory. Here the front end
// calls nextProgramVm() when a VM halts: same files, same host connection,
// same shared buffer (TSN 1/2), new resources and current directory.
import { createResourceManager } from '../resource/index.js';
import { Vm } from './vm.js';

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

/** NNN.SO / NNN.SCR patch files directly in `fs`'s current directory. */
function patchesIn(fs) {
  return fs.list('*').filter((name) => !name.includes('\\') && PATCH_PATTERN.test(name))
    .map((name) => ({ name, bytes: fs.read(name) }));
}

/** @param {import('./filesystem.js').FileSystem} fs a view of one directory */
function directoryResources(fs) {
  return createResourceManager({ map: fs.read('RESOURCE.MAP'), volumes: { 1: fs.read('RESOURCE.001') }, patches: patchesIn(fs) });
}

/**
 * Resources of a program directory with the install root behind it, like
 * LSCI.CFG "pathStr = ..\": a resource missing from the land falls back to the root.
 * @param {import('./filesystem.js').FileSystem} fs @param {string} directory
 */
export function createProgramResources(fs, directory) {
  const root = directoryResources(fs.inDirectory(''));
  if (!directory) {
    return root;
  }
  const land = directoryResources(fs.inDirectory(directory));
  const pick = (type, number) => (land.has(type, number) ? land : root);
  const list = () => {
    const seen = new Set(land.list().map((info) => `${info.type}.${info.number}`));
    return [...land.list(), ...root.list().filter((info) => !seen.has(`${info.type}.${info.number}`))];
  };
  return Object.freeze({
    list,
    has: (type, number) => land.has(type, number) || root.has(type, number),
    info: (type, number) => pick(type, number).info(type, number),
    get: (type, number) => pick(type, number).get(type, number),
  });
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
