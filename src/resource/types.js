// SCI resource type ids as stored in the map/volume (5-bit type field).
// Names follow ScummVM engines/sci/resource/resource.cpp (s_resourceTypeNames,
// s_resTypeMapSci0) and the SCI1 patch suffixes (s_resourceTypeSuffixes).
// LSCI (TSN) calls type 2 "module" instead of "script"; type names below are
// taken from the interpreter's own table in LSCITV.EXE.

export const RESOURCE_TYPE = Object.freeze({
  VIEW: 0,
  PIC: 1,
  SCRIPT: 2,
  MODULE: 2,
  TEXT: 3,
  SOUND: 4,
  MEMORY: 5,
  VOCAB: 6,
  FONT: 7,
  CURSOR: 8,
  PATCH: 9,
  BITMAP: 10,
  PALETTE: 11,
  CDAUDIO: 12,
  AUDIO: 13,
  SYNC: 14,
  MESSAGE: 15,
  MAP: 16,
  HEAP: 17,
});

const ID_TYPE_SHIFT = 11;
const ID_MASK = 0xffff;
const ID_NUMBER_MASK = 0x7ff;
const MAX_STANDARD_TYPE = RESOURCE_TYPE.PALETTE;

const TYPE_NAMES = Object.freeze({
  0: 'view',
  1: 'pic',
  2: 'module',
  3: 'text',
  4: 'sound',
  5: 'memory',
  6: 'vocab',
  7: 'font',
  8: 'cursor',
  9: 'patch',
  10: 'bitmap',
  11: 'palette',
  12: 'cdaudio',
  13: 'audio',
  14: 'sync',
  15: 'message',
  16: 'map',
  17: 'heap',
});

// Three-letter patch-file suffixes, e.g. "130.SCR" (SCI1 naming, ScummVM s_resourceTypeSuffixes).
const TYPE_SUFFIXES = Object.freeze({
  0: 'v56',
  1: 'p56',
  2: 'scr',
  3: 'tex',
  4: 'snd',
  6: 'voc',
  7: 'fon',
  8: 'cur',
  9: 'pat',
  10: 'bit',
  11: 'pal',
});

/** @param {number} type */
export function resourceTypeName(type) {
  return TYPE_NAMES[type] ?? `type${type}`;
}

/** @param {number} type */
export function resourceTypeSuffix(type) {
  return TYPE_SUFFIXES[type];
}

/** Build a canonical "type.number" key, e.g. "pic.100". */
export function resourceKey(type, number) {
  return `${resourceTypeName(type)}.${number}`;
}

/**
 * Encode a resource id the way LSCI does: (type << 11) + number, truncated to 16 bits.
 * Module numbers >= 2048 (e.g. the 59950..60081 class modules) overflow into the
 * type field, which is why they appear as "type 31" in RESOURCE.MAP.
 */
export function encodeResourceId(type, number) {
  return ((type << ID_TYPE_SHIFT) + number) & ID_MASK;
}

/**
 * Decode a 16-bit resource id. Ids whose type field is not a known type are
 * overflowed module numbers (see encodeResourceId).
 * @returns {{ type: number, number: number }}
 */
export function decodeResourceId(id) {
  const type = id >> ID_TYPE_SHIFT;
  if (type <= MAX_STANDARD_TYPE) {
    return { type, number: id & ID_NUMBER_MASK };
  }
  return { type: RESOURCE_TYPE.SCRIPT, number: id - (RESOURCE_TYPE.SCRIPT << ID_TYPE_SHIFT) };
}
