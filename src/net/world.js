// The host's shared world: every session (caller) of one server sees the same
// SIDs, groups (waiting rooms, game tables) and object properties, and the
// world routes messages between sessions. Pure state, no I/O: a session is
// anything with `deliver(message)` (HostLogic), and the world calls it for
// messages meant for another caller.

import { HostObjects, wordAt } from './host-objects.js';
import { groupChange, groupMembers, HOST_GROUP } from './host-messages.js';
import { encodeMessage } from './wire.js';

/**
 * @typedef {Object} WorldSession
 * @property {(message: Uint8Array) => void} deliver  one host->client message to this caller
 * @property {string} [playerName]
 */

/**
 * @typedef {Object} WorldOptions
 * @property {() => number} [allocateSid]
 */

const FIRST_SID = 100;
const NO_SID = 0;
const USER_MESSAGE = 2;
/** Client 28 "said" `b 28, w from, w count, count words of members, w msgType, data`. */
const SAID = Object.freeze({ FROM: 1, COUNT: 3, MEMBERS: 5 });

/** @param {number} [first] @returns {() => number} */
export function createSidAllocator(first = FIRST_SID) {
  let next = first;
  return () => {
    next += 1;
    return next;
  };
}

export class World {
  /** @param {WorldOptions} [options] */
  constructor({ allocateSid = createSidAllocator() } = {}) {
    this.allocateSid = allocateSid;
    this.objects = new HostObjects();
    /** @type {Map<number, WorldSession>} sid -> the session that joinNet'ed it */
    this.owners = new Map();
    /** @type {Map<string, number>} shared group key -> its one SID */
    this.sharedGroups = new Map();
    /** @type {(group: number) => void} called when a waiting room opens (bots join it) */
    this.onSharedGroup = () => {};
    /** @type {(group: number, who: number) => void} called after somebody joined a group (bots wait for the inviter) */
    this.onGroupJoined = () => {};
  }

  /**
   * A SID for a joinNet. Shared objects (one per key, e.g. a land's waiting
   * room) get the same SID for everybody; the rest get a new one owned by `session`.
   * @param {WorldSession} session @param {string | null} sharedKey
   * @returns {number}
   */
  joinNet(session, sharedKey) {
    if (sharedKey !== null) {
      return this.sharedGroups.get(sharedKey) ?? this.openSharedGroup(sharedKey);
    }
    const sid = this.allocateSid();
    this.owners.set(sid, session);
    return sid;
  }

  /** @param {string} sharedKey @returns {number} */
  openSharedGroup(sharedKey) {
    const sid = this.allocateSid();
    this.sharedGroups.set(sharedKey, sid);
    this.onSharedGroup(sid);
    return sid;
  }

  /** `sid` belongs to `session` unless someone already owns it. @param {number} sid @param {WorldSession} session */
  claim(sid, session) {
    if (!this.owners.has(sid)) {
      this.owners.set(sid, session);
    }
  }

  /** @param {number} sid @returns {WorldSession | undefined} */
  ownerOf(sid) {
    return this.owners.get(sid);
  }

  /** @param {number} sid @param {Uint8Array} message */
  sendTo(sid, message) {
    this.ownerOf(sid)?.deliver(message);
  }

  /**
   * Every session with a member in `group` gets `message` once.
   * @param {number} group @param {Uint8Array} message @param {number} [exceptSid]
   */
  sendToMembers(group, message, exceptSid = NO_SID) {
    const sessions = new Set(this.objects.members(group).filter((sid) => sid !== exceptSid).map((sid) => this.ownerOf(sid)));
    sessions.forEach((session) => session?.deliver(message));
  }

  /**
   * A user message (client 2 / 3, `[cmd, notify, toSID w2, fromSID w4, msgType w6, data]`)
   * goes unchanged to toSID's caller, or to every other member when toSID is a group.
   * @param {Uint8Array} message @param {number} to @param {number} from
   */
  relay(message, to, from) {
    if (this.objects.members(to).length > 0) {
      this.sendToMembers(to, message, from);
      return;
    }
    this.sendTo(to, message);
  }

  /**
   * Client 28 "said" (LL module 10, game moves at a table): one user message
   * for each listed member. Each gets host cmd 2 `[2, 0, member, from, msgType, data]`;
   * 0 (an empty seat) and the sender are skipped.
   * @param {Uint8Array} message
   */
  said(message) {
    const from = wordAt(message, SAID.FROM);
    const count = wordAt(message, SAID.COUNT);
    const payload = message.subarray(SAID.MEMBERS + count * 2);
    for (let i = 0; i < count; i++) {
      const member = wordAt(message, SAID.MEMBERS + i * 2);
      if (member !== NO_SID && member !== from) {
        this.sendTo(member, Uint8Array.from([...encodeMessage('bbww', [USER_MESSAGE, 0, member, from]), ...payload]));
      }
    }
  }

  /** Every other session with a member in a group `sid` is in. @param {Uint8Array} message @param {number} sid */
  sendToGroupmates(message, sid) {
    const owner = this.ownerOf(sid);
    const sessions = new Set(this.groupsOf(sid).flatMap((group) => this.objects.members(group)).map((member) => this.ownerOf(member)));
    sessions.forEach((session) => {
      if (session && session !== owner) {
        session.deliver(message);
      }
    });
  }

  /** Every session but `except` gets `message` (a property change everybody may know about). @param {Uint8Array} message @param {WorldSession} except */
  sendToOthers(message, except) {
    new Set(this.owners.values()).forEach((session) => {
      if (session !== except) {
        session.deliver(message);
      }
    });
  }

  /** `who` joins `group`; every member hears who joined (10) and the member list (12). @param {number} group @param {number} who */
  joinGroup(group, who) {
    const members = this.objects.join(group, who);
    this.sendToMembers(group, groupChange(HOST_GROUP.JOINED, group, who));
    this.sendToMembers(group, groupMembers(group, members));
    this.onGroupJoined(group, who);
  }

  /** `who` leaves `group`; it and the others hear it (11), the others get the new list (12). @param {number} group @param {number} who */
  leaveGroup(group, who) {
    if (!this.objects.members(group).includes(who)) {
      return;
    }
    this.sendToMembers(group, groupChange(HOST_GROUP.LEFT, group, who));
    this.objects.leave(group, who);
    this.sendToMembers(group, groupMembers(group, this.objects.members(group)));
  }

  /** @param {number} sid @returns {number[]} groups `sid` is in */
  groupsOf(sid) {
    return [...this.objects.groups].filter(([, members]) => members.includes(sid)).map(([group]) => group);
  }

  /** leaveNet: `sid` leaves every group and its properties go. @param {number} sid */
  release(sid) {
    this.groupsOf(sid).forEach((group) => this.leaveGroup(group, sid));
    this.objects.forget(sid);
    this.owners.delete(sid);
  }

  /** The caller hung up: release every SID it owned. @param {WorldSession} session */
  disconnect(session) {
    [...this.owners].filter(([, owner]) => owner === session).forEach(([sid]) => this.release(sid));
  }

  /** @returns {string[]} names of the players online */
  playerNames() {
    return [...new Set(this.owners.values())].map((session) => session.playerName ?? '').filter(Boolean);
  }
}
