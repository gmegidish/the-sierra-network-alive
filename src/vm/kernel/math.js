// Math kernels. Semantics follow stock SCI (ScummVM engines/sci/engine/kmath.cpp);
// Abs verified against 0x630:0xf8 of LSCITV.EXE. Long (0x630:0x164) is
// 32-bit arithmetic on objects with highWord/lowWord properties:
// Long(op, longObj, high, low): ops 0 add, 1 sub, 2 mul, 3 div, 4 sqrt(|a|),
// 5 neg, 6 a>b, 7 a<b, 8 a==b, 9 a>=b, 10 a<=b, 11 toString([unsigned]),
// 12 fromString(stringId). Arithmetic results are stored back into longObj.
import { signed } from '../opcodes.js';

const DEGREES = 180;
const FULL_CIRCLE = 360;
const LONG_OP = Object.freeze({
  ADD: 0, SUB: 1, MUL: 2, DIV: 3, SQRT: 4, NEG: 5, GT: 6, LT: 7, EQ: 8, GE: 9, LE: 10, TO_STRING: 11, FROM_STRING: 12,
});
const LONG_COMPARE = Object.freeze({
  [LONG_OP.GT]: (a, b) => a > b,
  [LONG_OP.LT]: (a, b) => a < b,
  [LONG_OP.EQ]: (a, b) => a === b,
  [LONG_OP.GE]: (a, b) => a >= b,
  [LONG_OP.LE]: (a, b) => a <= b,
});
const TWO_TO_16 = 0x10000;

function toRadians(angle) {
  return (signed(angle) * Math.PI) / DEGREES;
}

/** SCI GetAngle: compass angle from (x1,y1) to (x2,y2), 0 = up, clockwise. */
function getAngle(vm, [x1, y1, x2, y2]) {
  const dx = signed(x2) - signed(x1);
  const dy = signed(y1) - signed(y2);
  if (dx === 0 && dy === 0) {
    return 0;
  }
  const angle = Math.round((Math.atan2(dx, dy) * DEGREES) / Math.PI);
  return (angle + FULL_CIRCLE) % FULL_CIRCLE;
}

function getDistance(vm, [x1, y1, x2 = 0, y2 = 0, perspective = 0]) {
  const dx = signed(x2) - signed(x1);
  let dy = signed(y2) - signed(y1);
  if (perspective) {
    dy = Math.trunc((dy * 100) / Math.max(1, signed(perspective)));
  }
  return Math.round(Math.sqrt(dx * dx + dy * dy));
}

function random(vm, [low = 0, high]) {
  if (high === undefined) {
    return Math.floor(vm.random() * 0x10000);
  }
  const lo = signed(low);
  const hi = signed(high);
  return lo + Math.floor(vm.random() * (hi - lo + 1));
}

function longArithmetic(op, a, b) {
  switch (op) {
    case LONG_OP.ADD: return a + b;
    case LONG_OP.SUB: return a - b;
    case LONG_OP.MUL: return Math.imul(a, b);
    case LONG_OP.DIV: return b === 0 ? 0 : Math.trunc(a / b);
    case LONG_OP.SQRT: return Math.floor(Math.sqrt(Math.abs(a)));
    case LONG_OP.NEG: return -a;
    default: return a;
  }
}

function long(vm, [op, object, high = 0, low = 0]) {
  const a = (vm.prop(object, 'highWord') << 16) | vm.prop(object, 'lowWord');
  const b = (high << 16) | low;
  if (LONG_COMPARE[op]) {
    return LONG_COMPARE[op](a, b) ? 1 : 0;
  }
  if (op === LONG_OP.TO_STRING) {
    return vm.strings.create(String(high ? a >>> 0 : a));
  }
  const result = op === LONG_OP.FROM_STRING
    ? Number.parseInt(vm.strings.read(high), 10) | 0
    : longArithmetic(op, a, b) | 0;
  vm.setProp(object, 'highWord', (result >>> 16) & 0xffff);
  vm.setProp(object, 'lowWord', (result >>> 0) % TWO_TO_16);
  return object;
}

export const mathKernels = Object.freeze({
  Abs: (vm, [value]) => Math.abs(signed(value)),
  Sqrt: (vm, [value]) => Math.floor(Math.sqrt(Math.abs(signed(value)))),
  GetAngle: getAngle,
  GetDistance: getDistance,
  Random: random,
  SinMult: (vm, [angle, value]) => Math.round(Math.sin(toRadians(angle)) * signed(value)),
  CosMult: (vm, [angle, value]) => Math.round(Math.cos(toRadians(angle)) * signed(value)),
  SinDiv: (vm, [angle, value]) => {
    const sin = Math.sin(toRadians(angle));
    return sin === 0 ? 0 : Math.round(signed(value) / sin);
  },
  CosDiv: (vm, [angle, value]) => {
    const cos = Math.cos(toRadians(angle));
    return cos === 0 ? 0 : Math.round(signed(value) / cos);
  },
  Long: long,
});
