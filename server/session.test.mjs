import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostSession, STAGE, LOGIN_TRIES } from './session.js';
import { LinkEndpoint } from '../src/net/link.js';
import { asciiBytes, asciiText } from '../src/net/modem.js';
import { encodeFrame } from '../src/net/wire.js';
import {
  HOST, CLIENT, CLIENT_SUB, HOST_LANDS_SUB, LOGIN_WHICH_CMD, LOGIN_BAD_PASSWORD_SUB, describeHostMessage,
} from '../src/net/catalog.js';
import {
  loginMessage, joinNetMessage, startupBurstMessages, landRequestMessage,
} from '../src/net/client-messages.js';

const PASSWORD = 'secret';
const OBJECT_ID = 0x4321;
const ACCOUNT = 7;

/**
 * A HostSession and a client LinkEndpoint joined by an in-memory line.
 * Bytes are queued and delivered by deliverAll(), never re-entrantly.
 */
function clientDialedIntoSession() {
  const toClient = [];
  const toHost = [];
  const padText = [];
  const hostMessages = [];
  const log = [];
  const state = { isLinkUp: false };
  const session = new HostSession({
    send: (bytes) => toClient.push(bytes), now: () => 0, log: (line) => log.push(line), password: PASSWORD,
  });
  const client = new LinkEndpoint({ send: (bytes) => toHost.push(bytes), now: () => 0, onMessage: (m) => hostMessages.push(m) });
  const deliverAll = () => {
    while (toClient.length > 0 || toHost.length > 0) {
      toHost.splice(0).forEach((bytes) => session.receive(bytes));
      toClient.splice(0).forEach((bytes) => (state.isLinkUp ? client.receive(bytes) : padText.push(asciiText(bytes))));
    }
  };
  const typeAtPad = (text) => {
    toHost.push(asciiBytes(text));
    deliverAll();
    return padText.splice(0).join('');
  };
  const sendFromClient = (...messages) => {
    messages.forEach((m) => client.sendMessage(m));
    deliverAll();
    return hostMessages.splice(0);
  };
  return { session, client, log, state, typeAtPad, sendFromClient, toHost, deliverAll };
}

/** Autobaud and "c SIERRA" at the PAD; afterwards bytes belong to the link. */
function connectThroughPad(line) {
  const prompt = line.typeAtPad('@D\r\r');
  const connected = line.typeAtPad('c SIERRA\r');
  line.state.isLinkUp = true;
  return { prompt, connected };
}

function logInWith(line, password) {
  return line.sendFromClient(loginMessage({ number: ACCOUNT, password, name: 'Gil' }));
}

function wordAt(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function isDoneFor(message, whichCmd, whichSub) {
  return message[0] === HOST.FAIL_OR_DONE && message[4] === whichCmd && message[5] === whichSub;
}

function runFullStartup(line) {
  connectThroughPad(line);
  logInWith(line, PASSWORD);
  const [sidReply] = line.sendFromClient(joinNetMessage({ objectId: OBJECT_ID, number: ACCOUNT }));
  const sid = wordAt(sidReply, 6);
  const burstReplies = line.sendFromClient(...startupBurstMessages({ sid, personaName: 'Gil' }));
  const landReplies = line.sendFromClient(landRequestMessage());
  return { sid, burstReplies, landReplies };
}

test('the PAD answers autobaud with an @ prompt and "c SIERRA" with " CONNECTED"', () => {
  const line = clientDialedIntoSession();
  const { prompt, connected } = connectThroughPad(line);
  assert.match(prompt, /@$/);
  assert.match(connected, / CONNECTED/);
  assert.equal(line.session.stage, STAGE.LINK);
});

test('the right password gets a cmd 0 login OK naming whichCmd 22', () => {
  const line = clientDialedIntoSession();
  connectThroughPad(line);
  const [reply] = logInWith(line, PASSWORD);
  assert.deepEqual(Array.from(reply.subarray(0, 5)), [HOST.OK, 0, 0, 0, LOGIN_WHICH_CMD]);
  assert.equal(line.session.stage, STAGE.LOGGED_IN);
});

test('a wrong password gets cmd 1 with whichSub 9, the try limit and a message', () => {
  const line = clientDialedIntoSession();
  connectThroughPad(line);
  const [reply] = logInWith(line, 'wrong');
  const { fields } = describeHostMessage(reply);
  assert.equal(fields.cmd, HOST.FAIL_OR_DONE);
  assert.equal(fields.whichCmd, LOGIN_WHICH_CMD);
  assert.equal(fields.whichSub, LOGIN_BAD_PASSWORD_SUB);
  assert.equal(fields.numTries, LOGIN_TRIES);
  assert.ok(String(fields.text).length > 0);
  assert.equal(line.session.stage, STAGE.LINK);
});

test('joinNet gets cmd 8 echoing the object ID and assigning a SID', () => {
  const line = clientDialedIntoSession();
  connectThroughPad(line);
  logInWith(line, PASSWORD);
  const [reply] = line.sendFromClient(joinNetMessage({ objectId: OBJECT_ID, number: ACCOUNT }));
  assert.equal(reply[0], HOST.SID_ASSIGN);
  assert.equal(wordAt(reply, 2), OBJECT_ID);
  assert.ok(wordAt(reply, 6) > 0);
  assert.equal(line.session.stage, STAGE.JOINED);
});

test('the startup burst is answered with a host number, the land list and done for 36/6', () => {
  const line = clientDialedIntoSession();
  const { sid, burstReplies } = runFullStartup(line);
  const landList = burstReplies.find((m) => m[0] === HOST.LANDS && m[1] === HOST_LANDS_SUB.LIST);
  assert.ok(burstReplies.some((m) => m[0] === HOST.HOST_INFO));
  assert.equal(wordAt(landList, 2), sid);
  assert.ok(describeHostMessage(landList).fields.lands.length > 0);
  assert.ok(burstReplies.some((m) => isDoneFor(m, CLIENT.HOST_INFO, CLIENT_SUB.LAND_ADDR)));
});

test('the full startup sequence ends with done for 47/1 and the session online', () => {
  const line = clientDialedIntoSession();
  const { landReplies } = runFullStartup(line);
  assert.ok(landReplies.some((m) => isDoneFor(m, CLIENT.LANDS, CLIENT_SUB.LAND_REQUEST)));
  assert.equal(line.session.stage, STAGE.ONLINE);
});

test('an unknown message type is logged as hex and does not stop the session', () => {
  const line = clientDialedIntoSession();
  connectThroughPad(line);
  line.sendFromClient(Uint8Array.from([0xee, 0x01, 0x02]));
  const [reply] = logInWith(line, PASSWORD);
  assert.ok(line.log.some((entry) => entry.includes('unknown') && entry.includes('ee 01 02')));
  assert.equal(reply[0], HOST.OK);
});

test('garbage and a corrupted frame on the line do not crash the session', () => {
  const line = clientDialedIntoSession();
  connectThroughPad(line);
  const corrupted = encodeFrame({ control: 0, payload: [3, 1, 2, 3] });
  corrupted[5] ^= 0xff;
  line.toHost.push(Uint8Array.from([0x82, 0x1b, 0x00]), corrupted);
  line.deliverAll();
  const [reply] = logInWith(line, PASSWORD);
  assert.equal(reply[0], HOST.OK);
});
