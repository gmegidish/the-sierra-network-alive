// LSCI opcode semantics. Verified handler by handler against the PMachine in
// LSCITV.EXE (segment 0x7f7; dispatch table at DS:0x610). Differences from
// stock SCI (ScummVM engines/sci/engine/vm.cpp):
//  - 0x2d loadID / 0x3a pushID share the ldi / pushi handlers (the operand is
//    a block index the loader patched into a memory ID);
//  - `call` operand is a 16-bit code block ID (always a word), not an offset;
//  - `calle` is module (var), entry (byte), argBytes (byte);
//  - `class` / `super` take a class number resolved through the class table;
//  - pprev pushes the acc value saved by the last comparison.
// ldi/pushi byte operands are sign-extended (cbw); variable, property and
// call operands are zero-extended.

const WORD_MASK = 0xffff;
const VAR_BASE = 0x40;

/** Interpret a 16-bit value as signed. */
export function signed(value) {
  return value & 0x8000 ? value - 0x10000 : value;
}

function binary(interp, fn) {
  interp.acc = fn(interp.pop(), interp.acc) & WORD_MASK;
}

function compare(interp, fn) {
  const left = interp.pop();
  interp.prev = interp.acc;
  interp.acc = fn(left, interp.acc) ? 1 : 0;
}

function divide(interp, frame, remainder) {
  const left = signed(interp.pop());
  const right = signed(interp.acc);
  if (right === 0) {
    interp.host.log('error', `division by zero in code $${frame.codeId.toString(16)}`);
    interp.acc = 0;
    return;
  }
  const quotient = Math.trunc(left / right);
  interp.acc = (remainder ? left - quotient * right : quotient) & WORD_MASK;
}

function branch(interp, frame, small, condition) {
  const offset = interp.operand(frame, small, true);
  if (condition) {
    frame.pc += offset;
  }
}

/** Arithmetic and logic opcodes 0x00-0x16. Returns false if not handled. */
function executeAlu(interp, frame, opcode) {
  switch (opcode) {
    case 0x00: interp.acc ^= WORD_MASK; return true;
    case 0x01: binary(interp, (a, b) => a + b); return true;
    case 0x02: binary(interp, (a, b) => a - b); return true;
    case 0x03: binary(interp, (a, b) => Math.imul(signed(a), signed(b))); return true;
    case 0x04: divide(interp, frame, false); return true;
    case 0x05: divide(interp, frame, true); return true;
    case 0x06: binary(interp, (a, b) => a >>> (b & 0x1f)); return true;
    case 0x07: binary(interp, (a, b) => a << (b & 0x1f)); return true;
    case 0x08: binary(interp, (a, b) => a ^ b); return true;
    case 0x09: binary(interp, (a, b) => a & b); return true;
    case 0x0a: binary(interp, (a, b) => a | b); return true;
    case 0x0b: interp.acc = -interp.acc & WORD_MASK; return true;
    case 0x0c: interp.acc = interp.acc ? 0 : 1; return true;
    case 0x0d: compare(interp, (a, b) => a === b); return true;
    case 0x0e: compare(interp, (a, b) => a !== b); return true;
    case 0x0f: compare(interp, (a, b) => signed(a) > signed(b)); return true;
    case 0x10: compare(interp, (a, b) => signed(a) >= signed(b)); return true;
    case 0x11: compare(interp, (a, b) => signed(a) < signed(b)); return true;
    case 0x12: compare(interp, (a, b) => signed(a) <= signed(b)); return true;
    case 0x13: compare(interp, (a, b) => a > b); return true;
    case 0x14: compare(interp, (a, b) => a >= b); return true;
    case 0x15: compare(interp, (a, b) => a < b); return true;
    case 0x16: compare(interp, (a, b) => a <= b); return true;
    default: return false;
  }
}

/** Stack, branch and call opcodes 0x17-0x30. */
function executeControl(interp, frame, opcode, small) {
  switch (opcode) {
    case 0x17: branch(interp, frame, small, interp.acc !== 0); return true;
    case 0x18: branch(interp, frame, small, interp.acc === 0); return true;
    case 0x19: branch(interp, frame, small, true); return true;
    case 0x1a: case 0x2d: interp.acc = interp.operand(frame, small, true) & WORD_MASK; return true;
    case 0x1b: interp.push(interp.acc); return true;
    case 0x1c: case 0x3a: interp.push(interp.operand(frame, small, true)); return true;
    case 0x1d: interp.sp--; return true;
    case 0x1e: interp.push(interp.stack[interp.sp]); return true;
    case 0x1f: frame.temps = interp.sp + 1; interp.sp += interp.operand(frame, small); return true;
    case 0x20: {
      const codeId = interp.wordOperand(frame);
      interp.callLocal(codeId, interp.byteOperand(frame));
      return true;
    }
    case 0x21: {
      const number = interp.operand(frame, small);
      interp.callKernel(number, interp.byteOperand(frame));
      return true;
    }
    case 0x22: {
      const entry = interp.operand(frame, small);
      interp.callExport(0, entry, interp.byteOperand(frame));
      return true;
    }
    case 0x23: {
      const module = interp.operand(frame, small);
      const entry = interp.byteOperand(frame);
      interp.callExport(module, entry, interp.byteOperand(frame));
      return true;
    }
    case 0x24: interp.ret(); return true;
    case 0x25: interp.beginSend(interp.acc, interp.acc, interp.acc, interp.byteOperand(frame)); return true;
    case 0x28: interp.acc = interp.loader.classId(interp.operand(frame, small)); return true;
    case 0x2a: interp.beginSend(frame.self, frame.self, frame.self, interp.byteOperand(frame)); return true;
    case 0x2b: {
      const classId = interp.loader.classId(interp.operand(frame, small));
      interp.beginSend(frame.self, classId, frame.self, interp.byteOperand(frame));
      return true;
    }
    case 0x2c: pushRest(interp, frame, interp.operand(frame, small)); return true;
    // 1995 debug info (INN scripts): 0x26 line number, 0x27 module number; nothing to do.
    case 0x26: case 0x27: interp.operand(frame, small); return true;
    case 0x2e: interp.acc = frame.self; return true;
    case 0x30: interp.push(interp.prev); return true;
    default: return false;
  }
}

/** `&rest n`: push params n..argc and remember them for the next call. */
function pushRest(interp, frame, first) {
  const argc = interp.stack[frame.params];
  const count = Math.max(0, argc - first + 1);
  for (let i = 0; i < count; i++) {
    interp.push(interp.stack[frame.params + first + i]);
  }
  interp.restBytes += count * 2;
}

/** Property opcodes 0x31-0x38 (operand = byte offset into self). */
function executeProperty(interp, frame, opcode, small) {
  const offset = interp.operand(frame, small);
  const memory = interp.memory;
  const self = frame.self;
  switch (opcode) {
    case 0x31: interp.acc = memory.readWord(self, offset); return;
    case 0x32: memory.writeWord(self, offset, interp.acc); return;
    case 0x33: interp.push(memory.readWord(self, offset)); return;
    case 0x34: memory.writeWord(self, offset, interp.pop()); return;
    default: {
      const delta = opcode === 0x35 || opcode === 0x37 ? 1 : -1;
      const value = (memory.readWord(self, offset) + delta) & WORD_MASK;
      memory.writeWord(self, offset, value);
      if (opcode === 0x35 || opcode === 0x36) {
        interp.acc = value;
      } else {
        interp.push(value);
      }
    }
  }
}

function readVar(interp, frame, type, index) {
  switch (type) {
    case 0: return interp.memory.readWord(interp.globals, index * 2);
    case 1: return frame.locals ? interp.memory.readWord(frame.locals, index * 2) : 0;
    case 2: return interp.stack[frame.temps + index];
    default: return interp.stack[frame.params + index];
  }
}

function writeVar(interp, frame, type, index, value) {
  switch (type) {
    case 0: interp.memory.writeWord(interp.globals, index * 2, value); return;
    case 1:
      if (frame.locals) {
        interp.memory.writeWord(frame.locals, index * 2, value);
      }
      return;
    case 2: interp.stack[frame.temps + index] = value & WORD_MASK; return;
    default: interp.stack[frame.params + index] = value & WORD_MASK;
  }
}

/**
 * Variable opcodes 0x40-0x7f: bits 0-1 type (global, local, temp, param),
 * bit 2 result to stack, bit 3 indexed by acc, bits 4-5 load/store/inc/dec.
 */
function executeVariable(interp, frame, opcode, small) {
  const op = opcode - VAR_BASE;
  const type = op & 3;
  const toStack = (op & 4) !== 0;
  const indexed = (op & 8) !== 0;
  const action = op >> 4;
  const index = interp.operand(frame, small) + (indexed ? signed(interp.acc) : 0);
  if (action === 1) {
    const value = toStack || indexed ? interp.pop() : interp.acc;
    if (indexed && !toStack) {
      interp.acc = value;
    }
    writeVar(interp, frame, type, index, value);
    return;
  }
  let value = readVar(interp, frame, type, index);
  if (action >= 2) {
    value = (value + (action === 2 ? 1 : -1)) & WORD_MASK;
    writeVar(interp, frame, type, index, value);
  }
  if (toStack) {
    interp.push(value);
  } else {
    interp.acc = value;
  }
}

/**
 * Execute one decoded opcode.
 * @param {import('./interpreter.js').Interpreter} interp
 * @param {import('./interpreter.js').CodeFrame} frame
 */
export function executeOpcode(interp, frame, opcode, small) {
  if (opcode >= VAR_BASE) {
    executeVariable(interp, frame, opcode, small);
    return;
  }
  if (opcode >= 0x31 && opcode <= 0x38) {
    executeProperty(interp, frame, opcode, small);
    return;
  }
  if (opcode >= 0x3b && opcode <= 0x3e) {
    interp.push(opcode === 0x3e ? frame.self : opcode - 0x3b);
    return;
  }
  if (executeAlu(interp, frame, opcode) || executeControl(interp, frame, opcode, small)) {
    return;
  }
  interp.host.log('error', `bad opcode 0x${opcode.toString(16)} in code $${frame.codeId.toString(16)}`);
  interp.halted = true;
}
