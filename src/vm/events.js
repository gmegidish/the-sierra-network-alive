// Input event queue feeding kernel GetEvent.
// Event types/modifiers follow stock SCI (ScummVM engines/sci/event.h):
// 1 mouseDown, 2 mouseUp, 4 keyDown, 8 keyUp, 0x40 direction, 0 null.
// 0x400 is LSCI's network event: TSN(8) posts one per received message
// (message = byte-array ID, modifiers = poll result).

export const EVENT_TYPE = Object.freeze({
  NULL: 0,
  MOUSE_DOWN: 1,
  MOUSE_UP: 2,
  KEY_DOWN: 4,
  KEY_UP: 8,
  DIRECTION: 0x40,
  NETWORK: 0x400,
  ANY: 0x7fff,
});

const MAX_QUEUED = 256;

/**
 * @typedef {{ type: number, message: number, modifiers: number, x: number, y: number }} InputEvent
 */

export class EventQueue {
  constructor() {
    /** @type {InputEvent[]} */
    this.queue = [];
    this.mouse = { x: 160, y: 100 };
    this.modifiers = 0;
  }

  /** @param {Omit<InputEvent, 'x' | 'y' | 'modifiers'> & Partial<InputEvent>} event */
  push(event) {
    if (this.queue.length >= MAX_QUEUED) {
      return;
    }
    if (event.x !== undefined) {
      this.mouse = { x: event.x, y: event.y ?? this.mouse.y };
    }
    this.queue.push({
      modifiers: this.modifiers, x: this.mouse.x, y: this.mouse.y, ...event,
    });
  }

  moveMouse(x, y) {
    this.mouse = { x, y };
  }

  /** Remove and return the first event matching `mask`, or a null event. */
  take(mask, remove = true) {
    const index = this.queue.findIndex((event) => (event.type & mask) !== 0);
    if (index < 0) {
      return { type: EVENT_TYPE.NULL, message: 0, modifiers: this.modifiers, ...this.mouse };
    }
    const event = this.queue[index];
    if (remove) {
      this.queue.splice(index, 1);
    }
    return event;
  }
}
