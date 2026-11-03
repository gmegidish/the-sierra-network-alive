// Helpers that turn decoded resources into RGBA images for the dump tool.
import { indexedToRgba, mergePalettes } from '../src/resource/index.js';

const SHEET_GAP = 2;
const SHEET_BACKGROUND = Object.freeze([64, 64, 64, 255]);
const EGA_COLORS = Object.freeze([
  [0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170], [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170],
  [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255], [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255],
]);
const GLYPH_INK = Object.freeze([255, 255, 255, 255]);
const GLYPHS_PER_ROW = 16;

/** @returns {{ width: number, height: number, rgba: Uint8ClampedArray }} */
function createImage(width, height, fill) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba.set(fill, i * 4);
  }
  return { width, height, rgba };
}

function blit(target, source, sourceWidth, sourceHeight, left, top) {
  for (let y = 0; y < sourceHeight; y++) {
    for (let x = 0; x < sourceWidth; x++) {
      const from = (y * sourceWidth + x) * 4;
      if (source[from + 3] === 0) {
        continue;
      }
      const to = ((top + y) * target.width + left + x) * 4;
      target.rgba.set(source.subarray(from, from + 4), to);
    }
  }
}

/** Render a 16-level plane (priority/control) using EGA colors. */
export function planeToRgba(plane) {
  const rgba = new Uint8ClampedArray(plane.length * 4);
  for (let i = 0; i < plane.length; i++) {
    const [r, g, b] = EGA_COLORS[plane[i] & 0x0f];
    rgba.set([r, g, b, 255], i * 4);
  }
  return rgba;
}

/** Picture visual plane -> RGBA, using the pic's embedded palette over the base palette. */
export function picToRgba(pic, basePalette) {
  const palette = pic.palette ? mergePalettes(basePalette, pic.palette) : basePalette;
  return indexedToRgba(pic.visual, palette);
}

/** Lay out the first cel of every loop side by side. */
export function viewFirstCelsSheet(view, basePalette) {
  const palette = view.palette ? mergePalettes(basePalette, view.palette) : basePalette;
  const cels = view.loops.map((loop) => loop.cels[0]).filter((cel) => cel && cel.width > 0 && cel.height > 0);
  if (cels.length === 0) {
    return null;
  }
  const width = cels.reduce((sum, cel) => sum + cel.width + SHEET_GAP, SHEET_GAP);
  const height = Math.max(...cels.map((cel) => cel.height)) + SHEET_GAP * 2;
  const sheet = createImage(width, height, SHEET_BACKGROUND);
  let left = SHEET_GAP;
  for (const cel of cels) {
    blit(sheet, indexedToRgba(cel.pixels, palette, cel.clearKey), cel.width, cel.height, left, SHEET_GAP);
    left += cel.width + SHEET_GAP;
  }
  return sheet;
}

/** Glyph sheet, 16 glyphs per row. */
export function fontSheet(font) {
  const cellWidth = Math.max(1, ...font.glyphs.map((glyph) => glyph.width)) + SHEET_GAP;
  const cellHeight = Math.max(1, font.lineHeight, ...font.glyphs.map((glyph) => glyph.height)) + SHEET_GAP;
  const rows = Math.ceil(font.glyphs.length / GLYPHS_PER_ROW);
  const sheet = createImage(cellWidth * GLYPHS_PER_ROW, cellHeight * rows, SHEET_BACKGROUND);
  font.glyphs.forEach((glyph, index) => {
    const ink = new Uint8ClampedArray(glyph.width * glyph.height * 4);
    glyph.bits.forEach((bit, i) => {
      if (bit) {
        ink.set(GLYPH_INK, i * 4);
      }
    });
    const left = (index % GLYPHS_PER_ROW) * cellWidth;
    const top = Math.floor(index / GLYPHS_PER_ROW) * cellHeight;
    blit(sheet, ink, glyph.width, glyph.height, left, top);
  });
  return sheet;
}
