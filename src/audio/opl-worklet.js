// AudioWorkletProcessor running the OPL2 emulator (and the PCM sample mixer)
// on the audio thread. The main thread posts batches of timestamped
// operations (see src/audio/web-audio.js):
//   [frame, OP_WRITE, reg, value]
//   [frame, OP_SAMPLE, id, { pcm, rate, loops, volume }]
//   [frame, OP_STOP_SAMPLE, id]
// `frame` is an absolute AudioContext sample frame; operations whose frame has
// already passed are applied at once.
import { OplRenderer } from './opl-renderer.js';

const OP_WRITE = 0;
const OP_SAMPLE = 1;
const OP_STOP_SAMPLE = 2;

class OplProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.renderer = new OplRenderer(sampleRate);
    this.queue = [];
    this.port.onmessage = (event) => this.enqueue(event.data);
  }

  enqueue(ops) {
    const wasSorted = this.queue.length === 0 || ops.length === 0 || ops[0][0] >= this.queue[this.queue.length - 1][0];
    this.queue.push(...ops);
    if (!wasSorted) {
      this.queue.sort((a, b) => a[0] - b[0]);
    }
  }

  apply(op) {
    if (op[1] === OP_WRITE) {
      this.renderer.write(op[2], op[3]);
    } else if (op[1] === OP_SAMPLE) {
      const { pcm, rate, loops, volume } = op[3];
      this.renderer.playSample(op[2], pcm, rate, loops, volume);
    } else if (op[1] === OP_STOP_SAMPLE) {
      this.renderer.stopSample(op[2]);
    }
  }

  /** Apply due operations; return how many frames to render before the next one. */
  applyDue(frame, remaining) {
    let index = 0;
    while (index < this.queue.length && this.queue[index][0] <= frame) {
      this.apply(this.queue[index]);
      index += 1;
    }
    if (index > 0) {
      this.queue.splice(0, index);
    }
    if (this.queue.length === 0) {
      return remaining;
    }
    return Math.max(1, Math.min(remaining, this.queue[0][0] - frame));
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    const first = channels[0];
    let offset = 0;
    while (offset < first.length) {
      const count = this.applyDue(currentFrame + offset, first.length - offset);
      this.renderer.render(first, offset, count);
      offset += count;
    }
    for (let c = 1; c < channels.length; c += 1) {
      channels[c].set(first);
    }
    return true;
  }
}

registerProcessor('opl2', OplProcessor);
