// Node only: the installed INN worlds (Clubhouse CC, CasinoLand LL,
// SierraLand SL) as resource managers, each world's map over its own
// RESOURCE.001 and the shared root RESOURCE.002 (with the world's patches).
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTree } from '../vm/node-loader.mjs';
import { FileSystem } from '../vm/filesystem.js';
import { createProgramResources } from '../vm/programs.js';
import { RESOURCE_TYPE } from '../resource/types.js';

export const INSTALL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'installed', 'INN');
export const WORLDS = Object.freeze(['CC', 'LL', 'SL']);

/** @param {'CC' | 'LL' | 'SL'} world */
export function openWorld(world) {
  return createProgramResources(new FileSystem(readTree(INSTALL_DIR)), world);
}

export function soundNumbersOf(resources) {
  return resources.list().filter((r) => r.type === RESOURCE_TYPE.SOUND).map((r) => r.number);
}
