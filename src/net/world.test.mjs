// World: shared SIDs, groups and message routing between sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from './world.js';
import { encodeMessage } from './wire.js';

/**
 * @typedef {Object} RecordingSession
 * @property {Uint8Array[]} inbox
 * @property {(message: Uint8Array) => void} deliver
 * @property {string} playerName
 */

/** @param {string} name @returns {RecordingSession} */
function sessionNamed(name) {
  const inbox = [];
  return { inbox, playerName: name, deliver: (message) => inbox.push(message) };
}

/** @param {RecordingSession} session @returns {number[]} the command byte of every message it got */
function commandsReceivedBy(session) {
  return session.inbox.map((message) => message[0]);
}

/** @param {RecordingSession} session @returns {number[][]} */
function messagesReceivedBy(session) {
  return session.inbox.map((message) => Array.from(message));
}

/** A world where Gil and Kris each joinNet'ed their own body and sit in one shared room. */
function twoPlayersInOneRoom() {
  const world = new World();
  const gil = sessionNamed('Gil');
  const kris = sessionNamed('Kris');
  const gilSid = world.joinNet(gil, null);
  const krisSid = world.joinNet(kris, null);
  const room = world.joinNet(gil, 'room');
  world.joinGroup(room, gilSid);
  world.joinGroup(room, krisSid);
  gil.inbox.length = 0;
  kris.inbox.length = 0;
  return { world, gil, kris, gilSid, krisSid, room };
}

test('shared objects get one SID for everybody, private objects a new one each', () => {
  const world = new World();
  const gil = sessionNamed('Gil');
  const kris = sessionNamed('Kris');
  assert.equal(world.joinNet(gil, 'room'), world.joinNet(kris, 'room'));
  assert.notEqual(world.joinNet(gil, null), world.joinNet(kris, null));
});

test('joining a group tells every member who joined (10) and the member list (12)', () => {
  const world = new World();
  const gil = sessionNamed('Gil');
  const kris = sessionNamed('Kris');
  const room = world.joinNet(gil, 'room');
  world.joinGroup(room, world.joinNet(gil, null));
  gil.inbox.length = 0;
  world.joinGroup(room, world.joinNet(kris, null));
  assert.deepEqual(commandsReceivedBy(gil), [10, 12]);
  assert.deepEqual(commandsReceivedBy(kris), [10, 12]);
});

test('a user message to a player SID reaches only that player, unchanged', () => {
  const { world, gil, kris, gilSid, krisSid } = twoPlayersInOneRoom();
  const talk = encodeMessage('bbwwwa', [2, 0, krisSid, gilSid, 1, 2, [72, 105]]);
  world.relay(talk, krisSid, gilSid);
  assert.deepEqual(messagesReceivedBy(kris), [Array.from(talk)]);
  assert.deepEqual(gil.inbox, []);
});

test('a user message to a group reaches every member but the sender', () => {
  const { world, gil, kris, gilSid, room } = twoPlayersInOneRoom();
  world.relay(encodeMessage('bbwww', [2, 0, room, gilSid, 1]), room, gilSid);
  assert.equal(kris.inbox.length, 1);
  assert.deepEqual(gil.inbox, []);
});

test('a said (28) becomes one user message (2) per listed member, skipping empty seats and the sender', () => {
  const { world, gil, kris, gilSid, krisSid } = twoPlayersInOneRoom();
  const said = encodeMessage('bwwaw+', [28, krisSid, 3, 3, [0, gilSid, krisSid], 100, 3982, 1]);
  world.said(said);
  assert.deepEqual(messagesReceivedBy(gil), [Array.from(encodeMessage('bbwwwww', [2, 0, gilSid, krisSid, 100, 3982, 1]))]);
  assert.deepEqual(kris.inbox, []);
});

test('a public property change goes to every other session', () => {
  const { world, gil, kris } = twoPlayersInOneRoom();
  world.sendToOthers(Uint8Array.of(13), gil);
  assert.equal(kris.inbox.length, 1);
  assert.deepEqual(gil.inbox, []);
});

test('a hang-up takes the player out of its groups, tells the rest, and forgets its SIDs', () => {
  const { world, gil, kris, gilSid, krisSid, room } = twoPlayersInOneRoom();
  world.disconnect(gil);
  assert.deepEqual(commandsReceivedBy(kris), [11, 12]);
  assert.deepEqual(world.objects.members(room), [krisSid]);
  assert.equal(world.ownerOf(gilSid), undefined);
  assert.deepEqual(world.playerNames(), ['Kris']);
});

test('leaving a group you are not in sends nothing', () => {
  const { world, gil, kris, room } = twoPlayersInOneRoom();
  world.leaveGroup(room, 9999);
  assert.deepEqual(gil.inbox, []);
  assert.deepEqual(kris.inbox, []);
});

test('a property change of a player reaches the other players in its groups, not the player itself', () => {
  const { world, gil, kris, krisSid } = twoPlayersInOneRoom();
  world.sendToGroupmates(Uint8Array.of(13), krisSid);
  assert.equal(gil.inbox.length, 1);
  assert.deepEqual(kris.inbox, []);
});
