import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResourceManager } from './resource-manager.js';
import assert from 'node:assert/strict';
import { parseResourceMap } from './map.js';
import { RESOURCE_TYPE, encodeResourceId, decodeResourceId } from './types.js';
import { decompressDCL } from './dcl.js';
import { parsePatchFile } from './patch.js';
import { openCcWorld, readGameFile, readCcPatch, resourcesOfType } from './test-helpers.mjs';

const EXPECTED_MAP_ENTRIES = 260;
const FIRST_CLASS_MODULE = 60000;

function tallyByType(resources) {
  return resources.reduce((tally, r) => ({ ...tally, [r.type]: (tally[r.type] ?? 0) + 1 }), {});
}

test('RESOURCE.MAP has 260 entries, all in volume 1', () => {
  const entries = parseResourceMap(readGameFile('RESOURCE.MAP'));
  assert.equal(entries.length, EXPECTED_MAP_ENTRIES);
  assert.ok(entries.every((entry) => entry.volume === 1));
});

test('resource counts by type match the known CC world inventory', () => {
  const counts = tallyByType(openCcWorld({ withPatches: false }).list());
  assert.deepEqual(counts, {
    [RESOURCE_TYPE.VIEW]: 78,
    [RESOURCE_TYPE.PIC]: 16,
    [RESOURCE_TYPE.MODULE]: 129,
    [RESOURCE_TYPE.TEXT]: 2,
    [RESOURCE_TYPE.SOUND]: 16,
    [RESOURCE_TYPE.VOCAB]: 8,
    [RESOURCE_TYPE.FONT]: 7,
    [RESOURCE_TYPE.PATCH]: 3,
    [RESOURCE_TYPE.PALETTE]: 1,
  });
});

test('module numbers above 2047 overflow into the type field and decode back', () => {
  const id = encodeResourceId(RESOURCE_TYPE.MODULE, FIRST_CLASS_MODULE);
  assert.equal(id >> 11, 31);
  assert.deepEqual(decodeResourceId(id), { type: RESOURCE_TYPE.MODULE, number: FIRST_CLASS_MODULE });
  assert.ok(openCcWorld().has(RESOURCE_TYPE.MODULE, FIRST_CLASS_MODULE));
});

test('every resource decompresses to exactly its declared unpacked size', () => {
  const rm = openCcWorld({ withPatches: false });
  const failures = rm.list().filter((r) => {
    try {
      return rm.get(r.type, r.number).length !== r.unpackedSize;
    } catch {
      return true;
    }
  });
  assert.deepEqual(failures, []);
});

test('only "none" and DCL (method 8) compression are used', () => {
  const methods = new Set(openCcWorld({ withPatches: false }).list().map((r) => r.compression));
  assert.deepEqual([...methods].sort(), ['dcl', 'none']);
});

test('DCL decompressor rejects truncated input instead of returning garbage', () => {
  const rm = openCcWorld({ withPatches: false });
  const info = rm.info(RESOURCE_TYPE.VOCAB, 997);
  const volume = readGameFile('RESOURCE.001');
  const truncated = volume.subarray(info.offset + 8, info.offset + 8 + 20);
  assert.throws(() => decompressDCL(truncated, info.unpackedSize));
});

test('130.SO is a module patch that overrides module 130 from the volume', () => {
  const { name, bytes } = readCcPatch();
  const patch = parsePatchFile(name, bytes);
  assert.equal(patch.type, RESOURCE_TYPE.MODULE);
  assert.equal(patch.number, 130);
  const patched = openCcWorld();
  assert.equal(patched.info(RESOURCE_TYPE.MODULE, 130).source, 'patch');
  assert.notEqual(patched.get(RESOURCE_TYPE.MODULE, 130).length, openCcWorld({ withPatches: false }).get(RESOURCE_TYPE.MODULE, 130).length);
});

test('files that are not patches are ignored', () => {
  assert.equal(parsePatchFile('README.TXT', Uint8Array.from([0x82, 0])), null);
  assert.equal(parsePatchFile('130.SO', Uint8Array.from([0x02, 0])), null);
});

test('class modules 59950..60081 exist alongside regular modules', () => {
  const modules = resourcesOfType(openCcWorld(), RESOURCE_TYPE.MODULE).map((r) => r.number);
  assert.ok(modules.includes(59950));
  assert.ok(modules.includes(60081));
  assert.ok(modules.includes(0));
});

const LARRYLAND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'installed', 'INN', 'LL');
const FIRST_LARRYLAND_FACE_VIEW = 6000;

/** CasinoLand (INN LL): its map indexes its own RESOURCE.001 and the shared root RESOURCE.002. */
function openLarryLand() {
  const read = (name) => readFileSync(join(LARRYLAND_DIR, name));
  const volumes = { 1: read('RESOURCE.001'), 2: read(join('..', 'RESOURCE.002')) };
  return createResourceManager({ map: read('RESOURCE.MAP'), volumes, patches: [] });
}

test('view 6000 is found by its 16-bit id although the map decodes that id as module 1904', { skip: !existsSync(LARRYLAND_DIR) }, () => {
  const larryLand = openLarryLand();
  assert.equal(encodeResourceId(RESOURCE_TYPE.VIEW, FIRST_LARRYLAND_FACE_VIEW), encodeResourceId(RESOURCE_TYPE.MODULE, 1904));
  assert.ok(larryLand.has(RESOURCE_TYPE.VIEW, FIRST_LARRYLAND_FACE_VIEW));
  assert.ok(larryLand.get(RESOURCE_TYPE.VIEW, FIRST_LARRYLAND_FACE_VIEW).length > 0);
});
