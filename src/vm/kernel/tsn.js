// TSN kernel (#84, 0x126a:0x0c of the unpacked LSCITV.EXE). The original
// forwards to TSNEXEC through a far vtable; here every sub-function is logged
// and answered by a pluggable host: FakeServer (src/net/fake-server.js,
// in-process) or LineHost (src/net/line-host.js, the local server over a
// WebSocket). Both take decoded packets and hand back queued host messages.
// Sub-functions (docs/protocol.md "Layer 3"):
//  0 status -> (connected << 8) | linkType   1 get shared buffer -> byte array | 0
//  2 set shared buffer(data, len)            3 connect(target) -> 1 | 0
//  4 send(fmt, args...)                      7 disconnect
//  8 poll: each host message becomes an event of type 0x400 (message = byte array)
//  9 / 11 set / get next program name        12 idle -> 1
//  13 reconnect(address)  14 flush  16 -> 0  5, 6, 10, 15 no-op
import { encodeMessage } from '../../net/wire.js';
import { newArray } from './arrays.js';
import { STRING_HEADER } from '../strings.js';
import { EVENT_TYPE } from '../events.js';
import { findProgram } from '../programs.js';

const SUB_NAMES = Object.freeze([
  'status', 'getBuffer', 'setBuffer', 'connect', 'send', 'nop5', 'nop6', 'disconnect', 'poll',
  'setProgram', 'nop10', 'getProgram', 'idle', 'reconnect', 'flush', 'nop15', 'sub16',
]);
const BYTE_ARRAY = 2;
const CONNECTED_SHIFT = 8;
const QUIET_SUBS = Object.freeze(new Set([0, 8, 12, 14]));

function hasElementSizeOne(vm, id) {
  return vm.memory.readWord(id, 0) === 1;
}

/** Array contents for an 'a' field: Uint8Array for byte arrays, else words. */
function arrayContents(vm, id, count) {
  if (!vm.memory.isValid(id)) {
    return new Uint8Array(0);
  }
  if (hasElementSizeOne(vm, id)) {
    return vm.memory.bytes(id).slice(STRING_HEADER, STRING_HEADER + count);
  }
  return Array.from({ length: count }, (_, i) => vm.memory.readWord(id, STRING_HEADER + i * 2));
}

/** Resolve TSN(4) arguments against the format (strings and arrays become values). */
function resolveFields(vm, format, args) {
  const fields = [];
  let next = 0;
  for (const ch of format) {
    if (ch === 's') {
      fields.push(vm.strings.read(args[next++]));
    } else if (ch === 'a') {
      fields.push(args[next], arrayContents(vm, args[next + 1], args[next]));
      next += 2;
    } else if (ch === '+') {
      fields.push(...args.slice(next));
      next = args.length;
    } else if (ch === 'b' || ch === 'w') {
      fields.push(args[next++]);
    }
  }
  return fields;
}

function send(vm, [format, ...args]) {
  const fmt = vm.strings.read(format);
  const fields = resolveFields(vm, fmt, args);
  const bytes = encodeMessage(fmt, fields);
  if (bytes.length === 0) {
    return 0;
  }
  const printable = fields.map((field) => (typeof field === 'object' ? Array.from(field) : field));
  vm.server.receivePacket({ type: bytes[0], sub: bytes[1] ?? 0, format: fmt, fields: printable, bytes });
  return 1;
}

function byteArray(vm, bytes) {
  const id = newArray(vm, bytes.length, BYTE_ARRAY);
  vm.memory.bytes(id).set(bytes, STRING_HEADER);
  return id;
}

function poll(vm) {
  const replies = vm.server.takeReplies();
  for (const bytes of replies) {
    vm.events.push({ type: EVENT_TYPE.NETWORK, message: byteArray(vm, bytes), modifiers: bytes.length });
  }
  return replies.length;
}

function status(vm) {
  const { connected, linkType } = vm.server.status();
  return ((connected ? 1 : 0) << CONNECTED_SHIFT) | linkType;
}

const SUB_FUNCTIONS = Object.freeze({
  0: status,
  1: (vm) => (vm.tsnBuffer ? byteArray(vm, vm.tsnBuffer) : 0),
  // TSN(2, 0, 0) clears the buffer once the next program has read it.
  2: (vm, [data, length]) => {
    vm.tsnBuffer = vm.memory.isValid(data) ? vm.memory.bytes(data).slice(STRING_HEADER, STRING_HEADER + length) : null;
    return 1;
  },
  3: (vm, [target]) => {
    if (vm.server.status().connected) {
      return 1;
    }
    return vm.server.connect(vm.strings.read(target)) ? 1 : 0;
  },
  4: send,
  7: (vm) => {
    vm.server.disconnect();
    return 0;
  },
  8: poll,
  // TSNEXEC knows the program (TSN.PRG): it runs once this interpreter quits.
  9: (vm, [name]) => {
    const program = vm.strings.read(name);
    if (!findProgram(vm.fs, program)) {
      return 0;
    }
    vm.tsnProgram = program;
    return 1;
  },
  11: (vm) => vm.strings.create(vm.tsnProgram ?? ''),
  12: (vm) => ((vm.server.isIdle?.() ?? true) ? 1 : 0),
  13: (vm, [address]) => (vm.server.connect(vm.strings.read(address)) ? 1 : 0),
  14: () => undefined,
  16: () => 0,
});

/** Sub-functions whose first argument is a string (connect, setProgram, reconnect). */
const STRING_ARG_SUBS = Object.freeze(new Set([3, 9, 13]));

function describeArgs(vm, sub, args) {
  if (sub === 4) {
    return `"${vm.strings.read(args[0])}", ${args.length - 1} args (decoded in the packet line)`;
  }
  return args.map((arg, i) => (i === 0 && STRING_ARG_SUBS.has(sub) ? `"${vm.strings.read(arg)}"` : String(arg))).join(', ');
}

function tsn(vm, [sub, ...args]) {
  const name = SUB_NAMES[sub] ?? `sub${sub}`;
  const fn = SUB_FUNCTIONS[sub];
  const result = fn ? fn(vm, args) : 0;
  if (!QUIET_SUBS.has(sub) || (sub === 8 && result)) {
    vm.server.note('call', `TSN(${sub} ${name}${args.length ? `, ${describeArgs(vm, sub, args)}` : ''}) -> ${result ?? '(acc)'}`);
  }
  return result;
}

export const tsnKernels = Object.freeze({ TSN: tsn });
