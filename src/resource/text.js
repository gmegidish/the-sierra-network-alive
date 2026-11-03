// Text resources: NUL-separated strings, indexed from 0.
// Reference: ScummVM engines/sci/engine/kstring.cpp kGetFarText (SCI0/SCI1 text format).

const NUL = 0;

/** Decode a byte range as Latin-1 (DOS code page bytes map 1:1 to char codes). */
export function bytesToString(data, start = 0, end = data.length) {
  let out = '';
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(data[i]);
  }
  return out;
}

/** Read a NUL-terminated string starting at `offset`. */
export function readCString(data, offset) {
  let end = offset;
  while (end < data.length && data[end] !== NUL) {
    end++;
  }
  return bytesToString(data, offset, end);
}

/**
 * @param {Uint8Array} data decompressed text resource
 * @returns {string[]}
 */
export function decodeText(data) {
  const strings = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === NUL) {
      strings.push(bytesToString(data, start, i));
      start = i + 1;
    }
  }
  if (start < data.length) {
    strings.push(bytesToString(data, start));
  }
  return strings;
}
