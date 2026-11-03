import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HayesModem, X28Pad, asciiBytes, asciiText } from './modem.js';

function modemWithRecordedSides() {
  let time = 10_000;
  const toDriver = [];
  const toLine = [];
  const calls = { dialed: [], hangUps: 0 };
  const modem = new HayesModem({
    toDriver: (bytes) => toDriver.push(asciiText(bytes)),
    toLine: (bytes) => toLine.push(Array.from(bytes)),
    dial: (number) => calls.dialed.push(number),
    hangUp: () => { calls.hangUps += 1; },
    now: () => time,
  });
  const waitMs = (ms) => { time += ms; };
  const driverSaw = () => toDriver.splice(0).join('');
  return { modem, toLine, calls, waitMs, driverSaw };
}

function padWithRecordedOutput() {
  const output = [];
  const connectedTo = [];
  const pad = new X28Pad({ send: (bytes) => output.push(asciiText(bytes)), onConnected: (a) => connectedTo.push(a) });
  return { pad, connectedTo, padSaid: () => output.splice(0).join('') };
}

test('the modem answers AT with OK and ATDT with a dial, then CONNECT when the line opens', () => {
  const m = modemWithRecordedSides();
  m.modem.write(asciiBytes('\rAT\r'));
  assert.match(m.driverSaw(), /OK/);
  m.modem.write(asciiBytes('ATDT5551212\r'));
  assert.deepEqual(m.calls.dialed, ['5551212']);
  m.modem.lineOpened();
  assert.match(m.driverSaw(), /CONNECT 2400/);
});

test('once online the modem passes driver bytes to the line untouched', () => {
  const m = modemWithRecordedSides();
  m.modem.write(asciiBytes('ATDT1\r'));
  m.modem.lineOpened();
  m.modem.write([0x81, 0x2b, 0x2b, 0x2b, 0x82]);
  assert.deepEqual(m.toLine, [[0x81, 0x2b, 0x2b, 0x2b, 0x82]]);
});

test('"+++" after a second of silence returns the modem to command mode', () => {
  const m = modemWithRecordedSides();
  m.modem.write(asciiBytes('ATDT1\r'));
  m.modem.lineOpened();
  m.driverSaw();
  m.waitMs(1000);
  m.modem.write(asciiBytes('+++'));
  assert.match(m.driverSaw(), /OK/);
  m.modem.write(asciiBytes('AT H0\r'));
  assert.equal(m.calls.hangUps, 1);
});

test('a dropped line is reported to the driver as NO CARRIER', () => {
  const m = modemWithRecordedSides();
  m.modem.write(asciiBytes('ATDT1\r'));
  m.modem.lineClosed();
  assert.match(m.driverSaw(), /NO CARRIER/);
});

test('the PAD prompts after autobaud and connects with the address upper-cased', () => {
  const p = padWithRecordedOutput();
  p.pad.receive(asciiBytes('@D\r'));
  assert.match(p.padSaid(), /@$/);
  p.pad.receive(asciiBytes('c sierra\r'));
  assert.match(p.padSaid(), /SIERRA CONNECTED/);
  assert.deepEqual(p.connectedTo, ['SIERRA']);
});

test('bytes after the connect command are handed back for the link', () => {
  const p = padWithRecordedOutput();
  const leftover = p.pad.receive([...asciiBytes('c SIERRA\r'), 0x81, 0x01]);
  assert.deepEqual(Array.from(leftover), [0x81, 0x01]);
});

test('after a BREAK the PAD disconnects the call on "D"', () => {
  const p = padWithRecordedOutput();
  p.pad.receive(asciiBytes('c SIERRA\r'));
  p.pad.breakToCommandMode();
  p.pad.receive(asciiBytes('D\r'));
  assert.match(p.padSaid(), /DISCONNECTED/);
});

test('an over-long PAD command line is truncated instead of buffered forever', () => {
  const p = padWithRecordedOutput();
  p.pad.receive(asciiBytes(`${'x'.repeat(10_000)}\r`));
  assert.ok(p.padSaid().length < 100);
});
