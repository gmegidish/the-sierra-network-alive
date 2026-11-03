// Integration: the VM dials the real host logic (server/session.js) through
// LineHost, the X.28 PAD and LinkEndpoint framing, joined by an in-memory
// line instead of a WebSocket. Login must reach the TSN map (pic 50) with no
// LandAddr loop. Skipped when installed/TSN is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVmFromDirectory } from './node-loader.mjs';
import { EVENT_TYPE } from './events.js';
import { LineHost } from '../net/line-host.js';
import { HostSession, STAGE } from '../../server/session.js';

/**
 * @typedef {Object} InMemoryLine
 * @property {(options?: object) => import('../net/ws-transport.js').LineTransport} open  LineHost's openLine
 * @property {() => void} deliver  move queued bytes both ways and tick the host
 * @property {() => HostSession | null} session
 */

const INSTALL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'installed', 'TSN');
const MS_PER_FRAME = 1000 / 60;
const INSTRUCTIONS_PER_FRAME = 20000;
const PLAY_BUTTON = Object.freeze({ x: 282, y: 66 });
const PLAYER_SCREEN_FRAME = 650;
const MAP_FRAME = 2400;
const MAP_PIC = 50;
const LAND_ADDR_REQUEST = '36/6';

/** @param {() => number} now @returns {InMemoryLine} */
function inMemoryLineToHostSession(now) {
  const toHost = [];
  const toClient = [];
  const callbacks = { data: () => {}, open: () => {}, close: () => {} };
  const state = { session: null, isOpenPending: false };
  const open = () => {
    state.session = new HostSession({ send: (bytes) => toClient.push(Uint8Array.from(bytes)), now });
    state.isOpenPending = true;
    return {
      write: (bytes) => toHost.push(Uint8Array.from(bytes)),
      onData: (cb) => { callbacks.data = cb; },
      onOpen: (cb) => { callbacks.open = cb; },
      onClose: (cb) => { callbacks.close = cb; },
      sendBreak: () => state.session.lineBreak(),
      close: () => callbacks.close('hang up'),
    };
  };
  const deliver = () => {
    if (state.isOpenPending) {
      state.isOpenPending = false;
      callbacks.open();
    }
    toHost.splice(0).forEach((bytes) => state.session?.receive(bytes));
    toClient.splice(0).forEach((bytes) => callbacks.data(bytes));
    state.session?.tick();
  };
  return { open, deliver, session: () => state.session };
}

function bootAgainstRealHostLogic() {
  let clock = Date.UTC(1993, 0, 15, 20); // headless wall clock: a 1993 evening (DOS dates start in 1980)
  const now = () => clock;
  const line = inMemoryLineToHostSession(now);
  const host = new LineHost({ now, openLine: line.open });
  const vm = createVmFromDirectory(INSTALL_DIR, { now, server: host });
  const drawnPics = [];
  const drawPic = vm.graphics.drawPic.bind(vm.graphics);
  vm.graphics.drawPic = (number, clear) => {
    drawnPics.push(number);
    drawPic(number, clear);
  };
  vm.boot();
  const runFrames = (count) => {
    for (let i = 0; i < count; i++) {
      vm.runSlice(INSTRUCTIONS_PER_FRAME);
      line.deliver();
      clock += MS_PER_FRAME;
    }
  };
  return { vm, host, line, drawnPics, runFrames };
}

function clickAt(vm, { x, y }) {
  vm.events.push({ type: EVENT_TYPE.MOUSE_DOWN, message: 0, x, y });
  vm.events.push({ type: EVENT_TYPE.MOUSE_UP, message: 0, x, y });
}

/** @param {LineHost} host @param {string} typeAndSub */
function timesClientSent(host, typeAndSub) {
  return host.log.filter(({ kind, detail }) => kind === 'packet' && detail.startsWith(`${typeAndSub} `)).length;
}

test('login through the real host session over the link layer reaches the TSN map', { skip: !existsSync(INSTALL_DIR) }, () => {
  const { vm, host, line, drawnPics, runFrames } = bootAgainstRealHostLogic();
  runFrames(PLAYER_SCREEN_FRAME);
  clickAt(vm, PLAY_BUTTON);
  runFrames(MAP_FRAME - PLAYER_SCREEN_FRAME);

  assert.equal(vm.interp.halted, false);
  assert.equal(host.state, 'online', 'the PAD call connected');
  assert.equal(line.session()?.stage, STAGE.ONLINE, 'the host saw login, joinNet and the land request');
  assert.equal(timesClientSent(host, LAND_ADDR_REQUEST), 1, 'the land list is asked for once (no LandAddr loop)');
  assert.equal(drawnPics.at(-1), MAP_PIC);
});
