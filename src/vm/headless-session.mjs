// Node only, for the integration tests: one headless INN client on virtual
// time that follows TSNEXEC program switches (Clubhouse -> CasinoLand or
// SierraLand) and is driven by a frame -> input script, plus the scripted
// ways into each land (the same clicks as docs/vm.md).
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVmFromDirectory } from './node-loader.mjs';
import { nextProgramVm } from './programs.js';
import { createRandom } from './random.js';
import { EVENT_TYPE } from './events.js';

/**
 * @typedef {number[] | string | number} Action  a click [x, y], typed text or one key code
 * @typedef {[number, Action]} ScriptStep  the frame the action happens on, and the action
 * @typedef {{ seed?: number, server?: object, script?: ScriptStep[] }} SessionOptions
 * @typedef {Object} Session
 * @property {import('./vm.js').Vm} vm  the current program's VM
 * @property {{ ms: number }} clock
 * @property {Object} options  VM options, reused for the next program
 * @property {number} frame  frames run so far
 * @property {Map<number, Action[]>} script
 * @property {number[]} pics  every picture drawn, across programs
 * @property {string[]} programs  TSN.PRG programs switched to
 */

export const INSTALL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'installed', 'INN');
/** The headless wall clock starts on a 1993 evening (DOS dates start in 1980). */
const HEADLESS_EVENING = Date.UTC(1993, 0, 15, 20);
const MS_PER_FRAME = 1000 / 60;
const INSTRUCTIONS_PER_FRAME = 20000;
const PLAYER_GLOBAL = 81;

/** @param {SessionOptions} [options] @returns {Session} */
export function startSession({ seed = 1, server, script = [] } = {}) {
  const clock = { ms: HEADLESS_EVENING };
  const options = { now: () => clock.ms, random: createRandom(seed), ...(server ? { server } : {}) };
  const session = { vm: createVmFromDirectory(INSTALL_DIR, options), clock, options, frame: 0, script: new Map(), pics: [], programs: [] };
  addToScript(session, script);
  recordPictures(session);
  session.vm.boot();
  return session;
}

/** @param {Session} session @param {ScriptStep[]} steps */
export function addToScript(session, steps) {
  for (const [frame, action] of steps) {
    session.script.set(frame, [...(session.script.get(frame) ?? []), action]);
  }
}

/** @param {Session} session */
function recordPictures(session) {
  const { graphics } = session.vm;
  const drawPic = graphics.drawPic.bind(graphics);
  graphics.drawPic = (number, clear) => {
    session.pics.push(number);
    drawPic(number, clear);
  };
}

/** @param {import('./vm.js').Vm} vm @param {Action} action */
export function act(vm, action) {
  if (Array.isArray(action)) {
    const [x, y] = action;
    vm.events.push({ type: EVENT_TYPE.MOUSE_DOWN, message: 0, x, y });
    vm.events.push({ type: EVENT_TYPE.MOUSE_UP, message: 0, x, y });
    return;
  }
  const keys = typeof action === 'number' ? [action] : [...action].map((ch) => ch.charCodeAt(0));
  keys.forEach((message) => {
    vm.events.push({ type: EVENT_TYPE.KEY_DOWN, message });
    vm.events.push({ type: EVENT_TYPE.KEY_UP, message });
  });
}

/** @param {Session} session */
export function runOneFrame(session) {
  if (session.vm.interp.halted) {
    session.vm = nextProgramVm(session.vm, session.options) ?? session.vm;
    session.programs.push(session.vm.program?.name);
    recordPictures(session);
    session.vm.boot();
  }
  (session.script.get(session.frame) ?? []).forEach((action) => act(session.vm, action));
  session.vm.runSlice(INSTRUCTIONS_PER_FRAME);
  session.clock.ms += MS_PER_FRAME;
  session.frame += 1;
}

/** Run `session` up to (not including) `frame`. @param {Session} session @param {number} frame */
export function playUntil(session, frame) {
  while (session.frame < frame) {
    runOneFrame(session);
  }
}

/** Interleave several clients frame by frame up to `frame`. @param {Session[]} sessions @param {number} frame */
export function playTogetherUntil(sessions, frame) {
  while (sessions[0].frame < frame) {
    sessions.forEach(runOneFrame);
  }
}

/** The player's LarryBucks in CasinoLand (g81 is the player). @param {import('./vm.js').Vm} vm */
export function playerMoney(vm) {
  const player = vm.memory.readWord(vm.interp.globals, PLAYER_GLOBAL * 2);
  return vm.objects.getProperty(player, vm.sel('money'));
}

/** Shift a script by `frames` (a second client starting later). @param {ScriptStep[]} steps @param {number} frames */
export function delayed(steps, frames) {
  return steps.map(([frame, action]) => [frame + frames, action]);
}

/** The Clubhouse Select Player screen with the new persona on it. */
export const SELECT_PLAYER_FRAME = 8400;
/** The Winter Map is up and has the host's land list. */
export const WINTER_MAP_FRAME = 9300;

/**
 * A new Clubhouse persona (welcome OK, no guide, Create, name / age / city,
 * face, skills, hobbies, Save), then Play: it dials the host and logs in.
 * @param {string} name @returns {ScriptStep[]}
 */
export function toTheWinterMapAs(name) {
  return [
    [1250, [298, 137]], [2700, [243, 124]], [3100, [285, 93]],
    [3900, name], [3950, [117, 120]], [3970, '30'], [4000, [150, 132]], [4020, 'Explorer'], [4100, [124, 162]],
    [4400, [285, 74]], [5300, [285, 76]], [6300, [285, 76]], [7300, [285, 130]],
    [8500, [285, 58]],
  ];
}

/** Name, age and city in a land's "Information about yourself" dialog, then OK. @param {string} name @param {number} at */
function landPersonaDetails(name, at) {
  return [[at, name], [at + 50, [117, 110]], [at + 70, '30'], [at + 100, [150, 122]], [at + 120, 'Explorer'], [at + 200, [124, 152]]];
}

/** Face, skills and hobbies (Go On three times), then Save. @param {number} at */
function landPersonaPages(at) {
  return [[at, [85, 187]], [at + 600, [85, 187]], [at + 1200, [85, 187]], [at + 1800, [225, 187]]];
}

export const CASINOLAND_PLAYER_SCREEN_FRAME = 10400;
export const CASINOLAND_WAITING_ROOM_FRAME = 15900;

/**
 * CasinoLand from the map (no access password, the first casino), a new
 * CasinoLand persona, Play with BlackJack and Slots ticked: its waiting room.
 * @param {string} name @returns {ScriptStep[]}
 */
export function toTheCasinoLandWaitingRoomAs(name) {
  return [
    ...toTheWinterMapAs(name),
    [9300, [55, 40]], [9600, [219, 115]], [9900, [80, 96]],
    [10500, [125, 187]], ...landPersonaDetails(name, 11000), ...landPersonaPages(11800),
    [14300, [25, 187]], [14900, [115, 92]], [14950, [200, 140]],
  ];
}

export const SIERRALAND_WAITING_ROOM_FRAME = 15900;

/** SierraLand's first instance from the map, a new persona, Play with two games ticked. @param {string} name @returns {ScriptStep[]} */
export function toTheSierraLandWaitingRoomAs(name) {
  return [
    ...toTheWinterMapAs(name),
    [9300, [275, 80]], [9800, [80, 96]],
    [10500, [285, 95]], ...landPersonaDetails(name, 11000), ...landPersonaPages(11800),
    [14300, [285, 59]], [14900, [110, 52]], [14950, [200, 162]],
  ];
}

export const CLUBHOUSE_WAITING_ROOM_FRAME = 11000;

/** The Clubhouse's first room (INN Help Room) from the map, two games ticked. @param {string} name @returns {ScriptStep[]} */
export function toTheClubhouseWaitingRoomAs(name) {
  return [...toTheWinterMapAs(name), [9300, [185, 150]], [9800, [80, 96]], [10500, [110, 92]], [10550, [200, 160]]];
}
