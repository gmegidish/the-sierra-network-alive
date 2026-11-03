// Browser front end: fetch the installed TSN files, boot the VM, draw the
// 320x200 framebuffer into a canvas and feed it mouse/keyboard input.
// ?host=fake uses the in-page FakeServer instead of the local TSN host
// (npm run server, ws://localhost:7000/line).
import { Vm } from '../vm/vm.js';
import { createRootResources } from '../vm/root-resources.js';
import { FakeServer } from '../net/fake-server.js';
import { LineHost } from '../net/line-host.js';
import { attachInput } from './input.js';
import { nextProgramVm } from '../vm/programs.js';
import { drawCursor } from '../gfx/cursor.js';
import { startAudio } from '../audio/web-audio.js';

const INSTALL_URL = 'installed/TSN/';
const INSTRUCTIONS_PER_FRAME = 20000;
const DIRECTORY_MARKER = '.';

/** @returns {Promise<Map<string, Uint8Array>>} */
async function fetchInstall(status) {
  const response = await fetch(`${INSTALL_URL}manifest.json`);
  if (!response.ok) {
    throw new Error(`${INSTALL_URL}manifest.json missing: run node tools/make-manifest.mjs`);
  }
  const manifest = await response.json();
  const files = new Map();
  for (const [index, name] of manifest.files.entries()) {
    status(`loading ${name} (${index + 1}/${manifest.files.length})`);
    const file = await fetch(`${INSTALL_URL}${name.split('/').map(encodeURIComponent).join('/')}`);
    files.set(name, new Uint8Array(await file.arrayBuffer()));
  }
  manifest.directories.forEach((dir) => files.set(`${dir}/${DIRECTORY_MARKER}`, new Uint8Array(0)));
  return files;
}

function createHost() {
  const host = new URLSearchParams(window.location.search).get('host');
  return host === 'fake' ? new FakeServer() : new LineHost();
}

/** TSNEXEC: after TSN(9, program) the interpreter quits and that program boots. */
function chainIfQuit(vm) {
  if (!vm.interp.halted) {
    return vm;
  }
  const next = nextProgramVm(vm);
  if (!next) {
    return vm;
  }
  window.tsnVm = next;
  next.boot();
  return next;
}

function startLoop(first, canvas) {
  const context = canvas.getContext('2d');
  const image = context.createImageData(canvas.width, canvas.height);
  let vm = first;
  const frame = () => {
    try {
      vm = chainIfQuit(vm);
      vm.runSlice(INSTRUCTIONS_PER_FRAME);
    } catch (error) {
      document.getElementById('status').textContent = `VM error: ${error.message}`;
      throw error;
    }
    // ponytail: recomposited every frame so the cursor overlay follows the mouse.
    vm.screen.toRgba(image.data);
    drawCursor(vm.graphics, vm.cursor, vm.events.mouse, image.data);
    context.putImageData(image, 0, 0);
    vm.screen.dirty = false;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function main() {
  const statusLine = document.getElementById('status');
  const status = (text) => {
    statusLine.textContent = text;
  };
  const files = await fetchInstall(status);
  const vm = new Vm({ resources: createRootResources(files), files, server: createHost() });
  window.tsnVm = vm;
  const canvas = document.getElementById('screen');
  // Input goes to whichever program is running (window.tsnVm changes on a land switch).
  attachInput(canvas, {
    push: (event) => window.tsnVm.events.push(event),
    moveMouse: (x, y) => window.tsnVm.events.moveMouse(x, y),
  });
  startAudio({ canvas, getVm: () => window.tsnVm });
  vm.boot();
  status('running');
  startLoop(vm, canvas);
}

main().catch((error) => {
  document.getElementById('status').textContent = `Failed: ${error.message}`;
});
