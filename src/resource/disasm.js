// PMachine bytecode decoder for LSCI code blocks.
// Operand layout follows ScummVM engines/sci/engine/kernel_tables.h
// (g_base_opcode_formats). Opcode byte = (opcode << 1) | smallOperands: when
// the low bit is set, "variable" operands are 1 byte, otherwise 2 bytes.
// LSCI differences (from vocab.998 names): 0x2d is loadID and 0x3a is pushID,
// both taking a single variable-size operand (a block index, see module.js);
// 0x39 (stock lofsa) and 0x3f (stock line) are unused.
// Verified against the PMachine in LSCITV.EXE (segment 0x7f7 of the unpacked
// image): `call` always reads a 16-bit code block ID (not a relative offset)
// plus an arg-byte count, and `calle` reads module (var), entry (byte),
// arg bytes (byte).

const V = 'var'; // byte or word depending on the low opcode bit
const R = 'rel'; // signed byte or word, relative branch
const B = 'byte'; // always one byte
const W = 'word'; // always two bytes (LSCI `call` takes a code block ID)

const NONE = [];
const FORMATS = (() => {
  const formats = Array.from({ length: 128 }, () => NONE);
  const set = (op, operands) => {
    formats[op] = operands;
  };
  [0x17, 0x18, 0x19].forEach((op) => set(op, [R])); // bt bnt jmp
  [0x1a, 0x1c, 0x1f].forEach((op) => set(op, [V])); // ldi pushi link
  set(0x20, [W, B]); // call codeBlockId argBytes
  set(0x21, [V, B]); // callk
  set(0x22, [V, B]); // callb
  set(0x23, [V, B, B]); // calle module entry argBytes
  set(0x25, [B]); // send
  set(0x28, [V]); // class
  set(0x2a, [B]); // self
  set(0x2b, [V, B]); // super
  set(0x2c, [V]); // &rest
  set(0x2d, [V]); // loadID
  for (let op = 0x31; op <= 0x38; op++) {
    set(op, [V]); // property access
  }
  set(0x3a, [V]); // pushID
  for (let op = 0x40; op <= 0x7f; op++) {
    set(op, [V]); // load / store / inc / dec of variables
  }
  return Object.freeze(formats);
})();

export const OPCODE = Object.freeze({
  RET: 0x24,
  CALLK: 0x21,
  LOAD_ID: 0x2d,
  PUSH_ID: 0x3a,
});

function readOperand(code, pos, kind, small) {
  if (kind === W) {
    return { value: code[pos] | (code[pos + 1] << 8), size: 2 };
  }
  if (kind === B || small) {
    const value = code[pos];
    return { value: kind === R ? (value << 24) >> 24 : value, size: 1 };
  }
  const value = code[pos] | (code[pos + 1] << 8);
  return { value: kind === R ? (value << 16) >> 16 : value, size: 2 };
}

/**
 * Decode one instruction.
 * @param {Uint8Array} code
 * @param {number} pc
 * @returns {{ pc: number, opcode: number, operands: number[], size: number }}
 */
export function decodeInstruction(code, pc) {
  const byte = code[pc];
  const opcode = byte >> 1;
  const small = (byte & 1) === 1;
  let pos = pc + 1;
  const operands = [];
  for (const kind of FORMATS[opcode]) {
    const { value, size } = readOperand(code, pos, kind, small);
    operands.push(value);
    pos += size;
  }
  return { pc, opcode, operands, size: pos - pc };
}

/**
 * Decode a whole code block linearly.
 * @param {Uint8Array} code
 */
export function decodeCodeBlock(code) {
  const instructions = [];
  let pc = 0;
  while (pc < code.length) {
    const instruction = decodeInstruction(code, pc);
    instructions.push(instruction);
    pc += instruction.size;
  }
  return instructions;
}

/**
 * Format an instruction using opcode names from vocab.998.
 * @param {{ opcode: number, operands: number[], pc: number }} instruction
 * @param {{ name: string }[]} opcodeNames
 * @param {string[]} [kernelNames]
 */
export function formatInstruction(instruction, opcodeNames, kernelNames = []) {
  const name = opcodeNames[instruction.opcode]?.name || `op${instruction.opcode.toString(16)}`;
  const operands = instruction.operands.map((value, index) => {
    if (instruction.opcode === OPCODE.CALLK && index === 0) {
      return kernelNames[value] ?? `k${value}`;
    }
    return String(value);
  });
  return `${instruction.pc.toString(16).padStart(4, '0')}: ${name} ${operands.join(' ')}`.trimEnd();
}
