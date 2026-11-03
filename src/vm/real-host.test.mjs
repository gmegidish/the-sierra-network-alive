// Integration: the VM dials the real host logic (server/session.js) through
// LineHost, the X.28 PAD and LinkEndpoint framing, joined by an in-memory
// line instead of a WebSocket. Login must reach the Winter Map (pic 52) with no
// LandAddr loop. Skipped when installed/INN is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createVmFromDirectory } from './node-loader.mjs';
import { INSTALL_DIR, act, toTheWinterMapAs, WINTER_MAP_FRAME } from './headless-session.mjs';
import { LineHost } from '../net/line-host.js';
import { HostSession, STAGE } from '../../server/session.js';

/**
 * @typedef {Object} InMemoryLine
 * @property {(options?: object) => import('../net/ws-transport.js').LineTransport} open  LineHost's openLine
 * @property {() => void} deliver  move queued bytes both ways and tick the host
 * @property {() => HostSession | null} session
 */

const MS_PER_FRAME = 1000 / 60;
const INSTRUCTIONS_PER_FRAME = 20000;
const MAP_PIC = 52;
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
  const script = new Map(toTheWinterMapAs('Gil'));
  const runFrames = (count) => {
    for (let frame = 0; frame < count; frame++) {
      if (script.has(frame)) {
        act(vm, script.get(frame));
      }
      vm.runSlice(INSTRUCTIONS_PER_FRAME);
      line.deliver();
      clock += MS_PER_FRAME;
    }
  };
  return { vm, host, line, drawnPics, runFrames };
}

/** @param {LineHost} host @param {string} typeAndSub */
function timesClientSent(host, typeAndSub) {
  return host.log.filter(({ kind, detail }) => kind === 'packet' && detail.startsWith(`${typeAndSub} `)).length;
}

test('login through the real host session over the link layer reaches the Winter Map', { skip: !existsSync(INSTALL_DIR) }, () => {
  const { vm, host, line, drawnPics, runFrames } = bootAgainstRealHostLogic();
  runFrames(WINTER_MAP_FRAME);

  assert.equal(vm.interp.halted, false);
  assert.equal(host.state, 'online', 'the PAD call connected');
  assert.equal(line.session()?.stage, STAGE.ONLINE, 'the host saw login, joinNet and the land request');
  assert.equal(timesClientSent(host, LAND_ADDR_REQUEST), 1, 'the land list is asked for once (no LandAddr loop)');
  assert.equal(drawnPics.at(-1), MAP_PIC);
});
