# the-sierra-network-alive

A web port of **The ImagiNation Network** (INN, the 1995 successor of The Sierra
Network): a JavaScript implementation of its SCI-derived interpreter (LSCI),
plus a local Express server that plays the role of the host the client used to
dial by modem. It runs the Clubhouse (`CC`), CasinoLand (`LL`) and SierraLand
(`SL`); the DOS programs in `LAND.CFG` (Yserbius, Arena, ...) are out of scope.

## Requirements

- Node.js 22+
- Your own copy of an installed 1995 ImagiNation Network (LSCITV.EXE of May 1995,
  ImagiNation v2.4). Game data is not included.

The TSN v2.1 (1992) disks are no longer the target. `tools/install.mjs` and
the `test:install` / `test:resource` format tests still read them from `disk/`
when present.

## Setup

1. Copy the installed INN directory to `installed/INN/` (it holds `LSCITV.EXE`,
   `TSN.PRG`, `LAND.CFG`, the shared `RESOURCE.002` and the `CC`, `LL` and
   `SL` worlds, each with its own `RESOURCE.MAP` and `RESOURCE.001`). The port
   only reads it; nothing is written there except `manifest.json`.
2. Index it for the browser and install the dependencies:
   ```
   node tools/make-manifest.mjs
   npm install
   ```
3. Start the host and open the client:
   ```
   npm run server        # http://127.0.0.1:7000/, WebSocket "phone line" at /line
   ```
   Add `?host=fake` to run with an in-page fake host instead of the server.
   The host's default password is `XXXXXX`, the one in the shipped
   `PASS_SET.DTA` (`TSN_PASSWORD` overrides it); `--bots N` adds bots.

## Tests

```
npm run test:resource
npm run test:vm
npm run test:server
npm run test:audio
npm run test:install
```

## Docs

- `docs/install-format.md`: PART archive and PUFF compression
- `docs/sci-resources.md`: resource formats, LSCI module format, kernel table
- `docs/vm.md`: VM architecture and status
- `docs/protocol.md`: modem/PAD, framing, CRC, messages, login
- `docs/server.md`: host behaviour, message layouts, the Mall
- `docs/audio.md`: OPL2/AdLib music and digital sound
