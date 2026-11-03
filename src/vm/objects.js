// LSCI object model (ground truth: PMachine send code at 0x7f7:0x144d and the
// object kernels in segment 0x1391 of the unpacked LSCITV.EXE).
//
// Object memory: uint16 properties[-size-], uint16 methodCount,
// uint16 selectors[methodCount], uint16 codeIds[methodCount].
// Property names: -dict- is the ID of the class propDict (a list of selector
// numbers, one per property). Methods are searched in the object, then along
// -super- (a class ID after loading; 0 ends the chain).
// Clones (ObjectNew) copy the properties only (method count := 0), set -super-
// to the original and -info- := (info & 0x7fff) | 1.
import { MEMORY_TYPE } from './memory.js';
import { OBJ } from './loader.js';

export const INFO_CLASS = 0x8000;
export const INFO_CLONE = 1;
const INFO_KIND_MASK = 3;
const NOT_FOUND = -1;

/**
 * @typedef {{ kind: 'property', offset: number } | { kind: 'method', codeId: number }
 *   | { kind: 'missing' }} SelectorTarget
 */

export class ObjectModel {
  /** @param {import('./memory.js').Memory} memory */
  constructor(memory) {
    this.memory = memory;
  }

  isObject(id) {
    return this.memory.isValid(id) && this.memory.typeOf(id) === MEMORY_TYPE.OBJECT;
  }

  propertyCount(id) {
    return this.memory.readWord(id, OBJ.SIZE);
  }

  /** Byte offset of the property named `selector`, or -1. */
  propertyOffset(id, selector) {
    const dict = this.memory.readWord(id, OBJ.DICT);
    if (!this.memory.isValid(dict)) {
      return NOT_FOUND;
    }
    const count = this.propertyCount(id);
    for (let i = 0; i < count; i++) {
      if (this.memory.readWord(dict, i * 2) === selector) {
        return i * 2;
      }
    }
    return NOT_FOUND;
  }

  /** Code ID of the method `selector` defined directly on `id`, or 0. */
  ownMethod(id, selector) {
    const table = this.propertyCount(id) * 2;
    const count = this.memory.readWord(id, table);
    for (let i = 0; i < count; i++) {
      if (this.memory.readWord(id, table + 2 + i * 2) === selector) {
        return this.memory.readWord(id, table + 2 + (count + i) * 2);
      }
    }
    return 0;
  }

  /** Method lookup along the -super- chain starting at `id`. */
  findMethod(id, selector) {
    let current = id;
    while (current && this.memory.isValid(current)) {
      const codeId = this.ownMethod(current, selector);
      if (codeId) {
        return codeId;
      }
      current = this.memory.readWord(current, OBJ.SUPER);
    }
    return 0;
  }

  /** @returns {SelectorTarget} */
  resolve(id, selector) {
    const offset = this.propertyOffset(id, selector);
    if (offset !== NOT_FOUND) {
      return { kind: 'property', offset };
    }
    const codeId = this.findMethod(id, selector);
    return codeId ? { kind: 'method', codeId } : { kind: 'missing' };
  }

  respondsTo(id, selector) {
    return this.isObject(id) && this.resolve(id, selector).kind !== 'missing';
  }

  getProperty(id, selector) {
    const offset = this.propertyOffset(id, selector);
    return offset === NOT_FOUND ? 0 : this.memory.readWord(id, offset);
  }

  setProperty(id, selector, value) {
    const offset = this.propertyOffset(id, selector);
    if (offset !== NOT_FOUND) {
      this.memory.writeWord(id, offset, value);
    }
  }

  clone(id) {
    const size = (this.propertyCount(id) + 1) * 2;
    const copy = this.memory.alloc(MEMORY_TYPE.OBJECT, this.memory.bytes(id).subarray(0, size));
    this.memory.writeWord(copy, OBJ.SUPER, id);
    const info = this.memory.readWord(copy, OBJ.INFO);
    this.memory.writeWord(copy, OBJ.INFO, (info & ~INFO_CLASS) | INFO_CLONE);
    this.memory.writeWord(copy, size - 2, 0);
    return copy;
  }

  /** ObjectFree only releases clones. */
  free(id) {
    if (this.isObject(id) && (this.memory.readWord(id, OBJ.INFO) & INFO_KIND_MASK) === INFO_CLONE) {
      this.memory.free(id);
    }
  }

  isClass(id) {
    return (this.memory.readWord(id, OBJ.INFO) & INFO_CLASS) !== 0;
  }
}
