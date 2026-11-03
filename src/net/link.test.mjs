import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkEndpoint, RETRANSMIT_TIMEOUT_MS, MAX_RETRIES } from './link.js';
import { createFrameReader, encodeFrame, ackFrame, nakFrame, encodeMessageStream, MAX_FRAME_BYTES } from './wire.js';

/** @typedef {{ now: () => number, advance: (ms: number) => void }} FakeClock */

/** @returns {FakeClock} */
function createFakeClock() {
  let time = 0;
  return { now: () => time, advance: (ms) => { time += ms; } };
}

/**
 * An endpoint whose outgoing frames are captured instead of sent.
 * @param {FakeClock} clock
 */
function endpointWithCapturedOutput(clock) {
  const sentFrames = [];
  const messages = [];
  const failures = [];
  const reader = createFrameReader();
  const endpoint = new LinkEndpoint({
    send: (bytes) => sentFrames.push(...reader.push(bytes)),
    now: clock.now,
    onMessage: (m) => messages.push(Array.from(m)),
    onFail: (reason) => failures.push(reason),
  });
  return { endpoint, sentFrames, messages, failures };
}

/**
 * Two endpoints joined by a queued line; dropNext loses frames in flight.
 * @param {FakeClock} clock
 */
function twoEndpointsOnALine(clock) {
  const queues = { a: [], b: [] };
  const dropped = { toB: 0 };
  const received = { a: [], b: [] };
  const a = new LinkEndpoint({ send: (bytes) => queues.b.push(bytes), now: clock.now, onMessage: (m) => received.a.push(Array.from(m)) });
  const b = new LinkEndpoint({ send: (bytes) => queues.a.push(bytes), now: clock.now, onMessage: (m) => received.b.push(Array.from(m)) });
  const deliverAll = () => {
    while (queues.a.length > 0 || queues.b.length > 0) {
      const toB = queues.b.shift();
      if (toB && dropped.toB > 0) {
        dropped.toB -= 1;
      } else if (toB) {
        b.receive(toB);
      }
      const toA = queues.a.shift();
      if (toA) {
        a.receive(toA);
      }
    }
  };
  return { a, b, received, deliverAll, loseNextFrameToB: () => { dropped.toB += 1; } };
}

/** @param {number} seq @param {number[][]} messages */
function dataFrameCarrying(seq, messages) {
  return encodeFrame({ control: seq, payload: encodeMessageStream(messages) });
}

/** @param {Array<{ control: number }>} frames */
function controlsOf(frames) {
  return frames.map((f) => f.control);
}

test('a message sent by one endpoint arrives at the other and is ACKed', () => {
  const clock = createFakeClock();
  const line = twoEndpointsOnALine(clock);
  line.a.sendMessage([53, 0, 1]);
  line.deliverAll();
  assert.deepEqual(line.received.b, [[53, 0, 1]]);
  assert.ok(line.a.isIdle());
});

test('messages queued while a frame is unacked go out in the next frame with the next seq', () => {
  const clock = createFakeClock();
  const { endpoint, sentFrames } = endpointWithCapturedOutput(clock);
  endpoint.sendMessage([1]);
  endpoint.sendMessage([2]);
  endpoint.sendMessage([3]);
  assert.deepEqual(controlsOf(sentFrames), [0]);
  endpoint.receive(ackFrame(0));
  assert.deepEqual(controlsOf(sentFrames), [0, 1]);
  assert.deepEqual(Array.from(sentFrames[1].payload), [1, 2, 1, 3]);
});

test('a lost frame is retransmitted after the timeout and then delivered', () => {
  const clock = createFakeClock();
  const line = twoEndpointsOnALine(clock);
  line.loseNextFrameToB();
  line.a.sendMessage([7, 7]);
  line.deliverAll();
  assert.deepEqual(line.received.b, []);
  clock.advance(RETRANSMIT_TIMEOUT_MS + 1);
  line.a.tick();
  line.deliverAll();
  assert.deepEqual(line.received.b, [[7, 7]]);
});

test('nothing is retransmitted before the timeout expires', () => {
  const clock = createFakeClock();
  const { endpoint, sentFrames } = endpointWithCapturedOutput(clock);
  endpoint.sendMessage([1]);
  clock.advance(RETRANSMIT_TIMEOUT_MS);
  endpoint.tick();
  assert.equal(sentFrames.length, 1);
});

test('a duplicate data frame is re-ACKed but not delivered twice', () => {
  const clock = createFakeClock();
  const { endpoint, sentFrames, messages } = endpointWithCapturedOutput(clock);
  const frame = dataFrameCarrying(0, [[9, 9]]);
  endpoint.receive(frame);
  endpoint.receive(frame);
  assert.deepEqual(messages, [[9, 9]]);
  assert.deepEqual(controlsOf(sentFrames), [0x90, 0x90]);
});

test('a frame with a bad CRC is NAKed and not delivered', () => {
  const clock = createFakeClock();
  const { endpoint, sentFrames, messages } = endpointWithCapturedOutput(clock);
  const corrupted = dataFrameCarrying(0, [[1, 2, 3]]);
  corrupted[5] ^= 0x40;
  endpoint.receive(corrupted);
  assert.deepEqual(messages, []);
  assert.deepEqual(controlsOf(sentFrames), [0x80]);
});

test('a NAK for the pending frame makes the sender resend the identical frame', () => {
  const clock = createFakeClock();
  const { endpoint, sentFrames } = endpointWithCapturedOutput(clock);
  endpoint.sendMessage([4, 5]);
  endpoint.receive(nakFrame(0));
  assert.equal(sentFrames.length, 2);
  assert.deepEqual(sentFrames[1], sentFrames[0]);
});

test('a NAK for a seq that is not pending is ignored', () => {
  const clock = createFakeClock();
  const { endpoint, sentFrames } = endpointWithCapturedOutput(clock);
  endpoint.sendMessage([4, 5]);
  endpoint.receive(nakFrame(3));
  assert.equal(sentFrames.length, 1);
});

test('the link fails after more than the allowed retries of one frame', () => {
  const clock = createFakeClock();
  const { endpoint, sentFrames, failures } = endpointWithCapturedOutput(clock);
  endpoint.sendMessage([1]);
  for (let i = 0; i <= MAX_RETRIES; i += 1) {
    clock.advance(RETRANSMIT_TIMEOUT_MS + 1);
    endpoint.tick();
  }
  assert.equal(sentFrames.length, 1 + MAX_RETRIES);
  assert.deepEqual(failures, ['retransmit timeout']);
  assert.ok(endpoint.isFailed);
});

test('a message split across two data frames is reassembled', () => {
  const clock = createFakeClock();
  const { endpoint, messages } = endpointWithCapturedOutput(clock);
  const stream = encodeMessageStream([[1, 2, 3, 4, 5, 6]]);
  endpoint.receive(encodeFrame({ control: 0, payload: stream.subarray(0, 3) }));
  endpoint.receive(encodeFrame({ control: 1, payload: stream.subarray(3) }));
  assert.deepEqual(messages, [[1, 2, 3, 4, 5, 6]]);
});

test('a long message is sent as several frames within the size limit', () => {
  const clock = createFakeClock();
  const line = twoEndpointsOnALine(clock);
  const long = Array.from({ length: 700 }, (_, i) => i & 0xff);
  line.a.sendMessage(long);
  line.deliverAll();
  assert.deepEqual(line.received.b, [long]);
});

test('an oversized frame is dropped without an ACK', () => {
  const clock = createFakeClock();
  const { endpoint, sentFrames, messages } = endpointWithCapturedOutput(clock);
  const oversized = encodeFrame({ control: 0, payload: new Uint8Array(MAX_FRAME_BYTES + 10).fill(1) });
  endpoint.receive(oversized);
  assert.deepEqual(messages, []);
  assert.equal(sentFrames.length, 0);
});
