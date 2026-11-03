# TSN "CC" world resources (disk/1)

Resource layer for The Sierra Network's root world, read from
`disk/1/RESOURCE.MAP` + `disk/1/RESOURCE.001`, with patch overlay from
`disk/4/CCPATCH/130.SO`. Code: `src/resource/`, dump tool:
`tools/dump-resources.mjs` (output in `out/`), tests: `npm run test:resource`.

## 1. Version verdict

**LSCI is not stock SCI.** The interpreter `LSCITV.EXE` is LZEXE 0.91-packed
(signature `LZ91` at 0x1C). Once unpacked it identifies itself as:

> Script Interpreter, Copyright (C) 1987-1992 The Sierra Network.
> Authors: Jeff Stephenson, Bob Heitman, Pablo Ghenis, Gary Butts, and Conan Brink

i.e. the SCI team's code, forked for TSN. Splitting by layer:

| Layer | Format | Closest ScummVM equivalent |
|---|---|---|
| Map / volume | SCI0-style 6-byte map entries, 8-byte volume headers | `kResVersionSci0Sci1Early` |
| Compression | Method 0 (none) and **method 8 = PKWare DCL implode** | `kCompDCL` (stock SCI1.1 uses method numbers 18-20) |
| Graphics | SCI1 VGA: views, vector pics with VGA palette ops, SCI1 palettes | `SCI_VERSION_1_EARLY` / `1_MIDDLE`, `kViewVga` |
| Scripts | **LSCI-specific "module" block format** + ID-based object memory | none |
| Kernel | 89 named functions (+4 unnamed), SCI32-flavoured (`Array`, `String`, `List`, `Block`, `Seq`, `ModuleID`) plus `TSN` | none |

So: resource and graphics decoders follow SCI1-early ScummVM code, but the VM
must be written from scratch against the module format below; ScummVM's
`engines/sci/engine` is useful only as a guide to opcode semantics.

How this was pinned down:
- Every map id equals the volume header id; every resource uses method 0 or 8.
  Method 8 payloads begin `00 04|05|06` = DCL binary mode + dictionary size.
- Unpacking the EXE (LZEXE 0.91 algorithm) exposes the kernel name table
  (89 far pointers at image offset 0x1D350), resource type names
  (`view pic module text sound <memory> vocab font cursor patch bitmap palette`),
  and the PMachine error strings.
- `vocab.998` (opcode names) is the stock SCI opcode table except
  `0x2d lea -> loadID` and `0x3a lofss -> pushID` (`0x39 lofsa` and `0x3f` unused).

## 2. Resource inventory

260 map entries, all in volume 1. 0 decode failures (every resource
decompresses to exactly its declared size; all pics/views/fonts/modules decode).

| Type | Count | Notes |
|---|---|---|
| view | 78 | SCI1 VGA |
| pic | 16 | 0, 50, 100, 101, 104, 105, 120, 150, 155, 400-420, 500, 505 |
| module (script) | 129 | 67 regular (0..902) + 62 class modules 59950..60081 |
| text | 2 | 500, 510 |
| sound | 16 | not decoded yet |
| vocab | 8 | 0, 900, 901, 994, 995, 996, 997, 998 (no 999 kernel-name vocab) |
| font | 7 | 0, 3, 5, 10, 42, 910, 999 |
| patch | 3 | 1, 3, 101 (sound-driver patches; 1 is likely the MT-32 patch — starts with "THE SIERRA NETWORK" display text) |
| palette | 1 | 999 (system palette) |

Plus `130.SO` overriding module 130 (26 545 -> 26 570 bytes).

## 3. Formats

### RESOURCE.MAP (`map.js`)
6-byte entries `{uint16 id, uint32 location}` ending in `id == 0xFFFF`.
`location = volume << 26 | offset`. `id = (type << 11) + number`, **truncated to
16 bits**. Module numbers >= 2048 therefore overflow into the type bits: class
module 60000 is stored as id 0xFA60, which looks like "type 31, number 608".
`decodeResourceId` maps any type field > 11 back to `module (id - 0x1000)`.
(Reference: ScummVM `resource.cpp` `readResourceMapSCI0`.)

### Volume header (`volume.js`)
`uint16 id, uint16 packedSize + 4, uint16 unpackedSize, uint16 method`, then data.
(ScummVM `Resource::readResourceInfo`, `kResVersionSci0Sci1Early` branch.)

### DCL (`dcl.js`, `dcl-trees.js`)
PKWare implode, binary mode only in practice (dict sizes 1K/2K/4K: 140/45/72
resources). Port of ScummVM `common/compression/dcl.cpp`; the Huffman trees
are generated from that file.

### Patch files (`patch.js`)
`uint8 (0x80 | type), uint8 extraHeaderLen, extra[...], raw data`; number from
the file name. Same as SCI1 (`ResourceManager::processPatch`).

### Palette (`palette.js`)
SCI1: 256-byte remap + 4-byte timestamp, then 256 x `{used, r, g, b}` (8-bit) at
offset 260. (ScummVM `palette16.cpp` `createFromData`.)

### View (`view.js`, `cel.js`)
SCI1 VGA: `uint8 loops, uint8 flags, uint16 mirrorMask, uint16 version,
uint16 paletteOffset, uint16 loopOffsets[]`; loop `uint16 cels, uint16 ?,
uint16 celOffsets[]`; cel `uint16 w, h, int8 dx, uint8 dy, uint8 clearKey,
uint8 ?` then RLE (00/01 copy, 10 fill, 11 skip). (ScummVM `view.cpp`.)

### Pic (`pic.js`, `pic-canvas.js`, `pic-patterns.js`)
SCI1 vector opcodes 0xF0-0xFF incl. extended 0xFE: 2 = set palette, 1 = embedded
cel (most TSN pics are one big embedded bitmap), 4 = explicit priority bands.
Rendered into a 320x190 port (visual / priority / control). Every TSN pic
starts with `FE 02` (own palette) and sets explicit priority bands
`42,53,...,180`. Embedded cels use priority 0 (SCI1-early behaviour,
configurable). (ScummVM `picture.cpp`, `screen.cpp`.)

### Font (`font.js`), text (`text.js`)
Stock SCI: `uint16 ?, uint16 numChars(128), uint16 lineHeight, offsets[]`;
glyph `w, h, rows MSB-first`. Text = NUL-separated strings.

### Vocab (`vocab.js`)
- 997 selectors: `uint16 maxIndex`, offsets[maxIndex+1], `{uint16 len, chars}`.
  766 selectors; full list in `docs/lsci-selectors.txt`.
- 998 opcodes: `uint16 count(128)`, offsets, `{uint16 len+2, uint16 type, chars}`.
- 996 class table: 196 x `{uint16 0, uint16 module}`; class 0 (Obj) -> 60000.
- 995: debugger help text. 994: 35 words (unknown, likely property offsets).
  0: SCI0-style parser word list. 900/901: parser tables (suffix rules in 901).
  The parser appears unused (no `Said` kernel call).

### Module (LSCI script) — `module.js`, `disasm.js`
Reverse engineered from the data (all 129 modules parse exactly to EOF; all
837 objects/classes and every code block decode cleanly):

```
uint16 blockCount
blockCount x {
  uint8  kind
  uint16 size
  uint8  data[size]
  if kind != 7: uint16 fixupCount, uint16 fixups[fixupCount]
}
```

Block kinds: 2 object, 3 class, 4 code, 6 variables (module 0's = globals),
7 string, 9 dispatch (exports; absent in class modules), 11 property dictionary
(selector list, follows each class). The loader puts every block in its own
memory "ID"; fixups are byte offsets in `data` whose 16-bit value is a block
index to be replaced by that block's runtime ID. Bytecode references blocks
via `loadID n` / `pushID n`.

String block: `uint16 1, uint16 strlen+2, chars, NUL`.

Object/class block: `uint16 props[-size-]`, `uint16 methodCount`,
`uint16 selectors[n]`, `uint16 codeBlocks[n]`. Property order (from Obj's
propDict): `-env- -size- -dict- -super- -info- name sid ...`; `-info-` has
0x8000 for classes; `-super-` is a class number (vocab.996 index) or 0xFFFF.

Bytecode: stock SCI encoding (`opcode << 1 | byteOperands`); operand formats as
ScummVM `kernel_tables.h` `g_base_opcode_formats`, with loadID/pushID taking one
variable-size operand. `callk k, n` pushes argc first; n = arg bytes.

`out/module/N.txt` has a full block listing + disassembly of every module.

## 4. Kernel functions

Numbering = order of the name table in the EXE; confirmed by bytecode
(`Obj::new` does `callk 2` = ObjectNew).

| # | Name | # | Name | # | Name | # | Name |
|---|---|---|---|---|---|---|---|
| 0 | IsObject | 23 | DrawCel | 46 | GameIsRestarting | 69 | Sqrt |
| 1 | ObjectFree | 24 | DrawScaledCel | 47 | GetSaveDir | 70 | Long |
| 2 | ObjectNew | 25 | NumCels | 48 | GetSaveFiles | 71 | Graph |
| 3 | ObjectRespondsTo | 26 | NumLoops | 49 | Restart | 72 | Debug |
| 4 | Array | 27 | ScaledCelRect | 50 | Restore | 73 | Profiler |
| 5 | Block | 28 | DrawControl | 51 | Save | 74 | SetDebug |
| 6 | List | 29 | EditControl | 52 | Sound | 75 | ShowFree |
| 7 | ModuleDispose | 30 | HiliteControl | 53 | GetTime | 76 | StackUsage |
| 8 | ModuleID | 31 | GetPort | 54 | SetTimerFreq | 77 | Joystick |
| 9 | Resource | 32 | SetPort | 55 | Wait | 78 | BaseRectSet |
| 10 | Seq | 33 | WindowDispose | 56 | Alert | 79 | ConfigStr |
| 11 | String | 34 | WindowNew | 57 | CanBeHere | 80 | Encrypt |
| 12 | GetFarText | 35 | Display | 58 | OnControl | 81 | Decrypt |
| 13 | CoordPri | 36 | TextSize | 59 | FileSystem | 82 | ColorUp |
| 14 | DrawPic | 37 | GetEvent | 60 | DeviceInfo | 83 | ColorDown |
| 15 | PicState | 38 | GlobalToLocal | 61 | Abs | 84 | **TSN** |
| 16 | ShakeScreen | 39 | LocalToGlobal | 62 | CosDiv | 85 | ObjPropOffset |
| 17 | Show | 40 | MapKeyToDir | 63 | CosMult | 86 | ObjOffsetProp |
| 18 | AddToPic | 41 | Menu | 64 | GetAngle | 87 | SID |
| 19 | Animate | 42 | HaveMouse | 65 | GetDistance | 88 | InvokeMethod |
| 20 | CelHigh | 43 | SetCursor | 66 | Random | 89-92 | *(unnamed)* |
| 21 | CelRect | 44 | Memory | 67 | SinDiv | | |
| 22 | CelWide | 45 | CheckSaveGame | 68 | SinMult | | |

Call counts across all modules (top): IsObject 518, Graph 208, **TSN 196**,
Display 104, Animate 98, ModuleDispose 90, DrawCel 76, SetPort 71.

### Not in stock SCI
- Object/memory model: `IsObject`, `ObjectFree`, `ObjectNew`,
  `ObjectRespondsTo`, `Block`, `ModuleDispose`, `ModuleID`, `Resource`, `SID`,
  `InvokeMethod`, `ObjPropOffset`, `ObjOffsetProp`, `Seq`, `Long`.
  (`Array`, `String`, `List` resemble the later SCI32 calls.)
- Misc: `BaseRectSet`, `ConfigStr` (reads LSCI.CFG keys such as `modem`,
  `novell`), `Encrypt`/`Decrypt` (password handling, `PASS_SET.DTA`),
  `ColorUp`/`ColorDown`, `Profiler`, `StackUsage`, `GetFarText`.
- Unnamed 89-92: k89(5, r, g, b) returns a colour index — almost certainly the
  palette call (SCI1 `kPalette` sub-op 5 = FindColor); k90/k91/k92 are used
  once or twice in class modules 60045/60073, 60022, 60023 ("cast"). Unknown.
- **`TSN` (84) is the network/modem gateway** — the key call for the fake
  server. First argument is a sub-function:

| Sub | Args | Best guess (evidence) |
|---|---|---|
| 0 | - | status: result `>> 8` stored as "connected", low byte compared to 2 (module 101) |
| 1 | - | (101) unknown query |
| 2 | data, len | send raw bytes / string buffer (101) |
| 3 | target | connect: called with dial string (modem), host name (Novell, after "Host name:") or `"foo"` (direct serial); result -> global 85 "online" |
| 4 | fmt, msgType, ... | **send a packet**: fmt is a field-type string (`b`=byte, `w`=word, `s`=string, `+`=rest), then message type and fields |
| 7 | - | disconnect / hang up (paired with "Unable to connect", reconnect paths) |
| 8 | - | poll the comm driver (called in every wait loop alongside GetEvent) |
| 9, 13 | x | reconnect / teleport (`signal`, "Teleport to which room#?") |
| 12 | - | returns bool; loops `while !TSN(12) { TSN(8); TSN(14) }` — "link ready/idle?" |
| 14 | - | dispatch received messages to scripts (43 calls, after most sends) |
| 16 | - | (97) unknown |

Packets sent through `TSN(4, ...)` (message type, field format, modules):

| Type | Format(s) | Modules |
|---|---|---|
| 2 | w+ | 120, 59953 |
| 4, 6 | w+ | 59950 |
| 7 | wwwbbww | 3, 59954, 60000 |
| 9 | w+ | 101, 60000 |
| 10 | wwwbbb / w+ | 3 / 59954 |
| 11 | w+ | 59954 |
| 12 | www | 155 |
| 13 | w+ | 10, 121, 60000 |
| 14 | wwwws | 60000 |
| 22 | wwwws | 59950 |
| 25, 32 | w+ | 60000 |
| 26 | w+ | 59953 |
| 27 | bbw+ / bbwww / bbwwwwb | 120, 199 |
| 30 | bw+ | 59950 |
| 34 | bbw / bbwwwbw | 11, 50, 101 |
| 36 | bb / bbw+ | 101 |
| 37 | bbw+ | 50, 101, 142, 145, 160 |
| 38 | bbwbbbb | 135 |
| 40 | bbs | 101 |
| 45 | bbw | 101 |
| 47 | bbww / bbw+ | 0, 101 |
| 49 | bbwws / bbw+ | 50 |

(Collected heuristically from `pushi 4; pushID <fmt>; pushi <type>` sequences;
types assembled from expressions are missed.)

## 5. Notable modules

- **0** — game/globals module (564-byte globals block), "(C) 1993 by The Sierra
  Network", main loop polling `TSN(8)` / `TSN(14)`.
- **101** — communications: dialing (`ATDT`, `Dialing`, alternate numbers),
  Telenet/PAD error texts, Novell IPX connect, `landaddr.tim`/`hostaddr.tim`,
  `online.tim`, `land.cfg`, login/password (`Your password is out of date`),
  reconnect/teleport, "Connection Paused".
- **130** (patched by 130.SO) — Bulletin Board (`*.TXT`, "enter the name you
  will use for this BBS session").
- **59950..59957, 60000..60081** — class library (Obj = 60000; 59951 has 31
  classes). The TSN message classes live in 59950/59953/59954/60000.
- **120, 199, 50, 135, 142, 145, 155** — rooms sending game/chat packets.

## 6. ScummVM sources used

| Our file | ScummVM source |
|---|---|
| map.js, volume.js, resource-manager.js | engines/sci/resource/resource.cpp |
| dcl.js, dcl-trees.js | common/compression/dcl.cpp |
| patch.js | resource.cpp `processPatch` |
| palette.js | engines/sci/graphics/palette16.cpp |
| view.js, cel.js | engines/sci/graphics/view.cpp |
| pic.js, pic-canvas.js, pic-patterns.js | engines/sci/graphics/picture.cpp, screen.cpp |
| font.js | engines/sci/graphics/scifont.cpp |
| vocab.js | engines/sci/engine/kernel.cpp, vocabulary.cpp |
| disasm.js | engines/sci/engine/kernel_tables.h (`g_base_opcode_formats`) |
| module.js, kernel-names.js | none — reverse engineered from TSN data / LSCITV.EXE |
