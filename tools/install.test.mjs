import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, readArchiveChunks, videoSetForDriver, DEFAULT_OPTIONS } from './install.mjs';
import { explode } from './puff.mjs';

const MAP_ENTRY_SIZE = 6;
const MAP_END_MARKER = 0xffff;
const OFFSET_MASK = 0x03ffffff;
const VOLUME_SHIFT = 26;

let tempDir;
let tsn;

before(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'tsn-install-'));
  tsn = install({ outDir: path.join(tempDir, 'TSN') });
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function installedPath(...parts) {
  return path.join(tsn, ...parts);
}

function fileSize(...parts) {
  return statSync(installedPath(...parts)).size;
}

function filesIn(...parts) {
  return readdirSync(installedPath(...parts)).filter((name) => statSync(installedPath(...parts, name)).isFile());
}

function chunksForVga() {
  const vga = videoSetForDriver(DEFAULT_OPTIONS.video);
  return readArchiveChunks().filter((chunk) => chunk.videoSet === 0 || chunk.videoSet === vga);
}

function archivedSizeOf(dir, name) {
  const chunk = readArchiveChunks().find((c) => c.dir === dir && c.name === name);
  return chunk.totalSize;
}

// SCI0-style RESOURCE.MAP: 6-byte entries (uint16 type<<11|number, uint32 volume<<26|offset), FFFF-terminated.
function parseResourceMap(buffer) {
  const entries = [];
  for (let pos = 0; pos + MAP_ENTRY_SIZE <= buffer.length; pos += MAP_ENTRY_SIZE) {
    const id = buffer.readUInt16LE(pos);
    if (id === MAP_END_MARKER) {
      break;
    }
    const location = buffer.readUInt32LE(pos + 2);
    entries.push({ id, volume: location >>> VOLUME_SHIFT, offset: location & OFFSET_MASK });
  }
  return entries;
}

function resourceMapOf(dir) {
  return parseResourceMap(readFileSync(installedPath(dir, 'RESOURCE.MAP')));
}

function volumeFileName(volume) {
  return `RESOURCE.${String(volume).padStart(3, '0')}`;
}

function resourceHeaderIdAt(dir, volume, offset) {
  return readFileSync(installedPath(dir, volumeFileName(volume))).readUInt16LE(offset);
}

test('the archive spans four parts and every file chunk adds up to its declared size', () => {
  const chunks = readArchiveChunks();
  assert.deepEqual([...new Set(chunks.map((c) => c.part))], [1, 2, 3, 4]);
  const totals = new Map();
  for (const chunk of chunks) {
    const key = `${chunk.dir}/${chunk.name}/${chunk.videoSet}`;
    totals.set(key, (totals.get(key) ?? 0) + chunk.chunkSize);
  }
  for (const chunk of chunks) {
    assert.equal(totals.get(`${chunk.dir}/${chunk.name}/${chunk.videoSet}`), chunk.totalSize, chunk.name);
  }
});

test('the VGA install extracts 141 distinct files from the archive', () => {
  const distinct = new Set(chunksForVga().map((c) => `${c.dir}/${c.name}`));
  assert.equal(distinct.size, 141);
});

test('the installed tree has the expected directories and file counts', () => {
  assert.equal(filesIn('.').length, 47);
  assert.equal(filesIn('SL').length, 26);
  assert.equal(filesIn('LL').length, 5);
  assert.equal(filesIn('BARON').length, 8);
  assert.equal(filesIn('YSERBIUS').length, 107);
  assert.ok(statSync(installedPath('YSERBIUS', 'SAVE')).isDirectory());
});

test('SierraLand and LarryLand resource files exist with the sizes from the archive headers', () => {
  for (const world of ['SL', 'LL']) {
    for (const name of ['RESOURCE.MAP', 'RESOURCE.001']) {
      assert.equal(fileSize(world, name), archivedSizeOf(world, name), `${world}/${name}`);
    }
  }
  assert.equal(fileSize('SL', 'RESOURCE.001'), 999162);
  assert.equal(fileSize('LL', 'RESOURCE.001'), 878905);
});

test('every resource map entry points inside its volume at a header with the same id', () => {
  for (const dir of ['.', 'SL', 'LL']) {
    const entries = resourceMapOf(dir);
    assert.ok(entries.length > 50, `${dir} has resources`);
    for (const entry of entries) {
      assert.ok(entry.offset < fileSize(dir, volumeFileName(entry.volume)), `${dir} ${entry.id}`);
      assert.equal(resourceHeaderIdAt(dir, entry.volume, entry.offset), entry.id, `${dir} ${entry.id}`);
    }
  }
});

test('puffed files are decompressed to their real names and the underscore originals are removed', () => {
  for (const name of ['GRAPH256.DLL', 'NLNULL.DLL', 'GENERAL.DOC', 'YSERBIUS.DOC']) {
    assert.ok(existsSync(installedPath(name)), name);
  }
  assert.equal(fileSize('GRAPH256.DLL'), 13458);
  assert.equal(fileSize('BARON', 'VOLUME.001'), 247737);
  for (const dir of ['.', 'BARON', 'YSERBIUS']) {
    assert.deepEqual(filesIn(dir).filter((name) => name.startsWith('_')), [], dir);
  }
  assert.match(readFileSync(installedPath('GENERAL.DOC'), 'latin1'), /THE SIERRA NETWORK/);
});

test('the DCL decoder round-trips a known PKWARE example stream', () => {
  // Example from blast.c: decodes to "AIAIAIAIAIAIA".
  const stream = Buffer.from([0x00, 0x04, 0x82, 0x24, 0x25, 0x8f, 0x80, 0x7f]);
  assert.equal(explode(stream).toString('latin1'), 'AIAIAIAIAIAIA');
});

test('patch resources from disk 4 land in their world directories', () => {
  assert.ok(existsSync(installedPath('130.SO')));
  assert.ok(existsSync(installedPath('SL', '120.SO')));
  assert.ok(existsSync(installedPath('LL', '1040.SO')));
});

test('world configs point drivers at the parent directory', () => {
  const config = readFileSync(installedPath('SL', 'LSCI.CFG'), 'latin1');
  assert.match(config, /video = \.\.\\VGA320\.DRV/);
  assert.match(config, /pathStr = \.\.\\/);
  assert.match(readFileSync(installedPath('TSN.BAT'), 'latin1'), /tsnexec DEFAULT/);
});
