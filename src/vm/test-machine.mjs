// Test support: a bare interpreter (no game resources) plus helpers to build
// hand-assembled code blocks and objects. Used by the *.test.mjs files only.
import { Memory, MEMORY_TYPE } from './memory.js';
import { ObjectModel, INFO_CLASS } from './objects.js';
import { Interpreter } from './interpreter.js';

/**
 * @typedef {{ properties?: Record<number, number>, methods?: Record<number, number>,
 *   superId?: number, isClass?: boolean }} ObjectSpec
 *   properties: selector -> value (after the 6 header properties); methods: selector -> code ID
 */

const HEADER_SELECTORS = Object.freeze([0xfff0, 0xfff1, 0xfff2, 0xfff3, 0xfff4, 0xfff5]);
const BUDGET = 100000;

/** Opcode byte with a byte-sized operand (`op << 1 | 1`). */
export const small = (op) => (op << 1) | 1;
/** Opcode byte with no operand / word operand (`op << 1`). */
export const plain = (op) => op << 1;

export function createMachine() {
  const memory = new Memory();
  const objects = new ObjectModel(memory);
  const kernelCalls = [];
  const logs = [];
  const interp = new Interpreter(memory, /** @type {any} */ ({}), objects, {
    log: (kind, message) => logs.push(`${kind}: ${message}`),
    callKernel: (number, args) => {
      kernelCalls.push({ number, args });
      return args.reduce((sum, value) => sum + value, 0);
    },
    selectorName: (number) => `sel${number}`,
  });
  return { memory, objects, interp, kernelCalls, logs };
}

/** Store bytes as a code block and return its ID. */
export function codeBlock(machine, bytes) {
  return machine.memory.alloc(MEMORY_TYPE.CODE, Uint8Array.from(bytes));
}

/** Run a procedure with `args` and return acc. */
export function runProcedure(machine, codeId, args = []) {
  const { interp } = machine;
  interp.push(args.length);
  args.forEach((value) => interp.push(value));
  const params = interp.sp - args.length;
  interp.pushCodeFrame(codeId, 0, 0, params, params - 1);
  interp.run(BUDGET);
  return interp.acc;
}

/** Build an object (or class) with the given properties and methods. */
export function makeObject(machine, spec) {
  const { memory } = machine;
  const propertySelectors = Object.keys(spec.properties ?? {}).map(Number);
  const selectors = [...HEADER_SELECTORS, ...propertySelectors];
  const dict = memory.alloc(MEMORY_TYPE.PROPDICT, selectors.length * 2);
  selectors.forEach((selector, i) => memory.writeWord(dict, i * 2, selector));
  const methods = Object.entries(spec.methods ?? {}).map(([selector, codeId]) => [Number(selector), codeId]);
  const words = [
    0, selectors.length, dict, spec.superId ?? 0, spec.isClass ? INFO_CLASS : 0, 0,
    ...propertySelectors.map((selector) => spec.properties[selector]),
    methods.length, ...methods.map(([selector]) => selector), ...methods.map(([, codeId]) => codeId),
  ];
  const id = memory.alloc(MEMORY_TYPE.OBJECT, words.length * 2);
  words.forEach((value, i) => memory.writeWord(id, i * 2, value));
  return id;
}

/** Send `selector: args` to `object` and return acc. */
export function sendMessage(machine, object, selector, args = []) {
  return machine.interp.invoke(object, selector, args);
}
