// FileSystem kernel (0xd0d:0x00 of the unpacked LSCITV.EXE, jump table at
// 0xd0d:0x2b, sub-ops 0..15) over the in-memory filesystem.
//  0 open(name, mode)        mode 0 append/create, 1 open existing, 2 create; -> handle | -1
//  1 close(handle)
//  2 writeString(handle, str) -> bytes written
//  3 readString(buf, size, handle) -> buf | 0 (one line, CR/LF stripped)
//  4 getCWD(buf)
//  5 writeByte(handle, byte)
//  6 readByte(handle)         -> byte | -1
//  7 no-op
//  8 isDirectory(name)
//  9 seek(file, low, high, whence)   offset = low + high * 10000; file.lowWord/highWord = new pos
// 10 unlink(name)
// 11 read(file, buf, count)  0 ok, -1 fail, -2 no buf, -3 count too big; file.lowWord = bytes
// 12 write(file, buf, count)
// 13 tell(file)              file.lowWord/highWord = pos
// 14 findFirst(pattern, buf, attr) / 15 findNext(buf) -> 1 | 0
// "file" arguments are File objects whose `handle` property holds the DOS handle.
import { STRING_HEADER } from '../strings.js';

/**
 * @typedef {{ name: string, data: Uint8Array, pos: number }} OpenFile
 */

const FAIL = 0xffff;
const NO_BUFFER = 0xfffe;
const TOO_BIG = 0xfffd;
const FIRST_HANDLE = 5;
const SEEK_SCALE = 10000;
const SEEK = Object.freeze({ SET: 0, CURRENT: 1, END: 2 });
const OPEN_MODE = Object.freeze({ APPEND: 0, EXISTING: 1, CREATE: 2 });
const NEWLINE = 10;
const CARRIAGE_RETURN = 13;

/** @returns {Map<number, OpenFile>} */
function handles(vm) {
  vm.openFiles ??= new Map();
  return vm.openFiles;
}

function open(vm, [name, mode = OPEN_MODE.EXISTING]) {
  const path = vm.strings.read(name);
  const existing = vm.fs.read(path);
  if (!existing && mode === OPEN_MODE.EXISTING) {
    vm.trace.log('file', `open ${path} -> missing`);
    return FAIL;
  }
  const data = mode === OPEN_MODE.CREATE || !existing ? new Uint8Array(0) : existing;
  const files = handles(vm);
  let handle = FIRST_HANDLE;
  while (files.has(handle)) {
    handle++;
  }
  files.set(handle, { name: path, data, pos: mode === OPEN_MODE.APPEND ? data.length : 0 });
  vm.trace.log('file', `open ${path} mode ${mode} -> ${handle}`);
  return handle;
}

function writeBytes(vm, file, bytes) {
  const end = file.pos + bytes.length;
  if (end > file.data.length) {
    const grown = new Uint8Array(end);
    grown.set(file.data);
    file.data = grown;
  }
  file.data.set(bytes, file.pos);
  file.pos = end;
  vm.fs.write(file.name, file.data);
  return bytes.length;
}

/** One line without its CR/LF, or null at end of file. */
function readLine(file, size) {
  if (file.pos >= file.data.length) {
    return null;
  }
  let text = '';
  while (file.pos < file.data.length && text.length < size - 1) {
    const byte = file.data[file.pos++];
    if (byte === NEWLINE) {
      break;
    }
    if (byte !== CARRIAGE_RETURN) {
      text += String.fromCharCode(byte);
    }
  }
  return text;
}

function setPosition(vm, object, pos) {
  vm.setProp(object, 'lowWord', pos & 0xffff);
  vm.setProp(object, 'highWord', (pos >>> 16) & 0xffff);
}

function fileOf(vm, object) {
  return handles(vm).get(vm.prop(object, 'handle'));
}

function seek(vm, [object, low = 0, high = 0, whence = SEEK.SET]) {
  const file = fileOf(vm, object);
  if (!file) {
    setPosition(vm, object, FAIL);
    return FAIL;
  }
  const offset = (low << 16 >> 16) + (high << 16 >> 16) * SEEK_SCALE;
  const base = whence === SEEK.END ? file.data.length : whence === SEEK.CURRENT ? file.pos : 0;
  file.pos = Math.max(0, base + offset);
  setPosition(vm, object, file.pos);
  return 0;
}

function bufferRoom(vm, buffer) {
  return vm.memory.readWord(buffer, 2);
}

function readBlock(vm, [object, buffer = 0, count = 0]) {
  const file = fileOf(vm, object);
  if (!buffer) {
    return NO_BUFFER;
  }
  if (count > bufferRoom(vm, buffer)) {
    return TOO_BIG;
  }
  if (!file) {
    setPosition(vm, object, 0);
    return FAIL;
  }
  const bytes = file.data.subarray(file.pos, file.pos + count);
  vm.memory.bytes(buffer).set(bytes, STRING_HEADER);
  file.pos += bytes.length;
  setPosition(vm, object, bytes.length);
  return 0;
}

function writeBlock(vm, [object, buffer = 0, count = 0]) {
  const file = fileOf(vm, object);
  if (!buffer || !file) {
    setPosition(vm, object, 0);
    return FAIL;
  }
  // 0xd0d:0x386 takes a string pointer (0x243:0x1e3), so a Str object means its data.
  const bytes = vm.memory.bytes(vm.strings.resolve(buffer)).slice(STRING_HEADER, STRING_HEADER + count);
  setPosition(vm, object, writeBytes(vm, file, bytes));
  return 0;
}

function findFirst(vm, [pattern, buffer]) {
  vm.findResults = vm.fs.list(vm.strings.read(pattern));
  return findNext(vm, [buffer]);
}

function findNext(vm, [buffer]) {
  const next = vm.findResults?.shift();
  if (next === undefined) {
    return 0;
  }
  vm.strings.write(buffer, next.split('\\').pop());
  return 1;
}

const SUB_OPS = Object.freeze([
  open,
  (vm, [handle]) => {
    handles(vm).delete(handle);
    return 0;
  },
  (vm, [handle, text]) => {
    const file = handles(vm).get(handle);
    const bytes = Uint8Array.from(vm.strings.read(text), (c) => c.charCodeAt(0));
    return file ? writeBytes(vm, file, bytes) : FAIL;
  },
  (vm, [buffer, size, handle]) => {
    const file = handles(vm).get(handle);
    const line = file ? readLine(file, size) : null;
    if (line === null) {
      return 0;
    }
    vm.strings.write(buffer, line);
    return buffer;
  },
  (vm, [buffer]) => {
    vm.strings.write(buffer, 'C:\\TSN');
    return buffer;
  },
  (vm, [handle, byte]) => {
    const file = handles(vm).get(handle);
    return file ? writeBytes(vm, file, Uint8Array.of(byte)) : FAIL;
  },
  (vm, [handle]) => {
    const file = handles(vm).get(handle);
    return file && file.pos < file.data.length ? file.data[file.pos++] : FAIL;
  },
  () => undefined,
  (vm, [name]) => (vm.fs.isDirectory(vm.strings.read(name)) ? 1 : 0),
  seek,
  (vm, [name]) => (vm.fs.remove(vm.strings.read(name)) ? 0 : FAIL),
  readBlock,
  writeBlock,
  (vm, [object]) => {
    const file = fileOf(vm, object);
    setPosition(vm, object, file ? file.pos : FAIL);
    return file ? 0 : FAIL;
  },
  findFirst,
  findNext,
]);

function fileSystem(vm, [op, ...args]) {
  const fn = SUB_OPS[op];
  if (!fn) {
    vm.trace.log('todo', `FileSystem(${op}, ${args.join(', ')})`);
    return 0;
  }
  return fn(vm, args);
}

export const fileKernels = Object.freeze({ FileSystem: fileSystem });
