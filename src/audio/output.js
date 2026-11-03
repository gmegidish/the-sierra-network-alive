// The process-wide audio output. Node and headless runs never set one, so
// every SoundSystem gets the null sink there; the browser front end installs
// the Web Audio sink (src/audio/web-audio.js) after the first user gesture.

/** @type {import('./sound-system.js').AudioSink | null} */
let sink = null;

/** @param {import('./sound-system.js').AudioSink | null} next */
export function setAudioSink(next) {
  sink = next;
}

export function currentAudioSink() {
  return sink;
}
