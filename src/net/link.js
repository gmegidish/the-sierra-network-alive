// TSN link layer (TSNEXEC 0x1a6f sender, 0x1e55 receiver) as a reusable,
// I/O-free endpoint: stop-and-wait ARQ over CRC-checked frames, plus the
// length-prefixed message stream on top. Used by both the browser/Node
// client transport and the server's host session. See docs/protocol.md
// "Layer 2" and "Layer 2.5".

import {
  createFrameReader, encodeFrame, ackFrame, nakFrame, nextSeq, splitIntoPayloads,
  encodeMessageStream, decodeMessageStream,
  CTL_ACK, CTL_NAK, CTL_TYPE_MASK, CTL_SEQ_MASK, MAX_FRAME_BYTES,
} from './wire.js';

/**
 * @typedef {Object} LinkOptions
 * @property {(bytes: Uint8Array) => void} send  write raw bytes to the line
 * @property {() => number} now  clock in milliseconds (injectable for tests)
 * @property {(message: Uint8Array) => void} [onMessage]  a complete inbound message
 * @property {(reason: string) => void} [onFail]  link declared dead
 * @property {(text: string) => void} [log]  diagnostics (bad CRC, oversize, duplicates)
 * @property {number} [retransmitTimeoutMs]
 * @property {number} [maxRetries]
 */

/**
 * @typedef {Object} PendingFrame
 * @property {number} seq
 * @property {Uint8Array} wire  encoded frame, resent verbatim
 * @property {number} sentAt
 * @property {number} retries
 */

/** 300 ticks of the 60 Hz interpreter clock (TSNEXEC retransmit check). */
export const RETRANSMIT_TIMEOUT_MS = 5000;
/** More than this many retransmissions of one frame kills the link. */
export const MAX_RETRIES = 10;
/** Frame size cap at the boundary; one byte of slack for the documented ±1. */
export const MAX_ACCEPTED_FRAME_BYTES = MAX_FRAME_BYTES + 1;
const CTL_DATA = 0x00;

export class LinkEndpoint {
  /** @param {LinkOptions} options */
  constructor({
    send, now, onMessage = () => {}, onFail = () => {}, log = () => {},
    retransmitTimeoutMs = RETRANSMIT_TIMEOUT_MS, maxRetries = MAX_RETRIES,
  }) {
    this.sendLine = send;
    this.now = now;
    this.onMessage = onMessage;
    this.onFail = onFail;
    this.log = log;
    this.retransmitTimeoutMs = retransmitTimeoutMs;
    this.maxRetries = maxRetries;
    this.reset();
  }

  /** Both seqs back to 0 and buffers cleared (connect / reconnect). */
  reset() {
    this.txSeq = 0;
    this.rxExpected = 0;
    /** @type {number[]} */
    this.outbound = [];
    /** @type {Uint8Array} */
    this.inbound = new Uint8Array(0);
    /** @type {PendingFrame | null} */
    this.pending = null;
    this.isFailed = false;
    this.reader = createFrameReader({
      maxFrameBytes: MAX_ACCEPTED_FRAME_BYTES,
      onOversize: (length) => this.log(`dropped oversized frame (${length} bytes)`),
    });
  }

  /** @returns {boolean} no unacked data and nothing queued (TSN(12)) */
  isIdle() {
    return this.pending === null && this.outbound.length === 0;
  }

  /**
   * Queue one message (length-prefixed) and transmit if the window is free.
   * @param {ArrayLike<number>} message
   */
  sendMessage(message) {
    if (this.isFailed) {
      return;
    }
    this.outbound = [...this.outbound, ...encodeMessageStream([message])];
    this.pump();
  }

  /**
   * Feed raw bytes that arrived from the line.
   * @param {ArrayLike<number>} bytes
   */
  receive(bytes) {
    if (this.isFailed) {
      return;
    }
    for (const frame of this.reader.push(bytes)) {
      this.handleFrame(frame);
    }
  }

  /** Call periodically: retransmits the pending frame after the timeout. */
  tick() {
    if (this.isFailed || this.pending === null) {
      return;
    }
    if (this.now() - this.pending.sentAt > this.retransmitTimeoutMs) {
      this.retransmit('retransmit timeout');
    }
  }

  /** @param {import('./wire.js').DecodedFrame} frame */
  handleFrame(frame) {
    const type = frame.control & CTL_TYPE_MASK;
    const seq = frame.control & CTL_SEQ_MASK;
    if (!frame.crcOk) {
      this.log(`bad CRC on frame ctl=0x${frame.control.toString(16)}, NAK ${seq}`);
      this.sendLine(nakFrame(seq));
      return;
    }
    if (type === CTL_DATA) {
      this.handleData(seq, frame.payload);
    } else if (type === CTL_ACK) {
      this.handleAck(seq);
    } else if (type === CTL_NAK) {
      this.handleNak(seq);
    } else {
      this.log(`ignored frame with unknown ctl=0x${frame.control.toString(16)}`);
    }
  }

  /**
   * @param {number} seq
   * @param {Uint8Array} payload
   */
  handleData(seq, payload) {
    this.sendLine(ackFrame(seq));
    if (seq !== this.rxExpected) {
      this.log(`duplicate data frame seq ${seq} (expected ${this.rxExpected}), re-ACKed`);
      return;
    }
    this.rxExpected = nextSeq(this.rxExpected);
    const { messages, rest } = decodeMessageStream([...this.inbound, ...payload]);
    this.inbound = rest;
    messages.forEach((message) => this.onMessage(message));
  }

  /** @param {number} seq */
  handleAck(seq) {
    if (this.pending === null || this.pending.seq !== seq) {
      return;
    }
    this.pending = null;
    this.txSeq = nextSeq(this.txSeq);
    this.pump();
  }

  /** @param {number} seq */
  handleNak(seq) {
    if (this.pending === null || this.pending.seq !== seq) {
      return;
    }
    this.retransmit('too many NAKs');
  }

  /** @param {string} reasonIfExhausted */
  retransmit(reasonIfExhausted) {
    const pending = /** @type {PendingFrame} */ (this.pending);
    if (pending.retries >= this.maxRetries) {
      this.fail(reasonIfExhausted);
      return;
    }
    this.pending = { ...pending, sentAt: this.now(), retries: pending.retries + 1 };
    this.sendLine(pending.wire);
  }

  /** @param {string} reason */
  fail(reason) {
    this.isFailed = true;
    this.pending = null;
    this.log(`link dead: ${reason}`);
    this.onFail(reason);
  }

  /** Send the next data frame when nothing is awaiting an ACK. */
  pump() {
    if (this.pending !== null || this.outbound.length === 0) {
      return;
    }
    const [payload] = splitIntoPayloads(this.outbound);
    this.outbound = this.outbound.slice(payload.length);
    const wire = encodeFrame({ control: CTL_DATA | this.txSeq, payload });
    this.pending = { seq: this.txSeq, wire, sentAt: this.now(), retries: 0 };
    this.sendLine(wire);
  }
}
