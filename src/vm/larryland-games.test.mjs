// LarryLand end to end against the in-process host: persona, waiting room,
// a new Slots game, the Bank of LarryLand's starting money and one pull of
// the handle. The Random kernel is seeded, so the spin always comes out the
// same (seed 22: three cherries on a 2-buck bet pay 10; seed 1 at BlackJack:
// a 5-buck bet, the player stands and the dealer busts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextProgramVm } from './programs.js';
import { createVmFromDirectory } from './node-loader.mjs';
import { createRandom } from './random.js';
import { EVENT_TYPE } from './events.js';
import { STARTING_BUCKS } from '../net/host-logic.js';

const INSTALL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'installed', 'TSN');
const MS_PER_FRAME = 1000 / 60;
const INSTRUCTIONS_PER_FRAME = 20000;
const WINNING_SEED = 22;
const BET = 2;
const CHERRIES_PAY = 10;
const PLAYER_GLOBAL = 81;
const MONEY_SELECTOR = 598;

/** Frame -> clicks [x, y] or typed text, the same sequence as docs/vm.md. */
const TO_THE_SLOTS_ROOM = Object.freeze([
  [650, [282, 66]], [2450, [80, 30]], [2600, [80, 90]], [3500, [125, 190]],
  [4250, 'Gil'], [4300, [125, 109]], [4320, '30'], [4350, [165, 122]], [4370, 'Explorer'],
  [4400, [147, 135]], [4420, '1234'], [4460, [127, 152]],
  [4900, [90, 188]], [5300, [90, 188]], [5700, [90, 188]], [5950, [225, 188]],
  [6700, [25, 190]], [7500, [115, 92]], [7520, [205, 92]], [7600, [210, 141]],
  [8600, [285, 120]], [9100, [205, 78]], [10200, [95, 70]],
]);
const IN_THE_SLOTS_ROOM_FRAME = 10800;
const BLACKJACK_SEED = 1;
const BLACKJACK_BET = 5;
/** The same way in, but BlackJack in the game list, then a chip bet and Stand. */
const TO_THE_BLACKJACK_TABLE = Object.freeze([...TO_THE_SLOTS_ROOM.slice(0, -2), [9100, [115, 78]]]);
const AT_THE_TABLE_FRAME = 10100;
const CLICK_ON_CHIPS = Object.freeze([10100, [22, 22]]);
const STAND = Object.freeze([10950, [130, 55]]);
const HAND_SETTLED_FRAME = 11300;
const RAISE_BET = Object.freeze([10800, [122, 133]]);
const PULL_HANDLE = Object.freeze([10900, [163, 47]]);
const REELS_STOPPED_FRAME = 11600;

function act(vm, action) {
  if (typeof action === 'string') {
    [...action].forEach((ch) => {
      vm.events.push({ type: EVENT_TYPE.KEY_DOWN, message: ch.charCodeAt(0) });
      vm.events.push({ type: EVENT_TYPE.KEY_UP, message: ch.charCodeAt(0) });
    });
    return;
  }
  const [x, y] = action;
  vm.events.push({ type: EVENT_TYPE.MOUSE_DOWN, message: 0, x, y });
  vm.events.push({ type: EVENT_TYPE.MOUSE_UP, message: 0, x, y });
}

/** Run frames [from, to) of the session, following program switches and the scripted input. */
function play(session, to, script) {
  const actions = new Map(script);
  for (; session.frame < to; session.frame++) {
    if (session.vm.interp.halted) {
      session.vm = nextProgramVm(session.vm) ?? session.vm;
      session.vm.boot();
    }
    if (actions.has(session.frame)) {
      act(session.vm, actions.get(session.frame));
    }
    session.vm.runSlice(INSTRUCTIONS_PER_FRAME);
    session.clock.ms += MS_PER_FRAME;
  }
}

function startLarryLandSession(seed) {
  const clock = { ms: Date.UTC(1993, 0, 15, 20) }; // headless wall clock: a 1993 evening (DOS dates start in 1980)
  const vm = createVmFromDirectory(INSTALL_DIR, { now: () => clock.ms, random: createRandom(seed) });
  vm.boot();
  return { vm, clock, frame: 0 };
}

function playerMoney(vm) {
  const player = vm.memory.readWord(vm.interp.globals, PLAYER_GLOBAL * 2);
  return vm.objects.getProperty(player, MONEY_SELECTOR);
}

test('a new LarryLand player gets the bank\'s starting money and a seeded pull of the slot handle pays out', { skip: !existsSync(INSTALL_DIR) }, () => {
  const session = startLarryLandSession(WINNING_SEED);

  play(session, IN_THE_SLOTS_ROOM_FRAME, TO_THE_SLOTS_ROOM);
  assert.equal(session.vm.fs.cwd, 'LL');
  assert.equal(playerMoney(session.vm), STARTING_BUCKS);

  play(session, REELS_STOPPED_FRAME, [RAISE_BET, PULL_HANDLE]);
  assert.equal(playerMoney(session.vm), STARTING_BUCKS - BET + CHERRIES_PAY);
});

test('at the BlackJack table a seeded hand is dealt by the client and a win pays the bet back 1 to 1', { skip: !existsSync(INSTALL_DIR) }, () => {
  const session = startLarryLandSession(BLACKJACK_SEED);
  play(session, AT_THE_TABLE_FRAME, TO_THE_BLACKJACK_TABLE);
  assert.equal(playerMoney(session.vm), STARTING_BUCKS);

  play(session, HAND_SETTLED_FRAME, [CLICK_ON_CHIPS, STAND]);
  assert.equal(playerMoney(session.vm), STARTING_BUCKS + BLACKJACK_BET);
});
