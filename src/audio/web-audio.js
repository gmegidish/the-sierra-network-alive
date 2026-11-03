// Browser audio output: an AudioContext with the OPL2 AudioWorklet, a sink that
// timestamps register writes from the VM's sound clock, a pump that keeps the
// running VM's SoundSystem advanced to vm.ticks(), and a small sound control
// (button + volume slider under the canvas, Alt+M toggles mute).
// Browsers only allow audio after a user gesture, so the context is created on
// the first click or key press; until then sounds run silently (NULL_SINK),
// and the chip state is replayed into the worklet when it starts.
import { setAudioSink } from './output.js';
import { soundSystemOf } from '../vm/kernel/sound.js';

const TICKS_PER_SECOND = 60;
const MIN_LEAD_SECONDS = 0.02;
const TARGET_LEAD_SECONDS = 0.08;
const MAX_LEAD_SECONDS = 0.3;
const PUMP_INTERVAL_MS = 10;
const OP = Object.freeze({ WRITE: 0, SAMPLE: 1, STOP_SAMPLE: 2 });
const STORAGE_KEY = 'tsn-audio';
const DEFAULT_VOLUME = 0.7;
// Slot key for console auditions; not a VM memory ID, so it never collides with a script's sound.
const AUDITION_OBJECT = 0x10000;
const AUDITION_SETTINGS = Object.freeze({ loop: 1, priority: 0, volume: 127, playBed: false });

/**
 * @typedef {{ canvas: HTMLCanvasElement, getVm: () => any }} AudioStartOptions
 * @typedef {{ volume: number, muted: boolean }} AudioPreferences
 */

/** Sink posting timestamped operations to the worklet, flushed by the pump. */
class WorkletSink {
  constructor(context, port) {
    this.context = context;
    this.port = port;
    this.offset = null;
    this.pending = [];
  }

  /** Keep "tick -> audio time" slightly ahead of the audio clock. */
  sync(tick) {
    const now = this.context.currentTime;
    const at = this.offset === null ? -Infinity : tick / TICKS_PER_SECOND + this.offset;
    if (at < now + MIN_LEAD_SECONDS || at > now + MAX_LEAD_SECONDS) {
      this.offset = now + TARGET_LEAD_SECONDS - tick / TICKS_PER_SECOND;
    }
  }

  frameOf(tick) {
    if (this.offset === null) {
      this.sync(tick);
    }
    return Math.round((tick / TICKS_PER_SECOND + this.offset) * this.context.sampleRate);
  }

  write(tick, reg, value) {
    this.pending.push([this.frameOf(tick), OP.WRITE, reg, value]);
  }

  playSample(tick, id, sample, loops, volume) {
    const options = { pcm: sample.samples.slice(), rate: sample.rate, loops, volume };
    this.pending.push([this.frameOf(tick), OP.SAMPLE, id, options]);
  }

  stopSample(tick, id) {
    this.pending.push([this.frameOf(tick), OP.STOP_SAMPLE, id]);
  }

  flush() {
    if (this.pending.length) {
      this.port.postMessage(this.pending);
      this.pending = [];
    }
  }
}

function loadPreferences() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return { volume: stored?.volume ?? DEFAULT_VOLUME, muted: Boolean(stored?.muted) };
  } catch {
    return { volume: DEFAULT_VOLUME, muted: false };
  }
}

function savePreferences(preferences) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // storage unavailable (private window): keep the setting for this page only
  }
}

function createControls(canvas) {
  const bar = document.createElement('div');
  bar.className = 'audio-controls';
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;font:12px monospace;color:inherit';
  const button = document.createElement('button');
  button.type = 'button';
  button.style.cssText = 'font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:3px;padding:2px 8px;cursor:pointer';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.setAttribute('aria-label', 'Volume');
  bar.append(button, slider);
  canvas.insertAdjacentElement('afterend', bar);
  return { button, slider };
}

class WebAudioOutput {
  /** @param {AudioStartOptions} options */
  constructor({ canvas, getVm }) {
    this.getVm = getVm;
    this.preferences = loadPreferences();
    this.controls = createControls(canvas);
    this.context = null;
    this.sink = null;
    this.gain = null;
    this.state = 'waiting';
    this.lastVm = null;
    this.bindControls(canvas);
    this.render();
    setInterval(() => this.pump(), PUMP_INTERVAL_MS);
  }

  bindControls(canvas) {
    const { button, slider } = this.controls;
    slider.value = String(Math.round(this.preferences.volume * 100));
    button.addEventListener('click', () => this.toggleMute());
    slider.addEventListener('input', () => this.setVolume(Number(slider.value) / 100));
    const start = () => this.start();
    canvas.addEventListener('pointerdown', start);
    window.addEventListener('keydown', (event) => {
      if (event.altKey && event.code === 'KeyM') {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.toggleMute();
        return;
      }
      start();
    }, { capture: true });
  }

  render() {
    const labels = { waiting: 'Sound: click to start', starting: 'Sound: starting', failed: 'Sound unavailable' };
    const label = labels[this.state] ?? (this.preferences.muted ? 'Sound: off (Alt+M)' : 'Sound: on (Alt+M)');
    this.controls.button.textContent = label;
    this.controls.button.setAttribute('aria-pressed', String(!this.preferences.muted));
  }

  applyGain() {
    if (this.gain) {
      this.gain.gain.value = this.preferences.muted ? 0 : this.preferences.volume;
    }
  }

  toggleMute() {
    if (this.state === 'waiting') {
      this.start();
      return;
    }
    this.preferences = { ...this.preferences, muted: !this.preferences.muted };
    savePreferences(this.preferences);
    this.applyGain();
    this.start();
    this.render();
  }

  setVolume(volume) {
    this.preferences = { ...this.preferences, volume, muted: false };
    savePreferences(this.preferences);
    this.applyGain();
    this.render();
  }

  async start() {
    if (this.context) {
      this.context.resume();
      return;
    }
    this.state = 'starting';
    this.render();
    try {
      await this.createGraph();
      this.state = 'running';
    } catch (error) {
      this.state = 'failed';
      this.controls.button.title = String(error?.message ?? error);
    }
    this.render();
  }

  async createGraph() {
    const context = new AudioContext();
    this.context = context;
    await context.audioWorklet.addModule(new URL('./opl-worklet.js', import.meta.url));
    const node = new AudioWorkletNode(context, 'opl2', { numberOfInputs: 0, outputChannelCount: [2] });
    this.gain = context.createGain();
    node.connect(this.gain).connect(context.destination);
    this.applyGain();
    this.sink = new WorkletSink(context, node.port);
    setAudioSink(this.sink);
    this.getVm()?.soundSystem?.setSink(this.sink);
    await context.resume();
  }

  /** Console helper: play sound resource `number` of the running world (tsnAudio.play(201)). */
  audition(number) {
    this.start();
    const system = soundSystemOf(this.getVm());
    if (!system.hasSound(number)) {
      return `no sound ${number} in this world`;
    }
    system.init(AUDITION_OBJECT, number, AUDITION_SETTINGS);
    system.play(AUDITION_OBJECT, AUDITION_SETTINGS);
    return `playing sound ${number}`;
  }

  stopAudition() {
    soundSystemOf(this.getVm()).dispose(AUDITION_OBJECT);
  }

  /** Advance the running VM's sounds to its clock and ship the writes. */
  pump() {
    const vm = this.getVm();
    if (vm !== this.lastVm) {
      this.lastVm?.soundSystem?.shutdown();
      this.lastVm = vm;
    }
    const system = vm?.soundSystem;
    if (!system) {
      this.sink?.flush();
      return;
    }
    if (this.sink && system.sink !== this.sink) {
      system.setSink(this.sink);
    }
    this.sink?.sync(system.tick);
    system.advanceTo(vm.ticks());
    this.sink?.flush();
  }
}

/** Create the audio output and its controls. @param {AudioStartOptions} options */
export function startAudio(options) {
  const output = new WebAudioOutput(options);
  window.tsnAudio = { play: (number) => output.audition(number), stop: () => output.stopAudition(), output };
  return output;
}
