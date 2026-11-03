// Graphics state shared by the kernels: ports, fonts, views, pictures and
// saved screen areas. Port semantics follow SCI1 (ScummVM engines/sci/graphics/
// ports.cpp): a port has a screen rectangle, a pen position, colours and a
// font; drawing coordinates are relative to the current port. LSCI hands out
// ports as memory IDs (GetPort / SetPort / WindowNew return them).
import {
  RESOURCE_TYPE, decodeFont, decodeView, decodePalette, mergePalettes, renderPic,
} from '../resource/index.js';
import { MEMORY_TYPE } from '../vm/memory.js';
import { drawGlyphs } from './text.js';

export const PORT_TYPE = 0x23;
const SYSTEM_PALETTE = 999;
const DEFAULT_FONT = 0;
const MENU_BAR_HEIGHT = 10;
const PIC_TOP = MENU_BAR_HEIGHT;
/** SetPort argument for the screen port: -1 as an unsigned VM word. */
const SCREEN_PORT_ID = 0xffff;
const WHITE = 255;
const BLACK = 0;
const PRIORITY_BAND_COUNT = 15;
const DEFAULT_HORIZON = 42;

/**
 * @typedef {{ top: number, left: number, bottom: number, right: number }} Rect
 * @typedef {{ id: number, rect: Rect, penX: number, penY: number, fg: number, bg: number,
 *   font: number, priority: number, savedBits?: number }} Port
 */

export function makeRect(top, left, bottom, right) {
  return { top, left, bottom, right };
}

/** The port's rect limited to the screen: cels never draw outside their port. */
function clipToScreen(rect, screen) {
  return makeRect(Math.max(0, rect.top), Math.max(0, rect.left), Math.min(screen.height, rect.bottom), Math.min(screen.width, rect.right));
}

export class Graphics {
  /** @param {import('../vm/vm.js').Vm} vm */
  constructor(vm) {
    this.vm = vm;
    /** @type {Map<number, Port>} */
    this.ports = new Map();
    this.fonts = new Map();
    this.views = new Map();
    /** @type {Map<number, ReturnType<import('./screen.js').Screen['saveRect']>>} */
    this.savedBits = new Map();
    this.priorityBands = null;
    this.basePalette = null;
    this.screenPort = null;
    this.picPort = null;
    this.current = null;
    this.background = null;
    /** @type {Map<number, Rect>} screen rects of cels drawn by the last Animate */
    this.drawnCels = new Map();
  }

  get screen() {
    return this.vm.screen;
  }

  /** Create the screen and picture ports and load the system palette. */
  init() {
    if (this.screenPort) {
      return;
    }
    const resources = this.vm.resources;
    if (resources.has(RESOURCE_TYPE.PALETTE, SYSTEM_PALETTE)) {
      this.basePalette = decodePalette(resources.get(RESOURCE_TYPE.PALETTE, SYSTEM_PALETTE));
      this.screen.setPalette(this.basePalette);
    }
    this.screenPort = this.newPort(makeRect(0, 0, this.screen.height, this.screen.width));
    this.picPort = this.newPort(makeRect(PIC_TOP, 0, this.screen.height, this.screen.width));
    this.current = this.picPort;
  }

  /** @returns {Port} */
  newPort(rect) {
    const id = this.vm.memory.alloc(PORT_TYPE, 2);
    const port = {
      id, rect: { ...rect }, penX: 0, penY: 0, fg: BLACK, bg: WHITE, font: DEFAULT_FONT, priority: 0,
    };
    this.ports.set(id, port);
    return port;
  }

  disposePort(id) {
    if (this.ports.delete(id)) {
      this.vm.memory.free(id);
    }
    if (this.current && this.current.id === id) {
      this.current = this.picPort;
    }
  }

  /** SetPort(-1) selects the whole-screen port (status line); unknown IDs the picture port. */
  setPort(id) {
    this.init();
    if (id === SCREEN_PORT_ID) {
      this.current = this.screenPort;
      return;
    }
    const port = this.ports.get(id);
    this.current = port ?? this.picPort;
  }

  /** @returns {Port} */
  port() {
    this.init();
    return this.current;
  }

  // ---- resources -------------------------------------------------------

  font(number) {
    if (!this.fonts.has(number)) {
      const resources = this.vm.resources;
      const fallback = resources.has(RESOURCE_TYPE.FONT, number) ? number : DEFAULT_FONT;
      this.fonts.set(number, decodeFont(resources.get(RESOURCE_TYPE.FONT, fallback)));
    }
    return this.fonts.get(number);
  }

  /** @returns {import('../resource/view.js').View | null} */
  view(number) {
    if (!this.views.has(number)) {
      const resources = this.vm.resources;
      this.views.set(number, resources.has(RESOURCE_TYPE.VIEW, number)
        ? decodeView(resources.get(RESOURCE_TYPE.VIEW, number)) : null);
    }
    return this.views.get(number);
  }

  /** Clamp loop/cel and return the cel, or null. */
  cel(viewNumber, loop, cel) {
    const view = this.view(viewNumber);
    if (!view || view.loops.length === 0) {
      return null;
    }
    const loopData = view.loops[Math.min(Math.max(0, loop), view.loops.length - 1)];
    if (loopData.cels.length === 0) {
      return null;
    }
    return loopData.cels[Math.min(Math.max(0, cel), loopData.cels.length - 1)];
  }

  // ---- pictures --------------------------------------------------------

  /** Draw a pic into the picture port area (all three planes). */
  drawPic(number, clear = true) {
    this.init();
    const resources = this.vm.resources;
    if (!resources.has(RESOURCE_TYPE.PIC, number)) {
      this.vm.trace.log('error', `DrawPic: pic ${number} missing`);
      return;
    }
    const pic = renderPic(resources.get(RESOURCE_TYPE.PIC, number));
    if (pic.palette) {
      this.screen.setPalette(mergePalettes(this.basePalette ?? this.screen.palette, pic.palette));
    }
    this.priorityBands = pic.priorityBands;
    this.drawnCels = new Map();
    const top = this.picPort.rect.top;
    for (let y = 0; y < pic.height && y + top < this.screen.height; y++) {
      for (let x = 0; x < pic.width; x++) {
        const src = y * pic.width + x;
        const color = pic.visual[src];
        if (!clear && color === WHITE) {
          continue;
        }
        const dst = (y + top) * this.screen.width + x;
        this.screen.visual[dst] = color;
        this.screen.priority[dst] = pic.priority[src];
        this.screen.control[dst] = pic.control[src];
      }
    }
    this.screen.dirty = true;
    this.snapshotBackground();
  }

  /** Remember the current planes as the static background (pic + addToPics). */
  snapshotBackground() {
    this.background = this.screen.saveRect(makeRect(0, 0, this.screen.height, this.screen.width));
  }

  /** Copy a screen rect back from the static background. */
  restoreBackground(rect) {
    if (!this.background) {
      return;
    }
    const { width } = this.screen;
    const top = Math.max(0, rect.top);
    const bottom = Math.min(this.screen.height, rect.bottom);
    const left = Math.max(0, rect.left);
    const right = Math.min(width, rect.right);
    if (left >= right) {
      return;
    }
    const planes = [this.screen.visual, this.screen.priority, this.screen.control];
    planes.forEach((plane, index) => {
      for (let y = top; y < bottom; y++) {
        plane.set(this.background.planes[index][y].subarray(left, right), y * width + left);
      }
    });
    this.screen.dirty = true;
  }

  /** Priority for a y coordinate (SCI1 priority bands, ScummVM ports.cpp kernelCoordinateToPriority). */
  coordToPriority(y) {
    const bands = this.priorityBands;
    if (!bands || bands.length < PRIORITY_BAND_COUNT - 1) {
      const horizon = DEFAULT_HORIZON;
      return y < horizon ? 0 : Math.min(PRIORITY_BAND_COUNT - 1, Math.floor(((y - horizon) * 10) / (190 - horizon)) + 5);
    }
    for (let p = bands.length - 1; p >= 0; p--) {
      if (y >= bands[p]) {
        return p + 1;
      }
    }
    return 0;
  }

  priorityToCoord(priority) {
    const bands = this.priorityBands;
    if (!bands || priority <= 0) {
      return 0;
    }
    return bands[Math.min(priority, bands.length) - 1];
  }

  // ---- primitives (port-relative coordinates) ---------------------------

  toScreen(port, x, y) {
    return { x: x + port.rect.left, y: y + port.rect.top };
  }

  /** Fill a port-relative rect on the planes selected by `mask` (1 visual, 2 priority, 4 control). */
  fillRect(rect, mask, color, priority = 0, control = 0, port = this.port()) {
    const screenRect = makeRect(
      rect.top + port.rect.top, rect.left + port.rect.left, rect.bottom + port.rect.top, rect.right + port.rect.left,
    );
    if (mask & 1) {
      this.screen.fillRect(screenRect, color, this.screen.visual);
    }
    if (mask & 2) {
      this.screen.fillRect(screenRect, priority, this.screen.priority);
    }
    if (mask & 4) {
      this.screen.fillRect(screenRect, control, this.screen.control);
    }
  }

  frameRect(rect, color, port = this.port()) {
    this.fillRect(makeRect(rect.top, rect.left, rect.top + 1, rect.right), 1, color, 0, 0, port);
    this.fillRect(makeRect(rect.bottom - 1, rect.left, rect.bottom, rect.right), 1, color, 0, 0, port);
    this.fillRect(makeRect(rect.top, rect.left, rect.bottom, rect.left + 1), 1, color, 0, 0, port);
    this.fillRect(makeRect(rect.top, rect.right - 1, rect.bottom, rect.right), 1, color, 0, 0, port);
  }

  /** Bresenham line in port coordinates. */
  drawLine(x0, y0, x1, y1, color, port = this.port()) {
    let x = x0;
    let y = y0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      const p = this.toScreen(port, x, y);
      this.screen.putVisual(p.x, p.y, color);
      if (x === x1 && y === y1) {
        return;
      }
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Draw text at port-relative (x, y) with the port font/colour. */
  drawText(text, x, y, options = {}) {
    const port = options.port ?? this.port();
    const font = this.font(options.font ?? port.font);
    const origin = this.toScreen(port, x, y);
    drawGlyphs(this.screen, font, text, origin.x, origin.y, options.color ?? port.fg);
  }

  /**
   * Draw a view cel with its bottom-centre at port-relative (x, y), honouring
   * priority (pass -1 to ignore the priority plane).
   */
  drawCel(viewNumber, loop, celNumber, x, y, priority = -1, port = this.port()) {
    const rect = this.celRect(viewNumber, loop, celNumber, x, y);
    return this.drawCelAt(viewNumber, loop, celNumber, rect.left, rect.top, priority, port);
  }

  /** Draw a cel with its top-left corner at (left, top), port coordinates (kernel DrawCel). */
  drawCelAt(viewNumber, loop, celNumber, celLeft, celTop, priority = -1, port = this.port()) {
    const cel = this.cel(viewNumber, loop, celNumber);
    if (!cel) {
      return null;
    }
    const left = celLeft + port.rect.left;
    const top = celTop + port.rect.top;
    const { screen } = this;
    const clip = clipToScreen(port.rect, screen);
    for (let row = 0; row < cel.height; row++) {
      const sy = top + row;
      if (sy < clip.top || sy >= clip.bottom) {
        continue;
      }
      for (let col = 0; col < cel.width; col++) {
        const sx = left + col;
        const color = cel.pixels[row * cel.width + col];
        if (color === cel.clearKey || sx < clip.left || sx >= clip.right) {
          continue;
        }
        const offset = sy * screen.width + sx;
        if (priority >= 0 && screen.priority[offset] > priority) {
          continue;
        }
        screen.visual[offset] = color;
        if (priority >= 0) {
          screen.priority[offset] = priority;
        }
      }
    }
    screen.dirty = true;
    return makeRect(top - port.rect.top, left - port.rect.left, top + cel.height - port.rect.top, left + cel.width - port.rect.left);
  }

  /** Rect a cel would occupy (port coordinates). */
  celRect(viewNumber, loop, celNumber, x, y) {
    const cel = this.cel(viewNumber, loop, celNumber);
    if (!cel) {
      return makeRect(y, x, y, x);
    }
    const left = x - (cel.width >> 1) + cel.displaceX;
    const top = y - cel.height + 1 + cel.displaceY;
    return makeRect(top, left, top + cel.height, left + cel.width);
  }

  // ---- saved bits ------------------------------------------------------

  /** Save a screen-coordinate rect; returns a handle ID. */
  saveBits(rect) {
    const id = this.vm.memory.alloc(MEMORY_TYPE.BLOCK, 2);
    this.savedBits.set(id, this.screen.saveRect(rect));
    return id;
  }

  restoreBits(id, free = true) {
    const saved = this.savedBits.get(id);
    if (!saved) {
      return;
    }
    this.screen.restoreRect(saved);
    if (free) {
      this.savedBits.delete(id);
      this.vm.memory.free(id);
    }
  }
}
