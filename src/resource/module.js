// LSCI module (script) resource parser.
//
// TSN's interpreter (LSCITV.EXE) is not stock SCI: a module is a flat list of
// "blocks" that the interpreter loads into separately allocated memory IDs.
// This layout was reverse engineered from the resources themselves (it parses
// every module in RESOURCE.001 and the 130.SO patch exactly to end of file);
// ScummVM has no equivalent. See docs/sci-resources.md for details.
//
//   uint16 blockCount
//   blockCount x {
//     uint8  kind
//     uint16 size
//     uint8  data[size]
//     if kind != STRING: uint16 fixupCount, uint16 fixups[fixupCount]
//   }
//
// Fixups are byte offsets inside `data` holding a 16-bit block index that the
// loader converts into a runtime memory ID (pushID / loadID operands in code,
// ID-valued properties in objects, ...).
import { readCString } from './text.js';

export const BLOCK_KIND = Object.freeze({
  OBJECT: 2,
  CLASS: 3,
  CODE: 4,
  VARIABLES: 6,
  STRING: 7,
  DISPATCH: 9,
  PROPERTY_DICTIONARY: 11,
});

const KIND_NAMES = Object.freeze({
  2: 'object',
  3: 'class',
  4: 'code',
  6: 'variables',
  7: 'string',
  9: 'dispatch',
  11: 'propDict',
});

const STRING_HEADER_SIZE = 4;

/** @param {number} kind */
export function blockKindName(kind) {
  return KIND_NAMES[kind] ?? `kind${kind}`;
}

function readUint16(data, offset) {
  return data[offset] | (data[offset + 1] << 8);
}

/**
 * @typedef {{ index: number, kind: number, kindName: string, offset: number,
 *   data: Uint8Array, fixups: number[], text?: string }} ModuleBlock
 */

function readFixups(data, pos) {
  const count = readUint16(data, pos);
  const fixups = [];
  for (let i = 0; i < count; i++) {
    fixups.push(readUint16(data, pos + 2 + i * 2));
  }
  return { fixups, end: pos + 2 + count * 2 };
}

/**
 * String blocks: uint16 (unknown, always 1 in TSN), uint16 capacity
 * (strlen + 2), NUL-terminated text.
 */
function decodeStringBlock(data) {
  return readCString(data, STRING_HEADER_SIZE);
}

/**
 * @param {Uint8Array} data decompressed module resource
 * @returns {{ blocks: ModuleBlock[] }}
 */
export function parseModule(data) {
  const blockCount = readUint16(data, 0);
  const blocks = [];
  let pos = 2;
  for (let index = 0; index < blockCount; index++) {
    if (pos + 3 > data.length) {
      throw new Error(`module: block ${index} header past end of data`);
    }
    const kind = data[pos];
    const size = readUint16(data, pos + 1);
    const start = pos + 3;
    const end = start + size;
    if (end > data.length) {
      throw new Error(`module: block ${index} overruns data`);
    }
    const blockData = data.subarray(start, end);
    const isString = kind === BLOCK_KIND.STRING;
    const { fixups, end: next } = isString ? { fixups: [], end } : readFixups(data, end);
    blocks.push(Object.freeze({
      index,
      kind,
      kindName: blockKindName(kind),
      offset: start,
      data: blockData,
      fixups,
      ...(isString ? { text: decodeStringBlock(blockData) } : {}),
    }));
    pos = next;
  }
  if (pos !== data.length) {
    throw new Error(`module: ${data.length - pos} trailing bytes after ${blockCount} blocks`);
  }
  return Object.freeze({ blocks });
}

// Object / class block layout (kinds 2 and 3), as observed in TSN modules:
//   uint16 properties[size]  -- property 1 is -size- (the property count);
//                               names come from the class's propDict block
//   uint16 methodCount
//   uint16 methodSelectors[methodCount]
//   uint16 methodCodeBlocks[methodCount]  -- block indices (fixed up to IDs)
// Standard property order (from propDict of Obj): -env- -size- -dict- -super-
// -info- name sid. -info- has 0x8000 set for classes; -super- is a class
// number (vocab.996 index) or 0xFFFF.
const SIZE_PROPERTY_INDEX = 1;

/**
 * @param {ModuleBlock} block an OBJECT or CLASS block
 * @returns {{ properties: number[], methods: { selector: number, codeBlock: number }[] }}
 */
export function decodeObjectBlock(block) {
  const data = block.data;
  const propertyCount = readUint16(data, SIZE_PROPERTY_INDEX * 2);
  const properties = [];
  for (let i = 0; i < propertyCount; i++) {
    properties.push(readUint16(data, i * 2));
  }
  const methodTable = propertyCount * 2;
  const methodCount = methodTable + 2 <= data.length ? readUint16(data, methodTable) : 0;
  const methods = [];
  for (let i = 0; i < methodCount; i++) {
    methods.push({
      selector: readUint16(data, methodTable + 2 + i * 2),
      codeBlock: readUint16(data, methodTable + 2 + (methodCount + i) * 2),
    });
  }
  return { properties, methods };
}
