// Node-side helpers: build a VM from the installed TSN tree on disk.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRootResources } from './root-resources.js';
import { Vm } from './vm.js';

const MAX_FILE_SIZE = 4 * 1024 * 1024;

/** Every file under `root` (relative path -> bytes), skipping huge files. */
export function readTree(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = statSync(path);
      if (info.isDirectory()) {
        walk(path);
      } else if (info.size <= MAX_FILE_SIZE) {
        files.set(relative(root, path), readFileSync(path));
      }
    }
  };
  walk(root);
  return files;
}

export { createRootResources };

/**
 * @param {string} root installed/TSN directory
 * @param {Omit<import('./vm.js').VmOptions, 'resources' | 'files'>} [options]
 */
export function createVmFromDirectory(root, options = {}) {
  const files = readTree(root);
  return new Vm({ ...options, resources: createRootResources(files), files });
}
