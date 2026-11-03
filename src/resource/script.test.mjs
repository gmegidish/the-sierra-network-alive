import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESOURCE_TYPE } from './types.js';
import { parseModule, decodeObjectBlock, BLOCK_KIND } from './module.js';
import { decodeCodeBlock, OPCODE } from './disasm.js';
import { decodeSelectorNames, decodeOpcodeNames, decodeClassTable, VOCAB } from './vocab.js';
import { decodeText } from './text.js';
import { KERNEL_NAMES } from './kernel-names.js';
import { openCcWorld, resourcesOfType } from './test-helpers.mjs';

const OBJ_CLASS_MODULE = 60000;
const COMM_MODULE = 101;
const TSN_KERNEL = 84;

function parseEveryModule(rm) {
  return resourcesOfType(rm, RESOURCE_TYPE.MODULE).map((r) => ({ number: r.number, module: parseModule(rm.get(RESOURCE_TYPE.MODULE, r.number)) }));
}

function codeBlocksOf(module) {
  return module.blocks.filter((block) => block.kind === BLOCK_KIND.CODE);
}

function decodedLengthOf(code) {
  return decodeCodeBlock(code).reduce((sum, instruction) => sum + instruction.size, 0);
}

function kernelCallsIn(module) {
  return codeBlocksOf(module)
    .flatMap((block) => decodeCodeBlock(block.data))
    .filter((instruction) => instruction.opcode === OPCODE.CALLK)
    .map((instruction) => instruction.operands[0]);
}

test('every module (including the 130.SO patch) parses exactly to end of data', () => {
  assert.equal(parseEveryModule(openCcWorld()).length, 129);
});

test('every code block disassembles into whole instructions', () => {
  for (const { number, module } of parseEveryModule(openCcWorld())) {
    for (const block of codeBlocksOf(module)) {
      assert.equal(decodedLengthOf(block.data), block.data.length, `module ${number} block ${block.index}`);
    }
  }
});

test('every object and class block matches the properties + method table layout', () => {
  for (const { number, module } of parseEveryModule(openCcWorld())) {
    for (const block of module.blocks.filter((b) => b.kind === BLOCK_KIND.OBJECT || b.kind === BLOCK_KIND.CLASS)) {
      const { properties, methods } = decodeObjectBlock(block);
      assert.equal((properties.length + 1 + methods.length * 2) * 2, block.data.length, `module ${number} block ${block.index}`);
      assert.ok(methods.every((m) => module.blocks[m.codeBlock].kind === BLOCK_KIND.CODE));
    }
  }
});

test('module 60000 defines class Obj whose new method calls kernel ObjectNew', () => {
  const module = parseModule(openCcWorld().get(RESOURCE_TYPE.MODULE, OBJ_CLASS_MODULE));
  assert.equal(module.blocks[0].text, 'Obj');
  assert.ok(kernelCallsIn(module).includes(KERNEL_NAMES.indexOf('ObjectNew')));
});

test('the communications module 101 calls the TSN kernel function', () => {
  const module = parseModule(openCcWorld().get(RESOURCE_TYPE.MODULE, COMM_MODULE));
  assert.equal(KERNEL_NAMES[TSN_KERNEL], 'TSN');
  assert.ok(kernelCallsIn(module).includes(TSN_KERNEL));
  assert.ok(module.blocks.some((block) => block.text === 'ATDT'));
});

test('selector vocabulary starts with the object header properties', () => {
  const selectors = decodeSelectorNames(openCcWorld().get(RESOURCE_TYPE.VOCAB, VOCAB.SELECTORS));
  assert.deepEqual(selectors.slice(0, 6), ['-env-', '-size-', '-dict-', '-super-', '-info-', 'name']);
});

test('opcode vocabulary names 0x2d loadID and 0x3a pushID (LSCI specific)', () => {
  const opcodes = decodeOpcodeNames(openCcWorld().get(RESOURCE_TYPE.VOCAB, VOCAB.OPCODES));
  assert.equal(opcodes.length, 128);
  assert.equal(opcodes[OPCODE.LOAD_ID].name, 'loadID');
  assert.equal(opcodes[OPCODE.PUSH_ID].name, 'pushID');
});

test('class table maps class 0 to module 60000', () => {
  const classes = decodeClassTable(openCcWorld().get(RESOURCE_TYPE.VOCAB, VOCAB.CLASS_TABLE));
  assert.equal(classes[0], OBJ_CLASS_MODULE);
});

test('text 500 holds English help strings', () => {
  const strings = decodeText(openCcWorld().get(RESOURCE_TYPE.TEXT, 500));
  assert.match(strings[0], /Select this button/);
});
