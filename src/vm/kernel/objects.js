// Object / module kernels. Ground truth: segment 0x1391 (IsObject, ObjectNew,
// ObjectFree, ObjectRespondsTo), 0x27b (ModuleDispose, ModuleID) and 0x126a /
// 0x1326 (SID, InvokeMethod, ObjPropOffset, ObjOffsetProp) of LSCITV.EXE.

const SID_OP = Object.freeze({ INIT: 0, REGISTER: 1, UNREGISTER: 2, LOOKUP: 3 });

/** ObjectNew(obj [, selector, value]...): clone, then set properties. */
function objectNew(vm, args) {
  const [original, ...pairs] = args;
  if (!vm.objects.isObject(original)) {
    vm.trace.log('error', `ObjectNew of non-object $${original.toString(16)}`);
    return 0;
  }
  const copy = vm.objects.clone(original);
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    vm.objects.setProperty(copy, pairs[i], pairs[i + 1]);
  }
  return copy;
}

/** InvokeMethod(obj, selector, argc, argArray): send from C with array args. */
function invokeMethod(vm, [object, selector, count = 0, array = 0]) {
  const values = [];
  for (let i = 0; i < count; i++) {
    values.push(vm.memory.readWord(array, 4 + i * 2));
  }
  return vm.interp.invoke(object, selector, values);
}

/** ObjPropOffset(obj, selector) -> property index. */
function objPropOffset(vm, [object, selector]) {
  const offset = vm.objects.propertyOffset(object, selector);
  return offset < 0 ? 0 : offset / 2;
}

/** ObjOffsetProp(obj, index) -> selector of that property. */
function objOffsetProp(vm, [object, index]) {
  const dict = vm.memory.readWord(object, 4);
  return vm.memory.readWord(dict, index * 2);
}

/**
 * SID: table of network-visible objects by system ID (used by Obj::setSid /
 * dispose). Kernel at 0x126a:0x74e: 0 init(size), 1 register(sid, obj),
 * 2 unregister(sid, obj), 3 lookup(sid) -> obj. lookup(0) returns the game
 * object (DS:0x134e, set at startup), so host messages addressed to SID 0
 * reach the game's handleMsg.
 */
function sid(vm, [op, id = 0, object = 0]) {
  vm.sids ??= new Map();
  switch (op) {
    case SID_OP.INIT: return 1;
    case SID_OP.REGISTER: vm.sids.set(id, object); return object;
    case SID_OP.UNREGISTER: vm.sids.delete(id); return 0;
    case SID_OP.LOOKUP: return id === 0 ? vm.game : vm.sids.get(id) ?? 0;
    default: return 0;
  }
}

export const objectKernels = Object.freeze({
  IsObject: (vm, [id]) => (vm.objects.isObject(id) ? 1 : 0),
  ObjectFree: (vm, [id]) => {
    vm.objects.free(id);
    return undefined;
  },
  ObjectNew: objectNew,
  ObjectRespondsTo: (vm, [id, selector]) => (vm.objects.respondsTo(id, selector) ? 1 : 0),
  ModuleDispose: (vm, args) => {
    args.forEach((module) => vm.loader.dispose(module));
    return undefined;
  },
  ModuleID: (vm, [module, entry = 0]) => vm.loader.exportOf(module, entry),
  SID: sid,
  InvokeMethod: invokeMethod,
  ObjPropOffset: objPropOffset,
  ObjOffsetProp: objOffsetProp,
});
