// RESOURCE.MAP parser (SCI0 / early-SCI1 map format).
// Reference: ScummVM engines/sci/resource/resource.cpp ResourceManager::readResourceMapSCI0.
//
// Each entry is 6 bytes: uint16 id (type << 11 | number), uint32 location
// (volume << 26 | offset). The table ends with an entry whose id is 0xFFFF.
// Ids are (type << 11) + number truncated to 16 bits, so LSCI modules numbered
// 59950..60081 show up with type field 31; decodeResourceId undoes that.

import { decodeResourceId } from './types.js';

const ENTRY_SIZE = 6;
const END_MARKER = 0xffff;
const VOLUME_SHIFT = 26;
const OFFSET_MASK = 0x3ffffff;

/**
 * @typedef {{ id: number, type: number, number: number, volume: number, offset: number }} MapEntry
 */

/**
 * @param {Uint8Array} bytes RESOURCE.MAP contents
 * @returns {MapEntry[]}
 */
export function parseResourceMap(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  for (let pos = 0; pos + ENTRY_SIZE <= bytes.length; pos += ENTRY_SIZE) {
    const id = view.getUint16(pos, true);
    if (id === END_MARKER) {
      return entries;
    }
    const location = view.getUint32(pos + 2, true);
    entries.push(Object.freeze({
      id,
      ...decodeResourceId(id),
      volume: location >>> VOLUME_SHIFT,
      offset: location & OFFSET_MASK,
    }));
  }
  throw new Error('RESOURCE.MAP: missing 0xFFFF terminator');
}
