// Opcode semantics on hand-assembled bytecode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine, codeBlock, runProcedure, small, plain } from './test-machine.mjs';

const OP = Object.freeze({
  ADD: 0x01, SUB: 0x02, MUL: 0x03, DIV: 0x04, SHL: 0x07, LT: 0x11, BT: 0x17, BNT: 0x18, JMP: 0x19,
  LDI: 0x1a, PUSH: 0x1b, PUSHI: 0x1c, DUP: 0x1e, LINK: 0x1f, CALL: 0x20, CALLK: 0x21, RET: 0x24, PPREV: 0x30,
  LAT: 0x42, LAP: 0x43, SAT: 0x52, INC_AT: 0x62,
});

const loadImmediate = (value) => [small(OP.LDI), value & 0xff];
const pushImmediate = (value) => [small(OP.PUSHI), value & 0xff];
const pushAcc = () => [plain(OP.PUSH)];
const ret = () => [plain(OP.RET)];

function evaluate(bytes, args = []) {
  const machine = createMachine();
  return { machine, result: runProcedure(machine, codeBlock(machine, bytes), args) };
}

test('binary operators take the stack top as the left operand and acc as the right', () => {
  assert.equal(evaluate([...loadImmediate(10), ...pushAcc(), ...loadImmediate(3), plain(OP.SUB), ...ret()]).result, 7);
  assert.equal(evaluate([...loadImmediate(6), ...pushAcc(), ...loadImmediate(7), plain(OP.MUL), ...ret()]).result, 42);
  assert.equal(evaluate([...loadImmediate(1), ...pushAcc(), ...loadImmediate(4), plain(OP.SHL), ...ret()]).result, 16);
});

test('ldi sign-extends a byte operand', () => {
  assert.equal(evaluate([...loadImmediate(-1), ...ret()]).result, 0xffff);
});

test('signed division truncates toward zero and division by zero logs an error', () => {
  assert.equal(evaluate([...loadImmediate(-7), ...pushAcc(), ...loadImmediate(2), plain(OP.DIV), ...ret()]).result, 0xfffd);
  const { machine, result } = evaluate([...loadImmediate(5), ...pushAcc(), ...loadImmediate(0), plain(OP.DIV), ...ret()]);
  assert.equal(result, 0);
  assert.match(machine.logs[0], /division by zero/);
});

test('a comparison leaves its result in acc and pprev pushes the previous acc', () => {
  const bytes = [...pushImmediate(2), ...loadImmediate(5), plain(OP.LT), plain(OP.PPREV), plain(OP.ADD), ...ret()];
  const PREVIOUS_ACC = 5;
  const COMPARISON_RESULT = 1;
  assert.equal(evaluate(bytes).result, PREVIOUS_ACC + COMPARISON_RESULT);
});

test('a temp-variable loop counts to five', () => {
  // link 1; ldi 0; sat 0; loop: +at 0; push; ldi 5; lt?; bt loop; lat 0; ret
  const loopBody = [small(OP.INC_AT), 0, ...pushAcc(), ...loadImmediate(5), plain(OP.LT)];
  const backOffset = -(loopBody.length + 2);
  const bytes = [
    small(OP.LINK), 1, ...loadImmediate(0), small(OP.SAT), 0,
    ...loopBody, small(OP.BT), backOffset & 0xff, small(OP.LAT), 0, ...ret(),
  ];
  assert.equal(evaluate(bytes).result, 5);
});

test('lap reads parameters by index, 0 being argc', () => {
  const bytes = [small(OP.LAP), 1, ...pushAcc(), small(OP.LAP), 2, plain(OP.ADD), ...pushAcc(), small(OP.LAP), 0, plain(OP.ADD), ...ret()];
  assert.equal(evaluate(bytes, [30, 12]).result, 44);
});

// argBytes counts the arguments only, not the argc word.
test('callk passes its arguments to the kernel and puts the result in acc', () => {
  const bytes = [...pushImmediate(2), ...pushImmediate(3), ...pushImmediate(4), small(OP.CALLK), 9, 4, ...ret()];
  const { machine, result } = evaluate(bytes);
  assert.equal(result, 7);
  assert.deepEqual(machine.kernelCalls, [{ number: 9, args: [3, 4] }]);
  assert.equal(machine.interp.sp, -1, 'the stack is empty again once the procedure returned');
});

test('call runs a local procedure identified by its code block ID', () => {
  const machine = createMachine();
  const double = codeBlock(machine, [small(OP.LAP), 1, ...pushAcc(), plain(OP.ADD), ...ret()]);
  const main = codeBlock(machine, [...pushImmediate(1), ...pushImmediate(21), plain(OP.CALL), double & 0xff, double >> 8, 2, ...ret()]);
  assert.equal(runProcedure(machine, main), 42);
});

test('bnt and jmp skip code', () => {
  const bytes = [...loadImmediate(0), small(OP.BNT), 2, ...loadImmediate(99), small(OP.JMP), 2, ...loadImmediate(98), ...ret()];
  assert.equal(evaluate(bytes).result, 0, 'bnt skipped "ldi 99"; jmp skipped "ldi 98"');
});
