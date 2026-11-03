// One dial-in caller: X.28 PAD in front, then the shared TSN LinkEndpoint,
// then the shared host logic (src/net/host-logic.js, docs/protocol.md "Layer 4").
// No I/O here: bytes in via receive(), bytes out via the injected send().

import { LinkEndpoint } from '../src/net/link.js';
import { X28Pad } from '../src/net/modem.js';
import { HostLogic, STAGE } from '../src/net/host-logic.js';

export {
  STAGE, DEFAULT_PASSWORD, LOGIN_TRIES, BAD_PASSWORD_TEXT, DEFAULT_PRIVILEGE, DEFAULT_HOST_NUMBER,
  DEFAULT_LANDS, createSidAllocator,
} from '../src/net/host-logic.js';

/**
 * @typedef {Object} SessionOptions
 * @property {(bytes: Uint8Array) => void} send  raw bytes to the caller's line
 * @property {() => number} now  milliseconds
 * @property {(text: string) => void} [log]
 * @property {string} [password]  accepted password (compared upper-case)
 * @property {number} [privilege]  login reply word@5
 * @property {number} [hostNumber]  answer to 36/5, 0..200
 * @property {() => number} [allocateSid]
 * @property {import('../src/net/host-messages.js').LandRecord[]} [lands]
 * @property {import('../src/net/world.js').World} [world]  shared by every caller of the server
 * @property {Map<string, number>} [bank]
 */

export class HostSession {
  /** @param {SessionOptions} options */
  constructor({ send, now, log = () => {}, ...hostOptions }) {
    this.log = log;
    this.host = new HostLogic({ ...hostOptions, log, reply: (message) => this.link.sendMessage(message) });
    this.pad = new X28Pad({ send, log, onConnected: (address) => this.padConnected(address) });
    this.link = new LinkEndpoint({
      send, now, log: (text) => log(`link: ${text}`),
      onMessage: (message) => this.host.handleMessage(message),
      onFail: () => {
        this.host.stage = STAGE.DEAD;
      },
    });
  }

  /** Stage of the call; the host logic owns it once the PAD connects. */
  get stage() {
    return this.host.stage;
  }

  get sid() {
    return this.host.sid;
  }

  /** Raw bytes from the caller. Never throws. @param {ArrayLike<number>} bytes */
  receive(bytes) {
    try {
      const linkBytes = this.stage === STAGE.PAD ? this.pad.receive(bytes) : Uint8Array.from(Array.from(bytes));
      if (linkBytes.length > 0) {
        this.link.receive(linkBytes);
      }
    } catch (error) {
      this.log(`error handling ${bytes.length} inbound bytes: ${error instanceof Error ? error.stack : error}`);
    }
  }

  /** Drive retransmission; call every few hundred ms. */
  tick() {
    this.link.tick();
  }

  /** The caller hung up: drop it from the shared world. */
  hangUp() {
    this.host.hangUp();
  }

  /** Caller sent a line BREAK: PAD command mode, link seqs reset. */
  lineBreak() {
    this.host.stage = STAGE.PAD;
    this.link.reset();
    this.pad.breakToCommandMode();
  }

  /** @param {string} address */
  padConnected(address) {
    this.log(`PAD connected to ${address}`);
    this.host.stage = STAGE.LINK;
    this.link.reset();
  }
}
