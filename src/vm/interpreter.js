// LSCI PMachine: frames, calls and message sends.
//
// Ground truth: segment 0x7f7 of the unpacked LSCITV.EXE (threaded dispatch
// `lodsb; and bx,0xfe; jmp [bx+0x610]`). The real machine recurses on the C
// stack; here every call/send pushes an explicit frame so execution can be
// paused at any instruction (needed to yield to the browser).
//
// Registers (DS offsets in the EXE): acc 0x50a, globals 0x50c (module 0
// variables), locals 0x50e/0x800, params 0x7ec (points at argc), temps 0x7f0,
// &rest byte count 0x7f4, current code ID 0x7fc, self 0x802. The stack grows
// upward; "sp" here is the index of the top word.
import { executeOpcode } from './opcodes.js';
import { OBJ, ENV } from './loader.js';

export const STACK_WORDS = 0x4000;
const WORD_MASK = 0xffff;

/**
 * @typedef {{ type: 'code', codeId: number, code: Uint8Array, pc: number, self: number,
 *   locals: number, params: number, temps: number, popTo: number }} CodeFrame
 *   popTo: sp after `ret` (-2 = leave sp alone: method frames, the send frame restores it)
 * @typedef {{ type: 'send', self: number, lookup: number, locals: number, pos: number,
 *   end: number, restoreSp: number, rest: number }} SendFrame
 * @typedef {{ log: (kind: string, message: string) => void, callKernel: (n: number, args: number[]) => (number | undefined),
 *   selectorName: (n: number) => string }} InterpreterHost
 */

export class VmError extends Error {}

export class Interpreter {
  /**
   * @param {import('./memory.js').Memory} memory
   * @param {import('./loader.js').ModuleLoader} loader
   * @param {import('./objects.js').ObjectModel} objects
   * @param {InterpreterHost} host
   */
  constructor(memory, loader, objects, host) {
    this.memory = memory;
    this.loader = loader;
    this.objects = objects;
    this.host = host;
    this.stack = new Uint16Array(STACK_WORDS);
    this.sp = -1;
    this.acc = 0;
    this.prev = 0;
    this.restBytes = 0;
    /** @type {(CodeFrame | SendFrame)[]} */
    this.frames = [];
    this.globals = 0;
    this.yieldRequested = false;
    this.halted = false;
    this.instructionCount = 0;
  }

  push(value) {
    this.stack[++this.sp] = value & WORD_MASK;
  }

  pop() {
    return this.stack[this.sp--];
  }

  /** @returns {CodeFrame} */
  get frame() {
    return /** @type {CodeFrame} */ (this.frames[this.frames.length - 1]);
  }

  /** Current self (0 when no frame). */
  get self() {
    return this.frames.length ? this.frames[this.frames.length - 1].self : 0;
  }

  // ---- code frames -----------------------------------------------------

  pushCodeFrame(codeId, self, locals, params, popTo) {
    if (!this.memory.isValid(codeId)) {
      throw new VmError(`call to invalid code ID $${codeId.toString(16)}`);
    }
    this.frames.push({
      type: 'code', codeId, code: this.memory.bytes(codeId), pc: 0, self, locals, params, temps: this.sp + 1, popTo,
    });
  }

  /** Stack index of argc for a call whose arguments (argBytes + &rest) are on top. */
  takeParams(argBytes) {
    const params = this.sp - argBytes / 2 - this.restBytes / 2;
    this.stack[params] += this.restBytes / 2;
    this.restBytes = 0;
    return params;
  }

  /** `call codeId argBytes`: local procedure, same self and locals. */
  callLocal(codeId, argBytes) {
    const current = this.frame;
    const params = this.takeParams(argBytes);
    this.pushCodeFrame(codeId, current.self, current.locals, params, params - 1);
  }

  /** `callb` / `calle`: exported procedure; locals become the module's variables. */
  callExport(module, entry, argBytes) {
    const codeId = this.loader.exportOf(module, entry);
    const locals = this.loader.variablesOf(module);
    const params = this.takeParams(argBytes);
    this.pushCodeFrame(codeId, this.frame.self, locals, params, params - 1);
  }

  callKernel(number, argBytes) {
    const params = this.takeParams(argBytes);
    const argc = this.stack[params];
    const args = Array.from(this.stack.subarray(params + 1, params + 1 + argc));
    const result = this.host.callKernel(number, args);
    this.sp = params - 1;
    if (result !== undefined) {
      this.acc = result & WORD_MASK;
    }
  }

  ret() {
    const done = /** @type {CodeFrame} */ (this.frames.pop());
    if (done.popTo !== -2) {
      this.sp = done.popTo;
    }
    this.continueSendIfAny();
  }

  // ---- sends -----------------------------------------------------------

  /**
   * Start a send whose messages (selector, argc, args...) occupy the top
   * `argBytes` bytes of the stack (+ pending &rest words).
   */
  beginSend(receiver, lookup, self, argBytes) {
    const words = (argBytes + this.restBytes) / 2;
    const restoreSp = this.sp - words;
    const rest = this.restBytes / 2;
    this.restBytes = 0;
    if (!this.objects.isObject(lookup)) {
      this.host.log('error', `send to non-object $${lookup.toString(16)} (${this.describeMessage(restoreSp + 1)})`);
      this.sp = restoreSp;
      return;
    }
    const env = this.memory.readWord(receiver, OBJ.ENV);
    const locals = this.memory.isValid(env) ? this.memory.readWord(env, ENV.VARIABLES) : 0;
    this.frames.push({ type: 'send', self, lookup, locals, pos: restoreSp + 1, end: this.sp, restoreSp, rest });
    this.continueSendIfAny();
  }

  describeMessage(pos) {
    return `selector ${this.host.selectorName(this.stack[pos])}`;
  }

  /** Process messages of the send frame on top until a method has to run. */
  continueSendIfAny() {
    let top = this.frames[this.frames.length - 1];
    while (top && top.type === 'send') {
      if (top.pos > top.end) {
        this.frames.pop();
        this.sp = top.restoreSp;
        top = this.frames[this.frames.length - 1];
        if (top && top.type === 'send') {
          continue;
        }
        return;
      }
      if (this.dispatchMessage(top)) {
        return;
      }
    }
  }

  /** @param {SendFrame} send @returns {boolean} true when a method frame was pushed */
  dispatchMessage(send) {
    const selector = this.stack[send.pos];
    const params = send.pos + 1;
    const argc = this.stack[params] + send.rest;
    this.stack[params] = argc;
    send.rest = 0;
    send.pos = params + argc + 1;
    const target = this.objects.resolve(send.lookup, selector);
    if (target.kind === 'property') {
      this.accessProperty(send.lookup, target.offset, argc, params);
      return false;
    }
    if (target.kind === 'missing') {
      this.host.log('error', `$${send.lookup.toString(16)} ${this.objectName(send.lookup)} does not understand ${this.host.selectorName(selector)}`);
      return false;
    }
    this.frames.push({
      type: 'code', codeId: target.codeId, code: this.memory.bytes(target.codeId), pc: 0,
      self: send.self, locals: send.locals, params, temps: this.sp + 1, popTo: -2,
    });
    return true;
  }

  accessProperty(object, offset, argc, params) {
    if (argc === 0) {
      this.acc = this.memory.readWord(object, offset);
    } else {
      this.memory.writeWord(object, offset, this.stack[params + 1]);
    }
  }

  objectName(id) {
    const nameId = this.memory.readWord(id, OBJ.NAME);
    if (!this.memory.isValid(nameId)) {
      return '?';
    }
    const bytes = this.memory.bytes(nameId);
    let text = '';
    for (let i = 4; i < bytes.length && bytes[i]; i++) {
      text += String.fromCharCode(bytes[i]);
    }
    return text;
  }

  // ---- running ---------------------------------------------------------

  /** Queue a message send from outside the bytecode (game start). */
  startSend(object, selector, args = []) {
    this.push(selector);
    this.push(args.length);
    args.forEach((value) => this.push(value));
    this.beginSend(object, object, object, (args.length + 2) * 2);
  }

  /**
   * Synchronously run `object selector: args...` (kernel -> script callbacks,
   * InvokeMethod). Returns acc.
   */
  invoke(object, selector, args = []) {
    const depth = this.frames.length;
    this.startSend(object, selector, args);
    while (this.frames.length > depth && !this.halted) {
      this.step();
    }
    return this.acc;
  }

  /** Run up to `budget` instructions or until a kernel asks to yield. */
  run(budget) {
    this.yieldRequested = false;
    let remaining = budget;
    while (remaining-- > 0 && this.frames.length && !this.yieldRequested && !this.halted) {
      this.step();
    }
    if (!this.frames.length) {
      this.halted = true;
    }
    return budget - remaining - 1;
  }

  step() {
    const frame = this.frame;
    const byte = frame.code[frame.pc++];
    if (byte === undefined) {
      this.host.log('error', `ran off the end of code $${frame.codeId.toString(16)}`);
      this.ret();
      return;
    }
    this.instructionCount++;
    executeOpcode(this, frame, byte >> 1, (byte & 1) === 1);
  }

  /** Read an operand: `small` selects byte vs word; signed bytes sign-extend. */
  operand(frame, small, signed = false) {
    const code = frame.code;
    if (small) {
      const value = code[frame.pc++];
      return signed && value & 0x80 ? value - 0x100 : value;
    }
    const value = code[frame.pc] | (code[frame.pc + 1] << 8);
    frame.pc += 2;
    return signed && value & 0x8000 ? value - 0x10000 : value;
  }

  byteOperand(frame) {
    return frame.code[frame.pc++];
  }

  wordOperand(frame) {
    const value = frame.code[frame.pc] | (frame.code[frame.pc + 1] << 8);
    frame.pc += 2;
    return value;
  }
}
