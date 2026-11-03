import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVmFromDirectory } from '../node-loader.mjs';
import { arrayKernels } from './arrays.js';

const INSTALL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'installed', 'TSN');
const ARRAY_COMPARE = 7;
const NOT_FOUND = 255;

const vm = createVmFromDirectory(INSTALL_DIR, { now: () => Date.UTC(1993, 0, 15, 20) });

function regionsMatch(text, at, other) {
  const a = vm.strings.create(text);
  const b = vm.strings.create(other);
  return arrayKernels.Array(vm, [ARRAY_COMPARE, a, at, b, 0, other.length]);
}

/** String::strIndex as module 60001 block 16 does it: slide compToFrom along the text. */
function strIndex(text, other) {
  for (let at = 0; at <= text.length - other.length; at += 1) {
    if (regionsMatch(text, at, other)) {
      return at;
    }
  }
  return NOT_FOUND;
}

test('Array sub-op 7 compares two regions instead of copying', () => {
  assert.equal(regionsMatch('VGA320.DRV', 0, 'VGA'), 1);
  assert.equal(regionsMatch('VGA320.DRV', 0, 'ega'), 0);
});

test('a VGA install is not mistaken for EGA when entering MedievaLand', () => {
  assert.equal(strIndex('VGA320.DRV', 'ega'), NOT_FOUND);
  assert.equal(strIndex('VGA320.DRV', 'EGA'), NOT_FOUND);
});

test('an EGA install is still detected as EGA', () => {
  assert.equal(strIndex('EGA640.DRV', 'EGA'), 0);
});
