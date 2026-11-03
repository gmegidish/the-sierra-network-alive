// Bitmap-font text drawing and word wrapping.
// Reference: ScummVM engines/sci/graphics/text16.cpp (GetLongest, Box, Size).
import { measureText } from '../resource/index.js';

const NEWLINE = '\n';
const CARRIAGE_RETURN = '\r';
const SPACE = ' ';

/**
 * @param {import('./screen.js').Screen} screen
 * @param {import('../resource/font.js').Font} font
 */
export function drawGlyphs(screen, font, text, x, y, color) {
  let penX = x;
  for (const ch of text) {
    const glyph = font.glyphs[ch.charCodeAt(0)];
    if (!glyph) {
      continue;
    }
    for (let row = 0; row < glyph.height; row++) {
      for (let col = 0; col < glyph.width; col++) {
        if (glyph.bits[row * glyph.width + col]) {
          screen.putVisual(penX + col, y + row, color);
        }
      }
    }
    penX += glyph.width;
  }
}

/** Split text into lines no wider than `maxWidth` (0 = no wrapping). */
export function wrapText(font, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.replace(/\r\n?/g, NEWLINE).split(NEWLINE)) {
    if (maxWidth <= 0) {
      lines.push(paragraph);
      continue;
    }
    lines.push(...wrapParagraph(font, paragraph, maxWidth));
  }
  return lines;
}

function wrapParagraph(font, paragraph, maxWidth) {
  // A line that fits is kept verbatim: button labels like " OK " rely on their padding spaces.
  if (measureText(font, paragraph) <= maxWidth) {
    return [paragraph];
  }
  const lines = [];
  let line = '';
  for (const word of paragraph.split(SPACE)) {
    const candidate = line ? `${line}${SPACE}${word}` : word;
    if (line && measureText(font, candidate) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  lines.push(line);
  return lines;
}

/** Size of wrapped text: { width, height, lines }. */
export function measureBox(font, text, maxWidth) {
  const lines = wrapText(font, text.replace(CARRIAGE_RETURN, ''), maxWidth);
  const width = Math.max(0, ...lines.map((line) => measureText(font, line)));
  return { width, height: lines.length * font.lineHeight, lines };
}

/**
 * Draw wrapped text inside a box. `align`: 0 left, 1 centre, -1 right
 * (ScummVM text16.h SCI_TEXT16_ALIGNMENT_*).
 * @param {import('./graphics.js').Graphics} graphics
 */
export function drawTextBox(graphics, text, box, options = {}) {
  const port = options.port ?? graphics.port();
  const font = graphics.font(options.font ?? port.font);
  const width = box.right - box.left;
  const { lines } = measureBox(font, text, width);
  lines.forEach((line, index) => {
    const lineWidth = measureText(font, line);
    let x = box.left;
    if (options.align === -1) {
      x = box.right - lineWidth;
    } else if (options.align === 1) {
      x = box.left + Math.floor((width - lineWidth) / 2);
    }
    graphics.drawText(line, x, box.top + index * font.lineHeight, { ...options, port });
  });
}
