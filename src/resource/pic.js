// SCI1 VGA vector picture renderer -> visual / priority / control planes.
// Reference: ScummVM engines/sci/graphics/picture.cpp (drawVectorData,
// drawCelData, vectorGet*Coords, vectorPattern*).
import {
  createPicCanvas, drawingMask, putPixel, drawLine, floodFill, NO_DRAW, WHITE, MASK_VISUAL, MASK_PRIORITY,
} from './pic-canvas.js';
import { PATTERN_CIRCLES, PATTERN_TEXTURE_BITS, PATTERN_TEXTURE_OFFSETS } from './pic-patterns.js';
import { readCelHeader, unpackCelRle, CEL_HEADER_SIZE } from './cel.js';
import { decodePalette, SCI1_PALETTE_BYTES } from './palette.js';

export const PIC_WIDTH = 320;
// SCI1 draws pictures into the 320x190 picture port (screen rows 10..199).
export const PIC_HEIGHT = 190;

const OP = Object.freeze({
  SET_COLOR: 0xf0,
  DISABLE_VISUAL: 0xf1,
  SET_PRIORITY: 0xf2,
  DISABLE_PRIORITY: 0xf3,
  SHORT_PATTERNS: 0xf4,
  MEDIUM_LINES: 0xf5,
  LONG_LINES: 0xf6,
  SHORT_LINES: 0xf7,
  FILL: 0xf8,
  SET_PATTERN: 0xf9,
  ABSOLUTE_PATTERN: 0xfa,
  SET_CONTROL: 0xfb,
  DISABLE_CONTROL: 0xfc,
  MEDIUM_PATTERNS: 0xfd,
  EXTENDED: 0xfe,
  TERMINATE: 0xff,
});
const FIRST_OPCODE = OP.SET_COLOR;

const OPX = Object.freeze({
  SET_PALETTE_ENTRIES: 0,
  EMBEDDED_VIEW: 1,
  SET_PALETTE: 2,
  PRIORITY_TABLE_EQDIST: 3,
  PRIORITY_TABLE_EXPLICIT: 4,
});

const PATTERN_RECTANGLE = 0x10;
const PATTERN_USE_TEXTURE = 0x20;
const PATTERN_SIZE_MASK = 0x07;
const PRIORITY_TABLE_EXPLICIT_SIZE = 14;
const MAX_PRIORITY = 15;
const NIBBLE_MASK = 0x0f;

/** Cursor over the opcode stream. */
function createReader(data) {
  let pos = 0;
  const reader = {
    get pos() { return pos; },
    skip(n) { pos += n; },
    byte() { return data[pos++]; },
    word() {
      const value = data[pos] | (data[pos + 1] << 8);
      pos += 2;
      return value;
    },
    atParameter() { return pos < data.length && data[pos] < FIRST_OPCODE; },
    done() { return pos >= data.length; },
  };
  return reader;
}

function readAbsCoords(r) {
  const high = r.byte();
  const x = r.byte() + ((high & 0xf0) << 4);
  const y = r.byte() + ((high & 0x0f) << 8);
  return { x, y };
}

function readRelCoords(r, point) {
  const delta = r.byte();
  const dx = delta & 0x80 ? -((delta >> 4) & 7) : delta >> 4;
  const dy = delta & 0x08 ? -(delta & 7) : delta & 7;
  return { x: point.x + dx, y: point.y + dy };
}

function readRelCoordsMedium(r, point) {
  const deltaY = r.byte();
  const y = point.y + (deltaY & 0x80 ? -(deltaY & 0x7f) : deltaY);
  const deltaX = r.byte();
  const x = point.x + (deltaX & 0x80 ? -(128 - (deltaX & 0x7f)) : deltaX);
  return { x, y };
}

function patternBox(canvas, x, y, size) {
  let left = Math.max(0, x - size);
  let top = Math.max(0, y - size);
  const width = size * 2 + 2;
  const height = size * 2 + 1;
  if (left + width > canvas.width + 1) {
    left = canvas.width + 1 - width;
  }
  if (top + height > canvas.height) {
    top = canvas.height - height;
  }
  return { left, top, right: left + width, bottom: top + height };
}

function swapDitherColor(color) {
  if (!(color & 0xf0)) {
    return color;
  }
  let c = color ^ ((color << 4) & 0xff);
  c = ((c << 4) | (c >> 4)) & 0xff;
  return c ^ ((c << 4) & 0xff);
}

function plotBoxPixel(canvas, x, y, pen) {
  if (x < 0 || y < 0 || y >= canvas.height) {
    return;
  }
  if (x < canvas.width) {
    putPixel(canvas, x, y, pen.mask, pen.color, pen.priority, pen.control);
  } else if (y < canvas.height - 1) {
    // Original wrap-around quirk: overflow column lands at x=0 on the next row.
    putPixel(canvas, 0, y + 1, pen.mask, swapDitherColor(pen.color), pen.priority, pen.control);
  }
}

function plotCirclePixel(canvas, x, y, pen) {
  if (x >= 0 && y >= 0 && x < canvas.width && y < canvas.height) {
    putPixel(canvas, x, y, pen.mask, pen.color, pen.priority, pen.control);
  }
}

function drawPattern(canvas, point, pen, code, texture) {
  const size = code & PATTERN_SIZE_MASK;
  const box = patternBox(canvas, point.x, point.y, size);
  const useTexture = (code & PATTERN_USE_TEXTURE) !== 0;
  let textureIndex = PATTERN_TEXTURE_OFFSETS[texture] ?? 0;
  const textureAllows = () => !useTexture || PATTERN_TEXTURE_BITS[textureIndex++] === 1;
  if (code & PATTERN_RECTANGLE) {
    for (let y = box.top; y < box.bottom; y++) {
      for (let x = box.left; x < box.right; x++) {
        if (textureAllows()) {
          plotBoxPixel(canvas, x, y, pen);
        }
      }
    }
    return;
  }
  const circle = PATTERN_CIRCLES[size];
  let bitIndex = 0;
  for (let y = box.top; y < box.bottom; y++) {
    for (let x = box.left; x < box.right; x++) {
      const inCircle = (circle[bitIndex >> 3] >> (bitIndex & 7)) & 1;
      bitIndex++;
      if (inCircle && textureAllows()) {
        plotCirclePixel(canvas, x, y, pen);
      }
    }
  }
}

function drawEmbeddedCel(canvas, data, celOffset, origin, priority) {
  const header = readCelHeader(data, celOffset);
  // Not an add-to-pic draw: the clear color becomes white, so everything but white is painted.
  const { pixels } = unpackCelRle(data, celOffset + CEL_HEADER_SIZE, header.width * header.height, header.clearKey);
  const mask = priority > MAX_PRIORITY ? MASK_VISUAL : MASK_VISUAL | MASK_PRIORITY;
  for (let row = 0; row < header.height; row++) {
    const y = origin.y + row;
    if (y < 0 || y >= canvas.height) {
      continue;
    }
    for (let col = 0; col < header.width; col++) {
      const x = origin.x + col;
      const color = pixels[row * header.width + col];
      const visible = x >= 0 && x < canvas.width && color !== WHITE;
      if (visible && priority >= canvas.priority[y * canvas.width + x]) {
        putPixel(canvas, x, y, mask, color, priority, 0);
      }
    }
  }
}

function patternTexture(r, code) {
  return code & PATTERN_USE_TEXTURE ? (r.byte() >> 1) & 0x7f : 0;
}

/**
 * Render an SCI1 VGA vector picture.
 * @param {Uint8Array} data decompressed pic resource
 * @param {{ width?: number, height?: number, embeddedCelPriority?: number }} [options]
 *   embeddedCelPriority: SCI1-early interpreters draw embedded cels at priority 0
 *   (ScummVM: getSciVersion() <= SCI_VERSION_1_EARLY); pass -1 to use the current pen priority.
 * @returns {{ width: number, height: number, visual: Uint8Array, priority: Uint8Array,
 *   control: Uint8Array, palette: import('./palette.js').Palette | null,
 *   priorityBands: number[] | null }}
 */
export function renderPic(data, options = {}) {
  const canvas = createPicCanvas(options.width ?? PIC_WIDTH, options.height ?? PIC_HEIGHT);
  const celPriorityOverride = options.embeddedCelPriority ?? 0;
  const r = createReader(data);
  const pen = { color: 0, priority: NO_DRAW, control: NO_DRAW, mask: 0 };
  const refreshMask = () => {
    pen.mask = drawingMask(pen.color, pen.priority, pen.control);
  };
  refreshMask();
  let point = { x: 0, y: 0 };
  let patternCode = 0;
  let palette = null;
  let priorityBands = null;

  const line = (next) => {
    drawLine(canvas, point.x, point.y, next.x, next.y, pen.color, pen.priority, pen.control);
    point = next;
  };

  while (!r.done()) {
    const op = r.byte();
    switch (op) {
      case OP.SET_COLOR: pen.color = r.byte(); break;
      case OP.DISABLE_VISUAL: pen.color = NO_DRAW; break;
      case OP.SET_PRIORITY: pen.priority = r.byte() & NIBBLE_MASK; break;
      case OP.DISABLE_PRIORITY: pen.priority = NO_DRAW; break;
      case OP.SET_CONTROL: pen.control = r.byte() & NIBBLE_MASK; break;
      case OP.DISABLE_CONTROL: pen.control = NO_DRAW; break;
      case OP.SHORT_LINES:
        point = readAbsCoords(r);
        while (r.atParameter()) {
          line(readRelCoords(r, point));
        }
        break;
      case OP.MEDIUM_LINES:
        point = readAbsCoords(r);
        while (r.atParameter()) {
          line(readRelCoordsMedium(r, point));
        }
        break;
      case OP.LONG_LINES:
        point = readAbsCoords(r);
        while (r.atParameter()) {
          line(readAbsCoords(r));
        }
        break;
      case OP.FILL:
        while (r.atParameter()) {
          point = readAbsCoords(r);
          floodFill(canvas, point.x, point.y, pen.color, pen.priority, pen.control);
        }
        break;
      case OP.SET_PATTERN: patternCode = r.byte(); break;
      case OP.SHORT_PATTERNS:
      case OP.MEDIUM_PATTERNS: {
        const readNext = op === OP.SHORT_PATTERNS ? readRelCoords : readRelCoordsMedium;
        refreshMask();
        let texture = patternTexture(r, patternCode);
        point = readAbsCoords(r);
        drawPattern(canvas, point, pen, patternCode, texture);
        while (r.atParameter()) {
          texture = patternTexture(r, patternCode);
          point = readNext(r, point);
          drawPattern(canvas, point, pen, patternCode, texture);
        }
        break;
      }
      case OP.ABSOLUTE_PATTERN:
        refreshMask();
        while (r.atParameter()) {
          const texture = patternTexture(r, patternCode);
          point = readAbsCoords(r);
          drawPattern(canvas, point, pen, patternCode, texture);
        }
        break;
      case OP.EXTENDED: {
        const sub = r.byte();
        if (sub === OPX.SET_PALETTE_ENTRIES) {
          while (r.atParameter()) {
            r.skip(1);
          }
        } else if (sub === OPX.SET_PALETTE) {
          palette = decodePalette(data, r.pos);
          r.skip(SCI1_PALETTE_BYTES);
        } else if (sub === OPX.EMBEDDED_VIEW) {
          const origin = readAbsCoords(r);
          const size = r.word();
          const priority = celPriorityOverride < 0 ? pen.priority : celPriorityOverride;
          drawEmbeddedCel(canvas, data, r.pos, origin, priority);
          r.skip(size);
        } else if (sub === OPX.PRIORITY_TABLE_EQDIST) {
          priorityBands = [r.word(), r.word()];
        } else if (sub === OPX.PRIORITY_TABLE_EXPLICIT) {
          priorityBands = Array.from(data.subarray(r.pos, r.pos + PRIORITY_TABLE_EXPLICIT_SIZE));
          r.skip(PRIORITY_TABLE_EXPLICIT_SIZE);
        } else {
          throw new Error(`pic: unsupported extended opcode ${sub} at ${r.pos - 1}`);
        }
        break;
      }
      case OP.TERMINATE:
        return { ...canvas, palette, priorityBands };
      default:
        throw new Error(`pic: unsupported opcode 0x${op.toString(16)} at ${r.pos - 1}`);
    }
  }
  throw new Error('pic: vector data without terminator');
}
