// Bots: host-side players with no client behind them, so one person can see
// somebody in the waiting rooms. A bot joins every waiting room (shared group)
// as it opens, shows a persona in the room list, answers talk with a canned
// line and accepts game invitations the way an invitee's invite room does
// (SierraLand modules 905-907, the Football invite source installed/INN/913.SO):
// it gives the inviter a module SID (GET_SID), accepts, and on START_GAME
// takes its seat in the game group, so the inviter's game starts. It does not
// play: the game waits for the bot's moves, and a BlackJack seat needs a client.

import { encodeMessage } from './wire.js';
import { wordAt } from './host-objects.js';
import { createSidAllocator } from './world.js';

/**
 * @typedef {Object} BotPersona
 * @property {string} name        property 5, the name in the room list
 * @property {string} occupation  property 24
 * @property {string} reply       what it says when talked to
 */

/**
 * @typedef {Object} PendingSeat
 * @property {number} inviter  the inviter's player SID (fromSID of START_GAME)
 * @property {number} game     the game's module number
 */

const USER_MESSAGE = 2;
const TALK = 1;
/**
 * Invite room msgTypes (913.SO; DECLINE is 14, UNKNOWN_GAME 999). GET_SID and
 * START_GAME are read from the traffic of two SierraLand clients (module 905-907).
 */
const INVITE_MSG = 12;
const ACCEPT = 13;
const GET_SID = 56;
const START_GAME = 58;
/** INVITE data after msgType: whatGame w8, numInvitees w10, retAddress w12 (the inviter's invite room), invitee SIDs. */
const INVITE_DATA = Object.freeze({ GAME: 8, RET_ADDRESS: 12 });
/** START_GAME data after msgType: the game group's SID w8, number of players w10. */
const START_GAME_GROUP_OFFSET = 8;
/** fromSID of a property change every caller hears about (13 with fromSID 0xFFFF). */
const EVERYBODY = 0xffff;
const WORD_PROPERTIES = 13;
/** Talk data after msgType: b 14, b 2, b 1, then the zero-terminated text (as the LL client sends it). */
const TALK_HEAD = [14, 2, 1];
const MSG = Object.freeze({ TO: 2, FROM: 4, TYPE: 6 });
/** Host cmd 11 `[11, 0, group w2, who w4]`: somebody left a group the bot is in. */
const GROUP_LEFT = Object.freeze({ COMMAND: 11, GROUP: 2 });
/** Persona properties the waiting room asks for (client 32); values as a fresh LarryLand player sets them. */
const PROPERTY = Object.freeze({ NAME: 5, ROOM: 9, FACE: 18, OCCUPATION: 24, AGE: 23 });
/**
 * SierraLand's Player has other property offsets (module 59953 propDict): 17
 * gameSkillInt, 19 knowAppearance, 22 age (23 is city, a string). A SierraLand
 * game with an opponent whose knowAppearance is 0 never gets past loading.
 */
const SIERRALAND_PROPERTY = Object.freeze({ SKILLS: 17, KNOWS_APPEARANCE: 19, AGE: 22 });
const FACE_PARTS = 16;
const PLAIN_FACE_PART = 3;
const WAITING_ROOM_MODULE = 120;
const BOT_AGE = 30;
/**
 * Bots take SIDs above every caller's (the host's start at 101). The
 * SierraLand games sort the game group by SID and the lowest one leads
 * (Boogers' seed, msgType 1001, comes from it); a bot can't lead, so the
 * inviter must. Below 0x8000: the scripts compare SIDs as signed words.
 */
const BOT_FIRST_SID = 0x7000;

export const DEFAULT_BOTS = Object.freeze([
  { name: 'Robo Larry', occupation: 'Bot', reply: 'Beep! I only chat. Open a table and wait for a real player.' },
  { name: 'Patti Bot', occupation: 'Bot', reply: 'Hi there! I am a bot keeping the room warm.' },
]);

export class Bot {
  /**
   * @param {import('./world.js').World} world @param {BotPersona} persona
   * @param {() => number} [allocateSid] the bot's SIDs (its player and invite rooms); above every caller's by default
   */
  constructor(world, persona, allocateSid = createSidAllocator(BOT_FIRST_SID)) {
    this.allocateSid = allocateSid;
    this.world = world;
    this.persona = persona;
    this.playerName = persona.name;
    this.sid = this.joinNet();
    /** @type {Map<number, number>} the bot's invite-room SID (GET_SID) -> the game number it was invited to */
    this.inviteRooms = new Map();
    /** @type {Set<number>} game groups the bot is seated in */
    this.gameGroups = new Set();
    /** @type {Map<number, PendingSeat>} game group -> the seat the bot takes once the inviter is in it */
    this.pendingSeats = new Map();
    this.setPersona();
  }

  /** A new SID owned by the bot. @returns {number} */
  joinNet() {
    const sid = this.allocateSid();
    this.world.claim(sid, this);
    return sid;
  }

  setPersona() {
    const { objects } = this.world;
    objects.setProperty(this.sid, PROPERTY.NAME, this.persona.name);
    const plainFace = String.fromCharCode(...new Array(FACE_PARTS).fill(PLAIN_FACE_PART));
    objects.setProperty(this.sid, PROPERTY.FACE, plainFace);
    objects.setProperty(this.sid, PROPERTY.OCCUPATION, this.persona.occupation);
    objects.setProperty(this.sid, PROPERTY.ROOM, WAITING_ROOM_MODULE);
    objects.setProperty(this.sid, PROPERTY.AGE, BOT_AGE);
    objects.setProperty(this.sid, SIERRALAND_PROPERTY.SKILLS, plainFace);
    objects.setProperty(this.sid, SIERRALAND_PROPERTY.AGE, BOT_AGE);
    objects.setProperty(this.sid, SIERRALAND_PROPERTY.KNOWS_APPEARANCE, 1);
  }

  /** A message the world routes to the bot: talk gets the canned reply, an invitation a yes, START_GAME a seat. @param {Uint8Array} message */
  deliver(message) {
    if (message[0] === GROUP_LEFT.COMMAND) {
      this.onSomebodyLeft(wordAt(message, GROUP_LEFT.GROUP));
      return;
    }
    if (message[0] !== USER_MESSAGE) {
      return;
    }
    const to = wordAt(message, MSG.TO);
    const msgType = wordAt(message, MSG.TYPE);
    if (to === this.sid && msgType === TALK) {
      this.reply(wordAt(message, MSG.FROM));
    }
    if (to === this.sid && msgType === INVITE_MSG) {
      this.acceptInvitation(wordAt(message, INVITE_DATA.RET_ADDRESS), wordAt(message, INVITE_DATA.GAME));
    }
    if (this.inviteRooms.has(to) && msgType === START_GAME) {
      this.onStartGame(to, wordAt(message, START_GAME_GROUP_OFFSET), wordAt(message, MSG.FROM));
    }
  }

  /**
   * An invitee's invite room: joinNet its own room, tell the inviter its SID
   * (`wwwww [2, retAddress, mySid, GET_SID, roomSid]`, so START_GAME can reach
   * it), then `wwww [2, retAddress, mySid, ACCEPT]`.
   * @param {number} retAddress the inviter's invite room @param {number} game the game's module number
   */
  acceptInvitation(retAddress, game) {
    const inviteRoom = this.joinNet();
    this.inviteRooms.set(inviteRoom, game);
    this.world.relay(encodeMessage('wwwww', [USER_MESSAGE, retAddress, this.sid, GET_SID, inviteRoom]), retAddress, this.sid);
    this.world.relay(encodeMessage('wwww', [USER_MESSAGE, retAddress, this.sid, ACCEPT]), retAddress, this.sid);
  }

  /**
   * START_GAME (to the bot's invite room): leaveNet the invite room, then sit
   * down in the game group once the inviter is in it, as a real invitee
   * does a round trip later (the inviter's client expects to be in the
   * group first; who leads a game is decided by SID, see BOT_FIRST_SID).
   * @param {number} inviteRoom @param {number} gameGroup @param {number} inviter
   */
  onStartGame(inviteRoom, gameGroup, inviter) {
    const game = this.inviteRooms.get(inviteRoom) ?? WAITING_ROOM_MODULE;
    this.inviteRooms.delete(inviteRoom);
    this.world.release(inviteRoom);
    this.pendingSeats.set(gameGroup, { inviter, game });
    this.onGroupJoined(gameGroup);
  }

  /** Somebody joined `group`: take a pending seat there once the inviter is in. @param {number} group */
  onGroupJoined(group) {
    const seat = this.pendingSeats.get(group);
    if (!seat || !this.world.objects.members(group).includes(seat.inviter)) {
      return;
    }
    this.pendingSeats.delete(group);
    this.gameGroups.add(group);
    this.world.joinGroup(group, this.sid);
    this.showRoom(seat.game);
  }

  /** Whoever leaves a game the bot sits in ends it: the bot goes back to the waiting room. @param {number} group */
  onSomebodyLeft(group) {
    if (!this.gameGroups.has(group)) {
      return;
    }
    this.gameGroups.delete(group);
    this.world.leaveGroup(group, this.sid);
    this.showRoom(WAITING_ROOM_MODULE);
  }

  /** Public property 9 (the room module), as a client sets it with 13 / 0xFFFF. @param {number} room */
  showRoom(room) {
    this.world.objects.setProperty(this.sid, PROPERTY.ROOM, room);
    this.world.sendToOthers(encodeMessage('wwwww', [WORD_PROPERTIES, this.sid, EVERYBODY, PROPERTY.ROOM, room]), this);
  }

  /** @param {number} to */
  reply(to) {
    const data = [...TALK_HEAD, ...[...this.persona.reply].map((ch) => ch.charCodeAt(0)), 0];
    this.world.relay(encodeMessage('bbwwwa', [USER_MESSAGE, 0, to, this.sid, TALK, data.length, Uint8Array.from(data)]), to, this.sid);
  }
}

/**
 * `count` bots on `world`; each joins every waiting room as it opens.
 * @param {import('./world.js').World} world @param {number} count @returns {Bot[]}
 */
export function addBots(world, count) {
  const allocateSid = createSidAllocator(BOT_FIRST_SID);
  const bots = DEFAULT_BOTS.slice(0, count).map((persona) => new Bot(world, persona, allocateSid));
  world.onSharedGroup = (group) => bots.forEach((bot) => world.joinGroup(group, bot.sid));
  world.onGroupJoined = (group) => bots.forEach((bot) => bot.onGroupJoined(group));
  return bots;
}
