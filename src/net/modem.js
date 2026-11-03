// Line emulation around the TSN link, pure state machines with injected I/O.
//  - HayesModem: the local modem the MODEM.DRV emulation talks to (client side).
//    AT commands get OK; ATD opens the transport and answers CONNECT <baud>.
//  - X28Pad: the SprintNet/Telenet PAD at the far end of the call (server side).
//    "@D<cr>" autobaud and blank lines get the "@" prompt, "c <addr>" answers
//    "<addr> CONNECTED" and switches to transparent 8-bit mode.
// See docs/protocol.md "Layer 1".

/**
 * @typedef {Object} ModemOptions
 * @property {(bytes: Uint8Array) => void} toDriver  bytes the UART receives
 * @property {(number: string) => void} dial  open the line (e.g. a WebSocket)
 * @property {(bytes: Uint8Array) => void} toLine  online data towards the host
 * @property {() => void} hangUp  close the line
 * @property {() => number} now  milliseconds, for the +++ guard time
 * @property {number} [baud]
 */

/**
 * @typedef {Object} PadOptions
 * @property {(bytes: Uint8Array) => void} send  bytes to the caller
 * @property {(address: string) => void} [onConnected]
 * @property {(text: string) => void} [log]
 */

const CR = 0x0d;
const LF = 0x0a;
const PLUS = 0x2b;
const DEFAULT_BAUD = 2400;
const ESCAPE_GUARD_MS = 1000;
const ESCAPE_LENGTH = 3;
/** ATD[T|P]<number>; '&D2' is a DTR setting, not a dial. */
const DIAL_COMMAND = /(?<!&)D[TP]?([0-9*#,W ]+)/;
/** Longest command line kept; the rest is dropped (input validation). */
export const MAX_COMMAND_LINE = 80;

/** @param {string} text @returns {Uint8Array} */
export function asciiBytes(text) {
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}

/** @param {ArrayLike<number>} bytes @returns {string} */
export function asciiText(bytes) {
  return String.fromCharCode(...Array.from(bytes));
}

/**
 * Accumulates bytes into CR-terminated lines, capped at MAX_COMMAND_LINE.
 * @returns {{ push: (byte: number) => string | null }}
 */
function createLineCollector() {
  let line = '';
  return {
    push(byte) {
      if (byte === CR) {
        const done = line;
        line = '';
        return done;
      }
      if (byte !== LF && line.length < MAX_COMMAND_LINE) {
        line += String.fromCharCode(byte & 0x7f);
      }
      return null;
    },
  };
}

export class HayesModem {
  /** @param {ModemOptions} options */
  constructor({ toDriver, dial, toLine, hangUp, now, baud = DEFAULT_BAUD }) {
    Object.assign(this, { toDriver, dial, toLine, hangUp, now, baud });
    this.lines = createLineCollector();
    this.isOnline = false;
    this.isDialing = false;
    this.plusRun = 0;
    this.lastDataAt = -Infinity;
  }

  /** Bytes written by the driver to the UART. @param {ArrayLike<number>} bytes */
  write(bytes) {
    if (this.isOnline) {
      this.writeOnline(bytes);
      return;
    }
    for (const byte of Array.from(bytes)) {
      const line = this.lines.push(byte);
      if (line !== null) {
        this.command(line.trim().toUpperCase());
      }
    }
  }

  /** @param {string} line */
  command(line) {
    if (!line.startsWith('AT')) {
      return;
    }
    const dialMatch = DIAL_COMMAND.exec(line);
    if (dialMatch && !this.isDialing) {
      this.isDialing = true;
      this.dial(dialMatch[1].trim());
      return;
    }
    if (/H0?$/.test(line)) {
      this.hangUp();
    }
    this.reply('OK');
  }

  /** @param {ArrayLike<number>} bytes */
  writeOnline(bytes) {
    const now = this.now();
    const all = Array.from(bytes);
    const isGuardedEscape = all.every((b) => b === PLUS) && (this.plusRun > 0 || now - this.lastDataAt >= ESCAPE_GUARD_MS);
    this.plusRun = isGuardedEscape ? this.plusRun + all.length : 0;
    this.lastDataAt = now;
    if (this.plusRun >= ESCAPE_LENGTH) {
      this.plusRun = 0;
      this.isOnline = false;
      this.reply('OK');
      return;
    }
    this.toLine(Uint8Array.from(all));
  }

  /** The transport opened: the call is up. */
  lineOpened() {
    this.isDialing = false;
    this.isOnline = true;
    this.lastDataAt = this.now();
    this.reply(`CONNECT ${this.baud}`);
  }

  /** @param {ArrayLike<number>} bytes  data from the host */
  lineReceived(bytes) {
    if (this.isOnline) {
      this.toDriver(Uint8Array.from(Array.from(bytes)));
    }
  }

  /** The transport closed or failed to open. */
  lineClosed() {
    const wasConnected = this.isOnline || this.isDialing;
    this.isOnline = false;
    this.isDialing = false;
    if (wasConnected) {
      this.reply('NO CARRIER');
    }
  }

  /** @param {string} text */
  reply(text) {
    this.toDriver(asciiBytes(`\r\n${text}\r\n`));
  }
}

export class X28Pad {
  /** @param {PadOptions} options */
  constructor({ send, onConnected = () => {}, log = () => {} }) {
    this.send = send;
    this.onConnected = onConnected;
    this.log = log;
    this.lines = createLineCollector();
    /** @type {string | null} */
    this.address = null;
    this.isTransparent = false;
  }

  /**
   * Feed caller bytes in command mode. Returns the bytes that followed the
   * CONNECTED transition (they belong to the link), else an empty array.
   * @param {ArrayLike<number>} bytes
   * @returns {Uint8Array}
   */
  receive(bytes) {
    const all = Array.from(bytes);
    for (let i = 0; i < all.length; i += 1) {
      if (this.isTransparent) {
        return Uint8Array.from(all.slice(i));
      }
      const line = this.lines.push(all[i]);
      if (line !== null) {
        this.command(line.trim());
      }
    }
    return new Uint8Array(0);
  }

  /** A line BREAK: back to PAD command mode (reconnect, fn 8). */
  breakToCommandMode() {
    this.isTransparent = false;
    this.prompt();
  }

  /** @param {string} rawLine */
  command(rawLine) {
    const line = rawLine.replace(/^@+/, '').trim();
    const upper = line.toUpperCase();
    this.log(`PAD command "${line}"`);
    if (upper.startsWith('C ')) {
      this.connect(line.slice(2).trim());
    } else if (upper === 'D' && this.address !== null) {
      this.address = null;
      this.reply('DISCONNECTED');
      this.prompt();
    } else if (upper === '' || upper === 'D' || upper.startsWith('SET')) {
      this.prompt();
    } else {
      this.reply('?');
      this.prompt();
    }
  }

  /** @param {string} address */
  connect(address) {
    this.address = address.toUpperCase();
    this.isTransparent = true;
    this.send(asciiBytes(`\r\n${this.address} CONNECTED\r\n`));
    this.onConnected(this.address);
  }

  prompt() {
    this.send(asciiBytes('\r\n@'));
  }

  /** @param {string} text */
  reply(text) {
    this.send(asciiBytes(`\r\n${text}`));
  }
}
