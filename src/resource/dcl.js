// PKWare DCL "implode" decompressor, as used by Sierra (compression method 8 in
// The Sierra Network's LSCI volumes; methods 18-20 in SCI1.1).
// Port of ScummVM common/compression/dcl.cpp (DecompressorDCL::unpack).
import { LENGTH_TREE, DISTANCE_TREE, ASCII_TREE } from './dcl-trees.js';

const MODE_BINARY = 0;
const MODE_ASCII = 1;
const END_OF_STREAM_LENGTH = 519;
const BRANCH_SHIFT = 1024;
const SHORT_COPY_DISTANCE_BITS = 2;
const MIN_DICTIONARY_TYPE = 4;
const MAX_DICTIONARY_TYPE = 6;

function createBitReader(src) {
  let pos = 0;
  let bits = 0;
  let bitCount = 0;
  const readBits = (n) => {
    while (bitCount < n) {
      if (pos >= src.length) {
        throw new Error('DCL: unexpected end of compressed data');
      }
      bits |= src[pos++] << bitCount;
      bitCount += 8;
    }
    const value = bits & ((1 << n) - 1);
    bits >>>= n;
    bitCount -= n;
    return value;
  };
  return { readBits };
}

function decodeSymbol(reader, tree) {
  let node = tree[0];
  while (node >= 0) {
    const childIndex = reader.readBits(1) ? node % BRANCH_SHIFT : Math.floor(node / BRANCH_SHIFT);
    node = tree[childIndex];
  }
  return -node - 1;
}

function readCopyLength(reader) {
  const code = decodeSymbol(reader, LENGTH_TREE);
  if (code < 8) {
    return code + 2;
  }
  return 8 + (1 << (code - 7)) + reader.readBits(code - 7);
}

/**
 * Decompress DCL-imploded data.
 * @param {Uint8Array} src compressed bytes
 * @param {number} unpackedSize declared output size
 * @returns {Uint8Array}
 */
export function decompressDCL(src, unpackedSize) {
  const out = new Uint8Array(unpackedSize);
  const reader = createBitReader(src);
  const mode = reader.readBits(8);
  const dictionaryType = reader.readBits(8);
  if (mode !== MODE_BINARY && mode !== MODE_ASCII) {
    throw new Error(`DCL: bad mode ${mode}`);
  }
  if (dictionaryType < MIN_DICTIONARY_TYPE || dictionaryType > MAX_DICTIONARY_TYPE) {
    throw new Error(`DCL: bad dictionary type ${dictionaryType}`);
  }
  let written = 0;
  while (written < unpackedSize) {
    if (!reader.readBits(1)) {
      out[written++] = mode === MODE_ASCII ? decodeSymbol(reader, ASCII_TREE) : reader.readBits(8);
      continue;
    }
    const length = readCopyLength(reader);
    if (length === END_OF_STREAM_LENGTH) {
      break;
    }
    const distanceHigh = decodeSymbol(reader, DISTANCE_TREE);
    const lowBits = length === 2 ? SHORT_COPY_DISTANCE_BITS : dictionaryType;
    const distance = ((distanceHigh << lowBits) | reader.readBits(lowBits)) + 1;
    if (distance > written) {
      throw new Error(`DCL: copy distance ${distance} before start (at ${written})`);
    }
    if (written + length > unpackedSize) {
      throw new Error(`DCL: copy overflows declared size ${unpackedSize}`);
    }
    for (let i = 0; i < length; i++) {
      out[written] = out[written - distance];
      written++;
    }
  }
  if (written !== unpackedSize) {
    throw new Error(`DCL: wrote ${written} bytes, expected ${unpackedSize}`);
  }
  return out;
}
