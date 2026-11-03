// Vocabulary resource decoders used by the PMachine.
// Reference: ScummVM engines/sci/engine/kernel.cpp (Kernel::loadSelectorNames,
// Kernel::loadOpcodes) and engines/sci/engine/script.cpp (class table, vocab.996).
//
//   vocab.997  selector names: uint16 maxIndex, uint16 offsets[maxIndex+1],
//              entry = uint16 length + chars.
//   vocab.998  opcode names:   uint16 count, uint16 offsets[count],
//              entry = uint16 (length+2), uint16 operandType, chars.
//   vocab.996  class table:    4 bytes per class: uint16 reserved, uint16 module.
//              TSN class modules are numbered 59950..60081 (see types.js).
//   vocab.995 (debugger help), 994, 900, 901 and 0 (parser words) are not
//              decoded here; see docs/sci-resources.md.
import { bytesToString } from './text.js';

export const VOCAB = Object.freeze({
  PARSER_WORDS: 0,
  CLASS_TABLE: 996,
  SELECTORS: 997,
  OPCODES: 998,
});

const CLASS_ENTRY_SIZE = 4;
const OPCODE_LENGTH_BIAS = 2;

function readUint16(data, offset) {
  return data[offset] | (data[offset + 1] << 8);
}

/**
 * @param {Uint8Array} data vocab.997
 * @returns {string[]} selector names indexed by selector number
 */
export function decodeSelectorNames(data) {
  const count = readUint16(data, 0) + 1;
  const names = [];
  for (let i = 0; i < count; i++) {
    const offset = readUint16(data, 2 + i * 2);
    const length = readUint16(data, offset);
    names.push(bytesToString(data, offset + 2, offset + 2 + length));
  }
  return names;
}

/**
 * @param {Uint8Array} data vocab.998
 * @returns {{ name: string, operandType: number }[]} indexed by opcode (byte >> 1)
 */
export function decodeOpcodeNames(data) {
  const count = readUint16(data, 0);
  const opcodes = [];
  for (let i = 0; i < count; i++) {
    const offset = readUint16(data, 2 + i * 2);
    const length = readUint16(data, offset) - OPCODE_LENGTH_BIAS;
    opcodes.push(Object.freeze({
      name: bytesToString(data, offset + 4, offset + 4 + length),
      operandType: readUint16(data, offset + 2),
    }));
  }
  return opcodes;
}

/**
 * @param {Uint8Array} data vocab.996
 * @returns {number[]} module number per class number
 */
export function decodeClassTable(data) {
  const modules = [];
  for (let pos = 0; pos + CLASS_ENTRY_SIZE <= data.length; pos += CLASS_ENTRY_SIZE) {
    modules.push(readUint16(data, pos + 2));
  }
  return modules;
}
