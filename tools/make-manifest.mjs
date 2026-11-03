#!/usr/bin/env node
// Write installed/INN/manifest.json for the browser front end (src/web/main.js):
// the root files it fetches, the files of LSCI land directories (those with a
// RESOURCE.MAP, e.g. SL and LL, run by TSN.PRG programs) and every directory name.
// Usage: node tools/make-manifest.mjs [installDir=installed/INN]
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILE_SIZE = 4 * 1024 * 1024;
const MANIFEST = 'manifest.json';
const LAND_MARKER = 'RESOURCE.MAP';

/** Files of an LSCI land directory as "SUB/NAME", or none for other directories. */
function landDirectoryFiles(dir, sub, isSmallFile) {
  const names = readdirSync(join(dir, sub));
  if (!names.some((name) => name.toUpperCase() === LAND_MARKER)) {
    return [];
  }
  return names.filter((name) => isSmallFile(join(dir, sub, name))).map((name) => `${sub}/${name}`);
}

function main() {
  const dir = process.argv[2] ?? join(ROOT, 'installed', 'INN');
  const entries = readdirSync(dir).filter((name) => name !== MANIFEST);
  const isDirectory = (name) => statSync(join(dir, name)).isDirectory();
  const isSmallFile = (path) => !statSync(path).isDirectory() && statSync(path).size <= MAX_FILE_SIZE;
  const directories = entries.filter(isDirectory);
  const landFiles = directories.flatMap((sub) => landDirectoryFiles(dir, sub, isSmallFile));
  const files = [...entries.filter((name) => isSmallFile(join(dir, name))), ...landFiles];
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify({ files, directories }, null, 1)}\n`);
  process.stdout.write(`${files.length} files, ${directories.length} directories -> ${join(dir, MANIFEST)}\n`);
}

main();
