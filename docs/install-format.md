# TSN installer formats

The installer formats were worked out from the disk bytes, plus a disassembly of `INSTALL.EXE` after removing its LZEXE 0.91 packing. `INSTALL.EXE` is a Borland C++ program that interprets `INSTALL.SCR`. It links the PKWARE Data Compression Library. To simulate the install, run `node tools/install.mjs`. The output goes to `installed/TSN/`.

## PART.n spanned archive (`defuse %2 %1 part %6`)

`PART.1`..`PART.4` (one per disk) form a single stream of 31-byte entries. In this stream, each file entry is directly followed by its data. The archive stores files uncompressed. All integers are little-endian.

| off | size | field |
|----:|-----:|-------|
| 0   | 13 | name, NUL-terminated (the bytes after the NUL are uninitialised junk) |
| 13  | 2  | flags (see below) |
| 15  | 4  | file: total file size. First entry of a part: total archive size (4368820) |
| 19  | 4  | file: size of the data chunk that follows in this part. First entry: size of this part file |
| 23  | 4  | file: offset of this chunk within the file (non-zero when continuing from the previous disk). First entry: low byte = part number, next byte = part count (4) |
| 27  | 4  | DOS time (low word) + DOS date (high word) |

Flags (from the `defuse` code at unpacked offset 0x9033):
- `0x8000`: end of archive. The last entry of PART.4 has flags `0xA000`.
- `0x2000`: end of this disk. Each part ends with a 31-byte entry that has an empty name.
- `0x4000`: directory entry. It sets the current target directory, relative to the install root (`.`, `SL`, `LL`, `BARON`, `YSERBIUS`). Every part starts with one, which restates the directory that is current at that point.
- `0x0003`: video set. `0` = always installed, `1` = EGA only, `2` = VGA only. INSTALL.EXE reads the `video` line of `<dest>\LSCI.CFG`. It picks set 1 if the driver matches `ega??0.drv` (EGA640.DRV) and set 2 otherwise. Only BARON has both sets: one `RB.EXE`/`VOLUME.*`/`SIM*` set for EGA and one for VGA. All YSERBIUS files are VGA-only.

A file can span two parts. For example, `SL\RESOURCE.001` (999162 bytes) has 242052 bytes in PART.1 and 757110 bytes at offset 242052 in PART.2. Archive order: `SL` (RESOURCE.001, RESOURCE.MAP, *.PBM, *.IMG), `LL` (RESOURCE.MAP, RESOURCE.001, BARSTRNG.TXT), `BARON` (EGA set, then VGA set), then `YSERBIUS` (puffed `_*.*` files).

## PUFF (`puff /D _*.*`)

The first letter of a puffed file's name is replaced by `_` (`_RAPH256.DLL` → `GRAPH256.DLL`). The original name is stored inside the file.

| off | size | field |
|----:|-----:|-------|
| 0   | 13 | original file name, NUL-terminated |
| 13  | 4  | 32-bit checksum of the original data. It is not standard CRC-32 or a byte sum, so it is unverified |
| 17  | 4  | DOS time + date |
| 21  | …  | PKWARE DCL "implode" stream. Byte 0 is 0 (binary literals) or 1 (Huffman-coded literals); byte 1 is the dictionary size in bits (4–6). Here it is always `00 06` |

`tools/puff.mjs` decodes the stream with a JS port of Mark Adler's `blast.c`. The test checks the decoder against blast.c's reference vector. `/D` deletes the `_` source after it decompresses it. This was the same DCL family that Dynamix and Sierra used elsewhere.

## What the script does (simulated in `tools/install.mjs`)

1. It creates `TSN`, `SL`, `LL`, `BARON`, `YSERBIUS` and `YSERBIUS\SAVE`.
2. It copies the root files from disk 1. `INSTALL.EXE` is copied as `INSTTSN.EXE`. It also writes `TSN.BAT` (`tsnexec DEFAULT`) and puffs `_LNULL.DLL` → `NLNULL.DLL` and `_RAPH256.DLL` → `GRAPH256.DLL`.
3. It copies the CC (Clubhouse) `RESOURCE.MAP`/`RESOURCE.001` into the root.
4. It writes `LSCI.CFG`, `TSN.CFG` (`%4`, the modem/comm line) and `PASS_SET.DTA` (`%5`). `%3` holds the driver lines that the user picks in INSTALL.EXE. The defaults used here are `video = VGA320.DRV`, `keyboard = IBMKBD.DRV` and `music = ADL.DRV`. These lines are followed by the fixed `dll`/`pathStr`/`hostID`/`InterpSize` lines.
5. It runs `defuse`, then puffs `BARON\_*.*` and `YSERBIUS\_*.*` and copies `RBJOY.EXE` into BARON.
6. It writes `SL\LSCI.CFG` and `LL\LSCI.CFG`, which `lsciget -t` derives from the root config. The driver/dll values get the prefix `..\`, and `pathStr = ..\` is added.
7. It copies the docs `_*.DOC` from disk 4 and puffs them to GENERAL/SIERRLND/LARRYLND/YSERBIUS.DOC, then writes `DOC.LST`.
8. It applies the patches: `SLPATCH\120.SO` → `SL`, `LLPATCH\1040.SO` → `LL`, `CCPATCH\130.SO` → root. `YSPATCH` does not exist, and the script never references `RBPATCH`, which is empty.

What the simulation does not reproduce:
- `patchpif` (it patches `TSN.PIF` for Windows).
- The exact `%3`/`%4` text that INSTALL.EXE generates. The `mouseDrv`, `prefix`, `id` and `modem` keys are omitted.
- DOS 8.3 case. Generated files are written in upper case, and lookups in the VM should be case-insensitive.

## Resource maps

`RESOURCE.MAP` in the root, SL and LL uses the SCI0 layout: 6-byte entries made of a `uint16 type<<11 | number` and a `uint32 volume<<26 | offset`, terminated by `FFFF`. Each entry points at a resource header in `RESOURCE.00v` whose first word is the same id. The counts are 260 resources for CC, 312 for SL and 270 for LL. In YSERBIUS, `RESOURCE.0xx` are Dynamix files (they start with `MZ`), not SCI volumes.
