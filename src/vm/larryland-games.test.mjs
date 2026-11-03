// CasinoLand (INN LL) end to end against the in-process host: persona,
// waiting room, a new Slots game, the Bank of LarryLand's starting money and
// one pull of the handle. The Random kernel is seeded, so the spin always
// comes out the same (seed 22: a 2-buck bet wins 4; seed 2 at BlackJack: a
// 5-buck bet, the player stands and wins 1 to 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { STARTING_BUCKS } from '../net/host-logic.js';
import {
  INSTALL_DIR, startSession, playUntil, addToScript, playerMoney, toTheCasinoLandWaitingRoomAs, CASINOLAND_WAITING_ROOM_FRAME,
} from './headless-session.mjs';

const WINNING_SEED = 22;
const BET = 2;
const SEED_22_WINS = 4;
const PLAY = [15950, [285, 120]];
/** Slots, then "Grab the Cash" in the machine list. */
const TO_A_SLOT_MACHINE = Object.freeze([PLAY, [16500, [205, 78]], [17550, [95, 70]]]);
const AT_THE_MACHINE_FRAME = 18100;
const RAISE_BET = Object.freeze([18200, [122, 133]]);
const PULL_HANDLE = Object.freeze([18300, [163, 47]]);
const REELS_STOPPED_FRAME = 19000;
const BLACKJACK_SEED = 2;
const BLACKJACK_BET = 5;
const TO_THE_BLACKJACK_TABLE = Object.freeze([PLAY, [16500, [115, 78]]]);
const AT_THE_TABLE_FRAME = 17400;
const CLICK_ON_CHIPS = Object.freeze([17500, [22, 22]]);
const STAND = Object.freeze([18350, [130, 55]]);
const HAND_SETTLED_FRAME = 18900;

/** Gil in the CasinoLand waiting room, with `seed` for the Random kernel. */
function gilInTheWaitingRoom(seed) {
  const session = startSession({ seed, script: toTheCasinoLandWaitingRoomAs('Gil') });
  playUntil(session, CASINOLAND_WAITING_ROOM_FRAME);
  return session;
}

test('a new CasinoLand player gets the bank\'s starting money and a seeded pull of the slot handle pays out', { skip: !existsSync(INSTALL_DIR) }, () => {
  const session = gilInTheWaitingRoom(WINNING_SEED);
  addToScript(session, TO_A_SLOT_MACHINE);
  playUntil(session, AT_THE_MACHINE_FRAME);
  assert.equal(session.vm.fs.cwd, 'LL');
  assert.equal(playerMoney(session.vm), STARTING_BUCKS);

  addToScript(session, [RAISE_BET, PULL_HANDLE]);
  playUntil(session, REELS_STOPPED_FRAME);
  assert.equal(playerMoney(session.vm), STARTING_BUCKS - BET + SEED_22_WINS);
});

test('at the BlackJack table a seeded hand is dealt by the client and a win pays the bet back 1 to 1', { skip: !existsSync(INSTALL_DIR) }, () => {
  const session = gilInTheWaitingRoom(BLACKJACK_SEED);
  addToScript(session, TO_THE_BLACKJACK_TABLE);
  playUntil(session, AT_THE_TABLE_FRAME);
  assert.equal(playerMoney(session.vm), STARTING_BUCKS);

  addToScript(session, [CLICK_ON_CHIPS, STAND]);
  playUntil(session, HAND_SETTLED_FRAME);
  assert.equal(playerMoney(session.vm), STARTING_BUCKS + BLACKJACK_BET);
});
