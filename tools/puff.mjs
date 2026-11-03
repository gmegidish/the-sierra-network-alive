// PUFF file format (Sierra/Dynamix "puff /D") and PKWARE DCL "explode" decoder.
//
// A puffed file ("_RAPH256.DLL", "_OLUME.001", ...) is:
//   0..12   original file name, NUL padded (e.g. "GRAPH256.DLL")
//   13..16  uint32 checksum of the original data (not verified here)
//   17..20  DOS time (uint16) + DOS date (uint16)
//   21..    PKWARE Data Compression Library (implode) stream
// The DCL decoder below is a port of Mark Adler's blast.c.

const NAME_LENGTH = 13;
const DOS_STAMP_OFFSET = 17;
const STREAM_OFFSET = 21;
const END_OF_STREAM_LENGTH = 519;

// Compact code-length tables from the PKWARE format (see blast.c).
const LITERAL_LENGTHS = [
  11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8,
  9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5,
  7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12,
  8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27,
  44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45,
  44, 173,
];
const LENGTH_LENGTHS = [2, 35, 36, 53, 38, 23];
const DISTANCE_LENGTHS = [2, 20, 53, 230, 247, 151, 248];
const LENGTH_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
const MAX_BITS = 13;

function buildHuffman(compact) {
  const lengths = [];
  for (const packed of compact) {
    const repeat = (packed >> 4) + 1;
    for (let i = 0; i < repeat; i++) {
      lengths.push(packed & 15);
    }
  }
  const count = new Array(MAX_BITS + 1).fill(0);
  for (const len of lengths) {
    count[len]++;
  }
  const offsets = new Array(MAX_BITS + 2).fill(0);
  for (let len = 1; len <= MAX_BITS; len++) {
    offsets[len + 1] = offsets[len] + count[len];
  }
  const symbol = new Array(lengths.length).fill(0);
  lengths.forEach((len, sym) => {
    if (len !== 0) {
      symbol[offsets[len]++] = sym;
    }
  });
  return { count, symbol };
}

const LITERAL_CODE = buildHuffman(LITERAL_LENGTHS);
const LENGTH_CODE = buildHuffman(LENGTH_LENGTHS);
const DISTANCE_CODE = buildHuffman(DISTANCE_LENGTHS);

function createBitReader(input, start) {
  let pos = start;
  let buffer = 0;
  let available = 0;
  const readBit = () => {
    if (available === 0) {
      if (pos >= input.length) {
        throw new Error('DCL stream truncated');
      }
      buffer = input[pos++];
      available = 8;
    }
    const bit = buffer & 1;
    buffer >>= 1;
    available--;
    return bit;
  };
  const readBits = (n) => {
    let value = 0;
    for (let i = 0; i < n; i++) {
      value |= readBit() << i;
    }
    return value;
  };
  // PKWARE Huffman codes are stored bit-inverted, MSB of the code first.
  const decode = (huffman) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= MAX_BITS; len++) {
      code |= readBit() ^ 1;
      const count = huffman.count[len];
      if (code < first + count) {
        return huffman.symbol[index + (code - first)];
      }
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('DCL stream: bad Huffman code');
  };
  return { readBits, decode };
}

export function explode(input, start = 0) {
  const reader = createBitReader(input, start);
  const literalMode = reader.readBits(8);
  const dictionaryBits = reader.readBits(8);
  if (literalMode > 1) {
    throw new Error(`DCL stream: bad literal mode ${literalMode}`);
  }
  if (dictionaryBits < 4 || dictionaryBits > 6) {
    throw new Error(`DCL stream: bad dictionary size ${dictionaryBits}`);
  }
  let out = Buffer.alloc(Math.max(4096, (input.length - start) * 4));
  let size = 0;
  const ensure = (extra) => {
    if (size + extra > out.length) {
      const bigger = Buffer.alloc((size + extra) * 2);
      out.copy(bigger, 0, 0, size);
      out = bigger;
    }
  };
  for (;;) {
    if (reader.readBits(1) === 0) {
      const literal = literalMode ? reader.decode(LITERAL_CODE) : reader.readBits(8);
      ensure(1);
      out[size++] = literal;
      continue;
    }
    const lengthSymbol = reader.decode(LENGTH_CODE);
    const length = LENGTH_BASE[lengthSymbol] + reader.readBits(LENGTH_EXTRA[lengthSymbol]);
    if (length === END_OF_STREAM_LENGTH) {
      break;
    }
    const lowBits = length === 2 ? 2 : dictionaryBits;
    const distance = ((reader.decode(DISTANCE_CODE) << lowBits) | reader.readBits(lowBits)) + 1;
    if (distance > size) {
      throw new Error('DCL stream: distance before start of output');
    }
    ensure(length);
    for (let i = 0; i < length; i++) {
      out[size] = out[size - distance];
      size++;
    }
  }
  return out.subarray(0, size);
}

export function isPuffFile(buffer) {
  if (buffer.length <= STREAM_OFFSET + 2) {
    return false;
  }
  const literalMode = buffer[STREAM_OFFSET];
  const dictionaryBits = buffer[STREAM_OFFSET + 1];
  return literalMode <= 1 && dictionaryBits >= 4 && dictionaryBits <= 6;
}

export function unpuff(buffer) {
  const name = buffer.toString('latin1', 0, NAME_LENGTH).split('\0')[0];
  const dosStamp = buffer.readUInt32LE(DOS_STAMP_OFFSET);
  const checksum = buffer.readUInt32LE(NAME_LENGTH);
  const data = explode(buffer, STREAM_OFFSET);
  return { name, dosStamp, checksum, data };
}
