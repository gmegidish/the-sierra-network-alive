// A headless SierraLand player invites a host bot to a game: the bot accepts
// and takes its seat the way an invitee's client does (GET_SID, ACCEPT, then
// the game group on START_GAME), so the inviter's client goes past
// "Waiting to start...." into the game, with the bot as the opponent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { FakeServer } from '../net/fake-server.js';
import { World } from '../net/world.js';
import { addBots, DEFAULT_BOTS } from '../net/bots.js';
import {
  INSTALL_DIR, startSession, playUntil, toTheSierraLandWaitingRoomAs, SIERRALAND_WAITING_ROOM_FRAME,
} from './headless-session.mjs';

/** Select the first player in the room list (the bot), Invite, pick SneakATac in the game list. */
const INVITE_THE_BOT_TO_SNEAKATAC = [
  [SIERRALAND_WAITING_ROOM_FRAME + 100, [45, 22]],
  [SIERRALAND_WAITING_ROOM_FRAME + 200, [285, 101]],
  [SIERRALAND_WAITING_ROOM_FRAME + 800, [110, 108]],
];
const SNEAKATAC_PIC = 775;
const ROOM_PROPERTY = 9;
const GAME_LOADED_FRAME = SIERRALAND_WAITING_ROOM_FRAME + 4000;

/** @param {import('./headless-session.mjs').Session} player @param {string} text @returns {boolean} */
function clientMemoryHolds(player, text) {
  const needle = [...text].map((ch) => ch.charCodeAt(0));
  return [...player.vm.memory.entries.values()].some(({ bytes }) => containsBytes(bytes, needle));
}

/** @param {Uint8Array} bytes @param {number[]} needle @returns {boolean} */
function containsBytes(bytes, needle) {
  for (let i = 0; i + needle.length <= bytes.length; i++) {
    if (needle.every((byte, j) => bytes[i + j] === byte)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {World} world @param {FakeServer} inviter @param {number} bot
 * @returns {boolean} a group holds the inviter's player, then the bot, and nobody else
 */
function botIsSeatedAfterTheInviter(world, inviter, bot) {
  return world.groupsOf(bot).some((group) => {
    const members = world.objects.members(group);
    return members.length === 2 && world.ownerOf(members[0]) === inviter.host && members[1] === bot;
  });
}

test('a player who invites a bot to SneakATac gets into the game with the bot seated', { skip: !existsSync(INSTALL_DIR) }, () => {
  const world = new World();
  const [bot] = addBots(world, 1);
  const server = new FakeServer({ world });
  const gil = startSession({ server, script: [...toTheSierraLandWaitingRoomAs('Gil'), ...INVITE_THE_BOT_TO_SNEAKATAC] });

  playUntil(gil, GAME_LOADED_FRAME);

  assert.ok(gil.pics.includes(SNEAKATAC_PIC), 'the SneakATac board is drawn');
  assert.equal(world.objects.property(bot.sid, ROOM_PROPERTY), SNEAKATAC_PIC, 'the bot shows SneakATac as its room');
  assert.ok(botIsSeatedAfterTheInviter(world, server, bot.sid), 'the bot sits in the game group, second');
  assert.ok(clientMemoryHolds(gil, `${DEFAULT_BOTS[0].name} will make the first move`), 'the coin toss names the bot as the opponent');
});
