// SCI1-style patch files (e.g. disk/4/CCPATCH/130.SO).
// Reference: ScummVM engines/sci/resource/resource.cpp ResourceManager::processPatch.
//
// Layout: byte (0x80 | type), byte extraHeaderSize, extraHeaderSize bytes, raw
// (uncompressed) resource data. The resource number comes from the file name
// ("130.SO" -> 130). LSCI's interpreter has no ".SO" string of its own; TSN's
// launcher copies these into the game directory, so we accept any extension.

const PATCH_TYPE_FLAG = 0x80;
const PATCH_TYPE_MASK = 0x7f;
const PATCH_FIXED_HEADER_SIZE = 2;
const FILE_NAME_PATTERN = /^(\d+)\.[A-Za-z0-9]{1,3}$/;

/**
 * @typedef {{ type: number, number: number, data: Uint8Array, source: string }} PatchResource
 */

/** @param {string} fileName */
function baseName(fileName) {
  const parts = fileName.split(/[\\/]/);
  return parts[parts.length - 1];
}

/**
 * Parse one patch file. Returns null for files that are not patches.
 * @param {string} fileName
 * @param {Uint8Array} bytes
 * @returns {PatchResource | null}
 */
export function parsePatchFile(fileName, bytes) {
  const match = FILE_NAME_PATTERN.exec(baseName(fileName));
  if (!match || bytes.length < PATCH_FIXED_HEADER_SIZE) {
    return null;
  }
  if ((bytes[0] & PATCH_TYPE_FLAG) === 0) {
    return null;
  }
  const dataStart = PATCH_FIXED_HEADER_SIZE + bytes[1];
  if (dataStart > bytes.length) {
    return null;
  }
  return Object.freeze({
    type: bytes[0] & PATCH_TYPE_MASK,
    number: Number(match[1]),
    data: bytes.slice(dataStart),
    source: fileName,
  });
}

/**
 * Parse a list of candidate patch files; non-patch files are skipped.
 * @param {{ name: string, bytes: Uint8Array }[]} files
 * @returns {PatchResource[]}
 */
export function parsePatchFiles(files) {
  return files
    .map((file) => parsePatchFile(file.name, file.bytes))
    .filter((patch) => patch !== null);
}
