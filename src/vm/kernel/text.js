// Text and control kernels.
// TextSize(rectObj, text, font [, maxWidth]) 0x50a:0x512 writes the text's
// box into rectObj.top/left/bottom/right. Display(text, cmd, args...)
// 0x50a:0x55a, commands: 100 at(x, y), 101 align, 102 color, 103 back
// (-1 none), 104 (one arg, unknown), 105 font, 106 width, 107 save-under
// (returns a handle), 108 restore(handle), 121 no-show.
// GetFarText(module, index, buf) 0x50a:0x82c copies text resource strings.
// DrawControl/HiliteControl(control) and EditControl(control, event) at
// 0x4b1:0x4b2.. draw the control kinds of class 42: 1 button, 2 text,
// 3 edit, 4 icon (property layout from class dump, see docs/vm.md).
import { RESOURCE_TYPE, decodeText } from '../../resource/index.js';
import { measureBox, drawTextBox } from '../../gfx/text.js';
import { makeRect } from '../../gfx/graphics.js';
import { rectOf } from './graphics.js';
import { editControl } from './edit.js';

/**
 * @typedef {{ x: number, y: number, align: number, color: number, back: number, font: number,
 *   width: number, saveUnder: boolean, show: boolean }} DisplayState
 */

const DISPLAY = Object.freeze({
  AT: 100, ALIGN: 101, COLOR: 102, BACK: 103, UNKNOWN_104: 104, FONT: 105, WIDTH: 106,
  SAVE_UNDER: 107, RESTORE: 108, NO_SHOW: 121,
});
const NONE = 0xffff;
const CONTROL_TYPE = Object.freeze({ BUTTON: 1, TEXT: 2, EDIT: 3, ICON: 4 });
const DEFAULT_TEXT_WIDTH = 192;
const BLACK = 0;
const HILITE_COLOR = 9;

function signedValue(value) {
  return value & 0x8000 ? value - 0x10000 : value;
}

function textSize(vm, [rect, text, font = 0, maxWidth = 0]) {
  const box = measureBox(vm.graphics.font(font), vm.strings.read(text), signedValue(maxWidth) || DEFAULT_TEXT_WIDTH);
  vm.setProp(rect, 'top', 0);
  vm.setProp(rect, 'left', 0);
  vm.setProp(rect, 'bottom', box.height);
  vm.setProp(rect, 'right', box.width);
  return undefined;
}

/** @returns {{ state: DisplayState, result: number | undefined }} */
function parseDisplayCommands(vm, port, commands) {
  const state = {
    x: port.penX, y: port.penY, align: 0, color: port.fg, back: NONE, font: port.font, width: 0, saveUnder: false, show: true,
  };
  let result;
  for (let i = 0; i < commands.length; i++) {
    switch (commands[i]) {
      case DISPLAY.AT: state.x = signedValue(commands[++i]); state.y = signedValue(commands[++i]); break;
      case DISPLAY.ALIGN: state.align = signedValue(commands[++i]); break;
      case DISPLAY.COLOR: state.color = commands[++i]; break;
      case DISPLAY.BACK: state.back = commands[++i]; break;
      case DISPLAY.UNKNOWN_104: i++; break;
      case DISPLAY.FONT: state.font = commands[++i]; break;
      case DISPLAY.WIDTH: state.width = commands[++i]; break;
      case DISPLAY.SAVE_UNDER: state.saveUnder = true; break;
      case DISPLAY.RESTORE: vm.graphics.restoreBits(commands[++i]); result = 0; break;
      case DISPLAY.NO_SHOW: state.show = false; break;
      default: vm.trace.log('todo', `Display command ${commands[i]}`);
    }
  }
  return { state, result };
}

function display(vm, [text, ...commands]) {
  const g = vm.graphics;
  const port = g.port();
  const { state, result } = parseDisplayCommands(vm, port, commands);
  const string = vm.strings.isString(text) ? vm.strings.read(text) : '';
  if (!string) {
    return result;
  }
  const font = g.font(state.font);
  const size = measureBox(font, string, state.width || DEFAULT_TEXT_WIDTH);
  const box = makeRect(state.y, state.x, state.y + size.height, state.x + (state.width || size.width));
  let handle = 0;
  if (state.saveUnder) {
    handle = g.saveBits(makeRect(box.top + port.rect.top, box.left + port.rect.left, box.bottom + port.rect.top, box.right + port.rect.left));
  }
  if (state.back !== NONE) {
    g.fillRect(box, 1, state.back, 0, 0, port);
  }
  drawTextBox(g, string, box, { align: state.align, font: state.font, color: state.color, port });
  return state.saveUnder ? handle : result;
}

function getFarText(vm, [module, index, buffer]) {
  if (!vm.resources.has(RESOURCE_TYPE.TEXT, module)) {
    return 0;
  }
  const text = decodeText(vm.resources.get(RESOURCE_TYPE.TEXT, module))[index] ?? '';
  if (vm.memory.isValid(buffer)) {
    vm.strings.write(buffer, text);
    return buffer;
  }
  return vm.strings.create(text);
}

function drawControlText(vm, control, rect, align) {
  const text = vm.prop(control, 'text');
  if (!vm.strings.isString(text)) {
    return;
  }
  const color = vm.prop(control, 'color');
  drawTextBox(vm.graphics, vm.strings.read(text), rect, {
    // No colour of its own: the port's pen (white in the map's land chooser, black in most dialogs).
    align, font: vm.prop(control, 'font'), color: color === NONE ? vm.graphics.port().fg : color,
  });
}

function drawControl(vm, [control]) {
  const g = vm.graphics;
  const rect = rectOf(vm, control);
  const back = vm.prop(control, 'back');
  if (back !== NONE) {
    g.fillRect(rect, 1, back);
  }
  const type = vm.prop(control, 'type');
  if (type === CONTROL_TYPE.ICON || vm.prop(control, 'view')) {
    g.drawCelAt(vm.prop(control, 'view'), vm.prop(control, 'loop'), vm.prop(control, 'cel'), rect.left, rect.top, -1);
  }
  if (type === CONTROL_TYPE.BUTTON || type === CONTROL_TYPE.EDIT) {
    g.frameRect(rect, BLACK);
  }
  drawControlText(vm, control, type === CONTROL_TYPE.EDIT ? makeRect(rect.top + 1, rect.left + 1, rect.bottom, rect.right) : rect,
    signedValue(vm.prop(control, 'mode')));
  return undefined;
}

function hiliteControl(vm, [control]) {
  vm.graphics.frameRect(rectOf(vm, control), HILITE_COLOR);
  return undefined;
}

export const textKernels = Object.freeze({
  TextSize: textSize,
  Display: display,
  GetFarText: getFarText,
  DrawControl: drawControl,
  HiliteControl: hiliteControl,
  EditControl: editControl,
  Menu: () => 0,
});
