// Shared helpers for the resource tests (Node only; reads the original disk files).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResourceManager } from './resource-manager.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GAME_DIR = join(ROOT, 'disk', '1');
export const CC_PATCH_FILE = join(ROOT, 'disk', '4', 'CCPATCH', '130.SO');

export function readGameFile(name) {
  return readFileSync(join(GAME_DIR, name));
}

export function readCcPatch() {
  return { name: '130.SO', bytes: readFileSync(CC_PATCH_FILE) };
}

export function openCcWorld({ withPatches = true } = {}) {
  return createResourceManager({
    map: readGameFile('RESOURCE.MAP'),
    volumes: { 1: readGameFile('RESOURCE.001') },
    patches: withPatches ? [readCcPatch()] : [],
  });
}

export function resourcesOfType(rm, type) {
  return rm.list().filter((r) => r.type === type);
}

export function countDistinctValues(values) {
  return new Set(values).size;
}
