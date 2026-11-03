// SCI bitmap font decoder.
// Reference: ScummVM engines/sci/graphics/scifont.cpp (GfxFontFromResource).
//
// Header: uint16 lowChar (unused), uint16 numChars, uint16 lineHeight,
// uint16 charOffsets[numChars]. Glyph: uint8 width, uint8 height, then
// height rows of ceil(width/8) bytes, MSB = leftmost pixel.

const NUM_CHARS_OFFSET = 2;
const HEIGHT_OFFSET = 4;
const CHAR_TABLE_OFFSET = 6;
const GLYPH_HEADER_SIZE = 2;
const BITS_PER_BYTE = 8;
const MSB = 0x80;

function readUint16(data, offset) {
  return data[offset] | (data[offset + 1] << 8);
}

/**
 * @typedef {{ width: number, height: number, bits: Uint8Array }} Glyph
 * bits: width*height bytes, 1 = ink.
 * @typedef {{ lineHeight: number, glyphs: Glyph[] }} Font
 */

function decodeGlyph(data, offset) {
  const width = data[offset];
  const height = data[offset + 1];
  const bytesPerRow = Math.ceil(width / BITS_PER_BYTE);
  const bits = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = offset + GLYPH_HEADER_SIZE + y * bytesPerRow;
    for (let x = 0; x < width; x++) {
      const byte = data[row + Math.floor(x / BITS_PER_BYTE)];
      bits[y * width + x] = (byte << (x % BITS_PER_BYTE)) & MSB ? 1 : 0;
    }
  }
  return Object.freeze({ width, height, bits });
}

/**
 * @param {Uint8Array} data decompressed font resource
 * @returns {Font}
 */
export function decodeFont(data) {
  const numChars = readUint16(data, NUM_CHARS_OFFSET);
  const lineHeight = readUint16(data, HEIGHT_OFFSET);
  const glyphs = [];
  for (let i = 0; i < numChars; i++) {
    glyphs.push(decodeGlyph(data, readUint16(data, CHAR_TABLE_OFFSET + i * 2)));
  }
  return Object.freeze({ lineHeight, glyphs });
}

/** Width in pixels of `text` rendered with `font` (missing glyphs count as 0). */
export function measureText(font, text) {
  let width = 0;
  for (const ch of text) {
    width += font.glyphs[ch.charCodeAt(0)]?.width ?? 0;
  }
  return width;
}
