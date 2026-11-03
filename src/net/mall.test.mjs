// The Electronic Mall against HostLogic: store list, a store's products, a
// product's order form and an order, as module 160 asks for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostLogic } from './host-logic.js';
import { encodeMessage, decodeMessage } from './wire.js';
import { DEFAULT_STORES } from './mall.js';

const MALL_SID = 0x105;
const FIRST_STORE = DEFAULT_STORES[0];
const ENVELOPE_BYTES = 47;
const ENVELOPES_OFFSET = 8;
const ENVELOPE_NAME_OFFSET = 19;
const FORM_TEXT_OFFSET = 12;

/** Sends one client message to a fresh host and returns its replies. */
function askTheHost(format, fields) {
  const replies = [];
  const host = new HostLogic({ reply: (message) => replies.push(message) });
  host.handleMessage(encodeMessage(format, fields));
  return replies;
}

/** The NUL-terminated text starting at `offset`. */
function textAt(bytes, offset) {
  return String(decodeMessage('s', bytes.subarray(offset))[0]);
}

/** Store names in a 37/32 reply: records of box w, w, type b, name\0 from offset 8. */
function storeNames(reply) {
  const names = [];
  for (let at = ENVELOPES_OFFSET; at < reply.length;) {
    const name = textAt(reply, at + 5);
    names.push(name);
    at += 5 + name.length + 1;
  }
  return names;
}

test('the Mall gets its stores for 37/32 with its sid, and the startup 37/32 (sid 0) gets nothing', () => {
  const [reply] = askTheHost('bbw+', [37, 32, MALL_SID, 0, 0]);
  assert.deepEqual(Array.from(reply.subarray(0, 4)), [37, 32, 0x05, 0x01]);
  assert.deepEqual(storeNames(reply), DEFAULT_STORES.map((store) => store.name));
  assert.deepEqual(askTheHost('bbw+', [37, 32, 0, 0, 0]), []);
});

test('a store\'s products come back as 47-byte envelopes named after each product', () => {
  const [reply] = askTheHost('bbw+', [37, 19, MALL_SID, FIRST_STORE.box, 0]);
  assert.equal(reply[4], FIRST_STORE.box, 'lowWord names the box');
  assert.equal(reply.length, ENVELOPES_OFFSET + FIRST_STORE.products.length * ENVELOPE_BYTES);
  assert.equal(textAt(reply, ENVELOPES_OFFSET + ENVELOPE_NAME_OFFSET), 'Red Baron');
});

test('a product\'s order form has a title line and questions that start a line with %', () => {
  const [reply] = askTheHost('bbw+', [37, 31, MALL_SID, FIRST_STORE.box, 0, 1, 0]);
  const form = textAt(reply, FORM_TEXT_OFFSET);
  assert.match(form, /^Red Baron\n%t.*\$59\.95.*\n%9d/s);
});

test('an order (37/24) is acknowledged with ok for whichCmd 37, whichSub 24', () => {
  const [reply] = askTheHost('bbw+', [37, 24, MALL_SID, 0, 0]);
  assert.deepEqual(Array.from(reply), [0, 0, 0x05, 0x01, 37, 24]);
});
