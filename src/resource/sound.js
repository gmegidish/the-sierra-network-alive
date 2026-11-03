// SCI1 sound resources and the AdLib instrument patch (patch 3).
// References (GPL, used as format documentation for this hobby port):
//   ScummVM engines/sci/resource/resource_audio.cpp  SoundResource::SoundResource (SCI1 branch)
//   ScummVM engines/sci/sound/midiparser_sci.cpp     midiMixChannels / midiGetNextChannel
//   ScummVM engines/sci/sound/drivers/adlib.cpp      loadResource / loadInstrument
//
// Sound resource layout (SCI1, as used by LSCI):
//   repeat { uint8 deviceType; repeat { uint16 ?, uint16 offset, uint16 size } until 0xFF } until 0xFF
//   deviceType 0xF0 is not a device: the first byte of its list is the sound priority.
//   Each channel's data begins with { uint8 flags<<4 | midiChannel, uint8 prio<<4 | voices },
//   then a delta-timed MIDI stream ending in 0xFC. Channel byte 0xFE marks a digital
//   sample: { uint16 rate, uint16 size, uint16 loopStart, uint16 loopEnd, unsigned 8-bit PCM }.

export const SOUND_DEVICE = Object.freeze({
  ADLIB: 0x00,
  GENERAL_MIDI: 0x07,
  MT32: 0x0c,
  PC_SPEAKER: 0x12,
  TANDY: 0x13,
  PRIORITY_MARKER: 0xf0,
});

export const CONTROL_CHANNEL = 15;
export const END_OF_TRACK = 0xfc;
export const CHANNEL_FLAG = Object.freeze({ DONT_MAP: 1, DONT_REMAP: 2, START_MUTED: 4 });

const LIST_END = 0xff;
const CHANNEL_ENTRY_SIZE = 6;
const CHANNEL_HEADER_SIZE = 2;
const DIGITAL_CHANNEL = 0xfe;
const DIGITAL_HEADER_SIZE = 8;
const NO_PRIORITY = 0xff;
const DELAY_MARKER = 0xf8;
const DELAY_MARKER_TICKS = 240;
const SYSEX = 0xf0;
const SYSEX_END = 0xf7;

const INSTRUMENT_SIZE = 28;
const OPERATOR_SIZE = 13;
const PATCH_BANK = 48;
const PATCH_SIZE_ONE_BANK = 1344;
const PATCH_SIZE_TWO_BANKS = 2690;
const SECOND_BANK_GAP = 2;

/**
 * @typedef {{ number: number, flags: number, voices: number, prio: number, data: Uint8Array }} SoundChannel
 * @typedef {{ rate: number, size: number, loopStart: number, loopEnd: number, samples: Uint8Array }} DigitalSample
 * @typedef {{ device: number, channels: SoundChannel[], digital: DigitalSample | null }} SoundTrack
 * @typedef {{ priority: number, tracks: SoundTrack[] }} SoundResource
 * @typedef {{ tick: number, status: number, data1: number, data2: number }} MidiEvent
 * @typedef {{ kbScaleLevel: number, frequencyMult: number, attackRate: number, sustainLevel: number,
 *   envelopeType: boolean, decayRate: number, releaseRate: number, totalLevel: number,
 *   amplitudeMod: boolean, vibrato: boolean, kbScaleRate: boolean, waveForm: number }} AdlibOperator
 * @typedef {{ op: AdlibOperator[], feedback: number, algorithm: number }} AdlibInstrument
 */

const readWord = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);

/** Number of 6-byte channel entries before the 0xFF that closes a track's list. */
function countChannelEntries(bytes, offset) {
  let count = 0;
  while (offset + count * CHANNEL_ENTRY_SIZE < bytes.length && bytes[offset + count * CHANNEL_ENTRY_SIZE] !== LIST_END) {
    count += 1;
  }
  return count;
}

/** The played part is [start, size - (size - end)) as in ScummVM's soundInitSnd. */
function readDigitalSample(body) {
  const size = readWord(body, 2);
  const start = readWord(body, 4);
  const end = readWord(body, 6);
  const stop = end > 0 ? end : size;
  return Object.freeze({
    rate: readWord(body, 0),
    size,
    loopStart: start,
    loopEnd: end,
    samples: body.subarray(DIGITAL_HEADER_SIZE + start, DIGITAL_HEADER_SIZE + Math.max(start, stop)),
  });
}

/** @returns {{ channel: SoundChannel | null, digital: DigitalSample | null }} */
function readChannel(bytes, entryOffset) {
  const offset = readWord(bytes, entryOffset + 2);
  const size = Math.min(readWord(bytes, entryOffset + 4), bytes.length - offset);
  if (offset >= bytes.length || size < CHANNEL_HEADER_SIZE) {
    return { channel: null, digital: null };
  }
  const head = bytes[offset];
  const body = bytes.subarray(offset + CHANNEL_HEADER_SIZE, offset + size);
  if (head === DIGITAL_CHANNEL) {
    return { channel: null, digital: readDigitalSample(body) };
  }
  const info = bytes[offset + 1];
  const channel = Object.freeze({ number: head & 0x0f, flags: head >> 4, voices: info & 0x0f, prio: info >> 4, data: body });
  return { channel, digital: null };
}

function readTrack(bytes, offset, device) {
  const count = countChannelEntries(bytes, offset);
  const channels = [];
  let digital = null;
  for (let i = 0; i < count; i += 1) {
    const read = readChannel(bytes, offset + i * CHANNEL_ENTRY_SIZE);
    if (read.channel) {
      channels.push(read.channel);
    }
    digital = digital ?? read.digital;
  }
  return { track: Object.freeze({ device, channels, digital }), next: offset + count * CHANNEL_ENTRY_SIZE + 1 };
}

/**
 * Parse an SCI1 sound resource into per-device tracks.
 * @param {Uint8Array} bytes
 * @returns {SoundResource}
 */
export function parseSound(bytes) {
  const tracks = [];
  let priority = NO_PRIORITY;
  let offset = 0;
  while (offset < bytes.length && bytes[offset] !== LIST_END) {
    const device = bytes[offset];
    if (device === SOUND_DEVICE.PRIORITY_MARKER) {
      priority = bytes[offset + 1];
      offset += 1 + countChannelEntries(bytes, offset + 1) * CHANNEL_ENTRY_SIZE + 1;
      continue;
    }
    const { track, next } = readTrack(bytes, offset + 1, device);
    tracks.push(track);
    offset = next;
  }
  if (offset >= bytes.length) {
    throw new Error('sound header is not terminated by 0xFF');
  }
  return Object.freeze({ priority, tracks });
}

/** @param {SoundResource} sound @param {number} device @returns {SoundTrack | undefined} */
export function findTrack(sound, device) {
  return sound.tracks.find((track) => track.device === device);
}

const PARAMETER_COUNT = Object.freeze({ 0x8: 2, 0x9: 2, 0xa: 2, 0xb: 2, 0xc: 1, 0xd: 1, 0xe: 2 });

/** Per-channel read cursor used while merging. */
function createCursor(channel) {
  return { data: channel.data, pos: 0, time: 0, running: 0, done: channel.data.length === 0 };
}

function nextEventTime(cursor) {
  const delta = cursor.data[cursor.pos];
  return cursor.time + (delta === DELAY_MARKER ? DELAY_MARKER_TICKS : delta);
}

function pickEarliest(cursors) {
  let best = null;
  for (const cursor of cursors) {
    if (!cursor.done && cursor.pos < cursor.data.length && (!best || nextEventTime(cursor) < nextEventTime(best))) {
      best = cursor;
    }
  }
  return best;
}

function skipSysex(cursor) {
  while (cursor.pos < cursor.data.length && cursor.data[cursor.pos++] !== SYSEX_END) {
    // skip the payload
  }
}

/** Read one event at the cursor (after its delta). Returns null for no-output events. */
function readEvent(cursor) {
  const first = cursor.data[cursor.pos++];
  if (first === END_OF_TRACK) {
    cursor.done = true;
    return null;
  }
  if (first === SYSEX) {
    skipSysex(cursor);
    return null;
  }
  let status = first;
  let data1;
  if (first & 0x80) {
    data1 = cursor.data[cursor.pos++];
  } else {
    status = cursor.running;
    data1 = first;
  }
  cursor.running = status;
  const data2 = PARAMETER_COUNT[status >> 4] === 2 ? cursor.data[cursor.pos++] : 0;
  return { tick: cursor.time, status, data1: data1 ?? 0, data2: data2 ?? 0 };
}

/**
 * Merge a track's channel streams into one time-ordered event list (absolute ticks,
 * 60 per second), like MidiParser_SCI::midiMixChannels. The list ends with the
 * time of the last channel's end-of-track as `endTick`.
 * @param {SoundTrack} track
 * @returns {{ events: MidiEvent[], endTick: number, channelsUsed: Set<number> }}
 */
export function mixTrack(track) {
  const cursors = track.channels.map(createCursor);
  const events = [];
  const channelsUsed = new Set();
  let endTick = 0;
  for (let cursor = pickEarliest(cursors); cursor; cursor = pickEarliest(cursors)) {
    const delta = cursor.data[cursor.pos++];
    cursor.time += delta === DELAY_MARKER ? DELAY_MARKER_TICKS : delta;
    endTick = Math.max(endTick, cursor.time);
    if (delta === DELAY_MARKER || cursor.pos >= cursor.data.length) {
      continue;
    }
    const event = readEvent(cursor);
    if (event && event.status >= 0x80) {
      events.push(Object.freeze(event));
      channelsUsed.add(event.status & 0x0f);
    }
  }
  return { events, endTick, channelsUsed };
}

function decodeOperator(bytes) {
  return Object.freeze({
    kbScaleLevel: bytes[0] & 0x3,
    frequencyMult: bytes[1] & 0xf,
    attackRate: bytes[3] & 0xf,
    sustainLevel: bytes[4] & 0xf,
    envelopeType: bytes[5] !== 0,
    decayRate: bytes[6] & 0xf,
    releaseRate: bytes[7] & 0xf,
    totalLevel: bytes[8] & 0x3f,
    amplitudeMod: bytes[9] !== 0,
    vibrato: bytes[10] !== 0,
    kbScaleRate: bytes[11] !== 0,
    waveForm: 0,
  });
}

/** One 28-byte instrument: two 13-byte operators, then the two waveforms. */
function decodeInstrument(bytes) {
  const op = [0, 1].map((i) => Object.freeze({
    ...decodeOperator(bytes.subarray(i * OPERATOR_SIZE, (i + 1) * OPERATOR_SIZE)),
    waveForm: bytes[26 + i] & 0x3,
  }));
  return Object.freeze({ op, feedback: bytes[2] & 0x7, algorithm: bytes[12] ? 0 : 1 });
}

/**
 * Decode the AdLib patch resource (patch 3): 48 instruments, or 96 when the
 * second bank follows a 2-byte gap (2690 bytes). Like MidiDriver_AdLib::loadResource.
 * @param {Uint8Array} bytes
 * @returns {AdlibInstrument[]}
 */
export function decodeAdlibPatch(bytes) {
  if (bytes.length !== PATCH_SIZE_ONE_BANK && bytes.length !== PATCH_SIZE_TWO_BANKS) {
    throw new Error(`unsupported AdLib patch size ${bytes.length}`);
  }
  const at = (index) => (index < PATCH_BANK ? index * INSTRUMENT_SIZE : SECOND_BANK_GAP + index * INSTRUMENT_SIZE);
  const count = bytes.length === PATCH_SIZE_TWO_BANKS ? PATCH_BANK * 2 : PATCH_BANK;
  return Array.from({ length: count }, (_, i) => decodeInstrument(bytes.subarray(at(i), at(i) + INSTRUMENT_SIZE)));
}
