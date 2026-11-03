// Turns OPL2 register writes and digital sample starts into float audio at an
// arbitrary output rate: the chip runs at its native 49716 Hz and is linearly
// resampled (as Nuked-OPL3's OPL3_GenerateResampled does); 8-bit unsigned PCM
// samples are resampled the same way and mixed on top. Shared by the
// AudioWorklet (browser) and tools/render-sound.mjs (Node).
import { Opl2, OPL_RATE } from './opl2.js';

// One full-scale OPL voice is +-4084; the loudest TSN songs (several voices) then peak below 1.
const OPL_GAIN = 1 / 22000;
const PCM_GAIN = 0.6;
const PCM_CENTER = 128;

/**
 * @typedef {{ id: number, pcm: Uint8Array, step: number, position: number, loopsLeft: number, volume: number }} PcmVoice
 */

export class OplRenderer {
  /** @param {number} outputRate */
  constructor(outputRate) {
    this.outputRate = outputRate;
    this.chip = new Opl2();
    this.ratio = OPL_RATE / outputRate;
    this.phase = 1;
    this.previous = 0;
    this.current = 0;
    /** @type {PcmVoice[]} */
    this.pcmVoices = [];
    this.gain = 1;
  }

  write(reg, value) {
    this.chip.write(reg, value);
  }

  /** @param {number} id @param {Uint8Array} pcm @param {number} rate @param {number} loops @param {number} volume */
  playSample(id, pcm, rate, loops, volume) {
    this.stopSample(id);
    this.pcmVoices.push({ id, pcm, step: rate / this.outputRate, position: 0, loopsLeft: loops, volume });
  }

  stopSample(id) {
    this.pcmVoices = this.pcmVoices.filter((voice) => voice.id !== id);
  }

  nextOplSample() {
    this.phase += this.ratio;
    while (this.phase >= 1) {
      this.previous = this.current;
      this.current = this.chip.generate();
      this.phase -= 1;
    }
    return this.previous + (this.current - this.previous) * this.phase;
  }

  nextPcmSample() {
    let sum = 0;
    for (const voice of this.pcmVoices) {
      const index = Math.floor(voice.position);
      const a = voice.pcm[index] ?? PCM_CENTER;
      const b = voice.pcm[index + 1] ?? a;
      const fraction = voice.position - index;
      sum += (((a + (b - a) * fraction) - PCM_CENTER) / PCM_CENTER) * voice.volume;
      voice.position += voice.step;
      if (voice.position >= voice.pcm.length) {
        voice.position -= voice.pcm.length;
        voice.loopsLeft -= 1;
      }
    }
    if (this.pcmVoices.some((voice) => voice.loopsLeft <= 0)) {
      this.pcmVoices = this.pcmVoices.filter((voice) => voice.loopsLeft > 0);
    }
    return sum * PCM_GAIN;
  }

  /** Fill `out[start..start+count)` with mono samples in [-1, 1]. */
  render(out, start, count) {
    for (let i = start; i < start + count; i += 1) {
      const mixed = (this.nextOplSample() * OPL_GAIN + this.nextPcmSample()) * this.gain;
      out[i] = mixed > 1 ? 1 : mixed < -1 ? -1 : mixed;
    }
  }
}
