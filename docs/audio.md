# Audio: Sound Blaster / AdLib music and digital sound (src/audio/)

TSN is configured with `music = SNDBLAST.DRV 220` (LSCI.CFG). In SCI1 the
Sound Blaster driver plays the AdLib (device 0x00) track of a sound on the OPL2
FM chip, and plays the sound's 8-bit digital sample on the DAC when the track has
one. That is what this port does. MT-32, General MIDI, PC speaker and Tandy
tracks are parsed but never played.

## Running it

- Browser: open the page, then click the canvas or press any key (browsers need a user
  gesture before audio can start). The control under the canvas shows
  "Sound: click to start", then "Sound: on/off". Click it, or press **Alt+M**, to mute.
  The slider sets the volume. Both settings are kept in localStorage.
  From the console, `tsnAudio.play(201)` plays any sound of the running world and
  `tsnAudio.stop()` stops it.
- Node: `node tools/render-sound.mjs [CC|LL|SL] [number|all] [seconds=30] [loops=1]`
  (also `npm run render-sound -- ...`) writes `out/sound/<world>-<n>.wav` (22 050 Hz,
  16-bit mono). It prints the duration, whether the song ended, peak, RMS, the
  non-silent fraction, the clipped-sample count, and every signal with its tick.
- Tests: `npm run test:audio` (OPL2, sequencer, signals, kernel through the real
  scripts) and `npm run test:resource` (which includes `src/resource/sound.test.mjs`).

## Formats (src/resource/sound.js)

**Sound resource (SCI1).** The header is a list of device tracks:

```
repeat { uint8 device; repeat { uint16 ?, uint16 offset, uint16 size } until 0xFF } until 0xFF
```

- Device `0xF0` is not a track. The first byte of its list is the sound priority (LL 394,
  464 and 724-726: 10; SL 663: 50).
- Every channel block starts with `flags<<4 | channel` and `prio<<4 | voices`,
  followed by a delta-timed MIDI stream:
  - a delta of `0xF8` means 240 ticks;
  - running status is per channel;
  - `0xFC` ends the stream, sometimes followed by a pad byte.
- Channel byte `0xFE` marks a digital sample: `uint16 rate, size, start, end`, then
  unsigned 8-bit PCM.
- Channel flags: 1 = don't map, 2 = don't remap (rhythm channel 9 on MT-32), 4 = start muted.
- `mixTrack` merges a track's channels into one list of absolute-tick events
  (MidiParser_SCI::midiMixChannels). It keeps each channel's true time.
  ScummVM's mixer drops the delta that comes before an early channel's 0xFC.
- Inventory (installed/TSN):
  - CC: 16 sounds; LL: 33; SL: 48. All of them parse.
  - Every sound except SL 800 (MT-32 only, so silent here) has an AdLib track.
  - Digital samples: CC/LL/SL 100, 102, 103, 105 and 106 (6.5-11 kHz, inside the
    AdLib track), and SL 781 and 782.
  - Control channel 15 (cues, loop points) appears only in LL 512 (cues 10/20/30)
    and SL 663 (loop marker).

**Patch 3 (AdLib instruments).** 2690 bytes: 48 instruments of 28 bytes, a 2-byte gap,
then 48 more (96 in all). Each instrument has two 13-byte operator records
(ksl, mult, fb, ar, sl, egt, dr, rr, tl, am, vib, ksr, con), then the two waveforms.
This follows MidiDriver_AdLib::loadInstrument. Patch 1 is the MT-32 bank and
patch 101 is likely the GM map. Neither is used.

## Architecture

| file | role |
|---|---|
| `src/resource/sound.js` | Sound resource parser, `mixTrack`, `decodeAdlibPatch`. |
| `src/audio/opl2.js` | YM3812 emulator at 49 716 Hz. It is a JS re-implementation of Nuked-OPL3's operator, envelope and phase logic (LGPL-2.1+, by nukeykt), reduced to OPL2 (9 channels, waveforms 0-3 gated by register 0x01 bit 5, tremolo/vibrato depth from 0xBD). The log-sin and exp ROMs are computed. Not emulated: rhythm mode, timers, status, CSM. |
| `src/audio/adlib-driver.js` | Port of ScummVM `engines/sci/sound/drivers/adlib.cpp` (GPL), SCI1 mono path: voice mapping through controller 0x4B, round-robin voice search with oldest-note stealing, velocity tables, pitch wheel, hold pedal, master volume and play switch. |
| `src/audio/sound-entry.js` | One playing sound (MidiParser_SCI and MusicEntry). One MIDI tick per 60 Hz tick. Control channel 15 handling: program change 127 = loop point, other program changes = signal (skipped at tick 0), controller 0x60 = cue (`dataInc++`), 0x52 = hold. Also end of track with `loop` counting, fades, channel-state tracking and restore on remap, and volume scaling of controller 7. |
| `src/audio/sound-system.js` | SciMusic: the play list sorted by priority then age, the AdLib driver, a shadow of the OPL registers, and channel remapping of several sounds onto the 15 device channels (a simplified determineChannelMap: essential channels can evict, a voice budget of 9, `playBed` sounds don't remap). It also handles digital samples and the clock (`advanceTo(tick)`). |
| `src/vm/kernel/sound.js` | Kernel `Sound` (#52). See below. |
| `src/audio/opl-renderer.js` | OPL2 plus linear resampling to the output rate, plus a PCM sample mixer. Used by both the worklet and Node. |
| `src/audio/opl-worklet.js` | AudioWorkletProcessor `opl2`. It applies timestamped `[frame, op, ...]` messages at their sample frame and renders. |
| `src/audio/web-audio.js` | AudioContext started on the first gesture, `WorkletSink`, a 10 ms pump, and the mute/volume control. Hooked from `src/web/main.js` with one call. |
| `src/audio/output.js` | Process-wide sink registry (null in Node). |
| `src/audio/offline-render.js`, `tools/render-sound.mjs` | WAV rendering through the same SoundSystem and emulator. |
| `src/audio/installed-worlds.mjs` | Node-only loader for the CC/LL/SL resources, with each land layered over the root. |

### Timing and signals

The sound clock is the VM's 60 Hz `vm.ticks()`. Every `Sound` kernel call first
runs `soundSystem.advanceTo(vm.ticks())`, and the browser pump does the same every
10 ms. Signals, cues, fades and loop ends therefore happen at the same VM tick
whether or not audio is playing. In headless runs (virtual time) and Node tests,
the sink is a null sink and no audio device is needed.
`src/audio/sound-kernel.test.mjs` plays sound 505 on the game's `soundFX` object
through the real `Sound` class. It checks that `Sound::check` sees signal 0xFFFF
after about 20 ticks, and that two runs give identical tick counts.

In the browser, every register write carries the tick it happened on. The sink
maps ticks to AudioContext frames as `(tick/60 + offset) * sampleRate`, with the
offset chosen so writes land about 80 ms ahead of the audio clock. It re-bases
only when the lead leaves the 20-300 ms window, for example after a stall or a
switch to another VM. A Chrome check measured a steady lead of 64-85 ms with no
re-bases, and a non-silent output (RMS of about 0.1 for sound 201).

When a land switch creates a new VM, the pump shuts down the old VM's sounds. When
audio starts after sounds are already running, `setSink` replays the shadowed OPL
registers into the worklet.

### Kernel `Sound` (#52): SCI1-early sub-functions

The numbering is confirmed by the Sound class in module 60049 and by its callers.

| # | function | notes |
|---|---|---|
| 0 | MasterVolume([v]) | returns the previous value. Boot sets 12 (module 105, global 134). |
| 1 | Mute([on]) | the driver's play switch; returns the previous state |
| 2 | Restore | no-op |
| 3 | GetPolyphony | 9. The volume icon (module 900) maps it to a 15-step slider. |
| 4 | Update(obj) | re-reads `loop`, `vol`, `priority` (Sound::changeState) |
| 5 | Init(obj) | creates a slot from `number`, sets `nodePtr`. A missing resource (e.g. number 0) creates no slot, as in SSCI, so `check` stays quiet. |
| 6 | Dispose(obj) | stops, clears `handle` and `nodePtr` |
| 7 | Play(obj, bed) | sets `handle`/`nodePtr`, zeroes `min`/`sec`/`frame`/`signal`. The resource's 0xF0 priority overrides `priority`. |
| 8 | Stop(obj) | `handle` = 0, `signal` = 0xFFFF |
| 9 | Pause(obj or 0, flag) | 0 = all sounds |
| 10 | Fade(obj, to, ticks, step, stop) | a step every `ticks` + 1 ticks. On completion, signal = 0xFFFF, plus a stop if requested. |
| 11 | UpdateCues(obj) | Sound::check, as in processUpdateCues: cue → `dataInc` and signal `dataInc+127`; song signal or end (0xFFFF, which stops the sound); `min`/`sec`/`frame` from the ticker |
| 12 | SendMidi(obj, ch, ctrl, val) | channel is 1-based; ctrl 0xFF = pitch bend |
| 13 | GlobalReverb | no-op |
| 14 | SetHold(obj, n) | |

## Where sounds are used (CC scripts)

Found from `number:` / `play:` sends in `out/module/*.txt`. Global 138 is `soundFX`; the
other Sound instance is `CCMusic`.

| sound | used by |
|---|---|
| 505 | paging and "has just logged in" (59953), Bulletin Board (130), mail (140), print (90) |
| 105 | mail (140, 160), password screens (95, 96) |
| 102, 506 | checkers moves (400, 405, 410) |
| 201, 202 | checkers music (400, 410) |
| 104 | card game (493), loop 3 |
| 203 | icon-bar volume control (900), loop 255 |

Booting to the map and into the LarryLand/SierraLand waiting rooms plays nothing.
The music objects are initialised with number 0, so the first sounds a player
hears are pages, mail and the games.

## Verified renders (out/sound/)

Every sound of every world renders with no clipping (peak at most 0.96). Examples:

- `cc-201.wav`: 9.0 s, RMS 0.20
- `cc-501.wav`: 3.4 s
- `ll-700.wav`: 27.9 s, RMS 0.22
- `sl-878.wav`: 44.6 s
- `cc-100.wav`: 11 kHz PCM sample
- `ll-512.wav`: cues at ticks 239/366/417, end at 447

`sl-663` (65 s) and `sl-806` (104 s) run past the default 60-second limit.

## Known gaps

- MT-32/GM output is not implemented (patch 1/101 unused). SL 800 is silent.
- OPL2 rhythm mode and dual-OPL2 stereo panning are not implemented (the SCI1 driver doesn't use rhythm mode; pan is ignored in mono).
- Channel remapping is a simplified determineChannelMap. It doesn't model SSCI's exact
  device-channel choice or the dynamic voice changes from mid-song 0x4B messages.
  Those changes trigger a full remap instead.
- Looping jumps to the stored event index of the loop point. Channel state changed
  after the loop point isn't rewound, which differs from ScummVM's jumpToTick re-parse.
- Fades don't change digital-sample volume. Sample loop points (`start`/`end`) are
  used only to trim the sample, as ScummVM does.
- In background tabs, browsers throttle the pump (setInterval), so music stutters
  while the tab is hidden. Signals are unaffected.
- The LSCI kernels 90-92 are still unknown. None of them appears to be sound-related.
