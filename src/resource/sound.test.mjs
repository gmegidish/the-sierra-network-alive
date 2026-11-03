import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESOURCE_TYPE } from './types.js';
import { parseSound, findTrack, mixTrack, decodeAdlibPatch, SOUND_DEVICE, END_OF_TRACK } from './sound.js';
import { openWorld, soundNumbersOf, WORLDS } from '../audio/installed-worlds.mjs';

const EXPECTED_SOUND_COUNTS = Object.freeze({ CC: 39, LL: 46, SL: 62 });
const ADLIB_PATCH = 3;
const INSTRUMENTS_IN_TWO_BANKS = 96;
/** Sounds with no AdLib track (MT-32 only). */
const MT32_ONLY_SOUNDS = Object.freeze([800, 960]);
/** INN sound-type entries in some other format (no SCI device header). */
const NOT_SCI_SOUNDS = Object.freeze([728, 729]);

function eachSound(world, visit) {
  const resources = openWorld(world);
  for (const number of soundNumbersOf(resources).filter((n) => !NOT_SCI_SOUNDS.includes(n))) {
    visit(number, parseSound(resources.get(RESOURCE_TYPE.SOUND, number)));
  }
}

/** Channels end with 0xFC, sometimes followed by one pad byte. */
function channelEndsWithEndOfTrack(channel) {
  return channel.data.subarray(-2).includes(END_OF_TRACK);
}

for (const world of WORLDS) {
  test(`${world}: has the expected number of sound resources`, () => {
    assert.equal(soundNumbersOf(openWorld(world)).length, EXPECTED_SOUND_COUNTS[world]);
  });

  test(`${world}: every sound resource parses into device tracks`, () => {
    eachSound(world, (number, sound) => {
      assert.ok(sound.tracks.length > 0, `sound ${number} has tracks`);
      sound.tracks.forEach((track) => track.channels.forEach((channel) => {
        assert.ok(channel.number < 16, `sound ${number} channel number`);
        assert.ok(channelEndsWithEndOfTrack(channel), `sound ${number} channel ${channel.number} ends with 0xFC`);
      }));
    });
  });

  test(`${world}: every AdLib track mixes into time-ordered MIDI events`, () => {
    eachSound(world, (number, sound) => {
      const track = findTrack(sound, SOUND_DEVICE.ADLIB);
      if (!track) {
        assert.ok(MT32_ONLY_SOUNDS.includes(number), `sound ${number} lacks an AdLib track`);
        return;
      }
      const { events, endTick } = mixTrack(track);
      assert.ok(events.length > 0, `sound ${number} has events`);
      assert.ok(events.every((event, i) => i === 0 || event.tick >= events[i - 1].tick), `sound ${number} is ordered`);
      assert.ok(events.every((event) => event.status >= 0x80 && event.data1 < 0x80 && event.data2 < 0x80));
      assert.ok(endTick >= events[events.length - 1].tick);
    });
  });
}

test('the CC title sounds carry 8-bit digital samples for Sound Blaster', () => {
  const resources = openWorld('CC');
  const track = findTrack(parseSound(resources.get(RESOURCE_TYPE.SOUND, 100)), SOUND_DEVICE.ADLIB);
  assert.equal(track.digital.rate, 11000);
  assert.equal(track.digital.samples.length, track.digital.size);
});

test('a 0xF0 track sets the sound priority instead of being a device track', () => {
  const sound = parseSound(openWorld('LL').get(RESOURCE_TYPE.SOUND, 394));
  assert.equal(sound.priority, 10);
  assert.ok(sound.tracks.every((track) => track.device !== SOUND_DEVICE.PRIORITY_MARKER));
});

test('patch 3 decodes to 96 AdLib instruments in two banks', () => {
  const instruments = decodeAdlibPatch(openWorld('CC').get(RESOURCE_TYPE.PATCH, ADLIB_PATCH));
  assert.equal(instruments.length, INSTRUMENTS_IN_TWO_BANKS);
  assert.ok(instruments.every((instrument) => instrument.op.length === 2 && instrument.feedback < 8));
});

test('a sound header without the closing 0xFF is rejected', () => {
  assert.throws(() => parseSound(Uint8Array.from([0x00, 0x00, 0x00, 0x08, 0x00])), /not terminated/);
});
