#!/usr/bin/env node
// Dump every resource of one INN world (installed/INN/CC, LL or SL: its map
// over its RESOURCE.001 and the root RESOURCE.002, patches applied) into out/:
//   out/resources.txt         type, number, sizes, compression, source
//   out/pic/picN.png          visual plane (+ .priority.png / .control.png)
//   out/view/viewN.png        first cel of every loop
//   out/font/fontN.png        glyph sheet
//   out/text/textN.txt        text strings
//   out/vocab/*.txt           selectors, opcodes, class table, kernel names
//   out/module/N.txt          module block listing + disassembly
// Usage: node tools/dump-resources.mjs [world=CC] [outDir=out (CC) or out/<world>]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESOURCE_TYPE, resourceTypeName, decodePalette, decodeView, renderPic,
  decodeFont, decodeText, decodeSelectorNames, decodeOpcodeNames, decodeClassTable, VOCAB, KERNEL_NAMES,
} from '../src/resource/index.js';
import { encodePng } from './png.mjs';
import { planeToRgba, picToRgba, viewFirstCelsSheet, fontSheet } from './resource-images.mjs';
import { formatModuleListing } from './module-listing.mjs';
import { readTree } from '../src/vm/node-loader.mjs';
import { createProgramResources } from '../src/vm/programs.js';
import { FileSystem } from '../src/vm/filesystem.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_DIR = join(ROOT, 'installed', 'INN');
const DEFAULT_WORLD = 'CC';
const SYSTEM_PALETTE = 999;

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

/** SierraLand's pics 952-972 start "NN 80 00 00 00 00", some other format (like sounds 728/729). */
function renderPicOrSkip(rm, number) {
  try {
    return renderPic(rm.get(RESOURCE_TYPE.PIC, number));
  } catch (error) {
    process.stderr.write(`pic ${number}: ${error.message} (skipped)\n`);
    return null;
  }
}

function dumpPics(rm, outDir, basePalette) {
  for (const { number } of rm.list().filter((r) => r.type === RESOURCE_TYPE.PIC)) {
    const pic = renderPicOrSkip(rm, number);
    if (!pic) {
      continue;
    }
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
    // Module numbers 1904+ in LL are views 6000+ (16-bit resource ids wrap), not modules.
    try {
      writeFile(join(outDir, 'module', `${number}.txt`), formatModuleListing(rm.get(RESOURCE_TYPE.MODULE, number), names));
    } catch (error) {
      process.stderr.write(`module ${number}: ${error.message} (skipped)\n`);
    }
  }
}

function main() {
  const [world = DEFAULT_WORLD, outArg] = process.argv.slice(2);
  const outDir = outArg ?? (world === DEFAULT_WORLD ? join(ROOT, 'out') : join(ROOT, 'out', world));
  const rm = createProgramResources(new FileSystem(readTree(INSTALL_DIR)), world);
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
