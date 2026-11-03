// EditControl(item, event): text entry for edit items (class 47: text, font,
// max, cursor). The dialog passes the focused item with every key event and
// with 0 when focus leaves it. A key edits the text at `cursor`, claims the
// event and redraws the field with a caret; 0 redraws it without one.
import { measureText } from '../../resource/index.js';
import { makeRect } from '../../gfx/graphics.js';
import { rectOf } from './graphics.js';
import { EVENT_TYPE } from '../events.js';

/** @typedef {{ text: string, cursor: number }} EditState */

const KEY = Object.freeze({
  BACKSPACE: 8, DELETE: 0x5300, LEFT: 0x4b00, RIGHT: 0x4d00, HOME: 0x4700, END: 0x4f00,
});
const FIRST_PRINTABLE = 32;
const LAST_PRINTABLE = 126;
const NONE = 0xffff;
const BLACK = 0;
const WHITE = 255;
const VISUAL = 1;
const TEXT_INSET = 1;
/** Class 42 control type of edit items; dialogs pass any focused item (buttons too). */
const EDIT_TYPE = 3;

/** @param {EditState} state @param {number} key @param {number} max @returns {EditState} */
export function applyKey({ text, cursor }, key, max) {
  if (key === KEY.BACKSPACE) {
    return cursor > 0 ? { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 } : { text, cursor };
  }
  if (key === KEY.DELETE) {
    return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
  }
  const moves = {
    [KEY.LEFT]: Math.max(0, cursor - 1), [KEY.RIGHT]: Math.min(text.length, cursor + 1), [KEY.HOME]: 0, [KEY.END]: text.length,
  };
  if (moves[key] !== undefined) {
    return { text, cursor: moves[key] };
  }
  const isRoomLeft = !max || text.length < max;
  if (key >= FIRST_PRINTABLE && key <= LAST_PRINTABLE && isRoomLeft) {
    return { text: text.slice(0, cursor) + String.fromCharCode(key) + text.slice(cursor), cursor: cursor + 1 };
  }
  return { text, cursor };
}

/**
 * Colour already inside the field (its bottom-right inner pixel, which text
 * does not reach). ponytail: items with back = -1 keep whatever DrawControl
 * left there; read the original's edit painter if fields look wrong.
 */
function fieldColorOnScreen(g, rect) {
  const { x, y } = g.toScreen(g.port(), rect.right - TEXT_INSET - 1, rect.bottom - TEXT_INSET - 1);
  return g.screen.visual[y * g.screen.width + x] ?? BLACK;
}

/** @param {number} paper @returns {number} */
function contrastingInk(paper) {
  return paper === BLACK ? WHITE : BLACK;
}

/** Field background, text and (optionally) a one-pixel caret before `cursor`. */
function drawField(vm, item, { text, cursor }, hasCaret) {
  const g = vm.graphics;
  const rect = rectOf(vm, item);
  const back = vm.prop(item, 'back');
  const color = vm.prop(item, 'color');
  const fontNumber = vm.prop(item, 'font');
  const paper = back === NONE ? fieldColorOnScreen(g, rect) : back;
  g.fillRect(makeRect(rect.top + TEXT_INSET, rect.left + TEXT_INSET, rect.bottom - TEXT_INSET, rect.right - TEXT_INSET),
    VISUAL, paper);
  const ink = color === NONE ? contrastingInk(paper) : color;
  g.drawText(text, rect.left + TEXT_INSET, rect.top + TEXT_INSET, { font: fontNumber, color: ink });
  if (hasCaret) {
    const x = rect.left + TEXT_INSET + measureText(g.font(fontNumber), text.slice(0, cursor));
    g.fillRect(makeRect(rect.top + TEXT_INSET, x, rect.bottom - TEXT_INSET, x + 1), VISUAL, ink);
  }
}

function readState(vm, item) {
  const text = vm.strings.read(vm.prop(item, 'text'));
  return { text, cursor: Math.min(vm.prop(item, 'cursor'), text.length) };
}

export function editControl(vm, [item, event = 0]) {
  if (!vm.objects.isObject(item) || vm.prop(item, 'type') !== EDIT_TYPE) {
    return 0;
  }
  const isKey = vm.objects.isObject(event) && vm.prop(event, 'type') === EVENT_TYPE.KEY_DOWN;
  let state = readState(vm, item);
  if (isKey) {
    const next = applyKey(state, vm.prop(event, 'message'), vm.prop(item, 'max'));
    if (next !== state && (next.text !== state.text || next.cursor !== state.cursor)) {
      vm.strings.write(vm.prop(item, 'text'), next.text);
      vm.setProp(item, 'cursor', next.cursor);
      vm.setProp(event, 'claimed', 1);
    }
    state = next;
  }
  drawField(vm, item, state, event !== 0);
  return 0;
}
