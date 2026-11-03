#!/usr/bin/env node
// Plays the TSN client against the local host, using the same shared
// src/net classes the web client uses: HayesModem -> WebSocket line ->
// X.28 PAD dialog -> LinkEndpoint -> login, joinNet, startup burst, 47/1.
// Usage: node tools/fake-client.mjs [ws://localhost:7000/line] [password]

import { pathToFileURL } from 'node:url';
import { HayesModem, asciiBytes, asciiText } from '../src/net/modem.js';
import { LinkEndpoint } from '../src/net/link.js';
import { openLineTransport, DEFAULT_LINE_URL } from '../src/net/ws-transport.js';
import { describeHostMessage, formatDescribed, HOST, CLIENT, CLIENT_SUB, LOGIN_WHICH_CMD } from '../src/net/catalog.js';
import {
  loginMessage, joinNetMessage, startupBurstMessages, landRequestMessage,
} from '../src/net/client-messages.js';

/**
 * @typedef {Object} FakeClientOptions
 * @property {string} [url]
 * @property {string} [password]
 * @property {number} [number]  account number
 * @property {string} [name]  persona
 * @property {(line: string) => void} [log]
 * @property {number} [stepTimeoutMs]
 */

/**
 * @typedef {Object} FakeClientResult
 * @property {boolean} isOnline  reached the "online" state (47/1 done)
 * @property {string} failure  why it stopped, '' when online
 * @property {Uint8Array[]} hostMessages
 */

const DIAL_STRING = 'ATDT5551212\r';
const PAD_ADDRESS = 'SIERRA';
const SELF_OBJECT_ID = 0x1234;
const DEFAULT_ACCOUNT = 7;
const STEP_TIMEOUT_MS = 5000;
const LINK_TICK_MS = 100;

/**
 * Collects things that arrive asynchronously and lets the script wait for
 * the first one matching a predicate.
 * @template T
 */
class Inbox {
  constructor() {
    /** @type {T[]} */
    this.items = [];
    /** @type {Array<() => void>} */
    this.wakeups = [];
  }

  /** @param {T} item */
  put(item) {
    this.items = [...this.items, item];
    this.wakeups.forEach((wake) => wake());
  }

  /**
   * @param {(items: T[]) => number} findIndex  index of the match or -1
   * @param {number} timeoutMs
   * @param {string} what
   * @returns {Promise<T[]>} items up to and including the match (consumed)
   */
  waitFor(findIndex, timeoutMs, what) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`timed out waiting for ${what}`)), timeoutMs);
      const check = () => {
        const at = findIndex(this.items);
        if (at >= 0) {
          const taken = this.items.slice(0, at + 1);
          this.items = this.items.slice(at + 1);
          finish(null, taken);
        }
      };
      const finish = (error, taken) => {
        clearTimeout(timer);
        this.wakeups = this.wakeups.filter((w) => w !== check);
        if (error) {
          reject(error);
        } else {
          resolve(taken);
        }
      };
      this.wakeups = [...this.wakeups, check];
      check();
    });
  }
}

/** @param {Uint8Array} message @param {number} cmd @param {number} whichCmd @param {number} [whichSub] */
function isReply(message, cmd, whichCmd, whichSub) {
  return message[0] === cmd && message[4] === whichCmd && (whichSub === undefined || message[5] === whichSub);
}

/**
 * Wire the modem, line and link together.
 * @param {string} url
 * @param {(line: string) => void} log
 */
function buildClientStack(url, log) {
  const text = /** @type {Inbox<string>} */ (new Inbox());
  const host = /** @type {Inbox<Uint8Array>} */ (new Inbox());
  const state = { isLinkUp: false, transport: null };
  /** @type {Uint8Array[]} every host message, in arrival order */
  const received = [];
  const link = new LinkEndpoint({
    send: (bytes) => modem.write(bytes),
    now: () => Date.now(),
    onMessage: (message) => {
      log(`<- ${formatDescribed(describeHostMessage(message))}`);
      received.push(message);
      host.put(message);
    },
    log: (line) => log(`link: ${line}`),
    onFail: (reason) => log(`link failed: ${reason}`),
  });
  const modem = new HayesModem({
    now: () => Date.now(),
    toDriver: (bytes) => (state.isLinkUp ? link.receive(bytes) : text.put(asciiText(bytes))),
    toLine: (bytes) => state.transport?.write(bytes),
    hangUp: () => state.transport?.close(),
    dial: (number) => {
      log(`modem: dialing ${number} via ${url}`);
      state.transport = openLineTransport({ url });
      state.transport.onOpen(() => modem.lineOpened());
      state.transport.onData((bytes) => modem.lineReceived(bytes));
      state.transport.onClose((reason) => modem.lineClosed(reason));
    },
  });
  return { text, host, link, modem, state, received };
}

/** @param {Inbox<string>} text @param {string} needle @param {number} timeoutMs */
function waitForText(text, needle, timeoutMs) {
  return text.waitFor((items) => (items.join('').includes(needle) ? items.length - 1 : -1), timeoutMs, JSON.stringify(needle));
}

/** @param {ReturnType<typeof buildClientStack>} stack @param {number} timeoutMs @param {(line: string) => void} log */
async function dialAndConnectPad({ text, modem }, timeoutMs, log) {
  modem.write(asciiBytes('\rAT\r'));
  await waitForText(text, 'OK', timeoutMs);
  modem.write(asciiBytes(DIAL_STRING));
  const [connect] = (await waitForText(text, 'CONNECT', timeoutMs)).slice(-1);
  log(`modem: ${connect.trim()}`);
  modem.write(asciiBytes('@D\r\r'));
  await waitForText(text, '@', timeoutMs);
  modem.write(asciiBytes(`c ${PAD_ADDRESS}\r`));
  await waitForText(text, ' CONNECTED', timeoutMs);
  log(`pad: ${PAD_ADDRESS} CONNECTED`);
}

/**
 * @param {ReturnType<typeof buildClientStack>} stack
 * @param {Required<FakeClientOptions>} options
 * @returns {Promise<string>} '' when online, else the reason
 */
async function logIn({ link, host }, { password, number, name, stepTimeoutMs, log }) {
  const awaitHost = (predicate, what) => host.waitFor((items) => items.findIndex(predicate), stepTimeoutMs, what);
  const send = (message) => link.sendMessage(message);

  send(loginMessage({ number, password, name }));
  const [loginReply] = (await awaitHost((m) => m[4] === LOGIN_WHICH_CMD && m[0] <= HOST.FAIL_OR_DONE, 'login reply')).slice(-1);
  if (loginReply[0] !== HOST.OK) {
    return 'login rejected';
  }
  send(joinNetMessage({ objectId: SELF_OBJECT_ID, number }));
  const [sidReply] = (await awaitHost((m) => m[0] === HOST.SID_ASSIGN, 'SID assignment')).slice(-1);
  const sid = sidReply[6] | (sidReply[7] << 8);
  log(`client: SID ${sid}`);
  startupBurstMessages({ sid, personaName: name }).forEach(send);
  await awaitHost((m) => isReply(m, HOST.FAIL_OR_DONE, CLIENT.HOST_INFO, CLIENT_SUB.LAND_ADDR), 'land address done');
  send(landRequestMessage());
  await awaitHost((m) => isReply(m, HOST.FAIL_OR_DONE, CLIENT.LANDS, CLIENT_SUB.LAND_REQUEST), 'land request done');
  log('client: ONLINE');
  return '';
}

/**
 * @param {FakeClientOptions} [options]
 * @returns {Promise<FakeClientResult>}
 */
export async function runFakeClient(options = {}) {
  const config = {
    url: DEFAULT_LINE_URL, password: 'XXXXXX', number: DEFAULT_ACCOUNT, name: 'Gil',
    log: console.log, stepTimeoutMs: STEP_TIMEOUT_MS, ...options,
  };
  const stack = buildClientStack(config.url, config.log);
  const ticker = setInterval(() => stack.link.tick(), LINK_TICK_MS);
  const hostMessages = stack.received;
  try {
    await dialAndConnectPad(stack, config.stepTimeoutMs, config.log);
    stack.state.isLinkUp = true;
    const failure = await logIn(stack, config);
    return { isOnline: failure === '', failure, hostMessages };
  } catch (error) {
    return { isOnline: false, failure: error instanceof Error ? error.message : String(error), hostMessages };
  } finally {
    clearInterval(ticker);
    stack.state.transport?.close();
  }
}

function isRunAsScript() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isRunAsScript()) {
  const [url = DEFAULT_LINE_URL, password = 'XXXXXX'] = process.argv.slice(2);
  const result = await runFakeClient({ url, password });
  console.log(result.isOnline ? 'RESULT: online' : `RESULT: failed (${result.failure})`);
  process.exitCode = result.isOnline ? 0 : 1;
}
