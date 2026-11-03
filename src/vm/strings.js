// String memory helpers. LSCI strings are byte arrays (memory type 7):
// uint16 elementSize (1), uint16 capacity, then NUL-terminated text. Module
// string blocks use the same layout ("uint16 1, uint16 strlen+2, chars").
// Ground truth: kArray new (0x993:0x17e) and kString (0x243:0x02).
// Like the EXE's string-pointer helper (0x243:0x1e3), an object passed where
// a string is expected stands for its `data` property (selector 29).
import { MEMORY_TYPE } from './memory.js';

export const STRING_HEADER = 4;
const ELEMENT_SIZE_OFFSET = 0;
const CAPACITY_OFFSET = 2;
const DATA_SELECTOR = 29;

export class StringStore {
  /**
   * @param {import('./memory.js').Memory} memory
   * @param {import('./objects.js').ObjectModel} [objects]
   */
  constructor(memory, objects) {
    this.memory = memory;
    this.objects = objects;
  }

  /** The string block behind `id` (an object's `data`, or `id` itself). */
  resolve(id) {
    if (this.objects && this.objects.isObject(id)) {
      return this.objects.getProperty(id, DATA_SELECTOR);
    }
    return id;
  }

  /** True when `id` is a byte array / string block. */
  isString(objectOrId) {
    const id = this.resolve(objectOrId);
    if (!this.memory.isValid(id)) {
      return false;
    }
    const type = this.memory.typeOf(id);
    return type === MEMORY_TYPE.STRING || (type === MEMORY_TYPE.ARRAY && this.memory.readWord(id, 0) === 1);
  }

  /** Text of a string ID ('' for anything else). */
  read(objectOrId) {
    if (!this.isString(objectOrId)) {
      return '';
    }
    const id = this.resolve(objectOrId);
    const bytes = this.memory.bytes(id);
    let text = '';
    for (let i = STRING_HEADER; i < bytes.length && bytes[i] !== 0; i++) {
      text += String.fromCharCode(bytes[i]);
    }
    return text;
  }

  /** Allocate a new string holding `text`. */
  create(text, capacity = text.length + 1) {
    const id = this.memory.alloc(MEMORY_TYPE.STRING, STRING_HEADER + Math.max(capacity, text.length + 1));
    this.memory.writeWord(id, ELEMENT_SIZE_OFFSET, 1);
    this.memory.writeWord(id, CAPACITY_OFFSET, Math.max(capacity, text.length + 1));
    this.write(id, text);
    return id;
  }

  /** Replace the contents of string `id`, growing it if needed. */
  write(objectOrId, text) {
    const id = this.resolve(objectOrId);
    if (!this.memory.isValid(id)) {
      return;
    }
    let bytes = this.memory.bytes(id);
    const needed = STRING_HEADER + text.length + 1;
    if (bytes.length < needed) {
      bytes = this.memory.resize(id, needed);
      this.memory.writeWord(id, CAPACITY_OFFSET, text.length + 1);
    }
    for (let i = 0; i < text.length; i++) {
      bytes[STRING_HEADER + i] = text.charCodeAt(i) & 0xff;
    }
    bytes[STRING_HEADER + text.length] = 0;
  }
}
