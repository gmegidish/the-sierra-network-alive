// Array, String and Block kernels.
// Ground truth (unpacked LSCITV.EXE): kArray 0x993:0x00 (sub-ops 0..7),
// kString 0x243:0x02 (sub-ops 0..4), kBlock 0x0de:0x4ce (sub-ops 0..2).
// Array memory: uint16 elementSize (1 or 2), uint16 count, elements at +4.
// Array(0, size, type): type 0 word array (mem type 0x13), 1 ID array (0x15),
// 2 byte array (0x13), 3 string (mem type 7).
import { MEMORY_TYPE } from '../memory.js';
import { STRING_HEADER } from '../strings.js';
import { formatString } from '../format.js';

const HEADER = 4;
const ARRAY_TYPES = Object.freeze([
  { memoryType: MEMORY_TYPE.ARRAY, elementSize: 2 },
  { memoryType: MEMORY_TYPE.ID_ARRAY, elementSize: 2 },
  { memoryType: MEMORY_TYPE.ARRAY, elementSize: 1 },
  { memoryType: MEMORY_TYPE.STRING, elementSize: 1 },
]);
const ARRAY_OP = Object.freeze({ NEW: 0, FREE: 1, AT: 2, AT_PUT: 3, SIZE: 4, FILL: 5, COPY: 6, COMPARE: 7 });
const STRING_OP = Object.freeze({ LENGTH: 0, FORMAT_NEW: 1, FORMAT: 2, TRIM: 3, TO_NUMBER: 4 });
const BLOCK_OP = Object.freeze({ DUPLICATE: 0, FREE: 1, TYPE: 2 });
const WHOLE_STRING = 0xffff;

export function newArray(vm, size, type) {
  const spec = ARRAY_TYPES[type] ?? ARRAY_TYPES[0];
  const id = vm.memory.alloc(spec.memoryType, HEADER + size * spec.elementSize);
  vm.memory.writeWord(id, 0, spec.elementSize);
  vm.memory.writeWord(id, 2, size);
  return id;
}

function elementSize(vm, id) {
  return vm.memory.readWord(id, 0) === 1 ? 1 : 2;
}

function arraySize(vm, id) {
  return vm.memory.readWord(id, 2);
}

/** Grow an array so `count` elements fit. */
function ensureSize(vm, id, count) {
  if (arraySize(vm, id) >= count) {
    return;
  }
  vm.memory.resize(id, HEADER + count * elementSize(vm, id));
  vm.memory.writeWord(id, 2, count);
}

export function arrayGet(vm, id, index) {
  if (!vm.memory.isValid(id) || index >= arraySize(vm, id)) {
    return 0;
  }
  return elementSize(vm, id) === 1 ? vm.memory.bytes(id)[HEADER + index] : vm.memory.readWord(id, HEADER + index * 2);
}

export function arraySet(vm, id, index, value) {
  if (!vm.memory.isValid(id)) {
    vm.trace.log('error', `Array write to invalid ID $${id.toString(16)}`);
    return;
  }
  ensureSize(vm, id, index + 1);
  if (elementSize(vm, id) === 1) {
    vm.memory.bytes(id)[HEADER + index] = value & 0xff;
  } else {
    vm.memory.writeWord(id, HEADER + index * 2, value);
  }
}

/** Fill `count` elements from `start` (count -1: to the end of the array). */
function fillElements(vm, id, start, count, value) {
  if (!vm.memory.isValid(id)) {
    return id;
  }
  const total = count === WHOLE_STRING ? Math.max(0, arraySize(vm, id) - start) : count;
  for (let i = 0; i < total; i++) {
    arraySet(vm, id, start + i, value);
  }
  return id;
}

/**
 * Array copy (kArray 6, 0x993:0x411): grows dst to dstIndex + count elements,
 * then memmoves count * srcElementSize raw bytes. A byte message copied into
 * a word array therefore yields little-endian words (Msg members, cmd 12).
 */
function copyElements(vm, [dst, dstIndex, src, srcIndex, count]) {
  if (!vm.memory.isValid(dst) || !vm.memory.isValid(src)) {
    return dst;
  }
  const available = Math.max(0, arraySize(vm, src) - srcIndex);
  const total = count === WHOLE_STRING ? available : Math.min(count, available);
  const srcSize = elementSize(vm, src);
  const bytes = vm.memory.bytes(src).slice(HEADER + srcIndex * srcSize, HEADER + (srcIndex + total) * srcSize);
  ensureSize(vm, dst, dstIndex + total);
  const target = vm.memory.bytes(dst);
  const start = HEADER + dstIndex * elementSize(vm, dst);
  target.set(bytes.subarray(0, Math.max(0, target.length - start)), start);
  return dst;
}

/**
 * Array compare (kArray 7): Array(7, a, aIndex, b, bIndex, count) → 1 when the
 * count elements match. Only caller is Array::compToFrom (module 60002 block 9),
 * which String::strIndex/compare branch on; it is not a copy.
 */
function compareElements(vm, [a, aIndex, b, bIndex, count]) {
  if (!vm.memory.isValid(a) || !vm.memory.isValid(b)) {
    return 0;
  }
  for (let i = 0; i < count; i += 1) {
    const isOutside = aIndex + i >= arraySize(vm, a) || bIndex + i >= arraySize(vm, b);
    if (isOutside || arrayGet(vm, a, aIndex + i) !== arrayGet(vm, b, bIndex + i)) {
      return 0;
    }
  }
  return 1;
}

function array(vm, args) {
  const [op, id = 0, a = 0, b = 0, c = 0] = args;
  switch (op) {
    case ARRAY_OP.NEW: return newArray(vm, id, a);
    case ARRAY_OP.FREE: vm.memory.free(id); return undefined;
    case ARRAY_OP.AT: return arrayGet(vm, id, a);
    case ARRAY_OP.AT_PUT:
      args.slice(3).forEach((value, i) => arraySet(vm, id, a + i, value));
      return id;
    case ARRAY_OP.SIZE: return vm.memory.isValid(id) ? arraySize(vm, id) : 0;
    case ARRAY_OP.FILL: return fillElements(vm, id, a, b, c);
    case ARRAY_OP.COPY: return copyElements(vm, args.slice(1));
    case ARRAY_OP.COMPARE: return compareElements(vm, args.slice(1));
    default:
      vm.trace.log('error', `Array: unknown op ${op}`);
      return 0;
  }
}

function string(vm, args) {
  const [op, id = 0] = args;
  const read = (value) => vm.strings.read(value);
  switch (op) {
    case STRING_OP.LENGTH: return read(id).length;
    case STRING_OP.FORMAT_NEW: return vm.strings.create(formatString(read(id), args.slice(2), read));
    case STRING_OP.FORMAT:
      vm.strings.write(id, formatString(read(args[2]), args.slice(3), read));
      return id;
    case STRING_OP.TRIM: {
      const text = read(id);
      vm.memory.resize(id, STRING_HEADER + text.length + 1);
      vm.memory.writeWord(id, 2, text.length + 1);
      return undefined;
    }
    case STRING_OP.TO_NUMBER: return Number.parseInt(read(id), 10) & 0xffff || 0;
    default:
      vm.trace.log('error', `String: unknown op ${op}`);
      return 0;
  }
}

function block(vm, [op, id = 0, type]) {
  switch (op) {
    case BLOCK_OP.DUPLICATE: {
      const entry = vm.memory.get(id);
      if (!entry) {
        return 0;
      }
      const copy = vm.memory.alloc(entry.type, entry.bytes);
      if (Array.isArray(entry.data)) {
        vm.memory.get(copy).data = [...entry.data];
      }
      return copy;
    }
    case BLOCK_OP.FREE: vm.memory.free(id); return undefined;
    case BLOCK_OP.TYPE: {
      const current = vm.memory.typeOf(id);
      if (type !== undefined && vm.memory.isValid(id)) {
        vm.memory.setType(id, type);
      }
      return current < 0 ? 0 : current;
    }
    default: return 0;
  }
}

export const arrayKernels = Object.freeze({ Array: array, String: string, Block: block });
