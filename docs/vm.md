# LSCI VM (src/vm/)

A JavaScript interpreter for the LSCI bytecode of The Sierra Network's
LSCITV.EXE. It runs the CC (root) world in the browser and headless in Node.
It is plain ES modules with no dependencies and no build step.

Ground truth is the LZEXE-unpacked LSCITV.EXE. The data segment is 0x1b14.
Addresses below are `segment:offset` in the unpacked image. Where LSCI matches
stock SCI1.1, ScummVM was used as a cross-check.

## Running it

### Browser

```
npm install                    # once, for the local TSN host (express, ws)
node tools/make-manifest.mjs   # once: writes installed/TSN/manifest.json
npm run server                 # serves the repo on http://127.0.0.1:7000/ plus the /line WebSocket
open http://127.0.0.1:7000/    # index.html
```

Any static server works if you only want the in-page fake host, for example
`python3 -m http.server 8000` followed by `http://localhost:8000/?host=fake`.

- By default the TSN kernel talks to the local host over
  `ws://localhost:7000/line` (`LineHost`).
- `?host=fake` uses the in-process `FakeServer` instead.
- The canvas is 320x200, scaled with `image-rendering: pixelated` to a 4:3 box.
- Mouse and keyboard go into the VM's event queue (`src/web/input.js`).
- `window.tsnVm` is the running VM, for poking at it from the console.

### Headless

```
node tools/run-headless.mjs [frames=600] [instructionsPerFrame=20000] [screenshotEvery=60] [input]
# input: "frame@x,y" clicks, "frame@key:code" keys and "frame@text:abc" typing, separated by ";"
node tools/run-headless.mjs 2600 20000 650 "650@282,66"   # boot, click Play, log in, TSN map
```

The headless runner uses virtual time: one frame is 1/60 s. It writes the
following to `out/run/`:

| file | contents |
|---|---|
| `frameNNNN.png` | screenshots |
| `kernels.txt` | call counts and sample arguments per kernel; `*` marks an unimplemented kernel |
| `log.txt` | errors, stubs and file opens |
| `tsn.txt` | the fake host's packet-type table and its full log |
| `stack.txt` | the VM frames and the last 200 kernel calls |

### Tests

`npm run test:vm` runs:

- `src/vm/opcodes.test.mjs`: hand-assembled bytecode.
- `src/vm/objects.test.mjs`: dispatch, super, clones.
- `src/vm/boot.test.mjs`: boots CC, clicks Play, and asserts that login and joinNet go out and pic 50 is drawn; the status bar fills rows 0-9; the Select Player card shows the face and the "Gil" strip (not the empty card yellow); the cursor overlay draws view 897 without touching the framebuffer.
- `src/vm/real-host.test.mjs`: the same login against `server/session.js` over LinkEndpoint and the X.28 PAD, joined by an in-memory line; asserts room 50 and a single 36/6.
- `src/vm/lands.test.mjs`: TSN.PRG, directory views, edit keys, raw Array copy, and map -> LarryLand chooser -> LarryLand player screen.
- `src/net/fake-server.test.mjs`: shared host logic (SIDs, land list, groups, member properties).
- `src/vm/multiplayer.test.mjs`: two headless clients on one `World` (each with its own `FakeServer({ world })`): both reach the LarryLand waiting room, Gil's client learns Kris's name, Gil talks and Kris's client gets the line; then Kris opens a BlackJack table, Gil joins, and both screens show the same deal and result (~30 s).

## Architecture

| file | role |
|---|---|
| `vm.js` | `Vm`: wires memory, loader, interpreter, kernels, screen, graphics, events, filesystem and the TSN host. `boot()` loads module 0 and sends `play` (selector 26) to export 0 (class 148, CC). `runSlice(n)` runs n instructions, unless the VM is sleeping in Wait. |
| `memory.js` | The memory-ID table. IDs are multiples of 4 from 4 to 0x3ffc, lowest free first. Each entry has a type byte, like the EXE's {segment, type}. Reading or writing a freed ID is reported and ignored, because scripts do it and DOS tolerated it. |
| `loader.js` | Module loader (segment 0x27b). It creates the env record (type 13), reserves block IDs, applies fixups to every block kind except 7, 8 and 10, and initialises objects and classes (-env-, -super-, -dict-, the class table). |
| `objects.js` | Property lookup through the -dict- propDict, the method table, the -super- chain, and clones. |
| `interpreter.js` | The PMachine (segment 0x7f7). It keeps an explicit frame stack so it can yield at any instruction. It also handles `send` (message parsing and &rest), `invoke` for kernel-to-script callbacks, and kernel calls. |
| `opcodes.js` | All opcodes. LSCI differences: loadID/pushID share the ldi/pushi handlers; `call` takes a 16-bit code ID; `calle` takes module, entry byte and argBytes byte; class/super take class numbers. |
| `strings.js` | String blocks (type 7) and byte arrays. An object where a string is expected stands for its `data` property, as the EXE's helper 0x243:0x1e3 does. |
| `format.js` | `%d %u %x %c %s` formatting for String(1/2). |
| `events.js` | The event queue. Event types are 1/2 mouse, 4/8 key, 0x40 direction and 0x400 network. |
| `filesystem.js` | An in-memory DOS filesystem over the installed tree. It is case-insensitive and backslash-normalised. Writes stay in memory. `inDirectory(dir)` gives a view with its own current directory (`..\` climbs to the root) over the same files. |
| `root-resources.js`, `node-loader.mjs` | Build the resource manager and the VM from a file map (browser) or from disk (Node). |
| `trace.js` | Kernel-call statistics and the log. |
| `kernel/*.js` | The kernel table (`index.js`) and its implementations, grouped by area. |
| `../gfx/screen.js`, `graphics.js`, `text.js` | The visual, priority and control planes; ports; pic, cel and text drawing; saved bits; the static background used by Animate. |
| `programs.js` | TSNEXEC chaining: `TSN.PRG` parsing, layered resources for a land directory (land map, volume and patches over the root, as `pathStr = ..\`), and `nextProgramVm(vm)`, the VM TSNEXEC would start after `vm` quits. It shares the files, the host connection and the TSN buffer. |
| `kernel/edit.js` | EditControl: key editing of class 47 edit items (`text`, `max`, `cursor`). |
| `../net/fake-server.js` | The in-process host. It wraps the same `HostLogic` (src/net/host-logic.js) the real server runs. Decoded packets go in and queued replies come out. Handlers can be overridden with `on(type, fn)`, and every packet type is logged. |
| `../net/line-host.js` | The same interface over the real line: WebSocket, then the X.28 PAD dialog, then `LinkEndpoint`, as described in docs/server.md. |
| `../web/main.js`, `input.js` | The browser front end. |

### The host interface (FakeServer / LineHost)

The TSN kernel uses only this interface. A future Express or WebSocket move
only has to provide the same object.

```
connect(target) -> bool        disconnect()
status() -> {connected, linkType}       // linkType 3 = modem (1 serial, 2 novell)
receivePacket({type, sub, format, fields, bytes})
takeReplies() -> Uint8Array[]  // called by TSN(8) poll; each becomes event 0x400
isIdle?() -> bool              // TSN(12)
note(kind, detail), report()
```

## Kernels

Every kernel number from 0 to 92 has an entry. The EXE's own table stops at
88; scripts also call 89 to 92, so those are appended.

**Real implementations**

- Objects: IsObject, ObjectNew, ObjectFree, ObjectRespondsTo, ModuleID, ModuleDispose, InvokeMethod, ObjPropOffset, ObjOffsetProp.
  - SID (0x126a:0x74e). `lookup(0)` returns the game object.
- Data structures and math:
  - Array (0x993, sub-ops 0-7), String (0-4), Block (0-2), List (0-13). Array copy (6) is a raw byte memmove of count * source element size, as in 0x993:0x411; fill (5) with count -1 runs to the end.
  - Seq (0-6). Sub-op 6 retargets the iterator to another list.
  - Long (0-12), Abs, Sqrt, GetAngle, GetDistance, Random, Sin/CosMult, Sin/CosDiv.
- Graphics:
  - DrawPic, CoordPri, GetPort, SetPort (-1 = the whole-screen port, used for the status bar), GlobalToLocal, LocalToGlobal.
  - Cels are clipped to their port.
  - WindowNew (0x3e7:0x26f/0x42e): the rect is relative to the window-manager port (top 10, like SCI's wmgrPort). Type 0x8000 draws nothing (the scripts draw the box and save under it with Graph 14); otherwise bit 1 saves the area under the frame and fills the port, then a `borderSize` border outside the rect and a `shadowSize` shadow. WindowDispose restores the saved area. The title bar (bit 2) isn't drawn.
  - Graph sub-ops 1, 3, 6, 7, 10, 11, 12, 14, 15 (14/15 are a second save/restore-bits pair, 0x599:0x91f/0x94a).
  - k89 Palette FindColor (nearest RGB).
- Views:
  - Animate: doit, erase from the static background, priority-sorted redraw, nsRect written back. Stop-updated members (signal bit 1) that haven't changed stay on screen untouched, so cels drawn over them with DrawCel survive (the Select Player card face).
  - DrawCel(view, loop, cel, left, top, priority) takes the cel's top-left corner, not its origin (scripts get it from CelRect); icon controls also draw at the rect's top-left.
  - AddToPic, CelRect, CelWide, CelHigh, NumLoops, NumCels.
  - OnControl, CanBeHere (control plane against illegalBits only).
- Text:
  - Display (commands 100-108 and 121; save-under), TextSize, GetFarText.
  - DrawControl (button, text, edit, icon), HiliteControl. Text with no colour of its own (-1) uses the port's pen.
  - EditControl(item, event): printable keys insert at `cursor` (up to `max`), Backspace/Delete/Left/Right/Home/End, the event is claimed; event 0 redraws without the caret. Only type 3 (edit) items are touched: dialogs pass the focused item whatever it is, and drawing a button as a field put a caret before CANCEL.
- Input: GetEvent (peek with mask bit 0x8000), MapKeyToDir, HaveMouse. SetCursor (0x6a6:0x5b0): argc 1 show/hide, 2 move, 3 view/loop/cel, 5 with an explicit hotspot. The cursor (view 897) is an overlay (`src/gfx/cursor.js`) composited over the RGBA output each frame, never into the framebuffer; the hotspot defaults to the cel's origin. The canvas has `cursor: none`.
- Time:
  - GetTime.
  - Wait (0xcf7:0x28) has three forms:
    - `Wait(t)` blocks;
    - `Wait(t, 0)` arms the frame timer;
    - `Wait(x, 1)` polls the frame timer, returning 0 until it fires. Game::play idles on this.
- Files: FileSystem (0xd0d:0, sub-ops 0-15): open, close, read/write strings and bytes, seek, tell, read/write blocks, unlink, isDirectory, findFirst/findNext, getCWD.
- Configuration: ConfigStr (LSCI.CFG, then TSN.CFG).
- TSN (#84): every sub-function is logged; see below. TSN(9, name) returns 1 when TSN.PRG has that program and remembers it for `nextProgramVm`; TSN(2, 0, 0) clears the shared buffer.

**Stubs**

| kernel | behaviour |
|---|---|
| Sound | returns 0 |
| PicState, Show, ShakeScreen, ColorUp, ColorDown, BaseRectSet | no-ops |
| Menu | returns 0 |
| Joystick, DeviceInfo, CheckSaveGame, Save, Restore, GetSaveFiles | return 0 |
| Resource | returns 1 |
| Memory | returns 0x7fff |
| Encrypt, Decrypt | identity |
| Kernel90-92 | unknown; return 0 |
| Graph sub-ops 0, 2, 5, 8, 9, 13 | logged as `todo` |

Cel scaling is ignored.

## How far boot gets

Headless run: `node tools/run-headless.mjs 2600 20000 650 "650@282,66"`.

1. **Frame 650, the Select Player screen** (`out/run/frame0650.png`). It shows
   the "ImagiNation v2.1" title, the player card and the Play, Change, Create,
   Delete, Exit, Print and Help buttons. PLAYER.DIR, GAME.CFG and the persona
   `Gil.DTA` have been read.
2. **Clicking Play opens the dial screen** (pic with the satellite). TSN(0)
   reports linkType 3 (modem). The client dials `ATZtSIERRAATDT1!~`.
3. **The client logs in**:
   - it sends login 53 and gets the host's reply;
   - it sends joinNet 7 and receives SID 256;
   - it sends the startup burst: 36/5, 45/1, 36/1, 36/6, 37/32 and 40/4;
   - it receives the land list and the done message;
   - it sends 47/1 and receives done.
4. **Frame 2600, the TSN map** (pic 50, `out/run/headless-room50.png`):
   - the status bar ("ImagiNation v2.1 / Map") is drawn at rows 0-9 through
     the screen port (`SetPort(-1)`, module 0 block 74); the picture starts at row 10;
   - the hotspots respond to clicks: LarryLand, SierraLand, MedievalLand, the Clubhouse, the Mall, the Post Office and others.
5. **The land chooser.** Clicking LarryLand (80, 30) or SierraLand (286, 90)
   lists that land from LandAddr (`out/run/land-chooser.png`).
6. **Entering a land.** Picking the first entry (80, 90) sends joinNet and leaveNet
   9, calls TSN(9, "LLand") and quits. `nextProgramVm` boots LSCITV again in
   `LL` (or `SL`) with the land's own resources, and the land shows its
   Select Player screen (`out/run/larryland-player.png`, `sierraland-player.png`).
7. **Inside a land.** Create a persona (form with edit fields, appearance,
   hobbies, Save), click Play, pick a game, OK. The land joins its waiting-room
   group and reaches the **Waiting Room** (`out/run/larryland-waiting-room.png`,
   `sierraland-waiting-room.png`): the Talk / Look / Play / Go to / Options
   panel responds. The waiting rooms are chat-and-games hubs, not walkable
   rooms.

The same flow runs in the browser against `npm run server`
(`out/run/browser-room50.png`, `out/run/browser-larryland.png`).

The headless input for LarryLand, up to the waiting room:

```
650@282,66;2450@80,30;2600@80,90;3500@125,190;4250@text:Gil;4300@125,109;4320@text:30;
4350@165,122;4370@text:Explorer;4400@147,135;4420@text:1234;4460@127,152;4900@90,188;
5300@90,188;5700@90,188;5950@225,188;6700@25,190;7500@115,92;7520@205,92;7600@210,141
```

Then `8600@285,120;9100@205,78` (Play, Slots) creates a game and enters the
Slots room (`out/run/larryland-slots-room.png`), and `10200@95,70` opens the
"Grab the Cash" machine. `10800@122,133;10900@163,47` raises the bet to 2 and
pulls; with `SEED=22` that is three cherries, +10 (`larryland-slots-win.png`).
BlackJack instead: `9100@115,78`, then `10100@22,22` (a 5 chip) and
`10950@130,55` (Stand); with `SEED=1` the dealer busts (`larryland-blackjack-win.png`).
src/vm/larryland-games.test.mjs runs both.

**Resource ids.** LSCI ids are `(type << 11) + number` truncated to 16 bits,
so view 6000 (a LarryLand face) has the same id as module 1904, and the map
decodes it as that. The interpreter looks resources up by id, so the
resource manager falls back to the id when the decoded (type, number) misses.

Known script-level errors: writes to a freed object ($11bc, $1998) and `view`
sends to freed objects when rooms are disposed. They are harmless.

## Observed TSN calls and packets (fake host)

| call / packet | args / fields | reply |
|---|---|---|
| TSN(0) status | — | `0x0103` once connected (low byte 3 = modem; anything other than 1/2/3 gives "Comm driver problems.") |
| TSN(7) disconnect | — | first call of dialScript |
| TSN(3) connect | `"ATZtSIERRAATDT1!~"` (prefix `t` + hostID `SIERRA` + modem init/dial strings from TSN.CFG) | 1 |
| 53/0 login `bbwbbbbwwbas` | 53, 0, 0, number 1, ver 2.1.17, g262 1, g261 0, pwFromFile 1, 11, scrambled pw (= "123456"), "Gil" | `00 00 00 00 16 <priv w> 00 <landAccess w>` |
| 7 joinNet `wwwbbww` | 7, 0, objID 88 (CC), flags 0x81, number 1, 0, 12 | `08 00 58 00 00 00 <sid w>` |
| 36/5 `bb` | — | `24 05 01 00` (host number 1) |
| 45/1 `bbw` | sid | none |
| 36/1 `bbw+` | 0, 0 (hostaddr.tim absent) | none |
| 36/6 `bbw+` | 0, 0 (landaddr.tim absent) | land list (47/2), then `01 00 00 00 24 06` |
| 37/32 `bbw+` | 0, 0, 0 | none |
| 40/4 `bbs` | persona "Gil" | none |
| 47/1 `bbw+` and `bbww` | 0, 0 (sent twice) | land info (cmd 47 msgType 1), then `01 00 00 00 2F 01` |
| TSN(8) poll, TSN(14) flush | every game cycle once connected | — |

**Findings that matter for the host:**

- **Land list layout.** Message class 125 moves the payload from offset 6 to
  0, and dialScript then reads the count at payload word 4 and the records
  from payload offset 6. So the land records start at message offset **12**:
  `2F 02 <toSid w> 00 00 | 00 00 00 00 <count w> records...`.
- **Land access.** The login reply's word@8 becomes g253, the land access
  mask. Land n is allowed when bit (n-1) is set (module 50 block 206). With
  w8 = 1 only the Clubhouse is allowed, and it isn't installed, so the map
  says "no access rights". FakeServer sends 0xffff.
- **Messages to SID 0.** Messages addressed to SID 0 (login replies) reach the
  game object through `SID(3, 0)`.

## What's left (priority order)

1. **Money persistence.** LL's money file lives in the in-memory filesystem,
   so a reload asks the bank again (see 7).
2. **Roulette and Poker**, untried.
3. **TSN Clubhouse.** Program `Sierr` runs the root again, but the map says
   "TSN Clubhouse has not been installed"; find what module 50 checks
   (LAND.CFG directory `.`).
4. **Other players.** Presence, talk, joining a game and BlackJack between
   two clients work (docs/server.md "Multiplayer"). Not yet: paging and "has
   just logged in" (module 59953), the waiting-room head count, Poker/Roulette
   and SierraLand games over the net, bots that play.
5. **Graph sub-ops** 0, 2, 5, 8, 9 and 13, plus Kernel90-92. Display mode 1 centres button labels inside their width, but in DOSBox the Select Player button labels sit at their x; unexplained (0x50a:0x55a reads as centring).
6. **Sound** is being added separately (src/audio/, kernel/sound.js).
7. **Persistence.** Save in-memory filesystem writes (PLAYER.DIR, *.DTA,
   landaddr.tim) to IndexedDB in the browser.
