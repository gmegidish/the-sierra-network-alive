// Browser input -> LSCI event queue. Mouse positions are scaled from the
// canvas' CSS size to 320x200; keys become SCI key codes (ASCII, or scan
// code << 8 for cursor keys, as MapKeyToDir expects).
import { EVENT_TYPE } from '../vm/events.js';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from '../gfx/screen.js';

const SPECIAL_KEYS = Object.freeze({
  Enter: 13, Escape: 27, Backspace: 8, Tab: 9, Delete: 0x5300,
  ArrowUp: 0x4800, ArrowDown: 0x5000, ArrowLeft: 0x4b00, ArrowRight: 0x4d00,
  Home: 0x4700, End: 0x4f00, PageUp: 0x4900, PageDown: 0x5100,
  F1: 0x3b00, F2: 0x3c00, F3: 0x3d00, F4: 0x3e00, F5: 0x3f00, F6: 0x4000,
});
const MODIFIER = Object.freeze({ SHIFT: 3, CTRL: 4, ALT: 8 });

function modifiersOf(event) {
  return (event.shiftKey ? MODIFIER.SHIFT : 0) | (event.ctrlKey ? MODIFIER.CTRL : 0) | (event.altKey ? MODIFIER.ALT : 0);
}

function screenPoint(canvas, event) {
  const box = canvas.getBoundingClientRect();
  const x = Math.floor(((event.clientX - box.left) * SCREEN_WIDTH) / box.width);
  const y = Math.floor(((event.clientY - box.top) * SCREEN_HEIGHT) / box.height);
  return { x: Math.min(SCREEN_WIDTH - 1, Math.max(0, x)), y: Math.min(SCREEN_HEIGHT - 1, Math.max(0, y)) };
}

function keyCode(event) {
  if (SPECIAL_KEYS[event.key] !== undefined) {
    return SPECIAL_KEYS[event.key];
  }
  return event.key.length === 1 ? event.key.charCodeAt(0) : 0;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {import('../vm/events.js').EventQueue} queue
 */
export function attachInput(canvas, queue) {
  canvas.addEventListener('mousemove', (event) => {
    const { x, y } = screenPoint(canvas, event);
    queue.moveMouse(x, y);
  });
  for (const [name, type] of [['mousedown', EVENT_TYPE.MOUSE_DOWN], ['mouseup', EVENT_TYPE.MOUSE_UP]]) {
    canvas.addEventListener(name, (event) => {
      queue.push({ type, message: 0, modifiers: modifiersOf(event), ...screenPoint(canvas, event) });
    });
  }
  for (const [name, type] of [['keydown', EVENT_TYPE.KEY_DOWN], ['keyup', EVENT_TYPE.KEY_UP]]) {
    window.addEventListener(name, (event) => {
      const message = keyCode(event);
      if (!message) {
        return;
      }
      event.preventDefault();
      queue.push({ type, message, modifiers: modifiersOf(event) });
    });
  }
}
