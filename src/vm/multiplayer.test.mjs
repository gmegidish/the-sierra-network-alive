// Two headless CasinoLand players on one World (the in-process host shared
// the way `npm run server` shares it between browsers): Gil and Kris walk
// into the same waiting room, Gil sees Kris, selects him and talks, and
// Kris's client shows the line; then Gil joins Kris's BlackJack table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { FakeServer } from '../net/fake-server.js';
import { World } from '../net/world.js';
import { STARTING_BUCKS } from '../net/host-logic.js';
import {
  INSTALL_DIR, startSession, playTogetherUntil, playerMoney, delayed, toTheCasinoLandWaitingRoomAs, CASINOLAND_WAITING_ROOM_FRAME,
} from './headless-session.mjs';

const ENTER = 13;
/** Kris starts this many frames after Gil, so Gil is in the room first. */
const SECOND_PLAYER_DELAY = 300;
const BOTH_IN_THE_WAITING_ROOM_FRAME = CASINOLAND_WAITING_ROOM_FRAME + SECOND_PLAYER_DELAY + 50;
const TALK_DELIVERED_FRAME = 17300;

/** Select the first other player in the room list, Talk, type the line and send it. */
const SAY_HELLO_KRIS = [[16300, [45, 22]], [16400, [285, 83]], [16600, 'Hello Kris'], [16620, ENTER]];

/** @param {World} world @param {number} seed @param {import('./headless-session.mjs').ScriptStep[]} script */
function playerOnWorld(world, seed, script) {
  return startSession({ seed, server: new FakeServer({ world }), script });
}

/** @param {import('./headless-session.mjs').Session} player @param {string} text @returns {boolean} the text is somewhere in the client's heap */
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

test('two players in one waiting room see each other and a talk line reaches the other client', { skip: !existsSync(INSTALL_DIR) }, () => {
  const world = new World();
  const gil = playerOnWorld(world, 1, [...toTheCasinoLandWaitingRoomAs('Gil'), ...SAY_HELLO_KRIS]);
  const kris = playerOnWorld(world, 2, delayed(toTheCasinoLandWaitingRoomAs('Kris'), SECOND_PLAYER_DELAY));

  playTogetherUntil([gil, kris], BOTH_IN_THE_WAITING_ROOM_FRAME);
  assert.equal(world.playerNames().length, 2, 'both clients logged in (with the install\'s one INN account)');
  assert.ok(clientMemoryHolds(gil, 'Kris'), 'Gil\'s client learned Kris\'s name from the host');

  playTogetherUntil([gil, kris], TALK_DELIVERED_FRAME);
  assert.ok(clientMemoryHolds(kris, 'Hello Kris'), 'Kris\'s client got Gil\'s line');
});

/** Kris opens a BlackJack table from the waiting room and lets Gil in ("Will you allow Gil to play?" Yes). */
const KRIS_OPENS_A_BLACKJACK_TABLE = [[16300, [285, 120]], [16800, [115, 78]], [19100, [133, 108]]];
/** Gil selects Kris in the room list and asks to join his game. */
const GIL_JOINS_KRIS = [[18200, [45, 22]], [18300, [285, 120]]];
const KRIS_BETS = [20850, [22, 22]];
const KRIS_STANDS = [22200, [130, 55]];
const BEFORE_THE_DEAL_FRAME = 20800;
/** Kris's two cards and the dealer's up card are on the table. */
const MID_HAND_FRAME = 22100;
const HAND_SETTLED_FRAME = 22400;
const BET = 5;
/** Where the dealer's cards, and Kris's seat with his cards, are drawn. */
const DEALER_CARDS = Object.freeze({ left: 140, top: 10, right: 240, bottom: 40 });
const KRIS_SEAT = Object.freeze({ left: 255, top: 55, right: 310, bottom: 125 });

/** @param {import('./headless-session.mjs').Session} player @param {{ left: number, top: number, right: number, bottom: number }} rect @returns {number[]} */
function pixelsIn(player, rect) {
  const { visual, width } = player.vm.screen;
  const rows = Array.from({ length: rect.bottom - rect.top }, (_, i) => rect.top + i);
  return rows.flatMap((y) => Array.from(visual.subarray(y * width + rect.left, y * width + rect.right)));
}

test('at a two-player BlackJack table both clients see the same deal and the same result', { skip: !existsSync(INSTALL_DIR) }, () => {
  const world = new World();
  const gil = playerOnWorld(world, 1, [...toTheCasinoLandWaitingRoomAs('Gil'), ...GIL_JOINS_KRIS]);
  const kris = playerOnWorld(world, 2, [...delayed(toTheCasinoLandWaitingRoomAs('Kris'), SECOND_PLAYER_DELAY), ...KRIS_OPENS_A_BLACKJACK_TABLE, KRIS_BETS, KRIS_STANDS]);

  playTogetherUntil([gil, kris], BEFORE_THE_DEAL_FRAME);
  const emptyTable = pixelsIn(kris, DEALER_CARDS);
  playTogetherUntil([gil, kris], MID_HAND_FRAME);

  assert.notDeepEqual(pixelsIn(kris, DEALER_CARDS), emptyTable, 'the dealer has cards on the table');
  assert.deepEqual(pixelsIn(gil, DEALER_CARDS), pixelsIn(kris, DEALER_CARDS), 'Gil sees the dealer\'s cards Kris dealt');
  assert.deepEqual(pixelsIn(gil, KRIS_SEAT), pixelsIn(kris, KRIS_SEAT), 'Gil sees Kris\'s cards');
  playTogetherUntil([gil, kris], HAND_SETTLED_FRAME);
  assert.equal(playerMoney(kris.vm), STARTING_BUCKS + BET, 'Kris won his seeded hand');
  assert.equal(playerMoney(gil.vm), STARTING_BUCKS, 'Gil sat it out');
});
