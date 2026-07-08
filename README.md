# share.gnass.buzz

Peer-to-peer messaging and file transfer, straight between two devices — no
account, no server. WebRTC data channels carry everything; the connection
handshake is exchanged by QR code (point the devices at each other), a link, or
a pasted code. On the same network nothing external is contacted at all; a STUN
server is opt-in for connecting across networks.

## How it works

- **Pair:** one screen shows a QR and runs the camera at the same time — no mode
  switch. The devices auto-detect each other's codes and connect.
- **No camera:** share a link or paste a code instead.
- **SDP compaction:** only the variable WebRTC fields are shipped (packed to
  ~130 bytes) and a full SDP is rebuilt from a template, keeping the QR/link small.

## Develop

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

Produces a single self-contained `dist/index.html` (JS, CSS and the web font all
inlined) that can be hosted anywhere. Serve over HTTPS so the camera works.

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.
