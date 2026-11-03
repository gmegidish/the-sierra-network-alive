# LSCI VM (src/vm/)

A JavaScript interpreter for the LSCI bytecode of The ImagiNation Network's
LSCITV.EXE (the May 1995 build, ImagiNation v2.4, installed in
`installed/INN`). It runs the Clubhouse (`CC`), CasinoLand (`LL`) and
SierraLand (`SL`) worlds in the browser and headless in Node. The 1992 TSN
v2.1 build is no longer the target.
It is plain ES modules with no dependencies and no build step.

Ground truth is the LZEXE-unpacked LSCITV.EXE. The data segment is 0x1b14.
Addresses below are `segment:offset` in the unpacked image. Where LSCI matches
stock SCI1.1, ScummVM was used as a cross-check.

## Running it

### Browser

```
npm install                    # once, for the local TSN host (express, ws)
node tools/make-manifest.mjs   # once: writes installed/INN/manifest.json
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
node tools/run-headless.mjs 9400 20000 500 "<the persona script below>"   # new persona, Play, log in, Winter Map
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
- `src/vm/headless-session.mjs` (helper): a headless INN client on virtual time that follows program switches, driven by frame -> input scripts; the scripted ways into the Winter Map and each land live here.
- `src/vm/boot.test.mjs`: creates a Clubhouse persona, clicks Play, and asserts that login and joinNet go out and the Winter Map (pic 52) is drawn; the status bar fills rows 0-9; the Select Player card shows the face and the "Gil" strip; the cursor overlay draws view 897 without touching the framebuffer.
- `src/vm/real-host.test.mjs`: the same login against `server/session.js` over LinkEndpoint and the X.28 PAD, joined by an in-memory line; asserts pic 52 and a single 36/6.
- `src/vm/lands.test.mjs`: TSN.PRG, directory views, edit keys, raw Array copy; map -> CasinoLand chooser -> CasinoLand player screen; SierraLand's waiting room; a Clubhouse room.
- `src/vm/larryland-games.test.mjs`: CasinoLand Slots (seed 22) and BlackJack (seed 2).
- `src/net/fake-server.test.mjs`: shared host logic (SIDs, land list, groups, member properties).
- `src/vm/multiplayer.test.mjs`: two headless clients on one `World` (each with its own `FakeServer({ world })`): both reach the CasinoLand waiting room, Gil's client learns Kris's name, Gil talks and Kris's client gets the line; then Kris opens a BlackJack table, Gil joins, and both screens show the same deal and result (~30 s).

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

## The 1995 build (INN) vs the 1992 one

**Layout.** Each world (CC, LL, SL) has a RESOURCE.MAP indexing volume 1 (its
own RESOURCE.001) and volume 2 (the shared root RESOURCE.002); the root has no
map. `createProgramResources` (programs.js) builds that, with the compiled
`NNN.SO` patches of the root and the world (CC/50.SO, CC/120.SO; 913.SO is
script *source* and is skipped). TSN.PRG's DEFAULT program does `cd CC`, so
the first VM already runs in CC. LSCI.CFG's `pathStr = ..\` is honoured by
FileSystem: a file missing in the world directory is read from the root.

**Kernel table.** LSCITV.EXE unpacks (LZEXE) to 146980 bytes; the kernel name
table is at 0x1c71e (1993: 0x1c1ba), handlers (off, seg pairs) at 0x226a6.
All 89 kernel names and their order are unchanged. Differences found by
comparing handler bodies and jump-table bounds:

| kernel | 1993 | 1995 |
|---|---|---|
| String | sub-ops 0-4 (if chain) | 0-11 (jump table); 11 = getToken (Str getToken, module 60001 block 24), implemented |
| FileSystem | 0-15 | 0-17 (16/17 unseen, not implemented) |
| TextSize | | only adds resource lock/unlock |
| Graph 12, TSN 16, Sound 14 sub-ops | same bounds | same |

**Opcodes.** 0x26 and 0x27 take a word operand: debug line / debug module
info (`4e 32 00` = module 50, `4c 15 01` = line 277), emitted at the start of
every code block. The interpreter skips them; the disassembler names them.

**Selectors** were renumbered (e.g. `money` 598 -> 602); tests look them up by
name (`vm.sel('money')`).

**Behaviour fixes found on the way:**

- *Text box width.* Like ScummVM's GfxText16::Size, an explicit wrap width is
  the box width for both TextSize and Display, so `Display ... 106 w 101 1`
  centres in w: the status bar centres "ImagiNation v2.4" in 320, buttons
  centre their label in their width (sizeToStr + centerIn give the button rect).
- *Icon controls* (type 4) draw only their cel.
- *Freed memory.* A freed ID keeps its contents until reused: WhoUAre::dispose
  reads its locals after `super dispose` unloaded its module, and without that
  the LookLikeDialog was never disposed, g71 stayed 1 and NetMsgProcessor
  queued every host message instead of handling it (module 59957: with g71 set
  only command-2 messages are dispatched directly).

## How far it gets

Headless, with `tools/run-headless.mjs` (one frame = 1/60 s). A new persona and
the Winter Map (`src/vm/headless-session.mjs` `toTheWinterMapAs`):

```
1250@298,137;2700@243,124;3100@285,93;3900@text:Gil;3950@117,120;3970@text:30;
4000@150,132;4020@text:Explorer;4100@124,162;4400@285,74;5300@285,76;6300@285,76;
7300@285,130;8500@285,58
```

1. Welcome OK, no guide, Create, name / age / city, face, skills, hobbies,
   Save: the Select Player screen (frame 8400) with the persona card.
2. Play dials ("Modem Connect"), logs in (53), joins (7), sends the startup
   burst (36/5, 45/1, 36/1, 36/6, 37/32, 40/4, 36/7) and 47/1; the **Winter
   Map** (pic 52; the season follows the clock) is up by frame 9300.
3. **Clubhouse**: `9300@185,150;9800@80,96;10500@110,92;10550@200,160` (the
   lodge, INN Help Room, tick a game, OK): its Waiting Room (pic 100) in the
   same program, with Talk / Look / Invite / Watch.
4. **CasinoLand**: `9300@55,40;9600@219,115;9900@80,96` (the casino, no access
   password, High Rollers) switches to program LLand; a CasinoLand persona and
   Play reach its Waiting Room by 15900 (`toTheCasinoLandWaitingRoomAs`). From
   there Play, Slots (`15950@285,120;16500@205,78;17550@95,70`) and
   `18200@122,133;18300@163,47` (bet 2, pull; seed 22 wins 4), or BlackJack
   (`16500@115,78;17500@22,22;18350@130,55`; seed 2 wins 5).
5. **SierraLand**: `9300@275,80;9800@80,96` switches to program SLand; its
   persona and Play reach the Waiting Room (pic 120) by 15900.

The same flow runs in the browser against `npm run server`.

**Resource ids.** LSCI ids are `(type << 11) + number` truncated to 16 bits,
so view 6000 (a CasinoLand face) has the same id as module 1904, and the map
decodes it as that. The interpreter looks resources up by id, so the
resource manager falls back to the id when the decoded (type, number) misses.

Known script-level errors: writes to freed objects and `view` sends to freed
objects when rooms are disposed. They are harmless.

## Observed TSN calls and packets (fake host)

| call / packet | args / fields | reply |
|---|---|---|
| TSN(0) status | — | `0x0103` once connected (low byte 3 = modem; anything other than 1/2/3 gives "Comm driver problems.") |
| TSN(7) disconnect | — | first call of dialScript |
| TSN(3) connect | `"ATZtSIERRAATDT1!~"` (prefix `t` + hostID `SIERRA` + modem init/dial strings from TSN.CFG) | 1 |
| 53/0 login `bbwbbbbwwbas` | 53, 0, 0, number 1, ver 2.4.46, 123, 0, pwFromFile 1, 11, scrambled pw (= "XXXXXX", the INN PASS_SET.DTA), "Gil" | `00 00 00 00 16 <priv w> 00 <landAccess w>` |
| 7 joinNet `wwwbbww` | 7, 0, objID 88 (CC), flags 0x81, number 1, 0, 12 | `08 00 58 00 00 00 <sid w>` |
| 36/5 `bb` | — | `24 05 01 00` (host number 1) |
| 45/1 `bbw` | sid | none |
| 36/1 `bbw+` | 0, 0 (hostaddr.tim absent) | none |
| 36/6 `bbw+` | 0, 0 (landaddr.tim absent) | land list (47/2), then `01 00 00 00 24 06` |
| 37/32 `bbw+` | 0, 0, 0 | none |
| 40/4 `bbs` | persona "Gil" | none |
| 36/7 `bbw+` | gameinfo.tim stamp | `24 07 00 00` (short form: "current"; module 101 dialScript state 7 waits for any 36/7) |
| 47/1 `bbw+` and `bbww` | 0, 0 (sent twice) | land info (cmd 47 msgType 1), then `01 00 00 00 2F 01` |
| TSN(8) poll, TSN(14) flush | every game cycle once connected | — |

**Findings that matter for the host:**

- **Land list layout.** Message class 125 moves the payload from offset 6 to
  0, and dialScript then reads the count at payload word 4 and the records
  from payload offset 6. So the land records start at message offset **12**:
  `2F 02 <toSid w> 00 00 | 00 00 00 00 <count w> records...`.
- **Land access.** The login reply's word@8 becomes g253, the land access
  mask. Land n is allowed when bit (n-1) is set (module 50 block 206). With
  w8 = 1 only the Clubhouse is allowed, and the map for the others
  says "no access rights". FakeServer sends 0xffff.
- **Messages to SID 0.** Messages addressed to SID 0 (login replies) reach the
  game object through `SID(3, 0)`.

## What's left (priority order)

1. **Money persistence.** LL's money file lives in the in-memory filesystem,
   so a reload asks the bank again (see 7).
2. **Roulette and Poker**, untried.
3. **Clubhouse games** (Bridge, Chess, ...): the room is reached, the games are untried.
4. **Other players.** Presence, talk, joining a game and BlackJack between
   two clients work (docs/server.md "Multiplayer"). Not yet: paging and "has
   just logged in" (module 59953), the waiting-room head count, Poker/Roulette
   and SierraLand games over the net, bots that play.
5. **Graph sub-ops** 0, 2, 5, 8, 9 and 13, plus Kernel90-92; FileSystem 16/17 and String 5-10 of the 1995 build are not implemented (not seen called yet).
8. **Unknown formats**: SierraLand pics 952-972 and sounds 728/729 start `NN 80 00 00 00 00` (not SCI pic/sound data); the dump skips them and the games using them are untried.
6. **Sound** is being added separately (src/audio/, kernel/sound.js).
7. **Persistence.** Save in-memory filesystem writes (PLAYER.DIR, *.DTA,
   landaddr.tim) to IndexedDB in the browser.
