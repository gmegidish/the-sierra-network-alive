// SCI1 VGA cel RLE decoder, shared by views and pictures (embedded cels).
// Reference: ScummVM engines/sci/graphics/view.cpp GfxView::unpackCel (kViewVga case).
//
// Cel header (8 bytes): uint16 width, uint16 height, int8 displaceX,
// uint8 displaceY, uint8 clearKey, uint8 unused. RLE data follows directly.
// RLE byte: top two bits select the op, low 6 bits are the count:
//   00/01 -> copy (count | 0x40 for 01) literal bytes, 10 -> fill count with
//   next byte, 11 -> skip count pixels (clear key / transparent).

export const CEL_HEADER_SIZE = 8;
const OP_MASK = 0xc0;
const COUNT_MASK = 0x3f;
const OP_COPY = 0x00;
const OP_COPY_LONG = 0x40;
const OP_FILL = 0x80;
const LONG_COPY_BONUS = 64;

/**
 * @typedef {{ width: number, height: number, displaceX: number, displaceY: number,
 *   clearKey: number }} CelHeader
 */

/**
 * @param {Uint8Array} data
 * @param {number} offset
 * @returns {CelHeader}
 */
export function readCelHeader(data, offset) {
  return Object.freeze({
    width: data[offset] | (data[offset + 1] << 8),
    height: data[offset + 2] | (data[offset + 3] << 8),
    displaceX: (data[offset + 4] << 24) >> 24,
    displaceY: data[offset + 5],
    clearKey: data[offset + 6],
  });
}

/**
 * Unpack RLE cel pixels.
 * @param {Uint8Array} data
 * @param {number} rleOffset offset of the RLE stream
 * @param {number} pixelCount width * height
 * @param {number} clearKey value used for skipped pixels
 * @returns {{ pixels: Uint8Array, end: number }} pixels and offset after the stream
 */
export function unpackCelRle(data, rleOffset, pixelCount, clearKey) {
  const pixels = new Uint8Array(pixelCount).fill(clearKey);
  let pos = rleOffset;
  let written = 0;
  while (written < pixelCount) {
    if (pos >= data.length) {
      throw new Error('cel: RLE stream truncated');
    }
    const code = data[pos++];
    const op = code & OP_MASK;
    const runLength = op === OP_COPY_LONG ? (code & COUNT_MASK) + LONG_COPY_BONUS : code & COUNT_MASK;
    const count = Math.min(runLength, pixelCount - written);
    if (op === OP_COPY || op === OP_COPY_LONG) {
      pixels.set(data.subarray(pos, pos + count), written);
      pos += runLength;
    } else if (op === OP_FILL) {
      pixels.fill(data[pos++], written, written + count);
    }
    written += count;
  }
  return { pixels, end: pos };
}
