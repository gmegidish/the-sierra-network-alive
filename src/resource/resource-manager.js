// Resource manager: RESOURCE.MAP + RESOURCE.00x volumes + patch overlay.
// Reference: ScummVM engines/sci/resource/resource.cpp (ResourceManager).
// Works on in-memory bytes only, so it runs in the browser (fetch) and Node (readFileSync).
import { parseResourceMap } from './map.js';
import { readVolumeHeader, decompress, compressionName } from './volume.js';
import { parsePatchFiles } from './patch.js';
import { resourceKey, encodeResourceId } from './types.js';

/**
 * @typedef {{ type: number, number: number, source: 'volume' | 'patch', volume?: number,
 *   offset?: number, packedSize: number, unpackedSize: number, method: number,
 *   compression: string, patchFile?: string }} ResourceInfo
 */

function describeVolumeEntry(entry, volumes) {
  const volume = volumes[entry.volume];
  if (!volume) {
    throw new Error(`${resourceKey(entry.type, entry.number)}: missing volume ${entry.volume}`);
  }
  const header = readVolumeHeader(volume, entry.offset);
  if (header.id !== entry.id) {
    throw new Error(`${resourceKey(entry.type, entry.number)}: volume header id mismatch`);
  }
  return Object.freeze({
    type: entry.type,
    number: entry.number,
    source: 'volume',
    volume: entry.volume,
    offset: entry.offset,
    packedSize: header.packedSize,
    unpackedSize: header.unpackedSize,
    method: header.method,
    compression: compressionName(header.method),
  });
}

function describePatch(patch) {
  return Object.freeze({
    type: patch.type,
    number: patch.number,
    source: 'patch',
    packedSize: patch.data.length,
    unpackedSize: patch.data.length,
    method: 0,
    compression: 'none',
    patchFile: patch.source,
  });
}

function sortByTypeThenNumber(a, b) {
  return a.type - b.type || a.number - b.number;
}

/**
 * @param {{ map: Uint8Array, volumes: Record<number, Uint8Array>,
 *   patches?: { name: string, bytes: Uint8Array }[] }} input
 */
export function createResourceManager({ map, volumes, patches = [] }) {
  const index = new Map();
  /** 16-bit map id -> index key. LSCI ids are (type << 11) + number truncated to 16 bits,
   * so view 6000 has id 6000 and the map decodes it as module 1904; the interpreter looks
   * resources up by id, and so do we when the decoded key misses. */
  const keyById = new Map();
  for (const entry of parseResourceMap(map)) {
    const key = resourceKey(entry.type, entry.number);
    index.set(key, describeVolumeEntry(entry, volumes));
    keyById.set(entry.id, key);
  }
  const patchData = new Map();
  for (const patch of parsePatchFiles(patches)) {
    const key = resourceKey(patch.type, patch.number);
    index.set(key, describePatch(patch));
    patchData.set(key, patch.data);
  }
  const cache = new Map();

  /** @returns {ResourceInfo[]} */
  const list = () => [...index.values()].sort(sortByTypeThenNumber);

  const keyOf = (type, number) => {
    const key = resourceKey(type, number);
    return index.has(key) ? key : keyById.get(encodeResourceId(type, number)) ?? key;
  };

  const has = (type, number) => index.has(keyOf(type, number));

  const info = (type, number) => index.get(keyOf(type, number));

  /** @returns {Uint8Array} decompressed resource data */
  const get = (type, number) => {
    const key = keyOf(type, number);
    if (cache.has(key)) {
      return cache.get(key);
    }
    const entry = index.get(key);
    if (!entry) {
      throw new Error(`resource ${key} not found`);
    }
    const data = entry.source === 'patch'
      ? patchData.get(key)
      : readVolumeData(volumes[entry.volume], entry);
    cache.set(key, data);
    return data;
  };

  return Object.freeze({ list, has, info, get });
}

function readVolumeData(volume, entry) {
  const header = readVolumeHeader(volume, entry.offset);
  const packed = volume.subarray(header.dataOffset, header.dataOffset + header.packedSize);
  return decompress(packed, header.method, header.unpackedSize);
}
