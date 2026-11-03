# The Sierra Network wire protocol (client side, 1992)

Reverse engineered from `MODEM.DRV`, `NOBRK.DRV`, `TSNEXEC.EXE` and `LSCITV.EXE`
(both LZEXE 0.91, unpacked), plus the LSCI script modules. Code for layers 2-3 is in
`src/net/wire.js`.

Legend: **[C addr]** = confirmed in code at that address. **[G]** = guess or inference.
Addresses are image offsets in the unpacked binary. TSNEXEC DGROUP is DS=0x314 and the
link globals live at DS:0x6c2 and up.

```
 scripts   TSN(4, fmt, ...)            event type 0x400 -> Message class 98 'with'
   |              |                                ^
 LSCITV    0x435 format encoder         TSN(8) poll -> slot 0x14 receive
   |              |                                ^
 TSNEXEC   len-prefixed message stream -> frames 81..82, CRC16, stop-and-wait ARQ
   |              |                                ^
 MODEM.DRV UART 8N1, ring buffers, Hayes dial, SprintNet X.28 PAD
```

## Layer 1: physical, modem and PAD (MODEM.DRV)

The driver is SCI-style. Signature `21 43 65 87` sits at offset 4, and the entry at 0x63
dispatches with BX = function index through the near table at 0x4F. **[C]**

| BX | addr | function |
|---|---|---|
| 0 | 0x8d7 | driver type, returns 3 (modem) |
| 1 | 0x909 | init(config string), returns a far pointer to the shared struct at 0x95 |
| 2 | 0x1359 | terminate |
| 3 | 0xa3b | connect(dial string) |
| 4 | 0x124b | kick TX |
| 5 | 0x1268 | carrier-loss timer |
| 6 | 0x1288 | read and clear line error counters |
| 7 | 0x12ce | hang up: drop DTR for 1 s, `+++`, `AT H0\r` |
| 8 | 0xfbd | reconnect(address) |

The config string comes from `TSN.CFG` (`comm = MODEM.DRV : b2400 c4`). Its keys are
`bN` (baud, default 1200), `cN` (COM1-4; ports 3F8/2F8/3E8/2E8 with IRQ 4/3/4/3), `iN`
(IRQ) and `pHEX` (port). **[C 0x909]**

The UART runs at LCR=3, 8N1, with no flow control: no XON/XOFF, no RTS/CTS. While dialing
([0x4c8]=1) received bytes are masked to 7 bits; after that the line is 8-bit
transparent. **[C]**

Shared struct (0x95):

| off | field |
|---|---|
| +0 | TX buffer pointer |
| +4 | TX size (0x200) |
| +6 / +8 | TX head / tail |
| +0xa | RX buffer pointer |
| +0xe | RX size (0x200) |
| +0x10 / +0x12 | RX head / tail |
| +0x16 | status (0x80 = carrier) |
| +0x18 | link RX expected seq |
| +0x19 | link TX seq |
| +0x1a | port |
| +0x1c | baud |
| +0x20 | IRQ mask |

**[C]**

### Dial string

Script module 101 block 74 builds the dial string: **[C]**

```
<ConfigStr "prefix"> t <host> <ConfigStr "modem"|"modem2" or "ATDT"+number+"!~">
```

The host defaults to `SIERRA`. It is looked up in the `HOSTADDR` file (block 78): a match
on column 1 is replaced with column 2, the X.121 address. In the dial string `!` means CR
and `~` means a 9-tick (about 0.5 s) wait.

Driver connect (0xa3b): **[C]**

1. Sends `\rAT\r` and waits 18 ticks. If the string has no `ATD`, returns error 0x40.
2. Parses the host, the text between `t` and `ATD`:
   - All digits, length 4-14: the 4-digit DNIC is dropped (`311083420207` becomes `83420207`).
   - `DIRECT`: no PAD phase.
   - Anything else is a mnemonic of at most 14 chars.
   - Default: `SIERRA`.
3. Sends the text before `t`, then everything from `ATD` on, adding CR if the string has no `!`.
4. Waits up to 0x32a ticks (about 45 s):
   - `CONNECT` sets status 0x80. Any digits after it become the new baud rate.
   - `BUSY` returns 0x10.
   - On timeout it drops DTR, then returns 4 for `NO CARRIER` or 8 for anything else.

### PAD phase (SprintNet/Telenet X.28)

Strings are at driver 0x621..0x670. **[C]**

```
wait 1 s
send "@" (baud > 1200) or "\r", then "D", "\r", "\r"   (9 ticks after each; "@D<cr>" autobaud)
wait for '@' prompt, resend "\r" every 9 ticks          (180 ticks max -> err 2)
send "c <addr>\r"                                        (buffer 0x5ef starts "c ")
wait for " CONNECTED"                                    (270 ticks; up to 5 tries -> err 1)
```

A key press aborts with error 0x11. The strings `TERMINAL=` and `D1\r` exist in the driver
but are unused on the paths read. **[C]** The client sets no X.3 parameters at connect, so
the host side must be transparent 8-bit. **[G]**

**Reconnect** (fn 8, used by TSN(13) to move between hosts): **[C 0xfbd]**

1. Requires PAD mode, else error 0xe.
2. Sends a hardware BREAK, LCR bit 0x40 held for about 9 ticks (failure: 0xd).
3. Waits for `@` (3 tries, else 2).
4. Sends `SET? 0:0,32:0\r` and waits for `@`.
5. Sends `D\r` and waits for `DISCONNECTED` (else 0x12).
6. Sends `c <newaddr>\r` and waits for ` CONNECTED`; success returns 0.
7. Otherwise falls back to `c SIERRA\r`, which returns 0xf on success and 1 on failure.

`NOBRK.DRV` is identical except that step 2 sends
`~~~+++~~~AT!~AT\B!~ATO!~` (a modem-generated break) instead. **[C]**

### Driver error to READ.ME `ERROR #`

Mapped by TSNEXEC 0x1839. **[C]**

| driver | 0x80 | 0x40 | 0x20 | 0x10 | 8 | 4 | 2 | 1 | 9 | 0xa | 0xb | 0xc | 0xd | 0x11 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ERROR # | 5 | 7 | 6 | 8 | 9 | 10 | 12 | 13 | 15 | 16 | 17 | 18 | 19 | 23 |

Reconnect errors are mapped by 0x1955: 0xf to 22, 1 to 13, 2 to 21, 0xe to 20. **[C]**

### Other transports

TSN(0) returns `(connected << 8) | type`, where type 3 = modem, 2 = Novell and 1 = direct
serial. **[C]**

- **Novell:** the script prompts "Host name:" and calls TSN(3, host).
- **Direct serial:** the script calls TSN(7), then TSN(3, "foo").

Only the modem drivers ship, so both of these paths are untested. **[G]** that they share
layers 2 and up.

## Layer 2: link framing (TSNEXEC)

```
+----+--------+--------+-----+-------------------------+----+
| 81 | CRC lo | CRC hi | CTL | payload (ESC-stuffed)   | 82 |
+----+--------+--------+-----+-------------------------+----+
```

- **Stuffing:** a payload byte equal to 0x81, 0x82 or 0x1B is preceded by 0x1B and sent
  unchanged (no XOR). The receiver takes the byte after an ESC literally. **[C 0x25de, rx
  state 5]**
- **CRC:** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, MSB-first, no final XOR. It covers
  CTL plus the payload as transmitted, ESC bytes included. It is stored little-endian, and
  the CRC bytes and the CTL byte are never escaped. **[C 0x16ba byte, 0x16f5 block, TX
  0x1a20, RX states 3-5]** The routine has no lookup table:
  ```
  x = (crc >> 8) ^ b;  x ^= x >> 4;
  crc = (crc << 8) ^ (x << 12) ^ (x << 5) ^ x     (16-bit)
  ```
  Check value: `"123456789"` gives 0x29B1.
- **CTL:** the high nibble is the type, the low nibble is seq (0..7). **[C 0x1e55 state 3]**

  | CTL | meaning |
  |---|---|
  | `0x00 \| seq` | data |
  | `0x90 \| seq` | ACK, empty payload |
  | `0x80 \| seq` | NAK, empty payload |

  The ACK is built at 0x1bbb, the NAK at 0x1b8c, and control frames are sent at 0x1cc2.
  NAK seq 1 and seq 2 are 0x81 and 0x82 on the wire. They are not escaped, so a parser must
  take CTL by position.
- **Max frame:** 254 bytes on the wire including delimiters. That leaves 249 escaped payload
  bytes. **[C length ≤ 0xFE]** The exact boundary is **[G]** (±1).

### Worked example

ACK for seq 3:

```
CTL = 0x93; crc16([0x93]) = 0x522A  ->  81 2A 52 93 82
```

The sender caches control frames, so a server can precompute these.

Data frame seq 0 carrying a single message `22 04 34 12` (the "bbw" 34,4,0x1234 message,
length prefix 04):

```
payload = 04 22 04 34 12   ->  81 D2 7A 00 04 22 04 34 12 82   (CRC 0x7AD2)
```

### Receiver state machine

**[C 0x1e55]**

| state | input | action |
|---|---|---|
| 0 | 0x81 | go to 1; any other byte is ignored |
| 1, 2 | any | CRC lo, CRC hi |
| 3 | any | CTL |
| 4 | 0x1B | go to 5 |
| 4 | 0x81 | NAK the current seq and restart at state 1 |
| 4 | 0x82 | end of frame |
| 4 | other | store the byte |
| 5 | any | store the byte literally, back to 4 |

At the end of a frame:

- **CRC mismatch:** send NAK(seq).
- **Data frame, seq == expected:** commit the payload to the stream, ACK(seq), and set
  expected = (expected + 1) & 7. If the receive buffer overflows, send no ACK, so the peer
  retransmits.
- **Data frame, seq != expected:** a duplicate. Discard it and send ACK(seq). Counted at
  0x6dc.
- **ACK(seq) for the pending TX frame:** free it.
- **NAK(seq) for the pending TX frame:** retransmit it. NAKs are counted at 0x6d8; after 10,
  the link returns error 2.

### Sender

Stop-and-wait, window 1. **[C 0x1a6f]**

- It transmits only when the driver TX ring is empty.
- A pending ACK/NAK goes first. Otherwise the finished data frame goes, provided none is
  unacked.
- The data frame stays open, accumulating messages, until it is full or flushed: TSN(14),
  slot 0x38.
- **Retransmit timeout:** `now - sentTime > 300` ticks of the interpreter clock (slot 0x18;
  counted at 0x6da). **[C]** The clock is 60 Hz, so the timeout is about 5 s. **[G]**
- More than 10 retries returns 3 (link dead). Carrier loss returns 1.

Both seqs reset to 0 on connect and on reconnect. **[C]**

There is no link-level handshake, no keepalive and no window negotiation. LSCITV pumps the
link from a 20-tick timer (TSN(3)). **[C]**

## Layer 2.5: message stream

The committed payload bytes form one byte stream. Each message in it is: **[C TX 0x23ab,
RX 0x284c]**

```
len < 255 :  [len] [message bytes...]
len >= 255:  FF [len lo] [len hi] [message bytes...]
```

Messages may span frames; the prefix itself is written atomically. Prefix bytes are
escaped like any other payload byte. The receiver hands each complete message to LSCITV
through registered callbacks (slot 0x3c: alloc, deref, free).

## Layer 3: message encoding (LSCITV TSN kernel)

The kernel is at image 0x126ab, with its jump table at 0x1272b. **[C]**

| TSN sub | TSNEXEC slot | meaning |
|---|---|---|
| 0 | 0x00 | status: `(connected<<8)\|type` |
| 1 / 2 | 0x04 / 0x08 | get / set the shared 256-byte inter-program buffer |
| 3 | 0x0c | connect(dial string); 1 if already connected; starts the 20-tick pump |
| 4 | 0x10 | encode (0x435) and send |
| 5, 6, 10, 15 | none | no-op |
| 7 | 0x1c | disconnect |
| 8 | 0x20/0x14 | poll; each message becomes an SCI event of type 0x400, message = handle |
| 9 / 11 | 0x24 / 0x2c | set / get the next program name (land teleport) |
| 12 | 0x30 | idle (no unacked data) |
| 13 | 0x34 | reconnect(address) |
| 14 | 0x38 | flush |
| 16 | 0x40 | beyond the table **[G]** |

**TSN(4, fmt, args...)** walks `fmt` one char per argument. The message type is just the
first argument. **[C 0x435]**

| char | wire |
|---|---|
| `b` | low byte |
| `w` | word, LE |
| `s` | string bytes + NUL |
| `a` | takes `count, array`; copies count bytes for a byte array (type 1), else count LE words |
| `+` | all remaining args: bytes if the previous char was `b`, else LE words |
| other | ignored |

An empty result is not sent.

Common received header: `[0] command, [1] sub/flags, [2..3] toSID LE`. **[C module 59951
Message.with]**

### Client to host

| type | sender | fmt | fields |
|---|---|---|---|
| 2 / 3 | Net send / rSend (97) | `w+` / `wwwwa` | cmd\|notify, to.sid, from.sid, args |
| 4 / 5 / 6 | Net lock / lockQueue / unlock | `w+` / `wwa` | |
| 7 | Obj joinNet (60000 b17) | `wwwbbww` | 7, 0, selfObjID, flags (0x81 at login), g2.number, arg1, prop@2 |
| 9 | Obj leaveNet | | |
| 13 / 14 / 25 / 32 | Obj property updates | | |
| 18-21 | Net getObj / add / setEq / setNe | | |
| 22 | Net login (old form) | `bbwwwsbba` | |
| 30 | Net register | `bw+` | |
| 34 / 4 | dialScript st3 | `bbw` | 34, 4, sid |
| 36 / 5 | | `bb` | |
| 36 / 1, 36 / 6 | | `bbw+` | words of hostaddr.tim / landaddr.tim |
| 37 / 18, 37 / 32 | | | (g2.sid, g174, g175) / (0, 0, 0) |
| 40 / 4 | | `bbs` | persona name |
| 44 / 2 | change password (95 b35) | `bbwa` | 44, 2, sid, 10, pw |
| 45 / 1 | | `bbw` | |
| 47 / 1 | dialScript st5 | `bbw+` | 47, 1, 0, 0 |
| **53** | **login (196 b10)** | `bbwbbbbwwbas` | see below |

Logout is TSN(7), a plain disconnect. **[C]**

Login message 53: **[C module 196 block 10]**

```
35 00 | 00 00 | number | maj | min | rev | w g262 | w g261 | g184 | 11 bytes pw | name\0
```

- `number` is g2.number, the user's account number.
- `g184` is the password-from-file flag.
- The 11 password bytes come from g183, the scrambled password.
- `name` is g81.name, the persona, or the empty string.

The meaning of g261 and g262 is **[G]** (the user ID low and high words from the old form 22).

Password scrambling (module 95 block 33). **[C]** Verified against the shipped
`PASS_SET.DTA`, whose body `06 7D 7A 7B 7A 7A 00 00 00 00` decodes to `"123456"`:

```
out[i] = upper(p[i]) ^ "M34546788S"[i]   (i < n, rest 0, 10 bytes)
for j = 0..n-1: out[(j+1) % n] ^= out[j]
```

The `PASS_SET.DTA` header `AB` means a password is stored; `BC` means generate one.

### Host to client

Dispatch is in module 59951, Message class 98. Offsets are byte offsets in the message;
wN = LE word at N. **[C]**

| cmd | class | layout |
|---|---|---|
| 0 | 100 ack/ok | whichCmd @4, whichSub @5 (login: privilege w5, @7, w8) |
| 1 | 101 fail/done | as cmd 0, plus numTries @7; error text from 8 |
| 2 | 99 user msg | fromSID w4, msgType w6, data from 8 |
| 8 | 102 SID assign | object ID w2 (raw), sid w6 |
| 9 | 110 | dispose |
| 10 / 11 | 108 / 109 | who w4 |
| 12 | 107 | member SIDs, words from 6 |
| 13 | 105 | property list, count = (len-6)/4 |
| 14 | 106 | property offset w6, value from 8 |
| 23 | 122 | data from 4 |
| 25 | 112 | number w4, data from 6 |
| 27 | 114 | whichCmd @1, number w2, toSID w4, type w6 |
| 29 | 115 | toSID w1 (odd), number @3, majorVer @4, minorVer @5 |
| 31 | 124 | object property dump |
| 33 | 116 | prop / value |
| 34 | 113 | whichCmd @1 |
| 36 | 117 | type @1, value from 2 (type 5: hostNumber w2 0..200; type 1 len>10: hostaddr.tim) |
| 37 | 118 | whichCmd @1, lowWord w4, highWord w6, status w8 |
| 38 | 119 | whichCmd @1, toSID w2, which @4, string from 5 |
| 39 | 120 | whichCmd @1, data from 2 |
| 40 | 127 | whichCmd @1, msgType w4, whichSub w6, value w8/w10 when msgType 1 |
| 41 | 121 | data from 6 |
| 45 | 123 | whichCmd @1, status @4, lowWord w5, highWord w7 |
| 47 | 125 | msgType @1, toSID w2, fromSID w4, data from 6 |
| 48 | 126 | data from 2 |
| 49 | 128 | whichCmd @1, data from 4 |
| 51 | 103 | object ID w4 (raw), w6, data from 8 |
| 52 | 104 | object ID w2 (raw), data from 6 |
| 147 | 111 | msgType @1, data from 2 |

Events of type 0x400 are routed by NetUser.handleEvent (module 59952). It ignores them
unless g85 is non-zero, and delivers each to the `to` object's handleMsg. **[C]**

## Layer 4: session (module 101, dialScript changeState, block 38)

**[C]** unless marked.

```
client                                              host
  ATDT... / PAD "c <addr>"  ----------------------->  (" CONNECTED")
  [link up, seq 0/0, no handshake]
  53 login (bbwbbbbwwbas)    ----------------------->
                            <-----------------------  0: [00 ?? ?? ?? 16 priv priv x w8...]
                                                      (cmd 0, whichCmd@4 = 22)
  7 joinNet (flags 0x81)     ----------------------->
                            <-----------------------  8: [08 ?? objID objID ?? ?? sid sid]
  34/4, 36/5, 45/1, 36/1+, 36/6+, 37/18, 37/32, 40/4 ->
                            <-----------------------  47 msgType 2 (land list)  OR  1 [whichCmd 36, sub 6]
  47/1                       ----------------------->
                            <-----------------------  1 [whichCmd 47, whichSub 1]
  g85 = 2 (online), creates land object (class 150)
```

Details:

- **Login reply OK:** cmd 0 with byte@4 = 22. It disposes the 70 s LoginTimeout. Word@5 is
  the privilege mask (4 gives g82=3, 128 gives 2, 2 gives 1). Byte@7 = 11 means the
  password has expired. Word@8 goes to g253.
- **Login reply rejected:** cmd 1 with @4 = 22. whichSub @5 = 9 means bad password (the
  client retries up to numTries @7). The text from offset 8 is shown.
- **joinNet reply:** cmd 8 must echo the object ID the client sent in its type 7 (word 2)
  and put the new SID at word 6. The client then calls SID(1, sid, obj), and state 2 waits
  for g2.sid.
- **Land list:** cmd 47 msgType 2 carries w0, w2, count w4, then records from offset 6 of
  12 bytes plus a name. These are written to landaddr.tim. The exact record split is **[G]**.
- **Optional:** cmd 36 type 5 sets hostNumber g251 (word @2). Cmd 36 type 1 with length > 10
  rewrites hostaddr.tim.

### Minimum fake host

The minimum a fake host must send to reach "logged in" (g85=2):

1. After the login (53): `00 00 00 00 16 <priv lo> <priv hi> 00 <w8 lo> <w8 hi>`.
2. After joinNet (7, its word 2 = objID): `08 00 <objID lo> <objID hi> 00 00 <sid lo> <sid hi>`.
3. After the state-3 burst: `01 00 00 00 24 06`, meaning cmd 1 with whichCmd 36 / sub 6.
   This assumes the 36/6 path and is **[G]** to be sufficient.
4. After 47/1: `01 00 00 00 2F 01`, meaning cmd 1 with whichCmd 47 / sub 1.

Every message goes through length-prefixed data frames, and every client data frame must be
ACKed with `0x90|seq`.
