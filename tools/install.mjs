// Simulates disk/1/INSTALL.SCR (run by INSTALL.EXE) and produces installed/TSN/.
// Usage (from the repo root): node tools/install.mjs
// See docs/install-format.md for the PART.n archive and PUFF formats.

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, unlinkSync, utimesSync, writeFileSync, openSync, writeSync, closeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unpuff } from './puff.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DISK_DIR = path.join(REPO_ROOT, 'disk');
export const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'installed', 'TSN');

// Answers to the questions INSTALL.EXE would ask (%3/%4/%5 in INSTALL.SCR).
export const DEFAULT_OPTIONS = {
  video: 'VGA320.DRV',
  keyboard: 'IBMKBD.DRV',
  music: 'ADL.DRV',
  comm: 'comm = Sierra Network Default Settings : b2400 c1',
  passwordSetting: '',
};

const PART_COUNT = 4;
const ENTRY_SIZE = 31;
const ENTRY_NAME_LENGTH = 13;
const FLAG_END_OF_ARCHIVE = 0x8000;
const FLAG_DIRECTORY = 0x4000;
const FLAG_END_OF_PART = 0x2000;
const VIDEO_SET_MASK = 0x0003;
const VIDEO_SET_EGA = 1;
const VIDEO_SET_VGA = 2;
const CRLF = '\r\n';

const ROOT_FILES = [
  'READ.ME', ['INSTALL.EXE', 'INSTTSN.EXE'], 'INSTALL.BAT', 'LSCIGET.EXE', 'INSTALL.TXT',
  'DRIVERS.TXT', 'INSTALL.HLP', 'INSTTSN.TXT', 'INSTTSN.HLP', 'MODEM.TXT', 'PHONE.TXT',
  'RBJOY.EXE', 'TSNEXEC.EXE', 'TSN.PRG', 'MODEM.DRV', 'NOBRK.DRV', 'TSN.ICO', 'TSN.PIF',
  'PATCHPIF.EXE', 'HOSTADDR', 'LSCITV.EXE', 'GAME.CFG', 'LAND.CFG', 'LLSYSTEM.DAT',
  'TWEAKER.DRV', 'MT32.DRV', 'MT32.NL', 'ADL.DRV', 'SNDBLAST.DRV', 'TANDYXL.DRV',
  'IBMKBD.DRV', '_LNULL.DLL', 'VGA320.DRV', '_RAPH256.DLL', 'EGA640.DRV',
  'RESOURCE.MAP', 'RESOURCE.001',
];

const DOC_FILES = ['_ENERAL.DOC', '_IERRLND.DOC', '_ARRYLND.DOC', '_SERBIUS.DOC'];
const DOC_LIST = ['General.doc', 'Sierrlnd.doc', 'Larrylnd.doc', 'Yserbius.doc'];

// INSTALL.SCR: "copy %2:\xxPatch\*.*" into the matching world directory.
const PATCH_DIRS = [
  { from: 'SLPATCH', to: 'SL' },
  { from: 'LLPATCH', to: 'LL' },
  { from: 'YSPATCH', to: 'YSERBIUS' },
  { from: 'CCPATCH', to: '.' },
];

const WORLD_CONFIGS = ['SL', 'LL'];

export function dosStampToDate(stamp) {
  const time = stamp & 0xffff;
  const date = stamp >>> 16;
  return new Date(
    1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31,
    time >> 11, (time >> 5) & 63, (time & 31) * 2,
  );
}

function readEntry(buffer, offset) {
  return {
    name: buffer.toString('latin1', offset, offset + ENTRY_NAME_LENGTH).split('\0')[0],
    flags: buffer.readUInt16LE(offset + 13),
    totalSize: buffer.readUInt32LE(offset + 15),
    chunkSize: buffer.readUInt32LE(offset + 19),
    fileOffset: buffer.readUInt32LE(offset + 23),
    dosStamp: buffer.readUInt32LE(offset + 27),
  };
}

export function partPath(partNumber, diskDir = DISK_DIR) {
  return path.join(diskDir, String(partNumber), `PART.${partNumber}`);
}

// Returns every file chunk in PART.1..PART.4, in archive order.
export function readArchiveChunks(diskDir = DISK_DIR) {
  const chunks = [];
  let currentDir = '.';
  for (let part = 1; part <= PART_COUNT; part++) {
    const buffer = readFileSync(partPath(part, diskDir));
    let offset = 0;
    let finished = false;
    while (!finished) {
      if (offset + ENTRY_SIZE > buffer.length) {
        throw new Error(`PART.${part}: entry runs past end of file at ${offset}`);
      }
      const entry = readEntry(buffer, offset);
      offset += ENTRY_SIZE;
      if (entry.flags & (FLAG_END_OF_PART | FLAG_END_OF_ARCHIVE)) {
        finished = true;
      } else if (entry.flags & FLAG_DIRECTORY) {
        currentDir = entry.name;
      } else {
        chunks.push({
          ...entry,
          dir: currentDir,
          videoSet: entry.flags & VIDEO_SET_MASK,
          part,
          data: buffer.subarray(offset, offset + entry.chunkSize),
        });
        offset += entry.chunkSize;
      }
    }
  }
  return chunks;
}

// INSTALL.EXE looks at the "video" line of LSCI.CFG: an "ega??0.drv" driver means the EGA set.
export function videoSetForDriver(videoDriver) {
  return /ega..0\.drv/i.test(videoDriver) ? VIDEO_SET_EGA : VIDEO_SET_VGA;
}

function belongsToVideoSet(chunk, videoSet) {
  return chunk.videoSet === 0 || chunk.videoSet === videoSet;
}

// The "defuse" command: de-archives the spanned archive into outDir.
export function defuse(outDir, videoSet, diskDir = DISK_DIR) {
  const written = new Map();
  for (const chunk of readArchiveChunks(diskDir)) {
    if (!belongsToVideoSet(chunk, videoSet)) {
      continue;
    }
    const dir = path.join(outDir, chunk.dir);
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, chunk.name);
    const fd = openSync(target, chunk.fileOffset === 0 ? 'w' : 'r+');
    writeSync(fd, chunk.data, 0, chunk.data.length, chunk.fileOffset);
    closeSync(fd);
    written.set(target, chunk.dosStamp);
  }
  for (const [target, stamp] of written) {
    const when = dosStampToDate(stamp);
    utimesSync(target, when, when);
  }
  return [...written.keys()];
}

function isPuffedName(name) {
  return name.startsWith('_');
}

// The "puff /D" command: decompress a puffed file to its stored name, then delete the source.
export function puffFile(file) {
  const result = unpuff(readFileSync(file));
  const target = path.join(path.dirname(file), result.name);
  writeFileSync(target, result.data);
  const when = dosStampToDate(result.dosStamp);
  utimesSync(target, when, when);
  if (path.resolve(target) !== path.resolve(file)) {
    unlinkSync(file);
  }
  return target;
}

function puffAllIn(dir, suffix = '') {
  return readdirSync(dir)
    .filter((name) => isPuffedName(name) && name.toUpperCase().endsWith(suffix))
    .map((name) => puffFile(path.join(dir, name)));
}

// Like DOS COPY, keeps the source file's modification time.
function copyInto(source, targetDir, targetName = path.basename(source)) {
  const target = path.join(targetDir, targetName);
  copyFileSync(source, target);
  const { mtime } = statSync(source);
  utimesSync(target, mtime, mtime);
}

function copyAllFiles(sourceDir, targetDir) {
  if (!existsSync(sourceDir)) {
    return;
  }
  for (const name of readdirSync(sourceDir)) {
    copyInto(path.join(sourceDir, name), targetDir);
  }
}

function writeDosText(file, lines) {
  writeFileSync(file, lines.map((line) => line + CRLF).join(''), 'latin1');
}

function rootLsciConfig(options) {
  return [
    `video = ${options.video}`,
    `keyboard = ${options.keyboard}`,
    `music = ${options.music}`,
    ' dll = graph256.dll',
    ' dll = nlnull.dll',
    ' pathStr = .\\',
    ' hostID = SIERRA',
    ' InterpSize = 174',
  ];
}

function configValue(line) {
  return line.slice(line.indexOf('=') + 1).trim();
}

function configKey(line) {
  return line.slice(0, line.indexOf('=')).trim().toLowerCase();
}

// "lsciget lsci.cfg sl\lsci.cfg -t video ..\ keyboard ..\ ..." copies entries, prefixing values.
function lsciGetTranslated(sourceLines, translations) {
  const result = [];
  for (const [key, prefix] of translations) {
    for (const line of sourceLines.filter((l) => l.includes('=') && configKey(l) === key)) {
      result.push(`${key} = ${prefix}${configValue(line)}`);
    }
  }
  return result;
}

function worldLsciConfig(rootLines) {
  const translations = [['video', '..\\'], ['keyboard', '..\\'], ['music', '..\\'], ['dll', '..\\']];
  return [
    ' pathStr = ..\\',
    ...lsciGetTranslated(rootLines, translations),
    ' hostID = SIERRA',
    ' InterpSize = 174',
  ];
}

function prepareDirectories(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  for (const dir of ['.', 'SL', 'LL', 'BARON', 'YSERBIUS', path.join('YSERBIUS', 'SAVE')]) {
    mkdirSync(path.join(outDir, dir), { recursive: true });
  }
}

function copyRootFiles(outDir, diskDir) {
  for (const item of ROOT_FILES) {
    const [from, to] = Array.isArray(item) ? item : [item, item];
    copyInto(path.join(diskDir, '1', from), outDir, to);
  }
  writeDosText(path.join(outDir, 'TSN.BAT'), ['@echo off', 'tsnexec DEFAULT']);
  puffFile(path.join(outDir, '_LNULL.DLL'));
  puffFile(path.join(outDir, '_RAPH256.DLL'));
}

function writeConfigs(outDir, options) {
  const rootLines = rootLsciConfig(options);
  writeDosText(path.join(outDir, 'LSCI.CFG'), rootLines);
  writeDosText(path.join(outDir, 'TSN.CFG'), [options.comm]);
  writeDosText(path.join(outDir, 'PASS_SET.DTA'), [options.passwordSetting]);
  for (const world of WORLD_CONFIGS) {
    writeDosText(path.join(outDir, world, 'LSCI.CFG'), worldLsciConfig(rootLines));
  }
}

function installDocumentation(outDir, diskDir) {
  for (const doc of DOC_FILES) {
    copyInto(path.join(diskDir, '4', doc), outDir);
  }
  puffAllIn(outDir, '.DOC');
  writeDosText(path.join(outDir, 'DOC.LST'), DOC_LIST);
}

function installPatches(outDir, diskDir) {
  for (const { from, to } of PATCH_DIRS) {
    const target = path.join(outDir, to);
    copyAllFiles(path.join(diskDir, '4', from), target);
    puffAllIn(target);
  }
}

export function install({ outDir = DEFAULT_OUT_DIR, diskDir = DISK_DIR, options = DEFAULT_OPTIONS } = {}) {
  prepareDirectories(outDir);
  copyRootFiles(outDir, diskDir);
  writeConfigs(outDir, options);
  defuse(outDir, videoSetForDriver(options.video), diskDir);
  puffAllIn(path.join(outDir, 'BARON'));
  copyInto(path.join(outDir, 'RBJOY.EXE'), path.join(outDir, 'BARON'));
  puffAllIn(path.join(outDir, 'YSERBIUS'));
  copyAllFiles(path.join(outDir, 'YSERBIUS', 'SAVE'), path.join(outDir, 'YSERBIUS'));
  installDocumentation(outDir, diskDir);
  installPatches(outDir, diskDir);
  return outDir;
}

function isRunDirectly() {
  return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isRunDirectly()) {
  const outDir = install();
  console.log(`Installed TSN into ${outDir}`);
}
