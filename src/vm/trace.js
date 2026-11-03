// Execution trace: kernel call counts, first-seen arguments, errors and
// unimplemented kernels. This is what the headless runner writes to out/run/.

const MAX_SAMPLES_PER_KERNEL = 8;
const MAX_LOG_LINES = 5000;

/**
 * @typedef {{ count: number, implemented: boolean, samples: number[][] }} KernelStats
 */

export class Trace {
  /** @param {(kind: string, message: string) => void} [onLog] */
  constructor(onLog) {
    this.onLog = onLog ?? (() => {});
    /** @type {Map<string, KernelStats>} */
    this.kernels = new Map();
    /** @type {string[]} */
    this.lines = [];
    this.errorCount = 0;
    this.recordCalls = false;
    /** @type {string[]} */
    this.recentCalls = [];
  }

  log(kind, message) {
    if (kind === 'error') {
      this.errorCount++;
    }
    const line = `[${kind}] ${message}`;
    if (this.lines.length < MAX_LOG_LINES) {
      this.lines.push(line);
    }
    this.onLog(kind, message);
  }

  kernelCall(name, args, implemented) {
    let stats = this.kernels.get(name);
    if (!stats) {
      stats = { count: 0, implemented, samples: [] };
      this.kernels.set(name, stats);
      if (!implemented) {
        this.log('stub', `unimplemented kernel ${name}(${args.join(', ')})`);
      }
    }
    stats.count++;
    if (stats.samples.length < MAX_SAMPLES_PER_KERNEL) {
      stats.samples.push(args);
    }
    if (this.recordCalls) {
      this.recentCalls.push(`${name}(${args.join(',')})`);
      if (this.recentCalls.length > 200) {
        this.recentCalls.shift();
      }
    }
  }

  /** Text report of kernel usage. */
  kernelReport() {
    return [...this.kernels.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, stats]) => {
        const flag = stats.implemented ? ' ' : '*';
        const samples = stats.samples.slice(0, 3).map((args) => `(${args.join(',')})`).join(' ');
        return `${flag} ${name.padEnd(18)} ${String(stats.count).padStart(8)}  ${samples}`;
      })
      .join('\n');
  }
}
