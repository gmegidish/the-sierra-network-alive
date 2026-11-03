// Picture, port, window and Graph kernels.
// Sub-op numbering from LSCITV.EXE: kGraph dispatch table at DS:0x3d7
// (segment 0x599), WindowNew at 0x3e7:0xba0 (reads the window object's
// top/left/bottom/right, frameRect, borderSize, shadowSize, priority, type,
// title). Rect arguments are Rect objects (top/left/bottom/right properties).
// Drawing semantics follow SCI1 (ScummVM kgraphics.cpp) where they match.
import { makeRect } from '../../gfx/graphics.js';

const GRAPH = Object.freeze({
  COLOR_COUNT: 1, DRAW_LINE: 3, SAVE_BITS: 6, RESTORE_BITS: 7, FILL_BOX: 10, SHOW_BITS: 11,
  REDRAW_BOX: 12, SAVE_BITS_ALT: 14, RESTORE_BITS_ALT: 15,
});
// Window type bits (WindowNew 0x3e7:0x26f / draw 0x3e7:0x42e): 1 save-under
// and fill, 2 title bar, 0x8000 the script draws the window itself.
const WINDOW_TYPE = Object.freeze({ SAVE_AND_FILL: 0x1, TITLE: 0x2, CUSTOM: 0x8000 });
const COLOR_COUNT = 256;
const UNSET = 0xffff;
const VISUAL_MASK = 1;
const BORDER_COLOR = 0;

/** Rect object -> {top, left, bottom, right}. */
export function rectOf(vm, object) {
  if (!vm.objects.isObject(object)) {
    return makeRect(0, 0, 0, 0);
  }
  return makeRect(
    signedProp(vm, object, 'top'), signedProp(vm, object, 'left'),
    signedProp(vm, object, 'bottom'), signedProp(vm, object, 'right'),
  );
}

function signedProp(vm, object, name) {
  const value = vm.prop(object, name);
  return value & 0x8000 ? value - 0x10000 : value;
}

/** Screen rect for a rect given in current-port coordinates. */
function toScreenRect(vm, rect) {
  const port = vm.graphics.port();
  return makeRect(rect.top + port.rect.top, rect.left + port.rect.left, rect.bottom + port.rect.top, rect.right + port.rect.left);
}

function drawPic(vm, [picture, , clear = 1]) {
  vm.graphics.drawPic(picture, clear !== 0);
  return undefined;
}

function graph(vm, args) {
  const [op, a = 0, b = 0, c = 0, d = 0, e = 0] = args;
  const g = vm.graphics;
  switch (op) {
    case GRAPH.COLOR_COUNT: return COLOR_COUNT;
    case GRAPH.DRAW_LINE: g.drawLine(b, a, d, c, e); return undefined;
    case GRAPH.SAVE_BITS:
    case GRAPH.SAVE_BITS_ALT: return g.saveBits(toScreenRect(vm, rectOf(vm, a)));
    case GRAPH.RESTORE_BITS:
    case GRAPH.RESTORE_BITS_ALT: g.restoreBits(a); return undefined;
    case GRAPH.FILL_BOX: g.fillRect(rectOf(vm, a), b, c, d, e); return undefined;
    case GRAPH.SHOW_BITS:
    case GRAPH.REDRAW_BOX: vm.screen.dirty = true; return undefined;
    default:
      vm.trace.log('todo', `Graph(${args.join(', ')})`);
      return 0;
  }
}

/** Grow a rect by `size` on every side. */
function grow(rect, size) {
  return makeRect(rect.top - size, rect.left - size, rect.bottom + size, rect.right + size);
}

/** Border of `size` pixels outside `rect`, then a shadow strip right and below (0x3e7:0x860). */
function drawWindowFrame(g, rect, border, shadow) {
  const outer = grow(rect, border);
  if (shadow) {
    g.fillRect(makeRect(outer.bottom, outer.left + shadow, outer.bottom + shadow, outer.right + shadow), VISUAL_MASK, BORDER_COLOR, 0, 0, g.screenPort);
    g.fillRect(makeRect(outer.top + shadow, outer.right, outer.bottom, outer.right + shadow), VISUAL_MASK, BORDER_COLOR, 0, 0, g.screenPort);
  }
  if (border) {
    [makeRect(outer.top, outer.left, rect.top, outer.right), makeRect(rect.bottom, outer.left, outer.bottom, outer.right),
      makeRect(rect.top, outer.left, rect.bottom, rect.left), makeRect(rect.top, rect.right, rect.bottom, outer.right)]
      .forEach((strip) => g.fillRect(strip, VISUAL_MASK, BORDER_COLOR, 0, 0, g.screenPort));
  }
}

function sizeProp(vm, window, name) {
  const value = vm.prop(window, name);
  return value === UNSET ? 0 : value;
}

/**
 * WindowNew(window): open a port on the window's rect. Type 0x8000 windows
 * are drawn by the scripts (Graph 14 saves under them); otherwise bit 1 saves
 * the frame area and fills the port, then border and shadow are drawn.
 * ponytail: the title bar (type bit 2) isn't drawn yet.
 */
function windowNew(vm, [window]) {
  const g = vm.graphics;
  g.init();
  // Window rects are relative to the window-manager port, which starts below the status bar.
  const local = rectOf(vm, window);
  const top = g.picPort.rect.top;
  const rect = makeRect(local.top + top, local.left, local.bottom + top, local.right);
  const type = vm.prop(window, 'type');
  const border = sizeProp(vm, window, 'borderSize');
  const shadow = sizeProp(vm, window, 'shadowSize');
  const back = vm.prop(window, 'back');
  const port = g.newPort(rect);
  port.bg = back === UNSET ? port.bg : back;
  const color = vm.prop(window, 'color');
  port.fg = color === UNSET ? port.fg : color;
  if ((type & WINDOW_TYPE.CUSTOM) === 0) {
    if (type & WINDOW_TYPE.SAVE_AND_FILL) {
      const outer = grow(rect, border);
      port.savedBits = g.saveBits(makeRect(outer.top, outer.left, outer.bottom + shadow, outer.right + shadow));
      g.fillRect(rect, VISUAL_MASK, port.bg, 0, 0, g.screenPort);
    }
    drawWindowFrame(g, rect, border, shadow);
  }
  g.current = port;
  return port.id;
}

/** WindowDispose(id): put back what the window covered, then drop the port. */
function windowDispose(vm, [id]) {
  const g = vm.graphics;
  const saved = g.ports.get(id)?.savedBits;
  if (saved) {
    g.restoreBits(saved);
  }
  g.disposePort(id);
  return undefined;
}

function globalToLocal(vm, [event], direction) {
  const port = vm.graphics.port();
  vm.setProp(event, 'x', vm.prop(event, 'x') + direction * port.rect.left);
  vm.setProp(event, 'y', vm.prop(event, 'y') + direction * port.rect.top);
  return undefined;
}

/** Palette (k89, added by GRAPH256.DLL): sub-op 5 = find closest colour. */
function palette(vm, [op, r = 0, g = 0, b = 0]) {
  const FIND_COLOR = 5;
  if (op !== FIND_COLOR) {
    return 0;
  }
  vm.graphics.init(); // loads the system palette when FindColor runs before any drawing
  const rgb = vm.screen.palette.rgb;
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < rgb.length / 3; i++) {
    const distance = (rgb[i * 3] - r) ** 2 + (rgb[i * 3 + 1] - g) ** 2 + (rgb[i * 3 + 2] - b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

export const graphicsKernels = Object.freeze({
  DrawPic: drawPic,
  PicState: () => 0,
  Show: () => undefined,
  ShakeScreen: () => undefined,
  CoordPri: (vm, [value, toCoord = 0]) => (toCoord ? vm.graphics.priorityToCoord(value) : vm.graphics.coordToPriority(value)),
  GetPort: (vm) => vm.graphics.port().id,
  SetPort: (vm, [id = 0]) => {
    vm.graphics.setPort(id);
    return undefined;
  },
  WindowNew: windowNew,
  WindowDispose: windowDispose,
  Graph: graph,
  BaseRectSet: () => undefined,
  GlobalToLocal: (vm, args) => globalToLocal(vm, args, -1),
  LocalToGlobal: (vm, args) => globalToLocal(vm, args, 1),
  ColorUp: () => undefined,
  ColorDown: () => undefined,
  Palette: palette,
});
