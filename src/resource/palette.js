// SCI1 VGA palette decoder (palette resources and the palette embedded in pics/views).
// Reference: ScummVM engines/sci/graphics/palette16.cpp GfxPalette::createFromData.
//
// SCI0/SCI1 layout: 256-byte remap table + 4-byte timestamp, then 256 entries
// of {used, r, g, b} (8-bit components) starting at offset 260.

export const PALETTE_SIZE = 256;
const SCI1_PALETTE_OFFSET = 260;
const SCI1_ENTRY_SIZE = 4;
export const SCI1_PALETTE_BYTES = SCI1_PALETTE_OFFSET + PALETTE_SIZE * SCI1_ENTRY_SIZE;

/**
 * @typedef {{ used: Uint8Array, rgb: Uint8Array }} Palette
 * rgb holds PALETTE_SIZE * 3 bytes.
 */

/** @returns {Palette} an all-black palette with no used entries */
export function createEmptyPalette() {
  return { used: new Uint8Array(PALETTE_SIZE), rgb: new Uint8Array(PALETTE_SIZE * 3) };
}

/**
 * Decode an SCI1 palette at `offset` within `data`.
 * @param {Uint8Array} data
 * @param {number} [offset]
 * @returns {Palette}
 */
export function decodePalette(data, offset = 0) {
  if (offset + SCI1_PALETTE_BYTES > data.length) {
    throw new Error('palette: not enough data');
  }
  const palette = createEmptyPalette();
  let pos = offset + SCI1_PALETTE_OFFSET;
  for (let i = 0; i < PALETTE_SIZE; i++) {
    palette.used[i] = data[pos];
    palette.rgb[i * 3] = data[pos + 1];
    palette.rgb[i * 3 + 1] = data[pos + 2];
    palette.rgb[i * 3 + 2] = data[pos + 3];
    pos += SCI1_ENTRY_SIZE;
  }
  return palette;
}

/**
 * Overlay `top` onto `base`: entries marked used in `top` replace those in `base`.
 * Returns a new palette.
 * @param {Palette} base
 * @param {Palette} top
 * @returns {Palette}
 */
export function mergePalettes(base, top) {
  const merged = { used: base.used.slice(), rgb: base.rgb.slice() };
  for (let i = 0; i < PALETTE_SIZE; i++) {
    if (top.used[i]) {
      merged.used[i] = 1;
      merged.rgb.set(top.rgb.subarray(i * 3, i * 3 + 3), i * 3);
    }
  }
  return merged;
}

/**
 * Convert an indexed bitmap to RGBA.
 * @param {Uint8Array} pixels palette indices
 * @param {Palette} palette
 * @param {number} [transparentIndex] index rendered with alpha 0 (or -1 for none)
 * @returns {Uint8ClampedArray}
 */
export function indexedToRgba(pixels, palette, transparentIndex = -1) {
  const rgba = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    const index = pixels[i];
    rgba[i * 4] = palette.rgb[index * 3];
    rgba[i * 4 + 1] = palette.rgb[index * 3 + 1];
    rgba[i * 4 + 2] = palette.rgb[index * 3 + 2];
    rgba[i * 4 + 3] = index === transparentIndex ? 0 : 255;
  }
  return rgba;
}
