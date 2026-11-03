// Node-side helpers: build a VM from the installed INN tree on disk.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInstallVm } from './programs.js';

const MAX_FILE_SIZE = 4 * 1024 * 1024;
const LAND_MARKER = 'RESOURCE.MAP';
const DIRECTORY_MARKER = '.';

/**
 * The files the LSCI worlds use, like tools/make-manifest.mjs: the root files,
 * every file of a directory with a RESOURCE.MAP (CC, LL, SL), and a marker for
 * every other directory (the DOS games are not loaded).
 * @param {string} root @returns {Map<string, Uint8Array>} relative path -> bytes
 */
export function readTree(root) {
  const files = new Map();
  const add = (relative) => files.set(relative, readFileSync(join(root, relative)));
  const isSmallFile = (relative) => statSync(join(root, relative)).isFile() && statSync(join(root, relative)).size <= MAX_FILE_SIZE;
  for (const name of readdirSync(root)) {
    if (!statSync(join(root, name)).isDirectory()) {
      if (isSmallFile(name)) {
        add(name);
      }
      continue;
    }
    files.set(`${name}/${DIRECTORY_MARKER}`, new Uint8Array(0));
    if (existsSync(join(root, name, LAND_MARKER))) {
      readdirSync(join(root, name)).map((file) => `${name}/${file}`).filter(isSmallFile).forEach(add);
    }
  }
  return files;
}

/**
 * @param {string} root installed/INN directory
 * @param {Omit<import('./vm.js').VmOptions, 'resources' | 'files'>} [options]
 */
export function createVmFromDirectory(root, options = {}) {
  return createInstallVm(readTree(root), options);
}
