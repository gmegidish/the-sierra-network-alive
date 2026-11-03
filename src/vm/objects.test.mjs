// Object model and message dispatch: properties, methods, the -super- chain,
// self, super sends and clones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine, codeBlock, makeObject, sendMessage, small, plain } from './test-machine.mjs';

const SELECTOR = Object.freeze({ X: 100, Y: 101, WHO_AM_I: 200, DOUBLE_X: 201, VALUE: 202 });
const OP = Object.freeze({ LDI: 0x1a, PUSH: 0x1b, ADD: 0x01, RET: 0x24, SUPER: 0x2b, SELF_ID: 0x2e, PTOA: 0x31, PUSHI: 0x1c });

/** Method body: acc = self. */
const returnSelf = (machine) => codeBlock(machine, [plain(OP.SELF_ID), plain(OP.RET)]);
/** Method body: acc = value. */
const returnConstant = (machine, value) => codeBlock(machine, [small(OP.LDI), value, plain(OP.RET)]);
/** Method body: acc = self.x + self.x (property X is the 7th property: byte offset 12). */
const doubleX = (machine) => codeBlock(machine, [small(OP.PTOA), 12, plain(OP.PUSH), plain(OP.ADD), plain(OP.RET)]);

function classWithChild(machine, classMethods) {
  const base = makeObject(machine, { isClass: true, properties: { [SELECTOR.X]: 1 }, methods: classMethods });
  const child = makeObject(machine, { superId: base, properties: { [SELECTOR.X]: 21 } });
  return { base, child };
}

test('a send with no arguments reads a property and with one argument writes it', () => {
  const machine = createMachine();
  const { child } = classWithChild(machine, {});
  assert.equal(sendMessage(machine, child, SELECTOR.X), 21);
  sendMessage(machine, child, SELECTOR.X, [33]);
  assert.equal(sendMessage(machine, child, SELECTOR.X), 33);
});

test('methods are found along the -super- chain and run with self = the receiver', () => {
  const machine = createMachine();
  const { child } = classWithChild(machine, { [SELECTOR.WHO_AM_I]: returnSelf(machine), [SELECTOR.DOUBLE_X]: doubleX(machine) });
  assert.equal(sendMessage(machine, child, SELECTOR.WHO_AM_I), child);
  assert.equal(sendMessage(machine, child, SELECTOR.DOUBLE_X), 42);
});

test('an own method overrides the inherited one', () => {
  const machine = createMachine();
  const base = makeObject(machine, { isClass: true, methods: { [SELECTOR.VALUE]: returnConstant(machine, 1) } });
  const child = makeObject(machine, { superId: base, methods: { [SELECTOR.VALUE]: returnConstant(machine, 2) } });
  assert.equal(sendMessage(machine, child, SELECTOR.VALUE), 2);
});

test('super sends start the lookup at the given class but keep self', () => {
  const machine = createMachine();
  const CLASS_NUMBER = 7;
  const base = makeObject(machine, { isClass: true, methods: { [SELECTOR.WHO_AM_I]: returnSelf(machine) } });
  machine.interp.loader = { classId: (number) => (number === CLASS_NUMBER ? base : 0) };
  // (super whoAmI:) = pushi sel (word: byte operands are sign-extended); pushi 0; super 7 4; ret
  const callSuper = codeBlock(machine, [
    plain(OP.PUSHI), SELECTOR.WHO_AM_I & 0xff, SELECTOR.WHO_AM_I >> 8, small(OP.PUSHI), 0,
    small(OP.SUPER), CLASS_NUMBER, 4, plain(OP.RET),
  ]);
  const child = makeObject(machine, { superId: base, methods: { [SELECTOR.VALUE]: callSuper } });
  assert.equal(sendMessage(machine, child, SELECTOR.VALUE), child);
});

test('an unknown selector is reported and does not stop the machine', () => {
  const machine = createMachine();
  const { child } = classWithChild(machine, {});
  sendMessage(machine, child, 999);
  assert.match(machine.logs.join('\n'), /does not understand sel999/);
  assert.equal(sendMessage(machine, child, SELECTOR.X), 21);
});

test('a clone copies the properties, inherits the methods and is marked as a clone', () => {
  const machine = createMachine();
  const { child } = classWithChild(machine, { [SELECTOR.WHO_AM_I]: returnSelf(machine) });
  const clone = machine.objects.clone(child);
  assert.equal(sendMessage(machine, clone, SELECTOR.X), 21);
  assert.equal(sendMessage(machine, clone, SELECTOR.WHO_AM_I), clone);
  assert.equal(machine.memory.readWord(clone, 6), child, '-super- of a clone is the original');
  assert.equal(machine.memory.readWord(clone, 8) & 1, 1, '-info- has the clone bit');
});
