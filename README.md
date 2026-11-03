# the-sierra-network-alive

A web port of **The Sierra Network** (TSN / ImagiNation v2.1, 1992): a JavaScript
implementation of its SCI-derived interpreter (LSCI), plus a local Express server
that plays the role of the TSN host the client used to dial by modem.

## Requirements

- Node.js 22+
- Your own copy of the original TSN v2.1 install disks. Game data is not included.

## Setup

1. Copy the four disks into `disk/1`, `disk/2`, `disk/3`, `disk/4`.
2. Simulate the installer, which unpacks `PART.1-4` into `installed/TSN/`:
   ```
   node tools/install.mjs
   node tools/make-manifest.mjs
   npm install
   ```
3. Start the host and open the client:
   ```
   npm run server        # http://127.0.0.1:7000/, WebSocket "phone line" at /line
   ```
   Add `?host=fake` to run with an in-page fake host instead of the server.

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
