// 320x200 indexed framebuffer with SCI's three planes (visual, priority,
// control) plus the current 256-colour palette.
// Reference: ScummVM engines/sci/graphics/screen.cpp.
import { createEmptyPalette } from '../resource/index.js';

export const SCREEN_WIDTH = 320;
export const SCREEN_HEIGHT = 200;
const OPAQUE = 255;

export class Screen {
  constructor() {
    this.width = SCREEN_WIDTH;
    this.height = SCREEN_HEIGHT;
    this.visual = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    this.priority = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    this.control = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    this.palette = createEmptyPalette();
    this.dirty = true;
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  putVisual(x, y, color) {
    if (this.inBounds(x, y)) {
      this.visual[y * this.width + x] = color;
      this.dirty = true;
    }
  }

  /** @param {{ top: number, left: number, bottom: number, right: number }} rect */
  fillRect(rect, color, plane = this.visual) {
    const top = Math.max(0, rect.top);
    const left = Math.max(0, rect.left);
    const bottom = Math.min(this.height, rect.bottom);
    const right = Math.min(this.width, rect.right);
    for (let y = top; y < bottom; y++) {
      plane.fill(color, y * this.width + left, y * this.width + Math.max(left, right));
    }
    this.dirty = true;
  }

  /** Copy a rectangle of all three planes (for save/restore of bits). */
  saveRect(rect) {
    const planes = [this.visual, this.priority, this.control].map((plane) => {
      const rows = [];
      for (let y = Math.max(0, rect.top); y < Math.min(this.height, rect.bottom); y++) {
        rows.push(plane.slice(y * this.width + Math.max(0, rect.left), y * this.width + Math.min(this.width, rect.right)));
      }
      return rows;
    });
    return { rect: { ...rect }, planes };
  }

  restoreRect(saved) {
    const top = Math.max(0, saved.rect.top);
    const left = Math.max(0, saved.rect.left);
    [this.visual, this.priority, this.control].forEach((plane, index) => {
      saved.planes[index].forEach((row, i) => plane.set(row, (top + i) * this.width + left));
    });
    this.dirty = true;
  }

  /** @param {import('../resource/palette.js').Palette} palette */
  setPalette(palette) {
    this.palette = palette;
    this.dirty = true;
  }

  /** @returns {{ width: number, height: number, rgba: Uint8ClampedArray }} */
  toRgba(target = new Uint8ClampedArray(this.width * this.height * 4)) {
    const rgb = this.palette.rgb;
    for (let i = 0; i < this.visual.length; i++) {
      const index = this.visual[i] * 3;
      target[i * 4] = rgb[index];
      target[i * 4 + 1] = rgb[index + 1];
      target[i * 4 + 2] = rgb[index + 2];
      target[i * 4 + 3] = OPAQUE;
    }
    return { width: this.width, height: this.height, rgba: target };
  }
}
