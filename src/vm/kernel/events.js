// Input kernels. GetEvent (0x6a6:0x515): arg1 bit 0x8000 = peek, otherwise
// take; the event is written into the Event object (type, message, modifiers,
// y, x in global coordinates) and acc = non-zero when an event was found.
// SetCursor (0x6a6:0x5b0): argc 1 show (non-zero) / hide, 2 setPos(x, y),
// 3 (view, loop, cel), 5 (view, loop, cel, hotX, hotY); argc 3 passes hotspot -1.
// MapKeyToDir follows stock SCI1 (ScummVM kevent.cpp).
import { EVENT_TYPE } from '../events.js';

const PEEK_FLAG = 0x8000;
const NO_HOTSPOT = 0xffff;
const EVENT_MASK = 0x7fff;
const ARROW_DIRECTIONS = Object.freeze(new Map([
  [0x4800, 1], [0x4900, 2], [0x4d00, 3], [0x5100, 4],
  [0x5000, 5], [0x4f00, 6], [0x4b00, 7], [0x4700, 8], [0x4c00, 0],
]));

function getEvent(vm, [mask, object]) {
  const event = vm.events.take(mask & EVENT_MASK, (mask & PEEK_FLAG) === 0);
  vm.setProp(object, 'type', event.type);
  vm.setProp(object, 'message', event.message);
  vm.setProp(object, 'modifiers', event.modifiers);
  vm.setProp(object, 'x', event.x);
  vm.setProp(object, 'y', event.y);
  if (event.type === EVENT_TYPE.NULL) {
    vm.idleGetEvents = (vm.idleGetEvents ?? 0) + 1;
  }
  return event.type === EVENT_TYPE.NULL ? 0 : 1;
}

function mapKeyToDir(vm, [object]) {
  if (vm.prop(object, 'type') !== EVENT_TYPE.KEY_DOWN) {
    return object;
  }
  const direction = ARROW_DIRECTIONS.get(vm.prop(object, 'message'));
  if (direction !== undefined) {
    vm.setProp(object, 'type', EVENT_TYPE.DIRECTION);
    vm.setProp(object, 'message', direction);
  }
  return object;
}

/** SetCursor(show) / (x, y) / (view, loop, cel): the cursor itself is an overlay (gfx/cursor.js). */
function setCursor(vm, args) {
  if (args.length === 1) {
    vm.cursor = { ...vm.cursor, visible: args[0] !== 0 };
  } else if (args.length === 2) {
    vm.events.moveMouse(args[0], args[1]);
  } else if (args.length >= 3) {
    const [view, loop, cel, hotX = NO_HOTSPOT, hotY = NO_HOTSPOT] = args;
    vm.cursor = { ...vm.cursor, view, loop, cel, hotspot: hotX === NO_HOTSPOT ? null : { x: hotX, y: hotY } };
  }
  return undefined;
}

export const eventKernels = Object.freeze({
  GetEvent: getEvent,
  MapKeyToDir: mapKeyToDir,
  HaveMouse: () => 1,
  SetCursor: setCursor,
});
