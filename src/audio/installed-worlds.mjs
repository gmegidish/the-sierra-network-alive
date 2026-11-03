// Node only: the installed TSN worlds (CC root, LarryLand, SierraLand) as
// resource managers, a land layered over the root like TSNEXEC's pathStr = ..\
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResourceManager } from '../resource/resource-manager.js';
import { RESOURCE_TYPE } from '../resource/types.js';

export const INSTALL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'installed', 'TSN');
export const WORLDS = Object.freeze(['CC', 'LL', 'SL']);

function openDirectory(directory) {
  const path = (name) => join(INSTALL_DIR, directory, name);
  return createResourceManager({ map: readFileSync(path('RESOURCE.MAP')), volumes: { 1: readFileSync(path('RESOURCE.001')) } });
}

/** @param {'CC' | 'LL' | 'SL'} world */
export function openWorld(world) {
  const root = openDirectory('');
  if (world === 'CC') {
    return root;
  }
  const land = openDirectory(world);
  const pick = (type, number) => (land.has(type, number) ? land : root);
  return {
    has: (type, number) => land.has(type, number) || root.has(type, number),
    get: (type, number) => pick(type, number).get(type, number),
    list: () => land.list(),
  };
}

export function soundNumbersOf(resources) {
  return resources.list().filter((r) => r.type === RESOURCE_TYPE.SOUND).map((r) => r.number);
}
