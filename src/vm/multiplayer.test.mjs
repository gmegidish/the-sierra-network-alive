// Two headless LarryLand players on one World (the in-process host shared the
// way `npm run server` shares it between browsers): Gil and Kris walk into
// the same waiting room, Gil sees Kris, selects him and talks, and Kris's
// client shows the line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextProgramVm } from './programs.js';
import { createVmFromDirectory } from './node-loader.mjs';
import { createRandom } from './random.js';
import { EVENT_TYPE } from './events.js';
import { FakeServer } from '../net/fake-server.js';
import { World } from '../net/world.js';

/**
 * @typedef {Object} Player
 * @property {import('./vm.js').Vm} vm
 * @property {{ ms: number }} clock
 * @property {Object} options
 * @property {number} frame
 * @property {Map<number, string | number[]>} script frame -> click [x, y] or typed text
 */

const INSTALL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'installed', 'TSN');
const MS_PER_FRAME = 1000 / 60;
const INSTRUCTIONS_PER_FRAME = 20000;
const ENTER = 13;
/** Kris starts this many frames after Gil, so Gil is in the room first. */
const SECOND_PLAYER_DELAY = 300;
const BOTH_IN_THE_WAITING_ROOM_FRAME = 9000;
const TALK_DELIVERED_FRAME = 9600;

/** @param {string} name @returns {[number, string | number[]][]} login, persona and LarryLand's waiting room */
function toTheWaitingRoomAs(name) {
  return [
    [650, [282, 66]], [2450, [80, 30]], [2600, [80, 90]], [3500, [125, 190]],
    [4250, name], [4300, [125, 109]], [4320, '30'], [4350, [165, 122]], [4370, 'Explorer'],
    [4400, [147, 135]], [4420, '1234'], [4460, [127, 152]],
    [4900, [90, 188]], [5300, [90, 188]], [5700, [90, 188]], [5950, [225, 188]],
    [6700, [25, 190]], [7500, [115, 92]], [7520, [205, 92]], [7600, [210, 141]],
  ];
}

/** Select the first other player in the room list, Talk, type the line and send it. */
const SAY_HELLO_KRIS = [[9000, [45, 22]], [9100, [285, 83]], [9300, 'Hello Kris'], [9320, ENTER]];

/** @param {World} world @param {number} seed @param {[number, string | number[]][]} script @returns {Player} */
function playerOnWorld(world, seed, script) {
  const clock = { ms: Date.UTC(1993, 0, 15, 20) };
  const options = { now: () => clock.ms, random: createRandom(seed), server: new FakeServer({ world }) };
  const vm = createVmFromDirectory(INSTALL_DIR, options);
  vm.boot();
  return { vm, clock, options, frame: 0, script: new Map(script) };
}

/** @param {Player} player @param {string | number | number[]} action */
function act(player, action) {
  const { events } = player.vm;
  if (Array.isArray(action)) {
    events.push({ type: EVENT_TYPE.MOUSE_DOWN, message: 0, x: action[0], y: action[1] });
    events.push({ type: EVENT_TYPE.MOUSE_UP, message: 0, x: action[0], y: action[1] });
    return;
  }
  const keys = typeof action === 'number' ? [action] : [...action].map((ch) => ch.charCodeAt(0));
  keys.forEach((message) => {
    events.push({ type: EVENT_TYPE.KEY_DOWN, message });
    events.push({ type: EVENT_TYPE.KEY_UP, message });
  });
}

/** @param {Player} player */
function runOneFrame(player) {
  if (player.vm.interp.halted) {
    player.vm = nextProgramVm(player.vm, player.options) ?? player.vm;
    player.vm.boot();
  }
  if (player.script.has(player.frame)) {
    act(player, player.script.get(player.frame));
  }
  player.vm.runSlice(INSTRUCTIONS_PER_FRAME);
  player.clock.ms += MS_PER_FRAME;
  player.frame += 1;
}

/** Both clients run frame by frame, interleaved, up to `frame`. @param {Player[]} players @param {number} frame */
function playTogetherUntil(players, frame) {
  while (players[0].frame < frame) {
    players.forEach(runOneFrame);
  }
}

/** @param {Player} player @param {string} text @returns {boolean} the text is somewhere in the client's heap */
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
  const delayed = (script) => script.map(([frame, action]) => [frame + SECOND_PLAYER_DELAY, action]);
  const gil = playerOnWorld(world, 1, [...toTheWaitingRoomAs('Gil'), ...SAY_HELLO_KRIS]);
  const kris = playerOnWorld(world, 2, delayed(toTheWaitingRoomAs('Kris')));

  playTogetherUntil([gil, kris], BOTH_IN_THE_WAITING_ROOM_FRAME);
  assert.equal(world.playerNames().length, 2, 'both clients logged in (with the install\'s one TSN account)');
  assert.ok(clientMemoryHolds(gil, 'Kris'), 'Gil\'s client learned Kris\'s name from the host');

  playTogetherUntil([gil, kris], TALK_DELIVERED_FRAME);
  assert.ok(clientMemoryHolds(kris, 'Hello Kris'), 'Kris\'s client got Gil\'s line');
});

const PLAYER_GLOBAL = 81;
const MONEY_SELECTOR = 598;
/** Kris opens a BlackJack table from the waiting room; Gil selects Kris and joins it. */
const KRIS_OPENS_A_BLACKJACK_TABLE = [[9000, [285, 120]], [9100, [115, 78]], [11400, [133, 108]]];
const GIL_JOINS_KRIS = [[10500, [45, 22]], [10600, [285, 120]]];
/** Both click on the chips during the first betting round; Kris's bet makes it in. */
const GIL_BETS = [13100, [22, 22]];
const KRIS_BETS = [13150, [22, 22]];
const KRIS_STANDS = [14500, [120, 55]];
const HAND_SETTLED_FRAME = 14700;
/** Where the dealer's cards and the BUST sign, and Kris's seat with his card and WON, are drawn. */
const DEALER_CARDS = Object.freeze({ left: 140, top: 10, right: 240, bottom: 40 });
const KRIS_SEAT = Object.freeze({ left: 262, top: 62, right: 310, bottom: 125 });

/** @param {Player} player @param {{ left: number, top: number, right: number, bottom: number }} rect @returns {number[]} */
function pixelsIn(player, rect) {
  const { visual, width } = player.vm.screen;
  const rows = Array.from({ length: rect.bottom - rect.top }, (_, i) => rect.top + i);
  return rows.flatMap((y) => Array.from(visual.subarray(y * width + rect.left, y * width + rect.right)));
}

/** @param {Player} player @returns {number} */
function moneyOf(player) {
  const body = player.vm.memory.readWord(player.vm.interp.globals, PLAYER_GLOBAL * 2);
  return player.vm.objects.getProperty(body, MONEY_SELECTOR);
}

test('at a two-player BlackJack table both clients see the same deal and the same result', { skip: !existsSync(INSTALL_DIR) }, () => {
  const world = new World();
  const delayed = (script) => script.map(([frame, action]) => [frame + SECOND_PLAYER_DELAY, action]);
  const gil = playerOnWorld(world, 1, [...toTheWaitingRoomAs('Gil'), ...GIL_JOINS_KRIS, GIL_BETS]);
  const kris = playerOnWorld(world, 2, [...delayed(toTheWaitingRoomAs('Kris')), ...KRIS_OPENS_A_BLACKJACK_TABLE, KRIS_BETS, KRIS_STANDS]);
  const emptyTable = () => pixelsIn(kris, DEALER_CARDS);

  playTogetherUntil([gil, kris], GIL_BETS[0]);
  const beforeTheDeal = emptyTable();
  playTogetherUntil([gil, kris], HAND_SETTLED_FRAME);

  assert.notDeepEqual(pixelsIn(kris, DEALER_CARDS), beforeTheDeal, 'the dealer has cards on the table');
  assert.deepEqual(pixelsIn(gil, DEALER_CARDS), pixelsIn(kris, DEALER_CARDS), 'Gil sees the dealer\'s cards Kris dealt');
  assert.deepEqual(pixelsIn(gil, KRIS_SEAT), pixelsIn(kris, KRIS_SEAT), 'Gil sees Kris\'s card and result');
  assert.ok(moneyOf(kris) > moneyOf(gil), 'Kris won his hand while Gil sat it out with his chip on the table');
});
