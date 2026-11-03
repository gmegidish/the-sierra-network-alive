// Wire format of The Sierra Network (TSN) client link, as implemented in
// TSNEXEC.EXE (link layer) and LSCITV.EXE kernel TSN(4, fmt, ...) (messages).
// Pure functions over byte arrays: no I/O, works in browser and Node.
// See docs/protocol.md for the layered spec and code addresses.

/**
 * @typedef {Object} Frame
 * @property {number} control  CTL byte: seq 0..7 for data, 0x90|seq ACK, 0x80|seq NAK
 * @property {Uint8Array} payload  unescaped payload bytes (empty for ACK/NAK)
 */

/**
 * @typedef {Object} DecodedFrame
 * @property {number} control
 * @property {Uint8Array} payload  unescaped payload
 * @property {boolean} crcOk  CRC stored in the frame matches CTL + escaped payload
 */

/**
 * @typedef {Object} StreamSplit
 * @property {Uint8Array[]} messages  complete messages, without their length prefix
 * @property {Uint8Array} rest  trailing bytes of an incomplete message
 */

/**
 * @typedef {Object} FrameReaderOptions
 * @property {number} [maxFrameBytes]  drop frames longer than this (default: no limit)
 * @property {(length: number) => void} [onOversize]  called when a frame is dropped
 */

export const FRAME_START = 0x81;
export const FRAME_END = 0x82;
export const ESCAPE = 0x1b;
export const CTL_NAK = 0x80;
export const CTL_ACK = 0x90;
export const CTL_TYPE_MASK = 0xf0;
export const CTL_SEQ_MASK = 0x0f;
export const SEQ_MODULO = 8;
/** Largest frame on the wire, delimiters included (TSNEXEC frame length <= 0xFE). */
export const MAX_FRAME_BYTES = 254;
/** Escaped payload room: MAX_FRAME_BYTES minus start, 2 CRC, CTL and end. */
export const MAX_ESCAPED_PAYLOAD = MAX_FRAME_BYTES - 5;
export const LONG_LENGTH_MARKER = 0xff;
export const CRC_INIT = 0xffff;
export const PASSWORD_LENGTH = 10;
export const PASSWORD_KEY = 'M34546788S';

const BYTE_MASK = 0xff;
const WORD_MASK = 0xffff;
/** Index of the first payload byte inside a raw frame (after 81, CRC lo/hi, CTL). */
const PAYLOAD_OFFSET = 4;

// ---------------------------------------------------------------- CRC

/**
 * One byte of CRC-16/CCITT-FALSE (poly 0x1021, MSB first), the
 * table-less form used by TSNEXEC 0x16ba.
 * @param {number} crc
 * @param {number} byte
 * @returns {number}
 */
export function crc16Update(crc, byte) {
  let x = ((crc >> 8) ^ byte) & BYTE_MASK;
  x ^= x >> 4;
  return ((crc << 8) ^ (x << 12) ^ (x << 5) ^ x) & WORD_MASK;
}

/**
 * @param {ArrayLike<number>} bytes
 * @param {number} [crc]
 * @returns {number}
 */
export function crc16(bytes, crc = CRC_INIT) {
  let result = crc;
  for (const byte of Array.from(bytes)) {
    result = crc16Update(result, byte);
  }
  return result;
}

// ---------------------------------------------------------------- frames

/**
 * @param {number} byte
 * @returns {boolean}
 */
function needsEscape(byte) {
  return byte === FRAME_START || byte === FRAME_END || byte === ESCAPE;
}

/**
 * Byte stuffing (TSNEXEC 0x25de): special bytes are preceded by ESC, not XORed.
 * @param {ArrayLike<number>} bytes
 * @returns {number[]}
 */
export function escapeBytes(bytes) {
  const out = [];
  for (const byte of Array.from(bytes)) {
    if (needsEscape(byte)) {
      out.push(ESCAPE);
    }
    out.push(byte);
  }
  return out;
}

/**
 * @param {ArrayLike<number>} bytes  escaped bytes
 * @returns {number[]}
 */
export function unescapeBytes(bytes) {
  const out = [];
  let isEscaped = false;
  for (const byte of Array.from(bytes)) {
    if (!isEscaped && byte === ESCAPE) {
      isEscaped = true;
      continue;
    }
    out.push(byte);
    isEscaped = false;
  }
  return out;
}

/**
 * 81 | CRC lo | CRC hi | CTL | escaped payload | 82.
 * CRC covers CTL + escaped payload; CRC bytes themselves are not escaped.
 * @param {Frame} frame
 * @returns {Uint8Array}
 */
export function encodeFrame({ control, payload = new Uint8Array(0) }) {
  const body = [control & BYTE_MASK, ...escapeBytes(payload)];
  const crc = crc16(body);
  return Uint8Array.from([FRAME_START, crc & BYTE_MASK, crc >> 8, ...body, FRAME_END]);
}

/**
 * Decode one complete frame (starting 0x81, ending 0x82).
 * @param {ArrayLike<number>} bytes
 * @returns {DecodedFrame}
 */
export function decodeFrame(bytes) {
  const all = Array.from(bytes);
  if (all.length < 5 || all[0] !== FRAME_START || all[all.length - 1] !== FRAME_END) {
    throw new Error('not a complete TSN frame');
  }
  const storedCrc = all[1] | (all[2] << 8);
  const body = all.slice(3, -1);
  return {
    control: body[0],
    payload: Uint8Array.from(unescapeBytes(body.slice(1))),
    crcOk: crc16(body) === storedCrc,
  };
}

/** @param {number} seq @returns {Uint8Array} */
export function ackFrame(seq) {
  return encodeFrame({ control: CTL_ACK | (seq & CTL_SEQ_MASK) });
}

/** @param {number} seq @returns {Uint8Array} */
export function nakFrame(seq) {
  return encodeFrame({ control: CTL_NAK | (seq & CTL_SEQ_MASK) });
}

/** @param {number} seq @returns {number} */
export function nextSeq(seq) {
  return (seq + 1) % SEQ_MODULO;
}

/**
 * Streaming receiver mirroring TSNEXEC 0x1e55: feed raw line bytes, get
 * complete frames. A 0x81 inside a frame restarts it (the client NAKs).
 * A frame growing past maxFrameBytes (delimiters included) is dropped and
 * reported through onOversize, so a peer cannot grow the buffer unbounded.
 * @param {FrameReaderOptions} [options]
 * @returns {{ push: (bytes: ArrayLike<number>) => DecodedFrame[] }}
 */
export function createFrameReader({ maxFrameBytes = Infinity, onOversize = () => {} } = {}) {
  /** @type {number[] | null} */
  let current = null;
  let isEscaped = false;

  /** @param {number} byte @returns {DecodedFrame | null} */
  function feed(byte) {
    if (current === null) {
      current = byte === FRAME_START ? [byte] : null;
      return null;
    }
    // ponytail: indexes 1..3 (CRC lo, CRC hi, CTL) are taken raw; NAK|1 is 0x81
    const isPayload = current.length >= PAYLOAD_OFFSET;
    if (!isPayload || isEscaped) {
      current.push(byte);
      isEscaped = false;
      return null;
    }
    if (byte === FRAME_START) {
      current = [byte];
      return null;
    }
    current.push(byte);
    if (current.length > maxFrameBytes) {
      onOversize(current.length);
      current = null;
      isEscaped = false;
      return null;
    }
    if (byte === ESCAPE) {
      isEscaped = true;
      return null;
    }
    if (byte !== FRAME_END) {
      return null;
    }
    const frame = decodeFrame(current);
    current = null;
    return frame;
  }

  return {
    push(bytes) {
      const frames = [];
      for (const byte of Array.from(bytes)) {
        const frame = feed(byte);
        if (frame) {
          frames.push(frame);
        }
      }
      return frames;
    },
  };
}

/**
 * Split a raw (unescaped) stream into payload chunks whose escaped size fits
 * one frame. Never splits an escape pair; messages may span frames.
 * @param {ArrayLike<number>} bytes
 * @param {number} [maxEscaped]
 * @returns {Uint8Array[]}
 */
export function splitIntoPayloads(bytes, maxEscaped = MAX_ESCAPED_PAYLOAD) {
  const chunks = [];
  let chunk = [];
  let size = 0;
  for (const byte of Array.from(bytes)) {
    const cost = needsEscape(byte) ? 2 : 1;
    if (size + cost > maxEscaped) {
      chunks.push(Uint8Array.from(chunk));
      chunk = [];
      size = 0;
    }
    chunk.push(byte);
    size += cost;
  }
  if (chunk.length > 0) {
    chunks.push(Uint8Array.from(chunk));
  }
  return chunks;
}

// ---------------------------------------------------------------- message stream

/**
 * Length prefix: 1 byte if < 255, else FF lo hi.
 * @param {number} length
 * @returns {number[]}
 */
export function encodeLengthPrefix(length) {
  if (length < LONG_LENGTH_MARKER) {
    return [length];
  }
  return [LONG_LENGTH_MARKER, length & BYTE_MASK, (length >> 8) & BYTE_MASK];
}

/**
 * @param {ArrayLike<number>[]} messages
 * @returns {Uint8Array}
 */
export function encodeMessageStream(messages) {
  const out = [];
  for (const message of messages) {
    out.push(...encodeLengthPrefix(message.length), ...Array.from(message));
  }
  return Uint8Array.from(out);
}

/**
 * @param {number[]} bytes
 * @param {number} at
 * @returns {{ length: number, size: number } | null}
 */
function readLengthPrefix(bytes, at) {
  if (at >= bytes.length) {
    return null;
  }
  if (bytes[at] !== LONG_LENGTH_MARKER) {
    return { length: bytes[at], size: 1 };
  }
  if (at + 3 > bytes.length) {
    return null;
  }
  return { length: bytes[at + 1] | (bytes[at + 2] << 8), size: 3 };
}

/**
 * Parse the committed byte stream (TSNEXEC 0x284c) into messages.
 * @param {ArrayLike<number>} bytes
 * @returns {StreamSplit}
 */
export function decodeMessageStream(bytes) {
  const all = Array.from(bytes);
  const messages = [];
  let at = 0;
  for (;;) {
    const prefix = readLengthPrefix(all, at);
    if (!prefix || at + prefix.size + prefix.length > all.length) {
      break;
    }
    const start = at + prefix.size;
    messages.push(Uint8Array.from(all.slice(start, start + prefix.length)));
    at = start + prefix.length;
  }
  return { messages, rest: Uint8Array.from(all.slice(at)) };
}

// ---------------------------------------------------------------- messages

/**
 * @param {number[]} out
 * @param {number} value
 */
function pushWord(out, value) {
  out.push(value & BYTE_MASK, (value >> 8) & BYTE_MASK);
}

/**
 * @param {number[]} out
 * @param {string | ArrayLike<number>} value
 */
function pushString(out, value) {
  const codes = typeof value === 'string' ? Array.from(value, (c) => c.charCodeAt(0)) : Array.from(value);
  out.push(...codes.map((c) => c & BYTE_MASK), 0);
}

/**
 * 'a': count then array. Uint8Array/byte-typed arrays copy bytes, anything
 * else copies little-endian words (LSCITV 0x435 checks the array type).
 * @param {number[]} out
 * @param {number} count
 * @param {ArrayLike<number>} array
 */
function pushArray(out, count, array) {
  const isBytes = array instanceof Uint8Array;
  for (let i = 0; i < count; i += 1) {
    if (isBytes) {
      out.push(array[i] & BYTE_MASK);
    } else {
      pushWord(out, array[i]);
    }
  }
}

/**
 * Encode like TSN(4, fmt, args...) (LSCITV 0x435). The first format char
 * encodes the message type itself. b=byte, w=LE word, s=string+NUL,
 * a=count,array, +=all remaining args (bytes if previous char was 'b', else
 * words). Unknown chars are ignored.
 * @param {string} fmt
 * @param {Array<number | string | ArrayLike<number>>} args
 * @returns {Uint8Array}
 */
export function encodeMessage(fmt, args) {
  const out = [];
  let next = 0;
  let previous = '';
  for (const ch of fmt) {
    if (ch === 'b') {
      out.push(Number(args[next++]) & BYTE_MASK);
    } else if (ch === 'w') {
      pushWord(out, Number(args[next++]));
    } else if (ch === 's') {
      pushString(out, /** @type {string} */ (args[next++]));
    } else if (ch === 'a') {
      pushArray(out, Number(args[next]), /** @type {ArrayLike<number>} */ (args[next + 1]));
      next += 2;
    } else if (ch === '+') {
      const rest = args.slice(next).map(Number);
      next = args.length;
      rest.forEach((v) => (previous === 'b' ? out.push(v & BYTE_MASK) : pushWord(out, v)));
    }
    previous = ch;
  }
  return Uint8Array.from(out);
}

/**
 * Inverse of encodeMessage for building/inspecting fixtures. 'a' and '+'
 * take everything left ('a' as bytes; '+' as bytes after 'b', else words).
 * @param {string} fmt
 * @param {ArrayLike<number>} bytes
 * @returns {Array<number | string | Uint8Array | number[]>}
 */
export function decodeMessage(fmt, bytes) {
  const all = Array.from(bytes);
  const values = [];
  let at = 0;
  let previous = '';
  for (const ch of fmt) {
    if (ch === 'b') {
      values.push(all[at++]);
    } else if (ch === 'w') {
      values.push(all[at] | (all[at + 1] << 8));
      at += 2;
    } else if (ch === 's') {
      const end = all.indexOf(0, at);
      const stop = end < 0 ? all.length : end;
      values.push(String.fromCharCode(...all.slice(at, stop)));
      at = stop + 1;
    } else if (ch === 'a') {
      values.push(Uint8Array.from(all.slice(at)));
      at = all.length;
    } else if (ch === '+') {
      values.push(previous === 'b' ? all.slice(at) : wordsOf(all.slice(at)));
      at = all.length;
    }
    previous = ch;
  }
  return values;
}

/** @param {number[]} bytes @returns {number[]} */
function wordsOf(bytes) {
  const words = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    words.push(bytes[i] | (bytes[i + 1] << 8));
  }
  return words;
}

// ---------------------------------------------------------------- password

/**
 * PASS_SET.DTA / login password scrambling (script module 95 block 33):
 * out[i] = upper(p[i]) ^ KEY[i], zero padded to 10, then for j in 0..n-1
 * out[(j+1)%n] ^= out[j], n = password length.
 * @param {string} password
 * @returns {Uint8Array}
 */
export function encodePassword(password) {
  const text = password.toUpperCase().slice(0, PASSWORD_LENGTH);
  const n = text.length;
  const out = new Uint8Array(PASSWORD_LENGTH);
  for (let i = 0; i < n; i += 1) {
    out[i] = text.charCodeAt(i) ^ PASSWORD_KEY.charCodeAt(i);
  }
  for (let j = 0; j < n; j += 1) {
    out[(j + 1) % n] ^= out[j];
  }
  return out;
}

/**
 * Inverse of encodePassword. n is taken as the index after the last
 * non-zero byte (padding is zero).
 * @param {ArrayLike<number>} encoded
 * @returns {string}
 */
export function decodePassword(encoded) {
  const out = Array.from(encoded).slice(0, PASSWORD_LENGTH);
  let n = out.length;
  while (n > 0 && out[n - 1] === 0) {
    n -= 1;
  }
  for (let j = n - 1; j >= 0; j -= 1) {
    out[(j + 1) % n] ^= out[j];
  }
  return String.fromCharCode(...out.slice(0, n).map((b, i) => b ^ PASSWORD_KEY.charCodeAt(i)));
}
