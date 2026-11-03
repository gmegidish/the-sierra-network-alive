// List and Seq kernels. LSCI lists are growable word arrays (memory type 0xe:
// uint16 count, uint16 capacity, items...), not SCI's linked nodes; Seq is an
// iterator (type 0xf) over a list, either live (mode 1) or over a snapshot.
// Ground truth: segment 0x166 (List, dispatch at 0x750) and 0x1f7 (Seq at
// 0x37e) of the unpacked LSCITV.EXE. Items are kept JS-side in entry.data.

export const LIST_TYPE = 0xe;
export const SEQ_TYPE = 0xf;
const DEFAULT_CAPACITY = 10;
const BEFORE_BEGIN = -1;
const LIVE_MODE = 1;

const LIST_OP = Object.freeze({
  NEW: 0, DISPOSE: 1, SIZE: 2, AT: 3, DELETE: 4, CONTAINS: 5, ADD_TO_FRONT: 6, ADD_TO_END: 7,
  ADD_AFTER: 8, ADD_BEFORE: 9, MOVE_TO_FRONT: 10, MOVE_TO_END: 11, INDEX_OF: 12, RELEASE: 13,
});

const SEQ_OP = Object.freeze({ NEW: 0, DISPOSE: 1, BEGIN: 2, END: 3, NEXT: 4, PREV: 5, SET: 6 });
// SET = retarget the iterator to a new list (not "seek to element").

/** @returns {number[] | null} */
export function listItems(vm, id) {
  const entry = vm.memory.get(id);
  return entry && entry.type === LIST_TYPE ? entry.data : null;
}

function newList(vm) {
  const id = vm.memory.alloc(LIST_TYPE, (DEFAULT_CAPACITY + 2) * 2);
  vm.memory.get(id).data = [];
  return id;
}

function insertRelative(items, existing, value, after) {
  const index = items.indexOf(existing);
  if (index < 0) {
    return 0;
  }
  items.splice(after ? index + 1 : index, 0, value);
  return value;
}

function moveTo(items, value, front) {
  const index = items.indexOf(value);
  if (index < 0) {
    return 0;
  }
  items.splice(index, 1);
  if (front) {
    items.unshift(value);
  } else {
    items.push(value);
  }
  return value;
}

function listOp(vm, items, op, a, b) {
  switch (op) {
    case LIST_OP.SIZE: return items.length;
    case LIST_OP.AT: return items[a] ?? 0;
    case LIST_OP.DELETE: {
      const index = items.indexOf(a);
      if (index < 0) {
        return 0;
      }
      items.splice(index, 1);
      return a;
    }
    case LIST_OP.CONTAINS: return items.includes(a) ? a : 0;
    case LIST_OP.ADD_TO_FRONT: items.unshift(a); return a;
    case LIST_OP.ADD_TO_END: items.push(a); return a;
    case LIST_OP.ADD_AFTER: return insertRelative(items, a, b, true);
    case LIST_OP.ADD_BEFORE: return insertRelative(items, a, b, false);
    case LIST_OP.MOVE_TO_FRONT: return moveTo(items, a, true);
    case LIST_OP.MOVE_TO_END: return moveTo(items, a, false);
    case LIST_OP.INDEX_OF: {
      const index = items.indexOf(a);
      return index < 0 ? 0xffff : index;
    }
    case LIST_OP.RELEASE: items.length = 0; return undefined;
    default:
      vm.trace.log('error', `List: unknown op ${op}`);
      return 0;
  }
}

function list(vm, [op, id = 0, a = 0, b = 0]) {
  if (op === LIST_OP.NEW) {
    return newList(vm);
  }
  if (op === LIST_OP.DISPOSE) {
    vm.memory.free(id);
    return undefined;
  }
  const items = listItems(vm, id);
  if (!items) {
    return op === LIST_OP.RELEASE ? undefined : 0;
  }
  return listOp(vm, items, op, a, b);
}

/** @typedef {{ list: number, snapshot: number[] | null, pos: number }} SeqState */

function seqItems(vm, state) {
  return state.snapshot ?? listItems(vm, state.list) ?? [];
}

function newSeq(vm, listId, mode) {
  const id = vm.memory.alloc(SEQ_TYPE, 12);
  const items = listItems(vm, listId) ?? [];
  vm.memory.get(id).data = { list: listId, snapshot: mode === LIVE_MODE ? null : [...items], pos: BEFORE_BEGIN };
  return id;
}

function seqStep(vm, state, delta) {
  const items = seqItems(vm, state);
  if (state.pos === BEFORE_BEGIN && delta < 0) {
    state.pos = items.length;
  }
  state.pos += delta;
  if (state.pos < 0 || state.pos >= items.length) {
    state.pos = delta > 0 ? items.length : BEFORE_BEGIN;
    return 0;
  }
  return items[state.pos];
}

function seq(vm, [op, id = 0, value = LIVE_MODE]) {
  if (op === SEQ_OP.NEW) {
    return newSeq(vm, id, value);
  }
  const entry = vm.memory.get(id);
  if (!entry || entry.type !== SEQ_TYPE) {
    return 0;
  }
  /** @type {SeqState} */
  const state = entry.data;
  switch (op) {
    case SEQ_OP.DISPOSE: vm.memory.free(id); return undefined;
    case SEQ_OP.BEGIN: state.pos = BEFORE_BEGIN; return undefined;
    case SEQ_OP.END: state.pos = seqItems(vm, state).length; return undefined;
    case SEQ_OP.NEXT: return seqStep(vm, state, 1);
    case SEQ_OP.PREV: return seqStep(vm, state, -1);
    case SEQ_OP.SET: {
      // Seq(6, seq, list) points the iterator at another list (0x1f7:0xea copies
      // the items for a snapshot seq); Set handleEvent does Seq(0,0,0) then Seq(6).
      const items = listItems(vm, value) ?? [];
      entry.data = { list: value, snapshot: state.snapshot ? [...items] : null, pos: BEFORE_BEGIN };
      return undefined;
    }
    default: return 0;
  }
}

export const listKernels = Object.freeze({ List: list, Seq: seq });
