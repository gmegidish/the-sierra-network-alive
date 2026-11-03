// Bots: host-side players with no client behind them, so one person can see
// somebody in the waiting rooms. A bot joins every waiting room (shared group)
// as it opens, shows a persona in the room list, and answers talk with a
// canned line. It does not play games (a BlackJack seat needs a client).

import { encodeMessage } from './wire.js';
import { wordAt } from './host-objects.js';

/**
 * @typedef {Object} BotPersona
 * @property {string} name        property 5, the name in the room list
 * @property {string} occupation  property 24
 * @property {string} reply       what it says when talked to
 */

const USER_MESSAGE = 2;
const TALK = 1;
/** Talk data after msgType: b 14, b 2, b 1, then the zero-terminated text (as the LL client sends it). */
const TALK_HEAD = [14, 2, 1];
const MSG = Object.freeze({ TO: 2, FROM: 4, TYPE: 6 });
/** Persona properties the waiting room asks for (client 32); values as a fresh LarryLand player sets them. */
const PROPERTY = Object.freeze({ NAME: 5, ROOM: 9, FACE: 18, OCCUPATION: 24, AGE: 23 });
const FACE_PARTS = 16;
const PLAIN_FACE_PART = 3;
const WAITING_ROOM_MODULE = 120;
const BOT_AGE = 30;

export const DEFAULT_BOTS = Object.freeze([
  { name: 'Robo Larry', occupation: 'Bot', reply: 'Beep! I only chat. Open a table and wait for a real player.' },
  { name: 'Patti Bot', occupation: 'Bot', reply: 'Hi there! I am a bot keeping the room warm.' },
]);

export class Bot {
  /** @param {import('./world.js').World} world @param {BotPersona} persona */
  constructor(world, persona) {
    this.world = world;
    this.persona = persona;
    this.playerName = persona.name;
    this.sid = world.joinNet(this, null);
    this.setPersona();
  }

  setPersona() {
    const { objects } = this.world;
    objects.setProperty(this.sid, PROPERTY.NAME, this.persona.name);
    objects.setProperty(this.sid, PROPERTY.FACE, String.fromCharCode(...new Array(FACE_PARTS).fill(PLAIN_FACE_PART)));
    objects.setProperty(this.sid, PROPERTY.OCCUPATION, this.persona.occupation);
    objects.setProperty(this.sid, PROPERTY.ROOM, WAITING_ROOM_MODULE);
    objects.setProperty(this.sid, PROPERTY.AGE, BOT_AGE);
  }

  /** A message the world routes to the bot: talk gets the canned reply. @param {Uint8Array} message */
  deliver(message) {
    const isTalkToMe = message[0] === USER_MESSAGE && wordAt(message, MSG.TYPE) === TALK && wordAt(message, MSG.TO) === this.sid;
    if (!isTalkToMe) {
      return;
    }
    const to = wordAt(message, MSG.FROM);
    const data = [...TALK_HEAD, ...[...this.persona.reply].map((ch) => ch.charCodeAt(0)), 0];
    this.world.relay(encodeMessage('bbwwwa', [USER_MESSAGE, 0, to, this.sid, TALK, data.length, Uint8Array.from(data)]), to, this.sid);
  }
}

/**
 * `count` bots on `world`; each joins every waiting room as it opens.
 * @param {import('./world.js').World} world @param {number} count @returns {Bot[]}
 */
export function addBots(world, count) {
  const bots = DEFAULT_BOTS.slice(0, count).map((persona) => new Bot(world, persona));
  world.onSharedGroup = (group) => bots.forEach((bot) => world.joinGroup(group, bot.sid));
  return bots;
}
