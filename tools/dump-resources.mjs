#!/usr/bin/env node
// Dump every resource of TSN's root "CC" world (disk/1) into out/:
//   out/resources.txt         type, number, sizes, compression, source
//   out/pic/picN.png          visual plane (+ .priority.png / .control.png)
//   out/view/viewN.png        first cel of every loop
//   out/font/fontN.png        glyph sheet
//   out/text/textN.txt        text strings
//   out/vocab/*.txt           selectors, opcodes, class table, kernel names
//   out/module/N.txt          module block listing + disassembly
// Usage: node tools/dump-resources.mjs [gameDir] [outDir] [patchDir...]
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createResourceManager, RESOURCE_TYPE, resourceTypeName, decodePalette, decodeView, renderPic,
  decodeFont, decodeText, decodeSelectorNames, decodeOpcodeNames, decodeClassTable, VOCAB, KERNEL_NAMES,
} from '../src/resource/index.js';
import { encodePng } from './png.mjs';
import { planeToRgba, picToRgba, viewFirstCelsSheet, fontSheet } from './resource-images.mjs';
import { formatModuleListing } from './module-listing.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_GAME_DIR = join(ROOT, 'disk', '1');
const DEFAULT_OUT_DIR = join(ROOT, 'out');
const DEFAULT_PATCH_DIRS = [join(ROOT, 'disk', '4', 'CCPATCH')];
const SYSTEM_PALETTE = 999;

function loadPatchFiles(dirs) {
  return dirs.flatMap((dir) => readdirSync(dir).map((name) => ({ name, bytes: readFileSync(join(dir, name)) })));
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function formatListing(resources) {
  const header = 'type      number  packed  unpacked  compression  source';
  const rows = resources.map((r) => [
    resourceTypeName(r.type).padEnd(8),
    String(r.number).padStart(7),
    String(r.packedSize).padStart(7),
    String(r.unpackedSize).padStart(9),
    r.compression.padEnd(11),
    r.source === 'patch' ? `patch ${r.patchFile}` : `vol ${r.volume} @${r.offset}`,
  ].join('  '));
  return `${[header, ...rows].join('\n')}\n`;
}

function countByType(resources) {
  const counts = new Map();
  for (const r of resources) {
    counts.set(resourceTypeName(r.type), (counts.get(resourceTypeName(r.type)) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => `${type}=${count}`).join(' ');
}

function dumpPics(rm, outDir, basePalette) {
  for (const { number } of rm.list().filter((r) => r.type === RESOURCE_TYPE.PIC)) {
    const pic = renderPic(rm.get(RESOURCE_TYPE.PIC, number));
    const base = join(outDir, 'pic', `pic${number}`);
    writeFile(`${base}.png`, encodePng(pic.width, pic.height, picToRgba(pic, basePalette)));
    writeFile(`${base}.priority.png`, encodePng(pic.width, pic.height, planeToRgba(pic.priority)));
    writeFile(`${base}.control.png`, encodePng(pic.width, pic.height, planeToRgba(pic.control)));
  }
}

function dumpViews(rm, outDir, basePalette) {
  for (const { number } of rm.list().filter((r) => r.type === RESOURCE_TYPE.VIEW)) {
    const sheet = viewFirstCelsSheet(decodeView(rm.get(RESOURCE_TYPE.VIEW, number)), basePalette);
    if (sheet) {
      writeFile(join(outDir, 'view', `view${number}.png`), encodePng(sheet.width, sheet.height, sheet.rgba));
    }
  }
}

function dumpFonts(rm, outDir) {
  for (const { number } of rm.list().filter((r) => r.type === RESOURCE_TYPE.FONT)) {
    const sheet = fontSheet(decodeFont(rm.get(RESOURCE_TYPE.FONT, number)));
    writeFile(join(outDir, 'font', `font${number}.png`), encodePng(sheet.width, sheet.height, sheet.rgba));
  }
}

function dumpTexts(rm, outDir) {
  for (const { number } of rm.list().filter((r) => r.type === RESOURCE_TYPE.TEXT)) {
    const lines = decodeText(rm.get(RESOURCE_TYPE.TEXT, number)).map((s, i) => `${i}: ${JSON.stringify(s)}`);
    writeFile(join(outDir, 'text', `text${number}.txt`), `${lines.join('\n')}\n`);
  }
}

function numberedLines(values) {
  return `${values.map((value, index) => `${index}\t${value}`).join('\n')}\n`;
}

function dumpVocabs(rm, outDir) {
  const selectors = decodeSelectorNames(rm.get(RESOURCE_TYPE.VOCAB, VOCAB.SELECTORS));
  const opcodes = decodeOpcodeNames(rm.get(RESOURCE_TYPE.VOCAB, VOCAB.OPCODES));
  const classes = decodeClassTable(rm.get(RESOURCE_TYPE.VOCAB, VOCAB.CLASS_TABLE));
  writeFile(join(outDir, 'vocab', 'selectors.txt'), numberedLines(selectors));
  writeFile(join(outDir, 'vocab', 'opcodes.txt'), numberedLines(opcodes.map((op) => op.name)));
  writeFile(join(outDir, 'vocab', 'classes.txt'), numberedLines(classes.map((module) => `module ${module}`)));
  writeFile(join(outDir, 'vocab', 'kernel.txt'), numberedLines(KERNEL_NAMES));
  return { selectors, opcodes };
}

function dumpModules(rm, outDir, names) {
  for (const { number } of rm.list().filter((r) => r.type === RESOURCE_TYPE.MODULE)) {
    writeFile(join(outDir, 'module', `${number}.txt`), formatModuleListing(rm.get(RESOURCE_TYPE.MODULE, number), names));
  }
}

function main() {
  const [gameDir = DEFAULT_GAME_DIR, outDir = DEFAULT_OUT_DIR, ...patchArgs] = process.argv.slice(2);
  const patchDirs = patchArgs.length ? patchArgs : DEFAULT_PATCH_DIRS;
  const rm = createResourceManager({
    map: readFileSync(join(gameDir, 'RESOURCE.MAP')),
    volumes: { 1: readFileSync(join(gameDir, 'RESOURCE.001')) },
    patches: loadPatchFiles(patchDirs),
  });
  const resources = rm.list();
  for (const r of resources) {
    rm.get(r.type, r.number);
  }
  writeFile(join(outDir, 'resources.txt'), formatListing(resources));
  const basePalette = decodePalette(rm.get(RESOURCE_TYPE.PALETTE, SYSTEM_PALETTE));
  dumpPics(rm, outDir, basePalette);
  dumpViews(rm, outDir, basePalette);
  dumpFonts(rm, outDir);
  dumpTexts(rm, outDir);
  dumpModules(rm, outDir, dumpVocabs(rm, outDir));
  process.stdout.write(`${resources.length} resources (${countByType(resources)}) -> ${outDir}\n`);
}

main();
