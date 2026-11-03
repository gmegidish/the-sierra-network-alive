// LSCI memory manager.
//
// LSCITV.EXE keeps every loaded block and every runtime object in its own
// "memory ID": a table at DS:0x2690 holds 4-byte entries {uint16 segment,
// uint8 type, uint8 flags}, indexed by the ID itself, so IDs are multiples of
// 4. The allocator (segment 0x0de of the unpacked image) hands out the lowest
// free ID starting at 4; IsObject accepts `id != 0 && id % 4 == 0 && type == 2`
// and the object search loop stops at 0x3ffc.
//
// Types are the module block kinds (2 object, 4 code, 6 variables, 7 string,
// 9 dispatch, 11 propDict) plus runtime kinds seen in the EXE: 13 module
// environment, 0x13 word/byte array, 0x15 ID array (kArray new). Strings are
// byte arrays: {uint16 elementSize = 1, uint16 capacity, bytes...}.

export const MEMORY_TYPE = Object.freeze({
  OBJECT: 2,
  CODE: 4,
  VARIABLES: 6,
  STRING: 7,
  DISPATCH: 9,
  KIND10: 10,
  PROPDICT: 11,
  ENV: 13,
  ID_LIST: 14,
  ARRAY: 0x13,
  ID_ARRAY: 0x15,
  LIST: 0x20,
  NODE: 0x21,
  BLOCK: 0x22,
});

export const ID_STEP = 4;
export const FIRST_ID = 4;
export const LAST_ID = 0x3ffc;
const WORD_MASK = 0xffff;

/**
 * @typedef {{ type: number, bytes: Uint8Array, data?: any }} MemoryEntry
 * `data` carries JS-side state for runtime kinds (lists, nodes).
 */

export class Memory {
  constructor() {
    /** @type {((id: number, access: string) => void) | null} */
    this.onInvalidAccess = null;
    /** @type {Map<number, MemoryEntry>} */
    this.entries = new Map();
    /** @type {Map<number, Uint8Array>} contents of freed IDs, until reused */
    this.stale = new Map();
    this.lowestFree = FIRST_ID;
  }

  /** Reserve an ID without memory (the loader pre-allocates block IDs). */
  reserve() {
    let id = this.lowestFree;
    while (this.entries.has(id)) {
      id += ID_STEP;
    }
    if (id > LAST_ID) {
      throw new Error('memory: out of IDs');
    }
    this.entries.set(id, { type: 0, bytes: new Uint8Array(0) });
    this.stale.delete(id);
    this.lowestFree = id + ID_STEP;
    return id;
  }

  /**
   * @param {number} type
   * @param {number | Uint8Array} sizeOrBytes byte count, or initial contents (copied)
   * @returns {number} the new ID
   */
  alloc(type, sizeOrBytes) {
    const id = this.reserve();
    this.assign(id, type, sizeOrBytes);
    return id;
  }

  /** Give a reserved ID its memory. */
  assign(id, type, sizeOrBytes) {
    const bytes = typeof sizeOrBytes === 'number' ? new Uint8Array(sizeOrBytes) : Uint8Array.from(sizeOrBytes);
    this.entries.set(id, { type, bytes });
    return id;
  }

  free(id) {
    if (!this.entries.has(id)) {
      return;
    }
    this.stale.set(id, this.entries.get(id).bytes);
    this.entries.delete(id);
    if (id < this.lowestFree) {
      this.lowestFree = id;
    }
  }

  isValid(id) {
    return id !== 0 && id % ID_STEP === 0 && this.entries.has(id);
  }

  /** @returns {MemoryEntry | undefined} */
  get(id) {
    return this.entries.get(id);
  }

  typeOf(id) {
    return this.entries.get(id)?.type ?? -1;
  }

  setType(id, type) {
    this.require(id).type = type;
  }

  /** @returns {MemoryEntry} */
  require(id) {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`memory: invalid ID $${id.toString(16)}`);
    }
    return entry;
  }

  bytes(id) {
    return this.require(id).bytes;
  }

  /** Grow (or shrink) a block, keeping its contents. */
  resize(id, size) {
    const entry = this.require(id);
    const bytes = new Uint8Array(size);
    bytes.set(entry.bytes.subarray(0, Math.min(size, entry.bytes.length)));
    entry.bytes = bytes;
    return bytes;
  }

  /**
   * Scripts touch memory after disposing it (e.g. WhoUAre::dispose reads its
   * locals after super dispose unloaded its module), which the DOS interpreter
   * tolerates because a freed hunk keeps its contents until reused. So a freed
   * ID reads its stale contents, an unknown ID reads 0, and writes to either
   * are dropped (both reported via onInvalidAccess).
   */
  readWord(id, offset) {
    const entry = this.entries.get(id);
    const bytes = entry?.bytes ?? this.stale.get(id);
    if (!entry) {
      this.onInvalidAccess?.(id, 'read');
    }
    if (!bytes) {
      return 0;
    }
    if (offset < 0 || offset + 1 >= bytes.length) {
      return 0;
    }
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  writeWord(id, offset, value) {
    const entry = this.entries.get(id);
    if (!entry) {
      this.onInvalidAccess?.(id, 'write');
      return;
    }
    const { bytes } = entry;
    if (offset < 0 || offset + 1 >= bytes.length) {
      return;
    }
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value & WORD_MASK) >> 8;
  }

  /** IDs of every live object (type 2), ascending. */
  objectIds() {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.type === MEMORY_TYPE.OBJECT)
      .map(([id]) => id)
      .sort((a, b) => a - b);
  }
}
