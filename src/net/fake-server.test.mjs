// FakeServer: decoded packets in, queued host messages out, packet log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeServer } from './fake-server.js';
import { encodeMessage } from './wire.js';
import { DEFAULT_LANDS, LAND_CAPACITY } from './host-logic.js';

/** A Packet as the TSN kernel builds it from TSN(4, fmt, fields...). */
function packet(format, fields) {
  const bytes = encodeMessage(format, fields);
  return { type: bytes[0], sub: bytes[1], format, fields, bytes };
}

test('joinNet is answered with a SID assignment echoing the object ID', () => {
  const server = new FakeServer({ firstSid: 0x101 });
  server.receivePacket(packet('wwwbbww', [7, 0, 88, 129, 1, 0, 12]));
  assert.deepEqual(Array.from(server.takeReplies()[0]), [8, 0, 88, 0, 0, 0, 0x01, 0x01]);
  assert.deepEqual(server.takeReplies(), [], 'replies are handed out once');
});

test('the land list puts the land records after a 6-byte header and a 6-byte payload header', () => {
  const server = new FakeServer({ lands: ['LarryLand'] });
  server.receivePacket(packet('bbw+', [36, 6, 0, 0]));
  const [lands, done] = server.takeReplies();
  assert.equal(lands[0], 47);
  assert.equal(lands[10], 1, 'payload word 4 (message offset 10) is the land count');
  assert.equal(String.fromCharCode(...lands.slice(24, 33)), 'LarryLand');
  assert.deepEqual(Array.from(done), [1, 0, 0, 0, 36, 6]);
});

test('every packet type is counted in the report and a custom handler can be plugged in', () => {
  const server = new FakeServer();
  server.on(99, (received, reply) => reply([99, received.sub]));
  server.receivePacket(packet('bb', [99, 4]));
  server.receivePacket(packet('bb', [99, 4]));
  assert.match(server.report(), /99\/4 bb {2}x2/);
  assert.equal(server.takeReplies().length, 2);
});

test('joining a group tells the group who joined and lists its members (cmd 10, cmd 12)', () => {
  const server = new FakeServer();
  server.receivePacket(packet('wwwbbb', [10, 261, 260, 1, 1, 17]));
  const [joined, members] = server.takeReplies();
  assert.deepEqual(Array.from(joined), [10, 0, 0x05, 0x01, 0x04, 0x01]);
  assert.deepEqual(Array.from(members), [12, 0, 0x05, 0x01, 0, 0, 0x04, 0x01]);
});

test('get members returns the requested properties the members set earlier (cmd 31)', () => {
  const server = new FakeServer();
  const NAME_OFFSET = 5;
  const NUMBER_OFFSET = 30;
  server.receivePacket(packet('wwwws', [14, 260, 260, NAME_OFFSET, 'Gil']));
  server.receivePacket(packet('w+', [13, 260, 260, NUMBER_OFFSET, 7]));
  server.receivePacket(packet('wwwbbb', [10, 261, 260, 1, 1, 17]));
  server.takeReplies();
  server.receivePacket(packet('w+', [287, 261, 261, NAME_OFFSET, NUMBER_OFFSET]));
  const [reply] = server.takeReplies();
  const header = [31, 0, 0x05, 0x01, 0x05, 0x01, 1, 0, 2, 0, NAME_OFFSET, 0, 1, 0, NUMBER_OFFSET, 0, 0, 0];
  const member = [0x04, 0x01, ...Buffer.from('Gil'), 0, 7, 0];
  assert.deepEqual(Array.from(reply), [...header, ...member]);
});

test('locking a new game group is acknowledged with ok for command 4 on that group', () => {
  const server = new FakeServer();
  const GAME_GROUP = 262;
  const PLAYER = 260;
  server.receivePacket(packet('wwa', [4, GAME_GROUP, 1, [PLAYER]]));
  const [reply] = server.takeReplies();
  assert.deepEqual(Array.from(reply), [0, 0, 0x06, 0x01, 4, 0]);
});

test('a second joinNet (a game group) gets its own SID but the session keeps the first', () => {
  const server = new FakeServer();
  server.receivePacket(packet('wwwbbww', [7, 0, 88, 0x81, 1, 0, 12]));
  const sessionSid = server.sid;
  server.receivePacket(packet('wwwbbww', [7, 0, 7104, 1, 3, 0xffff, 19]));
  const [, groupReply] = server.takeReplies();
  assert.equal(server.sid, sessionSid);
  assert.notEqual(groupReply[6] | (groupReply[7] << 8), sessionSid);
});

const SESSION_SID = 259;

/** The login packet the CC client sends (scrambled password "123456"), for player `name`. */
const LOGIN_HEAD = [0x35, 0, 0, 0, 1, 2, 1, 0x11, 1, 0, 0, 0, 1, 6, 0x7d, 0x7a, 0x7b, 0x7a, 0x7a, 0, 0, 0, 0, 0];

/** Log in as `name`, as the CC client does before any land starts. */
function logInAs(server, name) {
  const bytes = Uint8Array.from([...LOGIN_HEAD, ...Buffer.from(name), 0]);
  server.receivePacket({ type: bytes[0], sub: bytes[1], format: 'bbwbbbbwwbas', fields: [], bytes });
  server.takeReplies();
}

/** LarryLand found no money file (ll$$NNNN.dat) and asks the Bank of LarryLand. */
function askTheBank(server) {
  server.receivePacket(packet('bbwww', [40, 3, SESSION_SID, 1, 1]));
  return server.takeReplies()[0];
}

/** The long at offset 8 of a bank reply. */
function bucksIn(reply) {
  return (reply[8] | (reply[9] << 8)) + (reply[10] | (reply[11] << 8)) * 0x10000;
}

test('the bank answers 40/3 to the game object with whichCmd 3, msgType 1, whichSub 1 and the LarryBucks', () => {
  const server = new FakeServer();
  logInAs(server, 'Gil');
  const reply = askTheBank(server);
  assert.deepEqual(Array.from(reply.subarray(0, 8)), [40, 3, 0, 0, 1, 0, 1, 0]);
  assert.equal(bucksIn(reply), 500);
});

test('the bank keeps a balance per player name, shared by the sessions of one server', () => {
  const bank = new Map([['Gil', 70000]]);
  const server = new FakeServer({ bank });
  logInAs(server, 'Gil');
  assert.equal(bucksIn(askTheBank(server)), 70000);
  logInAs(server, 'Kris');
  assert.equal(bucksIn(askTheBank(server)), 500);
  assert.equal(bank.get('Kris'), 500);
});

const LAND_INFO_RECORD_BYTES = 5;
const LAND_INFO_RECORDS_OFFSET = 12;
const SIERRALAND = 2;

/** The 5-byte land info records of a 47/1 reply: [hostNumber, landType, landNumber, maximum, curSize]. */
function landInfoRecords(reply) {
  const count = reply[10];
  return Array.from({ length: count }, (_, i) => Array.from(
    reply.slice(LAND_INFO_RECORDS_OFFSET + i * LAND_INFO_RECORD_BYTES, LAND_INFO_RECORDS_OFFSET + (i + 1) * LAND_INFO_RECORD_BYTES)));
}

test('the land request (47/1) gets how full each land is, as 5-byte records, then done', () => {
  const server = new FakeServer();
  server.receivePacket(packet('bbww', [47, 1, 0, 0]));
  const [info, done] = server.takeReplies();
  assert.deepEqual(Array.from(info.slice(0, 2)), [47, 1]);
  const sierraLands = landInfoRecords(info).filter(([, landType]) => landType === SIERRALAND);
  assert.deepEqual(sierraLands, [1, 2, 3, 4].map((landNumber) => [1, SIERRALAND, landNumber, LAND_CAPACITY, 0]));
  assert.deepEqual(Array.from(done), [1, 0, 0, 0, 47, 1]);
});

test('SierraLand has four named instances, spaces sent as underscores for the client\'s %20s', () => {
  const names = DEFAULT_LANDS.filter((land) => land.landType === SIERRALAND).map((land) => land.name);
  assert.deepEqual(names, ['Dogfight_Downs', 'Wacky_Way', 'Looney_Lane', 'Aerodrome']);
});
