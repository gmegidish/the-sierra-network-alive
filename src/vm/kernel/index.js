// Kernel dispatch table. Numbering = the far-pointer table at DS:0x107a of the
// unpacked LSCITV.EXE (names in src/resource/kernel-names.js). The EXE rejects
// kernel numbers above 88, yet scripts call 89-92: #89 (palette FindColor,
// args 5, r, g, b) from module 60007, #90 (1 arg) from 60045/60073, #91 (3 args)
// from 60022, #92 (1 arg) from 60023. They are appended as EXTRA_KERNELS;
// 90-92 are logged no-ops returning 0 until their purpose is known.
import { KERNEL_NAMES } from '../../resource/kernel-names.js';
import { objectKernels } from './objects.js';
import { arrayKernels } from './arrays.js';
import { listKernels } from './lists.js';
import { mathKernels } from './math.js';
import { systemKernels } from './system.js';
import { fileKernels } from './files.js';
import { graphicsKernels } from './graphics.js';
import { viewKernels } from './views.js';
import { textKernels } from './text.js';
import { eventKernels } from './events.js';
import { tsnKernels } from './tsn.js';
import { soundKernels } from './sound.js';

const EXTRA_KERNELS = Object.freeze(['Palette', 'Kernel90', 'Kernel91', 'Kernel92']);
const unknownKernel = () => 0;
const ALL_NAMES = Object.freeze([...KERNEL_NAMES, ...EXTRA_KERNELS]);

/**
 * @typedef {(vm: import('../vm.js').Vm, args: number[]) => (number | undefined)} KernelFunction
 */

const IMPLEMENTATIONS = Object.freeze({
  ...objectKernels,
  ...arrayKernels,
  ...listKernels,
  ...mathKernels,
  ...systemKernels,
  ...fileKernels,
  ...graphicsKernels,
  ...viewKernels,
  ...textKernels,
  ...eventKernels,
  ...tsnKernels,
  ...soundKernels,
  Kernel90: unknownKernel,
  Kernel91: unknownKernel,
  Kernel92: unknownKernel,
});

/** @returns {{ name: string, fn: KernelFunction | null }[]} */
export function buildKernelTable() {
  return ALL_NAMES.map((name) => ({ name, fn: IMPLEMENTATIONS[name] ?? null }));
}

/** Names of kernels without a real implementation. */
export function unimplementedKernels() {
  return ALL_NAMES.filter((name) => !IMPLEMENTATIONS[name]);
}
