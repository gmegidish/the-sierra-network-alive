// Resource manager for the root (CC) world of an install tree, shared by the
// Node loader and the browser front end. `files` maps install-relative paths
// (forward slashes) to bytes; NNN.SO / NNN.SCR files in the root are patches.
import { createResourceManager } from '../resource/index.js';

const PATCH_PATTERN = /^\d+\.(SO|SCR)$/i;

/** @param {Map<string, Uint8Array>} files */
export function createRootResources(files) {
  const get = (name) => files.get(name);
  const patches = [...files.keys()]
    .filter((name) => !name.includes('/') && PATCH_PATTERN.test(name))
    .map((name) => ({ name, bytes: get(name) }));
  return createResourceManager({ map: get('RESOURCE.MAP'), volumes: { 1: get('RESOURCE.001') }, patches });
}
