import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeClientMessage } from './catalog.js';

/** Bytes from a space-separated hex dump, as the server log prints them. */
function fromHexDump(dump) {
  return Uint8Array.from(dump.split(' ').map((byte) => parseInt(byte, 16)));
}

function described(dump) {
  return describeClientMessage(fromHexDump(dump));
}

test('a 14 from the log is a player setting their name string property', () => {
  assert.deepEqual(described('0e 00 69 00 69 00 05 00 31 31 00').fields, { type: 14, sub: 0, toSid: 0x69, fromSid: 0x69, offset: 5, text: '11' });
});

test('a 13 from the log is a list of (offset, value) word properties', () => {
  const { name, fields } = described('0d 00 69 00 69 00 0c 00 00 00 17 00 01 00');
  assert.equal(name, 'setWordProperties');
  assert.deepEqual(fields.properties, { 12: 0, 23: 1 });
});

test('a 31/1 from the log asks for the group members\' name, room and other properties', () => {
  const { name, fields } = described('1f 01 6a 00 6a 00 05 00 09 00 1f 00 1e 00 19 00');
  assert.equal(name, 'getMembers');
  assert.deepEqual(fields.offsets, [5, 9, 31, 30, 25]);
});

test('a 28 from the log is a talk line fanned out to the listed members', () => {
  const { name, fields } = described('1c 6b 00 01 00 66 00 01 00 0f 03 01 68 65 79 00');
  assert.equal(name, 'said');
  assert.deepEqual([fields.me, fields.members, fields.msgType], [0x6b, [0x66], 1]);
});
