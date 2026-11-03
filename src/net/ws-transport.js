// Browser-side "phone line": a WebSocket to the local TSN host carrying raw
// serial bytes as binary messages. Uses only the standard WebSocket API, so
// it also runs in Node 22+ (global WebSocket). See docs/server.md.

/**
 * @typedef {Object} LineTransportOptions
 * @property {string} [url]
 * @property {typeof WebSocket} [WebSocketImpl]
 */

/**
 * @typedef {Object} LineTransport
 * @property {(bytes: ArrayLike<number>) => void} write  queued until the socket opens
 * @property {(callback: (bytes: Uint8Array) => void) => void} onData
 * @property {(callback: () => void) => void} onOpen
 * @property {(callback: (reason: string) => void) => void} onClose
 * @property {() => void} sendBreak  PAD BREAK (reconnect, MODEM.DRV fn 8)
 * @property {() => void} close  hang up
 */

export const DEFAULT_LINE_URL = 'ws://localhost:7000/line';
/** Text control message understood by the server. */
export const BREAK_SIGNAL = 'BREAK';

/**
 * @param {LineTransportOptions} [options]
 * @returns {LineTransport}
 */
export function openLineTransport({ url = DEFAULT_LINE_URL, WebSocketImpl = globalThis.WebSocket } = {}) {
  const socket = new WebSocketImpl(url);
  socket.binaryType = 'arraybuffer';
  /** @type {Array<Uint8Array | string>} */
  let queue = [];
  const listeners = { data: [], open: [], close: [] };

  /** @param {Uint8Array | string} item */
  function sendOrQueue(item) {
    if (socket.readyState === WebSocketImpl.OPEN) {
      socket.send(item);
      return;
    }
    queue = [...queue, item];
  }

  socket.addEventListener('open', () => {
    queue.forEach((item) => socket.send(item));
    queue = [];
    listeners.open.forEach((cb) => cb());
  });
  socket.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(event.data);
      listeners.data.forEach((cb) => cb(bytes));
    }
  });
  socket.addEventListener('close', (event) => {
    listeners.close.forEach((cb) => cb(event.reason || `closed (${event.code})`));
  });

  return {
    write: (bytes) => sendOrQueue(Uint8Array.from(Array.from(bytes))),
    onData: (callback) => listeners.data.push(callback),
    onOpen: (callback) => listeners.open.push(callback),
    onClose: (callback) => listeners.close.push(callback),
    sendBreak: () => sendOrQueue(BREAK_SIGNAL),
    close: () => socket.close(),
  };
}
