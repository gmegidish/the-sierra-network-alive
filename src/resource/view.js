// SCI1 VGA view decoder (kViewVga).
// Reference: ScummVM engines/sci/graphics/view.cpp GfxView::initData (kViewVga case).
//
// Header: uint8 loopCount, uint8 flags (0x40 = uncompressed, unseen in TSN),
// uint16 mirrorMask, uint16 version, uint16 paletteOffset, uint16 loopOffsets[].
// Loop: uint16 celCount, uint16 unknown, uint16 celOffsets[].
// Loops whose bit is set in mirrorMask are drawn horizontally flipped; we
// return their pixels already flipped and set `mirrored` (displaceX untouched).
import { readCelHeader, unpackCelRle, CEL_HEADER_SIZE } from './cel.js';
import { decodePalette } from './palette.js';

const LOOP_TABLE_OFFSET = 8;
const PALETTE_OFFSET_FIELD = 6;
const MIRROR_FIELD = 2;
const LOOP_CEL_TABLE_OFFSET = 4;
const UNUSED_PALETTE_OFFSET = 0x100;

function readUint16(data, offset) {
  return data[offset] | (data[offset + 1] << 8);
}

/**
 * @typedef {{ width: number, height: number, displaceX: number, displaceY: number,
 *   clearKey: number, pixels: Uint8Array }} Cel
 * @typedef {{ mirrored: boolean, cels: Cel[] }} Loop
 * @typedef {{ loops: Loop[], palette: import('./palette.js').Palette | null }} View
 */

function mirrorPixels(pixels, width, height) {
  const out = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = pixels[y * width + (width - 1 - x)];
    }
  }
  return out;
}

function decodeCel(data, celOffset, mirrored) {
  const header = readCelHeader(data, celOffset);
  const { pixels } = unpackCelRle(data, celOffset + CEL_HEADER_SIZE, header.width * header.height, header.clearKey);
  return Object.freeze({
    ...header,
    pixels: mirrored ? mirrorPixels(pixels, header.width, header.height) : pixels,
  });
}

function decodeLoop(data, loopOffset, mirrored) {
  const celCount = readUint16(data, loopOffset);
  const cels = [];
  for (let i = 0; i < celCount; i++) {
    const celOffset = readUint16(data, loopOffset + LOOP_CEL_TABLE_OFFSET + i * 2);
    cels.push(decodeCel(data, celOffset, mirrored));
  }
  return Object.freeze({ mirrored, cels });
}

function decodeEmbeddedPalette(data) {
  const paletteOffset = readUint16(data, PALETTE_OFFSET_FIELD);
  if (paletteOffset === 0 || paletteOffset === UNUSED_PALETTE_OFFSET) {
    return null;
  }
  return decodePalette(data, paletteOffset);
}

/**
 * @param {Uint8Array} data decompressed view resource
 * @returns {View}
 */
export function decodeView(data) {
  const loopCount = data[0];
  let mirrorBits = readUint16(data, MIRROR_FIELD);
  const loops = [];
  for (let loopNo = 0; loopNo < loopCount; loopNo++) {
    const loopOffset = readUint16(data, LOOP_TABLE_OFFSET + loopNo * 2);
    loops.push(decodeLoop(data, loopOffset, (mirrorBits & 1) === 1));
    mirrorBits >>= 1;
  }
  return Object.freeze({ loops, palette: decodeEmbeddedPalette(data) });
}
