// RESOURCE.00x volume reader.
// Reference: ScummVM engines/sci/resource/resource.cpp Resource::readResourceInfo
// (kResVersionSci0Sci1Early branch).
//
// Header (8 bytes): uint16 id (type << 11 | number), uint16 packedSize + 4,
// uint16 unpackedSize, uint16 method. Then packedSize bytes of data.
import { decompressDCL } from './dcl.js';
import { decodeResourceId } from './types.js';

export const VOLUME_HEADER_SIZE = 8;
const HEADER_SIZE_BIAS = 4;

export const COMPRESSION = Object.freeze({
  NONE: 0,
  // LSCI (TSN) uses method 8 for PKWare DCL implode. Stock SCI used 18-20.
  DCL: 8,
});

const METHOD_NAMES = Object.freeze({ 0: 'none', 8: 'dcl', 18: 'dcl', 19: 'dcl', 20: 'dcl' });

/** @param {number} method */
export function compressionName(method) {
  return METHOD_NAMES[method] ?? `unknown(${method})`;
}

/**
 * @typedef {{ id: number, type: number, number: number, packedSize: number, unpackedSize: number,
 *   method: number, dataOffset: number }} VolumeHeader
 */

/**
 * @param {Uint8Array} volume
 * @param {number} offset
 * @returns {VolumeHeader}
 */
export function readVolumeHeader(volume, offset) {
  if (offset + VOLUME_HEADER_SIZE > volume.length) {
    throw new Error(`volume: header at ${offset} past end of file`);
  }
  const view = new DataView(volume.buffer, volume.byteOffset, volume.byteLength);
  const id = view.getUint16(offset, true);
  return Object.freeze({
    id,
    ...decodeResourceId(id),
    packedSize: view.getUint16(offset + 2, true) - HEADER_SIZE_BIAS,
    unpackedSize: view.getUint16(offset + 4, true),
    method: view.getUint16(offset + 6, true),
    dataOffset: offset + VOLUME_HEADER_SIZE,
  });
}

/**
 * Decompress a resource payload.
 * @param {Uint8Array} packed
 * @param {number} method
 * @param {number} unpackedSize
 * @returns {Uint8Array}
 */
export function decompress(packed, method, unpackedSize) {
  if (method === COMPRESSION.NONE) {
    return packed.slice(0, unpackedSize);
  }
  if (compressionName(method) === 'dcl') {
    return decompressDCL(packed, unpackedSize);
  }
  throw new Error(`unsupported compression method ${method}`);
}

/**
 * Read and decompress the resource whose header starts at `offset`.
 * @param {Uint8Array} volume
 * @param {number} offset
 */
export function readVolumeResource(volume, offset) {
  const header = readVolumeHeader(volume, offset);
  const end = header.dataOffset + header.packedSize;
  if (end > volume.length) {
    throw new Error(`volume: resource at ${offset} truncated`);
  }
  const packed = volume.subarray(header.dataOffset, end);
  return { header, data: decompress(packed, header.method, header.unpackedSize) };
}
