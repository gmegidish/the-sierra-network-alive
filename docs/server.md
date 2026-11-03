# Local TSN host (server/)

A local stand-in for the 1992 Sierra Network host, so the web client can
"dial" it. It speaks the wire protocol in `docs/protocol.md`.

```
npm install
npm run server          # http://127.0.0.1:7000/  line: ws://localhost:7000/line
npm run server -- --bots 2   # or BOTS=2: bots sit in every waiting room
npm run fake-client     # in a second terminal: dial, log in, reach "online"
npm run test:server
```

Environment: `PORT` (default 7000) and `TSN_PASSWORD` (default `XXXXXX`, the
password stored in the shipped `installed/INN/PASS_SET.DTA`). The server binds to 127.0.0.1
only and refuses WebSocket upgrades whose `Origin` is not localhost/127.0.0.1.

## Layout

| file | side | role |
|---|---|---|
| `src/net/wire.js` | shared | frames, CRC, escaping, message stream, TSN(4) format encoder, password scrambling |
| `src/net/link.js` | shared | `LinkEndpoint`: stop-and-wait ARQ plus message reassembly, injected `send`/`now` |
| `src/net/modem.js` | shared | `HayesModem` (client: AT/ATD/CONNECT/+++), `X28Pad` (server: `@` prompt, `c addr`, CONNECTED) |
| `src/net/catalog.js` | shared | message type constants, decoders for logging both directions |
| `src/net/client-messages.js` | shared | client message builders (login 53, joinNet 7, startup burst, 47/1) |
| `src/net/ws-transport.js` | browser | `openLineTransport()`: the WebSocket "phone line" |
| `server/index.js` | server | Express static files (repo root) and the `/line` WebSocket |
| `src/net/host-messages.js` | shared | host reply builders (login, SID, land list, groups, member properties) |
| `src/net/host-logic.js` | shared | `HostLogic`: one decoded client message in, replies out; used by `HostSession` and, in-process, by `FakeServer` |
| `src/net/host-objects.js` | shared | host state of networked objects: properties (13/14) and group membership (10/11) |
| `src/net/world.js` | shared | `World`: the SIDs, groups and properties every session of one server shares, and routing between sessions |
| `src/net/bots.js` | shared | host-side bot players (waiting rooms, canned talk replies, accepting invitations) |
| `server/session.js` | server | `HostSession`: PAD, then LinkEndpoint, then `HostLogic` |
| `tools/fake-client.mjs` | Node | the client stack end to end, without the VM |

## The line

One WebSocket on `/line` is one phone call. The modem is local to the client
(the browser), so the socket starts right after `CONNECT`:

- **Binary messages** carry raw serial bytes in either direction, exactly as
  they would cross the modem. Message boundaries mean nothing; the receiver
  treats the data as a byte stream.
- **Text message `BREAK`** (client to server) is a line BREAK: the PAD goes back
  to command mode (`@` prompt) and both link seqs reset. This stands in for the
  hardware BREAK of MODEM.DRV fn 8 (reconnect).
- Closing the socket is hanging up (carrier loss).

Server side, the bytes first meet the X.28 PAD:

| caller sends | PAD answers |
|---|---|
| `@D\r`, `\r`, `SET?...\r` | `\r\n@` |
| `c <addr>\r` | `\r\n<ADDR> CONNECTED\r\n`, then transparent 8-bit |
| `D\r` after a call (after BREAK) | `\r\nDISCONNECTED` and `\r\n@` |
| anything else | `\r\n?` and `\r\n@` |

Every address connects to the same host. After CONNECTED all bytes go to the
link layer.

## Integration contract for the VM (MODEM.DRV emulation)

```js
import { openLineTransport } from './src/net/ws-transport.js';
import { HayesModem } from './src/net/modem.js';

let line = null;
const modem = new HayesModem({
  now: () => performance.now(),
  toDriver: (bytes) => uartRx.push(...bytes),          // the driver's RX ring
  toLine: (bytes) => line?.write(bytes),
  hangUp: () => line?.close(),
  dial: () => {
    line = openLineTransport();                         // ws://localhost:7000/line
    line.onOpen(() => modem.lineOpened());              // -> "CONNECT 2400"
    line.onData((bytes) => modem.lineReceived(bytes));
    line.onClose(() => modem.lineClosed());             // -> "NO CARRIER"
  },
});
// The driver's UART TX: modem.write(bytes)
```

If the VM emulates MODEM.DRV at the function level instead of at the UART,
it can skip `HayesModem`. In that case connect (fn 3) opens the transport, plays the
PAD dialog (`@D\r\r`, wait for `@`, `c SIERRA\r`, wait for ` CONNECTED`), and then
hands every later byte to the TSNEXEC link. TSNEXEC itself can be replaced by
`LinkEndpoint`:

```js
const link = new LinkEndpoint({
  send: (bytes) => line.write(bytes),
  now: () => performance.now(),
  onMessage: (message) => postTsnEvent(message),        // TSN(8) poll -> event 0x400
  onFail: (reason) => reportLinkError(reason),
});
// TSN(4): link.sendMessage(encodeMessage(fmt, args))
// TSN(12) idle: link.isIdle()
// 20-tick pump: link.tick()
```

## What the host sends

| client sends | host replies |
|---|---|
| 53 login, right password | `00 00 00 00 16 <priv w> 00 01 00` (cmd 0, whichCmd 22) |
| 53 login, wrong password | `01 00 00 00 16 09 00 03 "Invalid password." 00` (cmd 1, sub 9, numTries 3) |
| 7 joinNet | `08 00 <objID w> 00 00 <sid w>`; SIDs start at 101 and are unique per server. The session keeps the SID of its first joinNet; later ones register groups (waiting room, a new game). Flags bit 4 (shared, the waiting room `[7, 0, obj, 5, landType, 1, 128]`): one SID per (object, landType, maximum) for everybody |
| 36/5 | `24 05 <hostNumber w>` (hostNumber 1) |
| 36/6 | 47/2 land list (the four lands of `LAND.CFG`), then `01 00 00 00 24 06` |
| 47/1 | land info `2F 01 00 00 00 00 00 00 00 00 <count w>` then 5 bytes per land (hostNumber, landType, landNumber, maximum, curSize; root module 0 ProcessLandInfo, which marks unlisted lands N/A), then `01 00 00 00 2F 01`; the session is now `online` |
| 9 leaveNet `[9, sid, 0]` | nothing (sent before a land switch) |
| 13 word properties `[13, toSID, fromSID, (offset, value)...]` | nothing; stored per SID. fromSID 0xFFFF (public, e.g. offset 9 = the room module: 120 waiting room, 911 BlackJack) is also sent unchanged to every other session |
| 14 string property `[14, toSID, fromSID, offset, text\0]` | the same |
| 32 get one object `[32, sid, sid, offset...]` | cmd 33 (class 116) `21 00 <sid w> <sid w>`, then per property `type b (0 word, 1 string), offset w, value` |
| 10 join group `[10, group, who, 1, 1, 17]` | to every member (the joiner too): cmd 10 `0A 00 <group w> <who w>`, then cmd 12 `0C 00 <group w> 00 00 <member w>...` |
| 11 leave group | to every member: cmd 11 `0B 00 <group w> <who w>`, then cmd 12 to the rest. Hang-up and 9 leaveNet do the same for every group of every SID the session owned |
| 2 / 3 user message `[2, notify, toSID w, fromSID w, msgType w, data]` | relayed unchanged to toSID's session, or to every other member when toSID is a group |
| 31/1 get members `[31/1, group, group, offset...]` | cmd 31, see below |
| 4 lock game group `wwa [4, group, member...]` (bytes `04 00 <group w> <member w>...`, no count) | cmd 0 ok `00 00 <group w> 04 00` (whichCmd 4 @4); the members join the group |
| 40/3 bank request `bbwww [40, 3, sid, 1, 1]` | cmd 40 to SID 0 `28 03 00 00 01 00 01 00 <low w> <high w>`: whichCmd 3 @1, msgType 1 @4, whichSub 1 @6, the LarryBucks as a long @8 |
| 28 "said" fan-out `bwwaw+ [28, me, count, count, members[], msgType, data...]` | each listed member except 0 and `me` gets cmd 2 `02 00 <member w> <me w> <msgType w> data` |
| 30/7 `[30, group]`, 2/0 user message `[2, group, me, 103, x]` (slot handle pulled) | nothing |
| 37/32 `bbw+ [37, 32, sid, 0, 0]` from the Mall (sid != 0) | store list, see "The Electronic Mall"; the startup 37/32 (sid 0) gets nothing |
| 37/19 `[37, 19, sid, boxLow, boxHigh]` | the box's letters (a store's products) |
| 37/31 `[37, 31, sid, boxLow, boxHigh, letterLow, letterHigh]` (37/25 the same) | the letter's text (an order form) |
| 37/24 deliver a letter `bbwwwawwawaaa` (an order) | cmd 0 `00 00 <sid w> 25 18` (whichCmd 37, whichSub 24) |
| 36/7 `bbw+ [36, 7, stampLow, stampHigh]` (INN: gameinfo.tim) | `24 07 00 00`: short form, "your gameinfo.cfg is current". A longer one (stamp words + file bytes) would be written to gameinfo.tim/.cfg; either releases the dial script (module 101 block 43 state 7) |
| 2/0 `wwwwa` INVITE (msgType 12) to a bot | the bot answers `wwww [2, retAddress, bot, 13 ACCEPT]` to the inviter's invite room (data word 2 of the INVITE) |
| anything else | nothing; it is logged |

**Land instances.** The host lists the INN lands it runs, four instances each,
named as in the shipped `installed/INN/LANDADDR` (Clubhouse: INN Help Room,
Tech Tower, Hearts, Singles Club; SierraLand: Dogfight Downs, Wacky Way,
Looney Lane, Aerodrome; CasinoLand: High Rollers, Polite Place, Atlantic City,
Key West), landNumber 1-4.
Module 55 reads names with `%20s`, so spaces travel as underscores and the
chooser shows spaces. The chooser gauge (PlaceButton.draw, view 55) shows
`0`, a bar of curSize * 24 / maximum pixels and the maximum; curSize 255 is
"???" and maximum 254 is "N/A". Every land is 0 of `LAND_CAPACITY` (64) for now.
The chooser's default item is the remembered instance from `lastplc.dat`
(module 50); without one (a new player) it is CANCEL, drawn in the red
selectColor.

**The Electronic Mall** (map "Shop", root module 160; src/net/mall.js).
Stores are TSN mail boxes (class Box, module 145) and products are letters in
them. The Mall joinNets (`[7, 0, 3852, 1, 1, -1, 25]`), and when the SID
arrives (cmd 8) and no store list is cached it sends 37/32 and shows "Getting
Store Information" until the reply. All replies are cmd 37 (class 118, no
payload shift): whichCmd @1, toSid w2, lowWord w4, highWord w6, data from 8.

- **37/32 stores:** per store `box low w, box high w, type b (4 = store), name\0`;
  `_` shows as a space, `|` is dropped. One store opens directly, more show
  "The Stores".
- **37/19 products** (Box getMailList, lowWord/highWord = the box): up to 64
  envelopes of 47 bytes (Envelope fromMsg, module 145 block 7): status b,
  letter low w, letter high w, returnLo w, returnHi w, host[10], name[10] (the
  product button), appBits w, time[6], toName[10].
- **37/31 form** (25 = plain read): box w4/w6, letter w8/w10, text from 12.
  The text is an order form (module 160 block 188): a title line, then
  questions, each a line starting with `%`, optional digits and a type letter
  (t true/false, d number with the digits as maximum, s fill in the blank, m
  multiple choice, c select). Real line breaks inside a question are dropped;
  `\n` breaks a line, `\h` starts its help text. A form with no question is
  "Invalid Order Form! Illegal format characters or bad header."
- **37/24 order:** the filled form goes out as a letter; cmd 0 whichCmd 37
  whichSub 24 shows "Order recieved by the Mall." (cmd 1 = NOT recieved).

The host has three dummy stores (Sierra Software, TSN Gear, Hint Books);
orders are acknowledged and dropped.

**Creating a game** (LarryLand "Play" -> pick a game; LL module 1019, the
game-creation script): state 0 joinNets the game object (`[7, 0, objID, 1,
landType, -1, 19]`) and gets its SID; state 1 sends lock (cmd 4) and waits in
handleMsg for `command 0, whichCmd 4`; state 2 unlocks (cmd 6, no reply
needed), builds `playGroup` and goes to the game room. The Slots room then
joins its room group (cmd 10) and sends `30/7 [30, group]` and
`28/4 [28, me, 0, 0, [], 100, group]`; neither needs a reply. 28 is a
fan-out to the other members (LL module 10), empty when alone.

**Money.** LarryLand keeps the player's money (g81 `money`, MoneyLongInt
g194) in its own file `..\ll$$NNNN.dat` (LL module 0 ReadMoneyFile /
UpdateMoneyFile, xor-scrambled with g153). Only when the file is missing does
it send 40/3; the reply opens "The Bank of LarryLand". New players get
`STARTING_BUCKS` (500). The server keeps one balance per player name for its
lifetime (in memory); the client never reports wins back, so the server's
number is only the opening balance.

**Games are client-side.** Slots (LL module 1030) and BlackJack (911) compute
spins and deals with the Random kernel; nothing is asked of the host. The host
can't decide results without changing the client. For repeatable runs the VM
takes a seedable `random` (`createRandom(seed)`, mulberry32; `SEED=n` for
tools/run-headless.mjs).

Group objects are registered with joinNet flags 5 (`[7, 0, objID, 5, landType,
1, maximum]`, the land's waiting-room group); the host assigns a SID as for any
joinNet.

Cmd 31 (class 124) is `1F 00 <toSID w> <group w> <member count w> <property
count w>`, then `(offset w, type w)` per property (type 1 = string, else word),
then per member `<sid w>` and its values (word, or NUL-terminated string). The
client skips its own object (g81) and sets the others' properties with
ObjOffsetProp. The waiting room's PlayerLogin script (LL module 120, block 226)
stays in state 3/4 until every member of the group has a name.

The client's cmd 12 handler copies the payload into a word array with Array
copy, which in LSCITV is a raw byte memmove: member SIDs are little-endian words.

Every inbound message is logged, decoded (`<- 53 login {...}`). An unknown
type is logged as hex. Bad CRCs are NAKed. Frames over 255 bytes are dropped.
A PAD command line is capped at 80 characters. Exceptions in a session are
logged, never thrown.

## Multiplayer

One `World` per server (`server/index.js`; each `FakeServer` makes its own
unless one is passed in) owns SIDs, groups, properties and which session owns
which SID. A session is anything with `deliver(message)`; HostLogic's
`deliver` queues a host message to its caller. Routing rules:

- joinNet: the SID belongs to the session; client 10 also claims `who` for
  the session. Shared (flags 4) objects have no owner.
- 2/3: toSID a group with members -> every member's session except fromSID's;
  else toSID's owner.
- 28: one cmd 2 per listed member (see the table).
- 13/14 with fromSID 0xFFFF -> every other session.
- 10/11/leaveNet/hang-up -> cmd 10/11 and 12 to the group's members.

**Presence.** The waiting room (LL module 120) joins its shared group; every
member hears cmd 10 + 12, and each client asks for an unknown member's
persona with client 32 (offsets 5 name, 18 face, 24 occupation, 9 room, ...),
answered with cmd 33 from the shared properties. 31/1 returns the stored
values of every member.

**Talk.** Select players, Talk: client 2 `[2, 0, to, from, 1, 14, 2, 1,
text\0]` per recipient; the receiver shows "Gil states, "...""  with
Complain/Mute/Reply/OK.

**Joining a game** (LL module 1020, play1Script). The table owner's client
sets public property 9 = 911 (BlackJack) with 13/0xFFFF, so a waiting room
shows the player as "in BlackJack" and offers Join. Join sends a msgType-55
user message to the owner; the owner's client asks "... wants to join, Yes/No"
and answers with msgType 13 (accept, carrying the table group) or 14/31/32/39
(refusals); on accept the joiner newRooms to the game and joins the table
group (`[7, 0, obj, 2, 3, -2, 64]`, flags 2) with client 10.

**BlackJack moves** (module 911, all 28 fan-outs or 2 to one player, msgType
then words; the meanings are read from the traffic and module 911's
handlers, not from documentation). The table owner deals; the round id is a
random word.

| msgType | from | data | meaning |
|---|---|---|---|
| 105 | dealer | `dealer, player, 0, 0, round` | a new betting round |
| 100 | each | `round, 0` / `round, 1, bet, 0` | bet state; bet 0 = sitting out |
| 24 | dealer, cmd 2 to each player | 52 bytes | the shuffled deck, one byte per card (rank in the high nibble 1-13, suit low 1-4) |
| 42 | dealer | `round, seat, card` | next card / turn (applied only in state 5) |
| 106 | player | `0` | done with the round |
| 109 | owner -> joiner, cmd 2 | `2, owner, joiner, 0, 0, owner` | the table after the join |

Messages that arrive before the game expects them are put back (putMsg) and
retried, so delivery order between different senders does not matter.

**Bots** (`--bots N` / `BOTS=N`, src/net/bots.js): host-side players with
names and a plain face. They join every waiting room when it opens and answer
talk with a canned line. They accept game invitations the way an invitee does
in the INN invite rooms (installed/INN/913.SO, SierraLand modules 905-907):
INVITE is msgType 12, its data is `whatGame, numInvitees, retAddress,
invitee SIDs...`, and the answer `TSN_SEND "wwww" SN_SEND retAddress mySid
ACCEPT(13)` goes to retAddress (DECLINE is 14, UNKNOWN_GAME 999). The inviter
then opens the game and shows "Waiting to start...": the bot never joins the
game group or moves, so the game does not start (a seat needs a client that
plays).

## Findings against docs/protocol.md

These come from module 101: block 22 (`handleMsg` of the session object) and
block 38 (dialScript).

- **Startup burst conditions.** 34/4 is skipped when g101 or `ShutUp` is set.
  45/1 is sent only when g102, g174 and g175 are all zero. 37/18 is sent only
  when g174 or g175 is set. 37/32 is always sent. 40/4 is sent only when g81 is
  an object. 36/1 and 36/6 are always sent, with two words from
  hostaddr.tim / landaddr.tim, or 0,0 when the file is absent.
- **The wait after the burst** (state 4, local 4) ends on *either* cmd 47
  msgType 2 (land list) *or* cmd 1 with whichCmd 36 / whichSub 6. The wait
  after 47/1 (state 6, local 3) ends on cmd 1 [47, 1] *or* cmd 47 msgType 1.
- **Land list layout.** The count is word@4 and records start at offset 6. Each
  record is 12 single bytes followed by a NUL-terminated name. It is written to
  landaddr.tim as `"%20s %3d %3d %3d %03d.%03d.%03d %03d.%03d.%03d %3d"`: the
  name, bytes 0-2, bytes 5-7, bytes 8-10 and byte 11. Bytes 3 and 4 are read but
  never written. Module 55 (block 18) parses each line into a land entry:
  `hostNumber` (byte 0), `landType` (1), `landNumber` (2), `minVer`
  (5-7, major.minor.revision), `maxVer` (8-10) and `landFlags` (11). A line is
  dropped when hostNumber is 255 or landType, landNumber or landFlags is 0.
  The chooser (module 55 blocks 12/14/15) lists the entries whose landType is
  the clicked land's LAND.CFG number (INN: 1 Clubhouse, 2 SierraLand,
  3 CasinoLand) and whose version range contains the installed land's
  version; min = max = 0.0.0 accepts any version. `DEFAULT_LANDS` now sends
  one entry per land, hostNumber 1, landNumber 1, versions 0, flags 1.
- **Entering a land** (module 101 block 112) is a program switch, not a
  message: the client joins again, stores a 129-byte handover in the TSN
  shared buffer (TSN 2: host and land numbers, persona name, g168, password
  bytes, g253, ...), sends leaveNet 9, calls TSN(9, program) with the LAND.CFG
  program name (falling back to "Default"), waits for the link to go idle and
  quits. TSNEXEC then runs that program from TSN.PRG (`LLand`: `cd LL`,
  `..\lscitv.exe`). The new interpreter reads the buffer back with TSN(1),
  clears it with TSN(2, 0, 0), logs in to the land (47/1, joinNet with the land
  type as number) and shows the land's own player screen. The connection is
  not dropped.
- **The minimum host does not set g85 = 2 by itself.** State 7 creates the land
  object and sets g85 = 2 only when g251 != 255 *and* g252 != 0. g251 is the
  host number from cmd 36/5 (or the `hostNum` ConfigStr); g252 is the land
  number (the `landNum` ConfigStr, or from a land object). Otherwise it calls
  block 5: g144 = 50, a new room 50, which is the TSN map ("gateway to all the
  TSN lands"), presumably fed by landaddr.tim. So the expected flow is login,
  then the map room, then choosing a land.
- **36/5 from the client** (`bb`, no data) is a request. The host's cmd 36
  type 5 (hostNumber word@2, accepted when 0..200) is its natural answer.
- **The login password field** is `a` with count 11, copied from g183's data.
  `encodePassword` yields 10 bytes, so the 11th byte is the NUL pad.
- **wire.js `createFrameReader`** had no frame-size limit, so a peer could
  grow its buffer without bound. It now takes `{ maxFrameBytes, onOversize }`.
  The default is unchanged (no limit); LinkEndpoint passes 255.
