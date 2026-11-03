// TSN host reached over the real "phone line" (docs/server.md): a WebSocket
// to the local server, the X.28 PAD dialog, then LinkEndpoint framing. It has
// the same interface as FakeServer, so the TSN kernel does not care which
// one it talks to. MODEM.DRV is emulated at the function level (no Hayes
// layer): connect opens the line, sends "@D\r\r", waits for "@", sends
// "c <address>\r" and waits for " CONNECTED".
import { LinkEndpoint } from './link.js';
import { openLineTransport } from './ws-transport.js';
import { asciiBytes, asciiText } from './modem.js';
import { hex, describeHostMessage, formatDescribed } from './catalog.js';
import { LINK_TYPE } from './fake-server.js';

/**
 * @typedef {{ url?: string, address?: string, now?: () => number,
 *   openLine?: typeof openLineTransport }} LineHostOptions
 * @typedef {'idle' | 'pad' | 'calling' | 'online' | 'closed'} LineState
 */

const PAD_WAKEUP = '@D\r\r';
const PAD_PROMPT = '@';
const PAD_CONNECTED = ' CONNECTED';
const DEFAULT_ADDRESS = 'SIERRA';

export class LineHost {
  /** @param {LineHostOptions} [options] */
  constructor(options = {}) {
    this.url = options.url;
    this.address = options.address ?? DEFAULT_ADDRESS;
    this.now = options.now ?? (() => performance.now());
    this.openLine = options.openLine ?? openLineTransport;
    /** @type {LineState} */
    this.state = 'idle';
    this.padText = '';
    /** @type {Uint8Array[]} messages sent before the call connected */
    this.waiting = [];
    /** @type {Uint8Array[]} */
    this.replies = [];
    /** @type {{ kind: string, detail: string }[]} */
    this.log = [];
    this.line = null;
    this.link = new LinkEndpoint({
      send: (bytes) => this.line?.write(bytes),
      now: this.now,
      onMessage: (message) => this.acceptReply(message),
      onFail: (reason) => this.note('link-fail', reason),
      log: (text) => this.note('link', text),
    });
  }

  connect(target) {
    this.note('connect', JSON.stringify(target));
    this.link.reset();
    this.state = 'pad';
    this.padText = '';
    this.line = this.openLine(this.url ? { url: this.url } : undefined);
    this.line.onData((bytes) => this.lineData(bytes));
    this.line.onClose((reason) => this.lineClosed(reason));
    this.line.onOpen(() => this.line.write(asciiBytes(PAD_WAKEUP)));
    return true;
  }

  disconnect() {
    this.note('disconnect', '');
    this.line?.close();
    this.line = null;
    this.state = 'idle';
  }

  /** "Connected" from the dial onwards, like a modem that is still training. */
  status() {
    return { connected: this.state !== 'idle' && this.state !== 'closed', linkType: LINK_TYPE.MODEM };
  }

  /** @param {import('./fake-server.js').Packet} packet */
  receivePacket(packet) {
    this.note('packet', `${packet.type}/${packet.sub} ${packet.format} ${JSON.stringify(packet.fields)} [${hex(packet.bytes)}]`);
    if (this.state === 'online') {
      this.link.sendMessage(packet.bytes);
    } else {
      this.waiting.push(packet.bytes);
    }
  }

  takeReplies() {
    this.link.tick();
    return this.replies.splice(0);
  }

  isIdle() {
    return this.state !== 'online' || this.link.isIdle();
  }

  acceptReply(message) {
    this.note('reply', `${formatDescribed(describeHostMessage(message))} [${hex(message)}]`);
    this.replies.push(message);
  }

  lineData(bytes) {
    if (this.state === 'online') {
      this.link.receive(bytes);
      return;
    }
    this.padText += asciiText(bytes);
    if (this.state === 'pad' && this.padText.includes(PAD_PROMPT)) {
      this.state = 'calling';
      this.padText = '';
      this.line.write(asciiBytes(`c ${this.address}\r`));
    } else if (this.state === 'calling' && this.padText.includes(PAD_CONNECTED)) {
      this.goOnline();
    }
  }

  goOnline() {
    this.state = 'online';
    this.note('online', this.address);
    const queued = this.waiting.splice(0);
    queued.forEach((message) => this.link.sendMessage(message));
  }

  lineClosed(reason) {
    this.note('hangup', reason);
    this.state = 'closed';
  }

  note(kind, detail) {
    this.log.push({ kind, detail });
  }

  report() {
    return this.log.map(({ kind, detail }) => `${kind} ${detail}`).join('\n');
  }
}
