// The TSN host's message logic, with no transport: one decoded client
// message in, host replies out through `reply`. server/session.js puts it
// behind the X.28 PAD and LinkEndpoint; FakeServer calls it in-process.

import {
  CLIENT, CLIENT_SUB, describeClientMessage, decodeLogin, decodeJoinNet, formatDescribed, hex,
} from './catalog.js';
import {
  loginOk, loginRejected, sidAssign, done, gameInfoCurrent, requestOk, bankBalance, hostNumber, landList, landInfo, memberProperties, objectProperties,
} from './host-messages.js';
import { wordAt, stringAt } from './host-objects.js';
import { World, createSidAllocator } from './world.js';
import { DEFAULT_STORES, MALL_SUB, storeList, letterList, letterText, letterDelivered } from './mall.js';

/**
 * @typedef {Object} HostLogicOptions
 * @property {(message: Uint8Array) => void} reply  one host->client message
 * @property {(text: string) => void} [log]
 * @property {string | null} [password]  accepted password (upper-cased); null accepts any
 * @property {number} [privilege]  login reply word@5
 * @property {number} [landAccess]  login reply word@8 (g253): land n needs bit n-1
 * @property {number} [hostNumber]  answer to 36/5, 0..200
 * @property {() => number} [allocateSid]  used when no world is given
 * @property {World} [world]  the server's shared world (one per server; a new one when alone)
 * @property {import('./host-messages.js').LandRecord[]} [lands]
 * @property {Map<string, number>} [bank]  player name -> LarryBucks, shared by a server's sessions
 * @property {readonly import('./mall.js').MallStore[]} [stores]  the Electronic Mall
 */

/** @typedef {(message: Uint8Array) => void} MessageHandler */

export const STAGE = Object.freeze({
  PAD: 'pad',
  LINK: 'link',
  LOGGED_IN: 'loggedIn',
  JOINED: 'joined',
  ONLINE: 'online',
  DEAD: 'dead',
});

export { createSidAllocator };

/** The password in the shipped installed/INN/PASS_SET.DTA. */
export const DEFAULT_PASSWORD = 'XXXXXX';
export const LOGIN_TRIES = 3;
export const BAD_PASSWORD_TEXT = 'Invalid password.';
/** Privilege mask 0: an ordinary member (g82 = 0). */
export const DEFAULT_PRIVILEGE = 0;
export const DEFAULT_HOST_NUMBER = 1;
export const ALL_LANDS_ACCESS = 0xffff;
/** LarryBucks a new player starts with. */
export const STARTING_BUCKS = 500;

/** Capacity of every land instance (the chooser gauge's right label). */
export const LAND_CAPACITY = 64;

const ANY_VERSION = Object.freeze([0, 0, 0]);
const FIRST_LAND_NUMBER = 1;
const LAND_ENABLED = 1;

/**
 * A land instance on this host, accepted by any client version. The name is
 * the instance's name in the land chooser.
 * @param {string} name @param {number} landType LAND.CFG number
 * @param {number} [hostNumber] @param {number} [landNumber] instance number within the land type
 * @returns {import('./host-messages.js').LandRecord}
 */
export function land(name, landType, hostNumber = DEFAULT_HOST_NUMBER, landNumber = FIRST_LAND_NUMBER) {
  return {
    name, hostNumber, landType, landNumber, unused: [0, 0],
    minVersion: [...ANY_VERSION], maxVersion: [...ANY_VERSION], flags: LAND_ENABLED,
  };
}

/** @param {number} landType @param {string[]} names @returns {import('./host-messages.js').LandRecord[]} */
function instances(landType, names) {
  return names.map((name, i) => land(name, landType, DEFAULT_HOST_NUMBER, FIRST_LAND_NUMBER + i));
}

/**
 * The INN lands this port runs (installed/INN/LAND.CFG types 1 Clubhouse,
 * 2 SierraLand, 3 CasinoLand), all on this host, named after the instances in
 * the shipped installed/INN/LANDADDR. Module 101 writes them to LandAddr with
 * "%20s", so spaces are sent as underscores (at most 20 characters).
 */
export const DEFAULT_LANDS = Object.freeze([
  ...instances(1, ['INN_Help_Room', 'Tech_Tower', 'Hearts', 'Singles_Club']),
  ...instances(2, ['Dogfight_Downs', 'Wacky_Way', 'Looney_Lane', 'Aerodrome']),
  ...instances(3, ['High_Rollers', 'Polite_Place', 'Atlantic_City', 'Key_West']),
]);


/**
 * Client object messages, all "type w, toSID w2, fromSID w4, ...":
 * 10 join group toSID, 11 leave it, 13 word properties (offset, value) pairs
 * from 6, 14 string property (offset w6, text from 8), 31/1 get members'
 * properties (offsets from 6).
 */
const CLIENT_OBJECT = Object.freeze({ SEND: 2, RSEND: 3, SAID: 28, LOCK: 4, JOIN: 10, LEAVE: 11, WORDS: 13, STRING: 14, GET_MEMBERS: 31, GET_OBJECT: 32 });
const GET_MEMBERS_SUB = 1;
/** fromSID of a property change every other caller should hear about. */
const EVERYBODY = 0xffff;
/** joinNet flags: 4 = a shared group object (a land's waiting room), one SID for every caller. */
const JOIN_FLAG = Object.freeze({ SHARED: 4 });
const BANK_REQUEST_SUB = 3;
const TO_SID_OFFSET = 2;
const FROM_SID_OFFSET = 4;
const PAYLOAD_OFFSET = 6;
const STRING_VALUE_OFFSET = 8;
const MAIL_BOX_OFFSET = 4;
const MAIL_LETTER_OFFSET = 8;

/** @param {number} type @param {number} [sub] @returns {string} */
function handlerKey(type, sub) {
  return sub === undefined ? `${type}` : `${type}/${sub}`;
}

export class HostLogic {
  /** @param {HostLogicOptions} options */
  constructor({
    reply, log = () => {}, password = DEFAULT_PASSWORD, privilege = DEFAULT_PRIVILEGE,
    landAccess = ALL_LANDS_ACCESS, hostNumber: hostNo = DEFAULT_HOST_NUMBER,
    allocateSid = createSidAllocator(), lands = DEFAULT_LANDS, bank = new Map(), stores = DEFAULT_STORES,
    world = new World({ allocateSid }),
  }) {
    this.config = {
      password: password === null ? null : password.toUpperCase(), privilege, landAccess, hostNumber: hostNo, lands,
    };
    /** @type {Map<string, number>} player name -> LarryBucks; shared by the sessions of one server */
    this.bank = bank;
    this.stores = stores;
    this.playerName = '';
    this.send = reply;
    this.log = log;
    this.stage = STAGE.PAD;
    this.sid = 0;
    this.failedLogins = 0;
    /** @type {Map<string, MessageHandler>} */
    this.handlers = new Map([
      [handlerKey(CLIENT.LOGIN), (m) => this.onLogin(m)],
      [handlerKey(CLIENT.JOIN_NET), (m) => this.onJoinNet(m)],
      [handlerKey(CLIENT.HOST_INFO, CLIENT_SUB.HOST_NUMBER_REQUEST), () => this.reply(hostNumber(this.config.hostNumber))],
      [handlerKey(CLIENT.HOST_INFO, CLIENT_SUB.LAND_ADDR), () => this.onLandAddr()],
      [handlerKey(CLIENT.HOST_INFO, CLIENT_SUB.GAME_INFO), () => this.reply(gameInfoCurrent())],
      [handlerKey(CLIENT.LANDS, CLIENT_SUB.LAND_REQUEST), () => this.onLandRequest()],
      [handlerKey(CLIENT.PERSONA, BANK_REQUEST_SUB), (m) => this.onBankRequest(m)],
      [handlerKey(CLIENT.SESSION_37, MALL_SUB.STORES), (m) => this.onStoreList(m)],
      [handlerKey(CLIENT.SESSION_37, MALL_SUB.LETTERS), (m) => this.onLetterList(m)],
      [handlerKey(CLIENT.SESSION_37, MALL_SUB.READ), (m) => this.onReadLetter(m)],
      [handlerKey(CLIENT.SESSION_37, MALL_SUB.FORM), (m) => this.onReadLetter(m)],
      // ponytail: orders are acknowledged and dropped; keep them per player when someone needs to read them.
      [handlerKey(CLIENT.SESSION_37, MALL_SUB.DELIVER), (m) => this.reply(letterDelivered(wordAt(m, TO_SID_OFFSET)))],
      [handlerKey(CLIENT_OBJECT.LOCK), (m) => this.onLock(m)],
      [handlerKey(CLIENT.LEAVE_NET), (m) => this.onLeaveNet(m)],
      [handlerKey(CLIENT_OBJECT.SEND), (m) => this.onUserMessage(m)],
      [handlerKey(CLIENT_OBJECT.RSEND), (m) => this.onUserMessage(m)],
      [handlerKey(CLIENT_OBJECT.SAID), (m) => this.world.said(m)],
      [handlerKey(CLIENT_OBJECT.JOIN), (m) => this.onGroupJoin(m)],
      [handlerKey(CLIENT_OBJECT.LEAVE), (m) => this.onGroupLeave(m)],
      [handlerKey(CLIENT_OBJECT.WORDS), (m) => this.onWordProperties(m)],
      [handlerKey(CLIENT_OBJECT.STRING), (m) => this.onStringProperty(m)],
      [handlerKey(CLIENT_OBJECT.GET_MEMBERS, GET_MEMBERS_SUB), (m) => this.onGetMembers(m)],
      [handlerKey(CLIENT_OBJECT.GET_OBJECT), (m) => this.onGetObject(m)],
    ]);
    this.world = world;
    this.objects = world.objects;
  }

  /** @param {Uint8Array} message */
  handleMessage(message) {
    this.log(`<- ${formatDescribed(describeClientMessage(message))}`);
    const handler = this.handlers.get(handlerKey(message[0], message[1])) ?? this.handlers.get(handlerKey(message[0]));
    if (!handler) {
      this.log(`   (no reply for ${hex(message.subarray(0, 2))})`);
      return;
    }
    handler(message);
  }

  /** A message from another caller, routed by the world. @param {Uint8Array} message */
  deliver(message) {
    this.reply(message);
  }

  /** The line dropped: everything this caller had on the net goes. */
  hangUp() {
    this.world.disconnect(this);
    this.stage = STAGE.DEAD;
  }

  /** @param {Uint8Array} message */
  reply(message) {
    this.log(`-> ${hex(message)}`);
    this.send(message);
  }

  /** @param {string} password @returns {boolean} */
  isPasswordAccepted(password) {
    return this.config.password === null || password.toUpperCase() === this.config.password;
  }

  /** @param {Uint8Array} message */
  onLogin(message) {
    const login = decodeLogin(message);
    if (this.isPasswordAccepted(String(login.password))) {
      this.stage = STAGE.LOGGED_IN;
      this.playerName = String(login.name);
      this.reply(loginOk({ privilege: this.config.privilege, w8: this.config.landAccess }));
      return;
    }
    this.failedLogins += 1;
    this.reply(loginRejected({ numTries: LOGIN_TRIES, text: BAD_PASSWORD_TEXT }));
  }

  /** @param {Uint8Array} message */
  onJoinNet(message) {
    const { objectId, flags, number, arg1, prop } = decodeJoinNet(message);
    const isShared = (Number(flags) & JOIN_FLAG.SHARED) !== 0;
    // ponytail: one waiting room per land type for all its instances; key by instance when the client says which.
    const sid = this.world.joinNet(this, isShared ? `${number}/${arg1}/${prop}` : null);
    // Later joinNets register groups (waiting room, a new game); the session keeps its first SID.
    this.sid ||= sid;
    this.stage = STAGE.JOINED;
    this.reply(sidAssign({ objectId: Number(objectId), sid }));
  }

  /** 36/6 is the last unconditional burst message: answer with the land list. */
  onLandAddr() {
    this.reply(landList({ toSid: this.sid, lands: [...this.config.lands] }));
    this.reply(done(CLIENT.HOST_INFO, CLIENT_SUB.LAND_ADDR));
  }

  /** 47/1: how full each land is (the chooser gauges), then done. */
  onLandRequest() {
    this.stage = STAGE.ONLINE;
    // ponytail: nobody is counted yet; count sessions per land when fan-out between sessions exists.
    const population = () => ({ maximum: LAND_CAPACITY, curSize: 0 });
    this.reply(landInfo({ toSid: 0, lands: [...this.config.lands], population }));
    this.reply(done(CLIENT.LANDS, CLIENT_SUB.LAND_REQUEST));
  }

  /** 4 `wwa` [4, group, members…]: lock game group toSID with its players; the creator waits for ok(4). */
  onLock(message) {
    const group = wordAt(message, TO_SID_OFFSET);
    for (let at = FROM_SID_OFFSET; at + 1 < message.length; at += 2) {
      this.objects.join(group, wordAt(message, at));
    }
    this.reply(requestOk(group, CLIENT_OBJECT.LOCK));
  }

  /** 10: a member joins a group object; the group hears who joined and who is in it. */
  onGroupJoin(message) {
    const group = wordAt(message, TO_SID_OFFSET);
    const who = wordAt(message, FROM_SID_OFFSET);
    this.world.claim(who, this);
    this.world.joinGroup(group, who);
  }

  /** 11: a member leaves a group object. */
  onGroupLeave(message) {
    const group = wordAt(message, TO_SID_OFFSET);
    const who = wordAt(message, FROM_SID_OFFSET);
    this.world.leaveGroup(group, who);
  }

  /** 2 / 3 Net send: talk and game moves, relayed to toSID (a player, or a group's other members). */
  onUserMessage(message) {
    this.world.relay(message, wordAt(message, TO_SID_OFFSET), wordAt(message, FROM_SID_OFFSET));
  }

  /** 9 `[9, sid, 0]` leaveNet: the object leaves its groups and its properties go. */
  onLeaveNet(message) {
    this.world.release(wordAt(message, TO_SID_OFFSET));
  }

  /**
   * 13: (offset, value) word pairs for object toSID. fromSID -1 means "tell
   * everybody": the other callers get the same message as host cmd 13 (class
   * 105), e.g. a player's room (offset 9) changing when they sit at a table.
   */
  onWordProperties(message) {
    const sid = wordAt(message, TO_SID_OFFSET);
    for (let at = PAYLOAD_OFFSET; at + 3 < message.length; at += 4) {
      this.objects.setProperty(sid, wordAt(message, at), wordAt(message, at + 2));
    }
    this.tellOthersIfPublic(message);
  }

  /**
   * A 13 / 14 property change: public ones (fromSID 0xFFFF) go to every other
   * session, the rest to the players sharing a group with the object (a
   * waiting room may have asked for them with 32 before they were set).
   * @param {Uint8Array} message
   */
  tellOthersIfPublic(message) {
    if (wordAt(message, FROM_SID_OFFSET) === EVERYBODY) {
      this.world.sendToOthers(message, this);
      return;
    }
    this.world.sendToGroupmates(message, wordAt(message, TO_SID_OFFSET));
  }

  /**
   * 40/3 `bbwww` [40, 3, sid, 1, 1]: LarryLand asks the Bank of LarryLand for
   * money when its money file (ll$$NNNN.dat) is missing; LL module 0 then
   * writes the file and keeps the balance itself. Reply cmd 40, msgType 1,
   * whichCmd 3, whichSub 1, the amount as a long (low word, high word).
   */
  onBankRequest(message) {
    const amount = this.bank.get(this.playerName) ?? STARTING_BUCKS;
    this.bank.set(this.playerName, amount);
    this.reply(bankBalance(0, amount));
  }


  /** 37/32 `[37, 32, sid, 0, 0]`: the Mall (module 160) asks for its stores. The startup burst sends it with sid 0; that gets nothing. */
  onStoreList(message) {
    const sid = wordAt(message, TO_SID_OFFSET);
    if (sid) {
      this.reply(storeList(sid, this.stores));
    }
  }

  /** @param {Uint8Array} message @returns {import('./mall.js').MallStore | undefined} the store whose box is at w4 */
  storeIn(message) {
    return this.stores.find((store) => store.box === wordAt(message, MAIL_BOX_OFFSET));
  }

  /** 37/19 `[37, 19, sid, boxLow, boxHigh]`: a store's products (the letters in its box). */
  onLetterList(message) {
    const store = this.storeIn(message);
    if (store) {
      this.reply(letterList(wordAt(message, TO_SID_OFFSET), store));
    }
  }

  /** 37/25 or 37/31 `[37, sub, sid, boxLow, boxHigh, letterLow, letterHigh]`: one product's text (31: the Mall's product form). */
  onReadLetter(message) {
    const store = this.storeIn(message);
    if (store) {
      this.reply(letterText(message[1], wordAt(message, TO_SID_OFFSET), store, wordAt(message, MAIL_LETTER_OFFSET)));
    }
  }

  /** 14: one string property for object toSID. */
  onStringProperty(message) {
    this.objects.setProperty(wordAt(message, TO_SID_OFFSET), wordAt(message, PAYLOAD_OFFSET), stringAt(message, STRING_VALUE_OFFSET));
    this.tellOthersIfPublic(message);
  }

  /** @param {Uint8Array} message @returns {number[]} property offsets, words from 6 */
  requestedOffsets(message) {
    const offsets = [];
    for (let at = PAYLOAD_OFFSET; at + 1 < message.length; at += 2) {
      offsets.push(wordAt(message, at));
    }
    return offsets;
  }

  /** 32 `[32, sid, from, offset...]`: one object's properties (another player who just joined), host cmd 33. */
  onGetObject(message) {
    const sid = wordAt(message, TO_SID_OFFSET);
    const values = this.requestedOffsets(message).map((offset) => ({ offset, value: this.objects.property(sid, offset) }));
    this.reply(objectProperties(sid, values, (offset) => this.objects.isStringProperty(offset)));
  }

  /** 31/1: the group's members with the requested properties (host cmd 31). */
  onGetMembers(message) {
    const group = wordAt(message, TO_SID_OFFSET);
    const offsets = this.requestedOffsets(message);
    const members = this.objects.members(group).map((sid) => ({
      sid, values: offsets.map((offset) => ({ offset, value: this.objects.property(sid, offset) })),
    }));
    this.reply(memberProperties(group, group, offsets, members, (offset) => this.objects.isStringProperty(offset)));
  }
}
