import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, LINE_PATH } from './index.js';
import { runFakeClient } from '../tools/fake-client.mjs';
import { HOST, LOGIN_WHICH_CMD } from '../src/net/catalog.js';

const quiet = () => {};

/** @param {(port: number) => Promise<void>} body */
async function withServerOnEphemeralPort(body) {
  const server = await startServer({ port: 0, log: quiet, password: 'letmein' });
  try {
    await body(server.port);
  } finally {
    await server.close();
  }
}

/** @param {number} port @returns {string} */
function lineUrl(port) {
  return `ws://127.0.0.1:${port}${LINE_PATH}`;
}

test('the fake client dials over a real WebSocket and reaches the online state', async () => {
  await withServerOnEphemeralPort(async (port) => {
    const result = await runFakeClient({ url: lineUrl(port), password: 'letmein', log: quiet });
    assert.equal(result.failure, '');
    assert.ok(result.isOnline);
  });
});

test('the fake client with a wrong password is rejected by the server', async () => {
  await withServerOnEphemeralPort(async (port) => {
    const result = await runFakeClient({ url: lineUrl(port), password: 'nope', log: quiet });
    assert.equal(result.isOnline, false);
    const [reply] = result.hostMessages;
    assert.equal(reply[0], HOST.FAIL_OR_DONE);
    assert.equal(reply[4], LOGIN_WHICH_CMD);
  });
});

test('the server serves repository files over HTTP', async () => {
  await withServerOnEphemeralPort(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/package.json`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).name, 'sierra-network');
  });
});
