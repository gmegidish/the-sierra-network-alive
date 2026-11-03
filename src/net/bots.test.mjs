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
const SIERRALAND_PAINTBALL = 2;

test('a bot accepts an invitation by answering ACCEPT to the inviter\'s invite room', () => {
  const world = new World();
  const [bot] = addBots(world, 1);
  const gil = recordingSession();
  const gilSid = world.joinNet(gil, null);
  const inviteRoom = world.joinNet(gil, null);
  const invitation = encodeMessage('wwwwwwww', [2, bot.sid, gilSid, INVITE, SIERRALAND_PAINTBALL, 1, inviteRoom, bot.sid]);
  world.relay(invitation, bot.sid, gilSid);
  const [answer] = gil.inbox;
  assert.equal(wordAt(answer, 2), inviteRoom, 'to the invite room (retAddress)');
  assert.equal(wordAt(answer, 4), bot.sid, 'from the bot');
  assert.equal(wordAt(answer, 6), ACCEPT);
});
