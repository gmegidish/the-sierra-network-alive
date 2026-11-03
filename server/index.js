// Local TSN host: serves the web client (repo root) over HTTP and accepts
// "phone calls" on ws://localhost:7000/line. Each WebSocket is one modem
// line; binary messages are raw serial bytes, the text message "BREAK" is a
// line break. Bound to 127.0.0.1 only. Run: npm run server

import http from 'node:http';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { HostSession } from './session.js';
import { World } from '../src/net/world.js';
import { addBots } from '../src/net/bots.js';
import { BREAK_SIGNAL } from '../src/net/ws-transport.js';

/**
 * @typedef {Object} ServerOptions
 * @property {number} [port]  0 picks an ephemeral port
 * @property {(text: string) => void} [log]
 * @property {string} [password]
 * @property {number} [bots]  host-side players sitting in the waiting rooms
 */

/**
 * @typedef {Object} RunningServer
 * @property {number} port
 * @property {() => Promise<void>} close
 */

export const DEFAULT_PORT = 7000;
export const BIND_ADDRESS = '127.0.0.1';
export const LINE_PATH = '/line';
/** One WebSocket message is at most this many bytes (a line burst, not a file). */
const MAX_WS_MESSAGE_BYTES = 64 * 1024;
/** Link pump interval: 20 ticks of the 60 Hz clock, like LSCITV's TSN(3) timer. */
const TICK_INTERVAL_MS = 333;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Browsers send Origin; only pages served from this machine may dial. */
function isLocalOrigin({ origin }) {
  return !origin || LOCAL_ORIGIN.test(origin);
}

/**
 * @param {import('ws').WebSocket} socket
 * @param {number} callId
 * @param {ServerOptions} options
 */
function answerCall(socket, callId, { log = console.log, password, bank, world }) {
  const say = (text) => log(`[line ${callId}] ${text}`);
  const session = new HostSession({
    send: (bytes) => socket.send(bytes),
    now: () => Date.now(),
    log: say,
    bank,
    world,
    ...(password ? { password } : {}),
  });
  const timer = setInterval(() => session.tick(), TICK_INTERVAL_MS);
  say('ring: caller connected');
  socket.on('message', (data, isBinary) => {
    if (!isBinary) {
      handleControlText(session, String(data), say);
      return;
    }
    session.receive(new Uint8Array(/** @type {Buffer} */ (data)));
  });
  socket.on('close', () => {
    clearInterval(timer);
    session.hangUp();
    say(`hang up (stage ${session.stage})`);
  });
  socket.on('error', (error) => say(`socket error: ${error.message}`));
}

/**
 * @param {HostSession} session
 * @param {string} text
 * @param {(text: string) => void} say
 */
function handleControlText(session, text, say) {
  if (text === BREAK_SIGNAL) {
    say('BREAK');
    session.lineBreak();
    return;
  }
  say(`ignored text message ${JSON.stringify(text.slice(0, 40))}`);
}

/**
 * @param {ServerOptions} [options]
 * @returns {Promise<RunningServer>}
 */
export function startServer(options = {}) {
  const { port = DEFAULT_PORT, log = console.log } = options;
  const app = express();
  app.use(express.static(REPO_ROOT, { dotfiles: 'ignore' }));
  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server, path: LINE_PATH, maxPayload: MAX_WS_MESSAGE_BYTES, verifyClient: isLocalOrigin,
  });
  let calls = 0;
  // ponytail: LarryBucks live in memory for the server's lifetime; a file or DB when restarts must keep them.
  const bank = new Map();
  const world = new World();
  addBots(world, options.bots ?? 0);
  wss.on('connection', (socket) => {
    calls += 1;
    answerCall(socket, calls, { ...options, log, bank, world });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_ADDRESS, () => {
      const actualPort = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
      resolve({ port: actualPort, close: () => closeAll(wss, server) });
    });
  });
}

/**
 * @param {WebSocketServer} wss
 * @param {http.Server} server
 * @returns {Promise<void>}
 */
function closeAll(wss, server) {
  wss.clients.forEach((client) => client.terminate());
  return new Promise((resolve) => {
    wss.close(() => server.close(() => resolve()));
  });
}

function isRunAsScript() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isRunAsScript()) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const bots = Number(parseArgs({ options: { bots: { type: 'string' } } }).values.bots ?? process.env.BOTS ?? 0);
  const { port: actualPort } = await startServer({ port, password: process.env.TSN_PASSWORD, bots });
  console.log(`TSN host listening on http://${BIND_ADDRESS}:${actualPort}/ (line: ws://localhost:${actualPort}${LINE_PATH})`);
}
