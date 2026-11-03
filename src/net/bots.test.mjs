// Bots: sit in every waiting room and answer talk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from './world.js';
import { addBots, DEFAULT_BOTS } from './bots.js';
import { encodeMessage } from './wire.js';
import { wordAt, stringAt } from './host-objects.js';

const TALK_TEXT_OFFSET = 11;

/** @returns {{ inbox: Uint8Array[], deliver: (message: Uint8Array) => void }} */
function recordingSession() {
  const inbox = [];
  return { inbox, deliver: (message) => inbox.push(message) };
}

test('a bot is a member of a waiting room as soon as it opens, with its name as a property', () => {
  const world = new World();
  const [bot] = addBots(world, 1);
  const room = world.joinNet(recordingSession(), 'larryland-room');
  assert.deepEqual(world.objects.members(room), [bot.sid]);
  assert.equal(world.objects.property(bot.sid, 5), DEFAULT_BOTS[0].name);
});

test('talking to a bot gets its canned line back as a talk message from the bot', () => {
  const world = new World();
  const [bot] = addBots(world, 1);
  const gil = recordingSession();
  const gilSid = world.joinNet(gil, null);
  const hello = encodeMessage('bbwwwbbba', [2, 0, bot.sid, gilSid, 1, 14, 2, 1, 3, Uint8Array.of(72, 105, 0)]);
  world.relay(hello, bot.sid, gilSid);
  const [reply] = gil.inbox;
  assert.equal(wordAt(reply, 2), gilSid, 'to Gil');
  assert.equal(wordAt(reply, 4), bot.sid, 'from the bot');
  assert.equal(stringAt(reply, TALK_TEXT_OFFSET), DEFAULT_BOTS[0].reply);
});

const INVITE = 12;
const ACCEPT = 13;
const GET_SID = 56;
const START_GAME = 58;
const SIERRALAND_SNEAKATAC = 775;
const ROOM_PROPERTY = 9;
const GROUP_JOINED = 10;

/**
 * Gil (a recorded session) opens an invite room and invites the bot, as SierraLand's invite room does.
 * @param {World} world @param {import('./bots.js').Bot} bot
 */
function gilInvitesTheBot(world, bot) {
  const gil = recordingSession();
  const gilSid = world.joinNet(gil, null);
  const inviteRoom = world.joinNet(gil, null);
  const invitation = encodeMessage('wwwwwwww', [2, bot.sid, gilSid, INVITE, SIERRALAND_SNEAKATAC, 1, inviteRoom, bot.sid]);
  world.relay(invitation, bot.sid, gilSid);
  return { gil, gilSid, inviteRoom };
}

/** @param {Uint8Array[]} inbox @param {number} msgType @returns {Uint8Array | undefined} */
function userMessageOfType(inbox, msgType) {
  return inbox.find((message) => message[0] === 2 && wordAt(message, 6) === msgType);
}

/** The inviter creates the game group and sends START_GAME to the bot's invite room (from GET_SID). @param {World} world */
function gilStartsTheGame(world, { gil, gilSid }) {
  const botInviteRoom = wordAt(userMessageOfType(gil.inbox, GET_SID), 8);
  const gameGroup = world.joinNet(gil, null);
  world.relay(encodeMessage('wwwwww', [2, botInviteRoom, gilSid, START_GAME, gameGroup, 2]), botInviteRoom, gilSid);
  return gameGroup;
}

test('a bot invited to a game tells the inviter its invite room SID, then accepts', () => {
  const world = new World();
  const [bot] = addBots(world, 1);
  const { gil, inviteRoom } = gilInvitesTheBot(world, bot);
  const [getSid, accept] = gil.inbox;
  assert.equal(wordAt(getSid, 2), inviteRoom, 'to the invite room (retAddress)');
  assert.equal(wordAt(getSid, 4), bot.sid, 'from the bot');
  assert.equal(wordAt(getSid, 6), GET_SID);
  assert.equal(world.ownerOf(wordAt(getSid, 8)), bot, 'the bot owns the invite room SID it gave');
  assert.equal(wordAt(accept, 2), inviteRoom);
  assert.equal(wordAt(accept, 6), ACCEPT);
});

test('bots have higher SIDs than the players, so the inviter leads the game', () => {
  const world = new World();
  const [bot] = addBots(world, 1);
  const gilSid = world.joinNet(recordingSession(), null);
  assert.ok(bot.sid > gilSid);
});

test('on START_GAME a bot takes its seat in the game group after the inviter, showing the game as its room', () => {
  const world = new World();
  const [bot] = addBots(world, 1);
  const invitation = gilInvitesTheBot(world, bot);
  const gameGroup = gilStartsTheGame(world, invitation);
  assert.deepEqual(world.objects.members(gameGroup), [], 'the bot waits for the inviter');

  world.joinGroup(gameGroup, invitation.gilSid);

  assert.deepEqual(world.objects.members(gameGroup), [invitation.gilSid, bot.sid]);
  assert.ok(invitation.gil.inbox.some((m) => m[0] === GROUP_JOINED && wordAt(m, 4) === bot.sid), 'Gil hears the bot join');
  assert.equal(world.objects.property(bot.sid, ROOM_PROPERTY), SIERRALAND_SNEAKATAC);
});

test('when the inviter leaves the game the bot goes back to the waiting room', () => {
  const world = new World();
  const [bot] = addBots(world, 1);
  const invitation = gilInvitesTheBot(world, bot);
  const gameGroup = gilStartsTheGame(world, invitation);
  world.joinGroup(gameGroup, invitation.gilSid);

  world.leaveGroup(gameGroup, invitation.gilSid);

  assert.deepEqual(world.objects.members(gameGroup), []);
  assert.equal(world.objects.property(bot.sid, ROOM_PROPERTY), 120);
});
