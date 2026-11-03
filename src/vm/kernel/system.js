// System kernels: resources, memory, timing, configuration, debugging.
// GetTime / Wait follow stock SCI (ScummVM kmisc.cpp kGetTime / kWait);
// ConfigStr reads "key = value" lines of LSCI.CFG/TSN.CFG (0x13be:0x714 in
// the EXE returns a new string, or 0 when the key is missing).

const PLENTY_OF_MEMORY = 0x7fff;
const CONFIG_FILES = Object.freeze(['LSCI.CFG', 'TSN.CFG']);
const GET_TIME_MODE = Object.freeze({ TICKS: 0, TWELVE_HOUR: 1, DOS_TIME: 2, DOS_DATE: 3 });
const DOS_EPOCH_YEAR = 1980;

/** Parse "key = value" lines (case-insensitive keys). */
function readConfig(vm) {
  if (vm.config) {
    return vm.config;
  }
  vm.config = new Map();
  for (const file of CONFIG_FILES) {
    for (const line of (vm.fs.readText(file) ?? '').split(/\r?\n/)) {
      const match = /^\s*([^=\s]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && !vm.config.has(match[1].toLowerCase())) {
        vm.config.set(match[1].toLowerCase(), match[2]);
      }
    }
  }
  return vm.config;
}

function configStr(vm, [key]) {
  const value = readConfig(vm).get(vm.strings.read(key).toLowerCase());
  return value === undefined ? 0 : vm.strings.create(value);
}

/**
 * GetTime([mode]), modes as the scripts decode them (modules 60063, 60065):
 *  none/0 = ticks; 1 = 12h packed (h<<12 | m<<6 | s);
 *  2 = DOS time (h<<11 | m<<5 | s/2); 3 = DOS date ((year-1980)<<9 | month<<5 | day).
 */
function getTime(vm, [mode]) {
  if (mode === undefined || mode === GET_TIME_MODE.TICKS) {
    return vm.ticks() & 0xffff;
  }
  const now = new Date(vm.now());
  if (mode === GET_TIME_MODE.DOS_TIME) {
    return (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  }
  if (mode === GET_TIME_MODE.DOS_DATE) {
    return ((now.getFullYear() - DOS_EPOCH_YEAR) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  }
  return ((now.getHours() % 12) << 12) | (now.getMinutes() << 6) | now.getSeconds();
}

/**
 * Wait (0xcf7:0x28):
 *  Wait(ticks)        block until `ticks` after the previous Wait(ticks); return elapsed ticks.
 *  Wait(ticks, 0)     arm a frame timer of `ticks`; return 1.
 *  Wait(any, nonzero) poll the frame timer: 0 while it runs (we also yield so
 *                     the idle loop does not spin), else ticks since the last
 *                     firing; firing disarms it. Game::play idles on this.
 */
function wait(vm, args) {
  if (args.length === 1) {
    return blockingWait(vm, args[0]);
  }
  const [ticks, poll] = args;
  if (!poll) {
    vm.frameTimer = { interval: ticks, last: vm.frameTimer?.last ?? vm.ticks() };
    return 1;
  }
  return pollFrameTimer(vm);
}

function blockingWait(vm, ticks) {
  const now = vm.ticks();
  const last = vm.lastWaitTick ?? now;
  vm.lastWaitTick = Math.max(now, last + ticks);
  vm.sleepUntilTick = vm.lastWaitTick;
  vm.requestYield();
  return (vm.lastWaitTick - last) & 0xffff;
}

function pollFrameTimer(vm) {
  const timer = vm.frameTimer;
  if (!timer || !timer.interval) {
    return 0;
  }
  const now = vm.ticks();
  const due = timer.last + timer.interval;
  if (due > now) {
    vm.sleepUntilTick = due;
    vm.requestYield();
    return 0;
  }
  vm.frameTimer = { interval: 0, last: now };
  return Math.max(1, now - timer.last) & 0xffff;
}

const noOp = () => undefined;

export const systemKernels = Object.freeze({
  Resource: () => 1,
  Memory: () => PLENTY_OF_MEMORY,
  ConfigStr: configStr,
  GetTime: getTime,
  Wait: wait,
  SetTimerFreq: noOp,
  Debug: noOp,
  Profiler: noOp,
  SetDebug: noOp,
  ShowFree: noOp,
  StackUsage: () => 0,
  Sound: () => 0,
  GameIsRestarting: () => 0,
  Restart: (vm) => {
    vm.interp.halted = true;
    return undefined;
  },
  Joystick: () => 0,
  DeviceInfo: () => 0,
  CheckSaveGame: () => 0,
  GetSaveDir: (vm) => vm.strings.create('.\\'),
  GetSaveFiles: () => 0,
  Save: () => 0,
  Restore: () => 0,
  Alert: (vm, [text]) => {
    vm.trace.log('alert', vm.strings.read(text));
    return 1;
  },
  Encrypt: (vm, [id]) => id,
  Decrypt: (vm, [id]) => id,
});
