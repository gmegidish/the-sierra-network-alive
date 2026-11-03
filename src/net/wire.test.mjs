import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  crc16, encodeFrame, decodeFrame, ackFrame, nakFrame, createFrameReader, splitIntoPayloads,
  encodeLengthPrefix, encodeMessageStream, decodeMessageStream, encodeMessage, decodeMessage,
  encodePassword, decodePassword, MAX_ESCAPED_PAYLOAD,
} from './wire.js';

const PASS_SET_PATH = fileURLToPath(new URL('../../installed/INN/PASS_SET.DTA', import.meta.url));
const PASS_SET_HEADER_LENGTH = 2;

function bytesOf(text) {
  return Array.from(text, (c) => c.charCodeAt(0));
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function encodedPasswordStoredInPassSetFile() {
  return readFileSync(PASS_SET_PATH).subarray(PASS_SET_HEADER_LENGTH);
}

function framesFromLine(...chunks) {
  const reader = createFrameReader();
  return chunks.flatMap((chunk) => reader.push(chunk));
}

test('crc matches the CRC-16/CCITT-FALSE check value 0x29B1 for "123456789"', () => {
  assert.equal(crc16(bytesOf('123456789')), 0x29b1);
});

test('an ACK for seq 3 is 81, CRC of 0x93 little-endian, 93, 82', () => {
  const crc = crc16([0x93]);
  assert.equal(hex(ackFrame(3)), hex([0x81, crc & 0xff, crc >> 8, 0x93, 0x82]));
});

test('a NAK carries 0x80 | seq and decodes with a valid CRC', () => {
  const frame = decodeFrame(nakFrame(5));
  assert.equal(frame.control, 0x85);
  assert.equal(frame.payload.length, 0);
  assert.ok(frame.crcOk);
});

test('special payload bytes are preceded by ESC and the CRC covers the escaped form', () => {
  const wire = encodeFrame({ control: 2, payload: [0x01, 0x81, 0x1b, 0x82] });
  const escapedBody = [0x02, 0x01, 0x1b, 0x81, 0x1b, 0x1b, 0x1b, 0x82];
  const crc = crc16(escapedBody);
  assert.equal(hex(wire), hex([0x81, crc & 0xff, crc >> 8, ...escapedBody, 0x82]));
});

test('a data frame round-trips through encode and decode', () => {
  const payload = Uint8Array.from([0x81, 0x82, 0x1b, 0x00, 0xff, 0x7f]);
  const frame = decodeFrame(encodeFrame({ control: 7, payload }));
  assert.equal(frame.control, 7);
  assert.deepEqual(frame.payload, payload);
  assert.ok(frame.crcOk);
});

test('a corrupted payload byte makes the CRC check fail', () => {
  const wire = encodeFrame({ control: 0, payload: [1, 2, 3] });
  wire[5] ^= 0x40;
  assert.equal(decodeFrame(wire).crcOk, false);
});

test('the frame reader finds frames split across chunks and skips line noise', () => {
  const first = encodeFrame({ control: 0, payload: [0x81, 9] });
  const second = ackFrame(1);
  const line = Uint8Array.from([0x40, 0x0d, ...first, ...second]);
  const frames = framesFromLine(line.subarray(0, 5), line.subarray(5));
  assert.equal(frames.length, 2);
  assert.deepEqual(Array.from(frames[0].payload), [0x81, 9]);
  assert.equal(frames[1].control, 0x91);
});

test('the frame reader accepts NAK seq 1 and seq 2 whose CTL bytes equal the delimiters', () => {
  const frames = framesFromLine(nakFrame(1), nakFrame(2));
  assert.deepEqual(frames.map((f) => f.control), [0x81, 0x82]);
  assert.ok(frames.every((f) => f.crcOk));
});

test('a bare 0x81 inside a payload restarts the frame', () => {
  const good = encodeFrame({ control: 4, payload: [5] });
  const frames = framesFromLine([0x81, 0, 0, 0, 1, 2], good);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].control, 4);
});

test('payload splitting keeps every escaped chunk within one frame', () => {
  const stream = new Uint8Array(600).fill(0x1b);
  const chunks = splitIntoPayloads(stream);
  assert.ok(chunks.every((c) => c.length * 2 <= MAX_ESCAPED_PAYLOAD));
  assert.equal(chunks.reduce((n, c) => n + c.length, 0), 600);
});

test('lengths below 255 use one byte and longer lengths use FF lo hi', () => {
  assert.deepEqual(encodeLengthPrefix(254), [254]);
  assert.deepEqual(encodeLengthPrefix(255), [0xff, 0xff, 0x00]);
  assert.deepEqual(encodeLengthPrefix(0x1234), [0xff, 0x34, 0x12]);
});

test('a message stream round-trips and keeps an incomplete tail', () => {
  const long = new Uint8Array(300).fill(7);
  const stream = encodeMessageStream([[1, 2], long]);
  const { messages, rest } = decodeMessageStream([...stream, 5, 1]);
  assert.deepEqual(messages.map((m) => m.length), [2, 300]);
  assert.deepEqual(Array.from(rest), [5, 1]);
});

test('the "bbw" format puts type and sub first and the word little-endian', () => {
  assert.equal(hex(encodeMessage('bbw', [34, 4, 0x1234])), '22 04 34 12');
});

test('the login format packs password bytes and a NUL-terminated persona name', () => {
  const password = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const message = encodeMessage('bbwbbbbwwbas', [53, 0, 0, 7, 1, 2, 3, 0x10, 0x20, 1, 11, password, 'Al']);
  assert.equal(hex(message), '35 00 00 00 07 01 02 03 10 00 20 00 01 01 02 03 04 05 06 07 08 09 0a 0b 41 6c 00');
});

test('"+" after a byte appends bytes and after a word appends words', () => {
  assert.equal(hex(encodeMessage('bbw+', [36, 1, 9, 0x0102, 3])), '24 01 09 00 02 01 03 00');
  assert.equal(hex(encodeMessage('bb+', [47, 1, 0, 0])), '2f 01 00 00');
});

test('a word array passed to "a" is copied as little-endian words', () => {
  assert.equal(hex(encodeMessage('ba', [2, 2, [0x0201, 0x0403]])), '02 01 02 03 04');
});

test('decodeMessage reads back what encodeMessage wrote', () => {
  const bytes = encodeMessage('bbws+', [40, 4, 300, 'Bob', 1, 2]);
  assert.deepEqual(decodeMessage('bbws+', bytes), [40, 4, 300, 'Bob', [1, 2]]);
});

test('password "XXXXXX" encodes to the bytes stored in the shipped INN PASS_SET.DTA', () => {
  assert.equal(hex(encodePassword('XXXXXX')), hex(encodedPasswordStoredInPassSetFile()));
});

test('the shipped INN PASS_SET.DTA decodes back to "XXXXXX"', () => {
  assert.equal(decodePassword(encodedPasswordStoredInPassSetFile()), 'XXXXXX');
});

test('passwords are upper-cased before scrambling', () => {
  assert.equal(decodePassword(encodePassword('secret')), 'SECRET');
});

test('the documented worked examples produce exactly the bytes in docs/protocol.md', () => {
  assert.equal(hex(ackFrame(3)), '81 2a 52 93 82');
  const stream = encodeMessageStream([encodeMessage('bbw', [34, 4, 0x1234])]);
  assert.equal(hex(encodeFrame({ control: 0, payload: stream })), '81 d2 7a 00 04 22 04 34 12 82');
});
