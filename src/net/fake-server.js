// Fake TSN host. Pluggable and transport-agnostic: the client side hands it
// decoded packets (receivePacket) and pulls queued host->client messages
// (takeReplies). It does no I/O, so it can later sit behind a WebSocket in a
// local Express server unchanged. Message layouts: docs/protocol.md
// ("Host to client", "Minimum fake host").
//
// Replies come from the same host logic the real server runs
// (src/net/host-logic.js). Override a message type with
// `server.on(type, handler)`; a handler gets the decoded packet and a
// `reply(bytes)` function.

import { HostLogic, createSidAllocator, land } from './host-logic.js';
import { hex } from './catalog.js';

/**
 * @typedef {{ type: number, sub: number, format: string,
 *   fields: Array<number | string | number[]>, bytes: Uint8Array }} Packet
 *   A client->host message. `fields` are the TSN(4) arguments after the
 *   format string, with strings and arrays resolved; `bytes` is the encoded message.
 * @typedef {(packet: Packet, reply: (bytes: ArrayLike<number>) => void) => void} PacketHandler
 * @typedef {{ kind: string, detail: string }} LogEntry
 * @typedef {{ privilege?: number, firstSid?: number, linkType?: number, hostNumber?: number,
 *   lands?: string[], landAccess?: number, password?: string | null, bank?: Map<string, number>,
 *   world?: import('./world.js').World }} FakeServerOptions
 *   world: share one with other FakeServers to put several in-process clients on one host.
 *   password null (the default) accepts any password.
 */

export const MESSAGE = Object.freeze({
  JOIN_NET: 7, LOGIN: 53, SESSION_36: 36, LAND_47: 47,
  ACK: 0, DONE: 1, SID_ASSIGN: 8,
});
/** TSN(0) low byte, checked by dialScript (module 101 block 74). */
export const LINK_TYPE = Object.freeze({ SERIAL: 1, NOVELL: 2, MODEM: 3 });
const DEFAULT_FIRST_SID = 0x100;

export class FakeServer {
  /** @param {FakeServerOptions} [options] */
  constructor(options = {}) {
    this.linkType = options.linkType ?? LINK_TYPE.MODEM;
    this.connected = false;
    /** @type {Uint8Array[]} */
    this.replies = [];
    /** @type {LogEntry[]} */
    this.log = [];
    /** @type {Map<string, {count: number, first: string}>} packet type -> stats */
    this.packetTypes = new Map();
    /** @type {Map<number, PacketHandler>} overrides of the shared host logic */
    this.handlers = new Map();
    this.host = new HostLogic({
      reply: (message) => this.queueReply(message),
      password: options.password ?? null,
      privilege: options.privilege,
      landAccess: options.landAccess,
      hostNumber: options.hostNumber,
      bank: options.bank,
      world: options.world,
      allocateSid: createSidAllocator((options.firstSid ?? DEFAULT_FIRST_SID) - 1),
      lands: options.lands?.map((name, i) => land(name, i + 1)),
    });
  }

  get sid() {
    return this.host.sid;
  }

  /** Register (or replace) the handler for a client message type. */
  on(type, handler) {
    this.handlers.set(type, handler);
  }

  connect(target) {
    this.connected = true;
    this.note('connect', JSON.stringify(target));
    return true;
  }

  disconnect() {
    this.connected = false;
    this.note('disconnect', '');
  }

  /** @returns {{ connected: boolean, linkType: number }} */
  status() {
    return { connected: this.connected, linkType: this.linkType };
  }

  /** @param {Packet} packet */
  receivePacket(packet) {
    const key = `${packet.type}/${packet.sub} ${packet.format}`;
    const summary = `${JSON.stringify(packet.fields)} [${hex(packet.bytes)}]`;
    const seen = this.packetTypes.get(key);
    this.packetTypes.set(key, { count: (seen?.count ?? 0) + 1, first: seen?.first ?? summary });
    this.note('packet', `${key} ${summary}`);
    const handler = this.handlers.get(packet.type);
    if (handler) {
      handler(packet, (bytes) => this.queueReply(bytes));
      return;
    }
    this.host.handleMessage(Uint8Array.from(packet.bytes));
  }

  queueReply(bytes) {
    const message = Uint8Array.from(bytes);
    this.note('reply', hex(message));
    this.replies.push(message);
  }

  /** Remove and return every queued host->client message. */
  takeReplies() {
    return this.replies.splice(0);
  }

  note(kind, detail) {
    this.log.push({ kind, detail });
  }

  report() {
    const types = [...this.packetTypes].map(([key, { count, first }]) => `${key}  x${count}  first: ${first}`);
    return [
      '# packet types seen (type/sub format  count  first fields [bytes])',
      ...types,
      '',
      '# full log',
      ...this.log.map(({ kind, detail }) => `${kind} ${detail}`),
      '',
    ].join('\n');
  }
}
