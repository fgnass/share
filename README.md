# share.gnass.buzz

Peer-to-peer messaging and file transfer, straight between two devices — no
account, no server. WebRTC data channels carry everything; the connection
handshake is exchanged by QR code (point the devices at each other), a link, or
a pasted code. On the same network nothing external is contacted at all; a STUN
server is opt-in for connecting across networks.

## How it works

- **Start screen:** a short intro explains the flow; "Connect a device" opens the
  pairing screen. Scanned/hand-off links skip straight past it.
- **Pair:** one screen shows a QR and runs the camera at the same time — no mode
  switch. The devices auto-detect each other's codes and connect.
- **No camera:** share a link or paste a code instead.
- **SDP compaction:** only the variable WebRTC fields are shipped (packed to
  ~130 bytes) and a full SDP is rebuilt from a template, keeping the QR/link small.
- **Installable (PWA):** a manifest + service worker make it installable to the
  home screen and usable offline (pairing is peer-to-peer, so no server is needed
  once loaded).

## License

MIT — see [LICENSE](LICENSE).

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
