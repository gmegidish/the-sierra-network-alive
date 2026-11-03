// The LSCI virtual machine: memory, loader, interpreter, kernel and devices.
import { Memory } from './memory.js';
import { ModuleLoader } from './loader.js';
import { ObjectModel } from './objects.js';
import { Interpreter } from './interpreter.js';
import { buildKernelTable } from './kernel/index.js';
import { StringStore } from './strings.js';
import { Trace } from './trace.js';
import { Screen } from '../gfx/screen.js';
import { Graphics } from '../gfx/graphics.js';
import { createCursor } from '../gfx/cursor.js';
import { EventQueue } from './events.js';
import { FileSystem } from './filesystem.js';
import { FakeServer } from '../net/fake-server.js';
import { decodeSelectorNames, RESOURCE_TYPE } from '../resource/index.js';

const SELECTOR_VOCAB = 997;
const GAME_MODULE = 0;
const GAME_EXPORT = 0;
const PLAY_SELECTOR = 26;
const TICKS_PER_SECOND = 60;
const MS_PER_SECOND = 1000;

/**
 * @typedef {{ resources: ReturnType<typeof import('../resource/index.js').createResourceManager>,
 *   files?: Map<string, Uint8Array>, fileSystem?: FileSystem, now?: () => number, server?: FakeServer,
 *   onLog?: (kind: string, message: string) => void }} VmOptions
 * `now` returns milliseconds (virtual time in the headless runner).
 */

export class Vm {
  /** @param {VmOptions} options */
  constructor(options) {
    this.resources = options.resources;
    this.now = options.now ?? (() => Date.now());
    /** Random kernel source in [0, 1); pass createRandom(seed) for repeatable runs. */
    this.random = options.random ?? Math.random;
    this.trace = new Trace(options.onLog);
    this.memory = new Memory();
    this.memory.onInvalidAccess = (id, access) => this.trace.log('error', `${access} of freed/invalid ID $${id.toString(16)}`);
    this.loader = new ModuleLoader(this.memory, this.resources);
    this.objects = new ObjectModel(this.memory);
    this.strings = new StringStore(this.memory, this.objects);
    this.selectorNames = decodeSelectorNames(this.resources.get(RESOURCE_TYPE.VOCAB, SELECTOR_VOCAB));
    this.selectorIds = new Map(this.selectorNames.map((name, index) => [name, index]));
    this.kernels = buildKernelTable();
    this.interp = new Interpreter(this.memory, this.loader, this.objects, {
      log: (kind, message) => this.trace.log(kind, message),
      callKernel: (number, args) => this.callKernel(number, args),
      selectorName: (number) => this.selectorNames[number] ?? `sel${number}`,
    });
    this.screen = new Screen();
    this.graphics = new Graphics(this);
    this.events = new EventQueue(this);
    this.cursor = createCursor();
    this.fs = options.fileSystem ?? new FileSystem(options.files ?? new Map());
    this.server = options.server ?? new FakeServer();
    this.startMs = this.now();
    this.sleepUntilTick = 0;
  }

  /** Load the game module and queue `(game play:)`. */
  boot() {
    const env = this.loader.load(GAME_MODULE);
    this.interp.globals = this.memory.readWord(env, 8);
    const game = this.loader.exportOf(GAME_MODULE, GAME_EXPORT);
    this.game = game;
    this.interp.startSend(game, PLAY_SELECTOR);
  }

  /** 60 Hz tick counter since boot. */
  ticks() {
    return Math.floor(((this.now() - this.startMs) * TICKS_PER_SECOND) / MS_PER_SECOND);
  }

  /** Execute up to `budget` instructions unless sleeping (kernel Wait). */
  runSlice(budget) {
    if (this.interp.halted || this.ticks() < this.sleepUntilTick) {
      return 0;
    }
    return this.interp.run(budget);
  }

  requestYield() {
    this.interp.yieldRequested = true;
  }

  callKernel(number, args) {
    const entry = this.kernels[number];
    if (!entry) {
      this.trace.log('error', `kernel #${number} out of range (args ${args.join(',')})`);
      return 0;
    }
    this.trace.kernelCall(entry.name, args, Boolean(entry.fn));
    if (!entry.fn) {
      return undefined;
    }
    return entry.fn(this, args);
  }

  /** Selector number by name (-1 when unknown). */
  sel(name) {
    return this.selectorIds.get(name) ?? -1;
  }

  selectorName(number) {
    return this.selectorNames[number] ?? `sel${number}`;
  }

  /** Synchronous message send from kernel code. */
  send(object, selector, ...args) {
    return this.interp.invoke(object, selector, args);
  }

  /** Read a property by selector (0 when missing). */
  prop(object, name) {
    return this.objects.getProperty(object, this.sel(name));
  }

  setProp(object, name, value) {
    this.objects.setProperty(object, this.sel(name), value);
  }
}
