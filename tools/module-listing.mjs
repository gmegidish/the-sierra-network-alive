// Human-readable listing of an LSCI module: blocks, strings, objects and disassembly.
import {
  parseModule, decodeObjectBlock, decodeCodeBlock, formatInstruction, BLOCK_KIND, OPCODE, KERNEL_NAMES,
} from '../src/resource/index.js';

const MAX_STRING_PREVIEW = 60;

function describeIdOperand(blocks, index) {
  const block = blocks[index];
  if (!block) {
    return `block ${index}?`;
  }
  if (block.text !== undefined) {
    return JSON.stringify(block.text.slice(0, MAX_STRING_PREVIEW));
  }
  return `${block.kindName} #${index}`;
}

function listObject(block, names) {
  const { properties, methods } = decodeObjectBlock(block);
  const lines = [`  properties: ${properties.map((value) => value.toString(16)).join(' ')}`];
  for (const method of methods) {
    lines.push(`  method ${names.selectors[method.selector] ?? method.selector} -> block ${method.codeBlock}`);
  }
  return lines;
}

function listCode(block, blocks, names) {
  return decodeCodeBlock(block.data).map((instruction) => {
    const text = formatInstruction(instruction, names.opcodes, KERNEL_NAMES);
    const isIdReference = instruction.opcode === OPCODE.LOAD_ID || instruction.opcode === OPCODE.PUSH_ID;
    return `  ${text}${isIdReference ? `   ; ${describeIdOperand(blocks, instruction.operands[0])}` : ''}`;
  });
}

/**
 * @param {Uint8Array} data module resource
 * @param {{ selectors: string[], opcodes: { name: string }[] }} names
 * @returns {string}
 */
export function formatModuleListing(data, names) {
  const { blocks } = parseModule(data);
  const lines = [];
  for (const block of blocks) {
    const fixups = block.fixups.length ? ` fixups=[${block.fixups.join(',')}]` : '';
    lines.push(`-- block ${block.index} ${block.kindName} size=${block.data.length}${fixups}`);
    if (block.text !== undefined) {
      lines.push(`  ${JSON.stringify(block.text)}`);
    } else if (block.kind === BLOCK_KIND.OBJECT || block.kind === BLOCK_KIND.CLASS) {
      lines.push(...listObject(block, names));
    } else if (block.kind === BLOCK_KIND.CODE) {
      lines.push(...listCode(block, blocks, names));
    } else {
      lines.push(`  ${Buffer.from(block.data).toString('hex').replace(/(.{4})/g, '$1 ').trim()}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
