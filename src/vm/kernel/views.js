// View/cel kernels (segment 0xa7e of the unpacked LSCITV.EXE).
// NumLoops(view) 0xa7e:0x1b60, NumCels(view, loop) 0x1b91,
// CelRect(dest, view, loop, cel, x, y [, z, scaleX, scaleY]) 0x1bc9,
// CelWide/CelHigh(view, loop, cel) 0x1e7c. Animate(cast, doit) follows the
// SCI1.1 model (ScummVM animate.cpp) in simplified form: every cast member
// gets `doit:` when doit is set, the cels drawn last time are erased from the
// static background, then all visible members are redrawn in priority order.
// View signal bits (SCI1.1): 0x08 hidden, 0x10 fixed priority, 0x8000 dispose.
import { listItems } from './lists.js';
import { arraySet } from './arrays.js';

/**
 * @typedef {{ id: number, view: number, loop: number, cel: number, x: number, y: number,
 *   priority: number, signal: number }} CastMember
 */

const SIGNAL = Object.freeze({ STOP_UPDATE: 0x01, HIDDEN: 0x08, FIXED_PRIORITY: 0x10, DISPOSE_ME: 0x8000 });
const CONTROL_PLANE = 4;
const ILLEGAL_DEFAULT = 0x8000;

function signedValue(value) {
  return value & 0x8000 ? value - 0x10000 : value;
}

/** Members of a cast: a Collect-like object (elements = list) or a list ID. */
function castMembers(vm, cast) {
  const list = vm.objects.isObject(cast) ? vm.prop(cast, 'elements') : cast;
  return [...(listItems(vm, list) ?? [])].filter((id) => vm.objects.isObject(id));
}

/** @returns {CastMember} */
function readMember(vm, id) {
  return {
    id,
    view: vm.prop(id, 'view'),
    loop: vm.prop(id, 'loop'),
    cel: vm.prop(id, 'cel'),
    x: signedValue(vm.prop(id, 'x')),
    y: signedValue(vm.prop(id, 'y')) - signedValue(vm.prop(id, 'z')),
    priority: signedValue(vm.prop(id, 'priority')),
    signal: vm.prop(id, 'signal'),
  };
}

function updatePriority(vm, member) {
  if (member.signal & SIGNAL.FIXED_PRIORITY) {
    return member.priority;
  }
  const priority = vm.graphics.coordToPriority(member.y);
  vm.setProp(member.id, 'priority', priority);
  return priority;
}

function setRectProps(vm, id, rect) {
  vm.setProp(id, 'top', rect.top & 0xffff);
  vm.setProp(id, 'left', rect.left & 0xffff);
  vm.setProp(id, 'bottom', rect.bottom & 0xffff);
  vm.setProp(id, 'right', rect.right & 0xffff);
}

/** Identity of what a member looks like on screen; unchanged means no redraw is needed. */
function drawKey(member) {
  return [member.view, member.loop, member.cel, member.x, member.y, member.priority].join(',');
}

/**
 * Stop-updated members that haven't changed stay on screen untouched (SCI's
 * stopUpd views), so cels drawn over them with DrawCel survive the next cycle.
 * ponytail: overlap between kept and erased members isn't re-composited.
 */
function isStillDrawn(graphics, member) {
  const drawn = graphics.drawnCels.get(member.id);
  return Boolean(drawn) && (member.signal & SIGNAL.STOP_UPDATE) !== 0 && drawn.key === drawKey(member);
}

function eraseDrawnCels(graphics, kept) {
  for (const [id, drawn] of graphics.drawnCels) {
    if (!kept.has(id)) {
      graphics.restoreBackground(drawn.rect);
      graphics.drawnCels.delete(id);
    }
  }
}

function drawMember(vm, member) {
  const g = vm.graphics;
  const rect = g.drawCel(member.view, member.loop, member.cel, member.x, member.y, member.priority, g.picPort);
  if (!rect) {
    return;
  }
  setRectProps(vm, member.id, rect);
  // Clip to the pic port: erasing a cel that overhangs the port (the Winter Map
  // clouds) must not restore stale background over the status bar.
  const port = g.picPort.rect;
  const screenRect = {
    top: Math.max(rect.top + port.top, port.top), left: Math.max(rect.left, port.left),
    bottom: Math.min(rect.bottom + port.top, port.bottom), right: Math.min(rect.right, port.right),
  };
  g.drawnCels.set(member.id, { rect: screenRect, key: drawKey(member) });
}

function animate(vm, [cast = 0, doit = 0]) {
  const g = vm.graphics;
  g.init();
  let members = castMembers(vm, cast);
  if (doit) {
    members.forEach((id) => vm.send(id, vm.sel('doit')));
    members = castMembers(vm, cast);
  }
  const visible = members.map((id) => readMember(vm, id))
    .filter((member) => (member.signal & SIGNAL.HIDDEN) === 0)
    .map((member) => ({ ...member, priority: updatePriority(vm, member) }))
    .sort((a, b) => a.priority - b.priority || a.y - b.y);
  const kept = new Set(visible.filter((member) => isStillDrawn(g, member)).map((member) => member.id));
  eraseDrawnCels(g, kept);
  visible.filter((member) => !kept.has(member.id)).forEach((member) => drawMember(vm, member));
  return undefined;
}

/** AddToPic(list) or AddToPic(view, loop, cel, x, y, priority): draw into the background. */
function addToPic(vm, args) {
  const g = vm.graphics;
  g.init();
  if (args.length === 1) {
    for (const id of castMembers(vm, args[0])) {
      const member = readMember(vm, id);
      g.drawCel(member.view, member.loop, member.cel, member.x, member.y, updatePriority(vm, member), g.picPort);
    }
  } else {
    const [view, loop, cel, x, y, priority = -1] = args;
    g.drawCel(view, loop, cel, signedValue(x), signedValue(y), signedValue(priority), g.picPort);
  }
  g.snapshotBackground();
  return undefined;
}

function drawCel(vm, [view, loop, cel, x, y, priority = 0xffff]) {
  // DrawCel takes the cel's top-left corner, not its origin (scripts get it from CelRect).
  vm.graphics.drawCelAt(view, loop, cel, signedValue(x), signedValue(y), signedValue(priority));
  return undefined;
}

function celRect(vm, [dest, view, loop, cel, x = 0, y = 0, z = 0]) {
  const rect = vm.graphics.celRect(view, loop, cel, signedValue(x), signedValue(y) - signedValue(z));
  if (vm.objects.isObject(dest)) {
    setRectProps(vm, dest, rect);
  } else if (vm.memory.isValid(dest)) {
    [rect.top, rect.left, rect.bottom, rect.right].forEach((value, index) => arraySet(vm, dest, index, value & 0xffff));
  }
  return undefined;
}

function celSize(vm, [view, loop = 0, cel = 0], key) {
  const data = vm.graphics.cel(view, loop, cel);
  return data ? data[key] : 0;
}

function numLoops(vm, [view]) {
  return vm.graphics.view(view)?.loops.length ?? 0;
}

function numCels(vm, [view, loop = 0]) {
  const loops = vm.graphics.view(view)?.loops ?? [];
  return loops.length ? loops[Math.min(loop, loops.length - 1)].cels.length : 0;
}

/** Bitmask of control colours under a port-relative rect (SCI OnControl). */
function controlUnder(vm, left, top, right, bottom) {
  const { screen, picPort } = vm.graphics;
  let mask = 0;
  for (let y = top; y < Math.max(bottom, top + 1); y++) {
    for (let x = left; x < Math.max(right, left + 1); x++) {
      const sy = y + picPort.rect.top;
      if (screen.inBounds(x, sy)) {
        mask |= 1 << screen.control[sy * screen.width + x];
      }
    }
  }
  return mask;
}

function onControl(vm, [plane, x, y, x2, y2]) {
  if (plane !== CONTROL_PLANE) {
    return 0;
  }
  const left = signedValue(x);
  const top = signedValue(y);
  return controlUnder(vm, left, top, x2 === undefined ? left + 1 : signedValue(x2), y2 === undefined ? top + 1 : signedValue(y2));
}

function canBeHere(vm, [object]) {
  const member = readMember(vm, object);
  const rect = vm.graphics.celRect(member.view, member.loop, member.cel, member.x, member.y);
  const illegal = vm.prop(object, 'illegalBits') || ILLEGAL_DEFAULT;
  return (controlUnder(vm, rect.left, member.y, rect.right, member.y + 1) & illegal) === 0 ? 1 : 0;
}

export const viewKernels = Object.freeze({
  Animate: animate,
  AddToPic: addToPic,
  DrawCel: drawCel,
  DrawScaledCel: drawCel,
  CelRect: celRect,
  ScaledCelRect: celRect,
  CelWide: (vm, args) => celSize(vm, args, 'width'),
  CelHigh: (vm, args) => celSize(vm, args, 'height'),
  NumLoops: numLoops,
  NumCels: numCels,
  OnControl: onControl,
  CanBeHere: canBeHere,
});
