// LSCI module loader and class table.
//
// Ground truth: segment 0x27b of the unpacked LSCITV.EXE.
//  - loadModule (0x27b:0x3d) allocates a 12-byte environment record (type 13):
//      +0 module number, +2 block count, +4 ID of the block-ID list,
//      +6 dispatch (exports) ID, +8 variables ID, +10 kind-10 block ID
//  - every block ID is reserved up front so fixups can reference any block,
//    then each block is copied into its own memory ID (0x27b:0x220);
//  - object/class blocks are initialised (0x27b:0x3ce): -env- := env ID,
//    -super- := class ID of the superclass number (0xffff -> 0, loading its
//    module on demand); a class registers itself in the class table under its
//    -dict- number and then -dict- := ID of the following propDict block; an
//    instance copies -dict- from its class;
//  - class blocks (kind 3) are stored as type 2 (object);
//  - fixups are applied to every kind except 7 (string), 8 and 10.
// The class table comes from vocab.996: one {uint16 ID, uint16 module} per class.
import { parseModule, BLOCK_KIND, RESOURCE_TYPE, decodeClassTable } from '../resource/index.js';
import { MEMORY_TYPE } from './memory.js';

export const ENV = Object.freeze({
  MODULE: 0,
  BLOCK_COUNT: 2,
  BLOCK_LIST: 4,
  DISPATCH: 6,
  VARIABLES: 8,
  KIND10: 10,
  SIZE: 12,
});

export const OBJ = Object.freeze({
  ENV: 0,
  SIZE: 2,
  DICT: 4,
  SUPER: 6,
  INFO: 8,
  NAME: 10,
});

const CLASS_TABLE_VOCAB = 996;
const NO_CLASS = 0xffff;
const KIND_WITHOUT_FIXUPS = new Set([BLOCK_KIND.STRING, 8, MEMORY_TYPE.KIND10]);
const ENV_SLOT_FOR_KIND = Object.freeze({
  [BLOCK_KIND.VARIABLES]: ENV.VARIABLES,
  [BLOCK_KIND.DISPATCH]: ENV.DISPATCH,
  [MEMORY_TYPE.KIND10]: ENV.KIND10,
});

export class ModuleLoader {
  /**
   * @param {import('./memory.js').Memory} memory
   * @param {{ get(type: number, number: number): Uint8Array, has(type: number, number: number): boolean }} resources
   */
  constructor(memory, resources) {
    this.memory = memory;
    this.resources = resources;
    /** @type {{ id: number, module: number }[]} */
    this.classes = decodeClassTable(resources.get(RESOURCE_TYPE.VOCAB, CLASS_TABLE_VOCAB))
      .map((module) => ({ id: 0, module }));
    /** @type {Map<number, number>} module number -> env ID */
    this.loaded = new Map();
    /** @type {Map<number, number[]>} module number -> block IDs */
    this.blockIds = new Map();
  }

  /** @returns {number} env ID of the (possibly already loaded) module */
  load(number) {
    const existing = this.loaded.get(number);
    if (existing !== undefined) {
      return existing;
    }
    if (!this.resources.has(RESOURCE_TYPE.MODULE, number)) {
      throw new Error(`loader: module ${number} not found`);
    }
    const { blocks } = parseModule(this.resources.get(RESOURCE_TYPE.MODULE, number));
    const env = this.memory.alloc(MEMORY_TYPE.ENV, ENV.SIZE);
    this.memory.writeWord(env, ENV.MODULE, number);
    this.memory.writeWord(env, ENV.BLOCK_COUNT, blocks.length);
    const ids = blocks.map(() => this.memory.reserve());
    this.loaded.set(number, env);
    this.blockIds.set(number, ids);
    blocks.forEach((block, index) => this.loadBlock(env, block, ids, index));
    return env;
  }

  loadBlock(env, block, ids, index) {
    const id = ids[index];
    this.memory.assign(id, block.kind, block.data);
    if (block.kind === BLOCK_KIND.OBJECT || block.kind === BLOCK_KIND.CLASS) {
      this.initObject(id, env, ids[index + 1], block.kind);
    }
    const slot = ENV_SLOT_FOR_KIND[block.kind];
    if (slot !== undefined) {
      this.memory.writeWord(env, slot, id);
    }
    if (block.kind === BLOCK_KIND.CLASS) {
      this.memory.setType(id, MEMORY_TYPE.OBJECT);
    }
    if (!KIND_WITHOUT_FIXUPS.has(block.kind)) {
      for (const offset of block.fixups) {
        this.memory.writeWord(id, offset, ids[this.memory.readWord(id, offset)] ?? 0);
      }
    }
  }

  initObject(id, env, nextBlockId, kind) {
    const isClass = kind === BLOCK_KIND.CLASS;
    if (isClass) {
      const number = this.memory.readWord(id, OBJ.DICT);
      if (this.classes[number]) {
        this.classes[number].id = id;
      }
    }
    const superId = this.classId(this.memory.readWord(id, OBJ.SUPER));
    this.memory.writeWord(id, OBJ.SUPER, superId);
    this.memory.writeWord(id, OBJ.ENV, env);
    const dict = isClass ? nextBlockId : this.memory.readWord(superId, OBJ.DICT);
    this.memory.writeWord(id, OBJ.DICT, dict);
  }

  /** Class number -> class object ID, loading the class's module if needed. */
  classId(number) {
    if (number === NO_CLASS) {
      return 0;
    }
    const entry = this.classes[number];
    if (!entry) {
      throw new Error(`loader: unknown class ${number}`);
    }
    if (entry.id === 0) {
      this.load(entry.module);
    }
    return entry.id;
  }

  /** Export `entry` of `module` (ModuleID / callb / calle). */
  exportOf(module, entry) {
    const env = this.load(module);
    const dispatch = this.memory.readWord(env, ENV.DISPATCH);
    if (!dispatch || this.memory.readWord(dispatch, 0) < entry) {
      throw new Error(`loader: module ${module} has no export ${entry}`);
    }
    return this.memory.readWord(dispatch, 2 + entry * 2);
  }

  variablesOf(module) {
    return this.memory.readWord(this.load(module), ENV.VARIABLES);
  }

  /** ModuleDispose: free every block of a module and forget its classes. */
  dispose(number) {
    const env = this.loaded.get(number);
    if (env === undefined) {
      return;
    }
    for (const entry of this.classes) {
      if (entry.module === number) {
        entry.id = 0;
      }
    }
    for (const id of this.blockIds.get(number)) {
      this.memory.free(id);
    }
    this.memory.free(env);
    this.loaded.delete(number);
    this.blockIds.delete(number);
  }

  /** Module number owning an env ID (or -1). */
  moduleOfEnv(env) {
    for (const [number, id] of this.loaded) {
      if (id === env) {
        return number;
      }
    }
    return -1;
  }
}
