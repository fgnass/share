import { batch } from "@preact/signals";
import * as S from "./state";

/**
 * Staging mode for clean portfolio screenshots. Loading the app with
 * `?demo=<scene>` skips the live pairing and arranges a deterministic frame
 * instead — so each shot is the *real* UI (the actual QR renderer, the actual
 * message list), never a mockup, and stays correct as the app evolves.
 *
 * Every screen this app has is driven purely by the signals in state.ts, so a
 * scene is just a batch of signal writes: nothing here reaches into the
 * components, and App.tsx needs no demo branch at all.
 *
 *   ?demo=pair   the QR route mid-pairing: our code on the left, the camera
 *                panel on the right. No getUserMedia is started, so the scan
 *                area shows its black backdrop rather than whatever webcam the
 *                capture machine happens to have.
 *   ?demo=room   a connected room with a short conversation and two transfers,
 *                one finished and one still streaming.
 *
 * See scripts/screenshot.mjs, which drives the capture and waits on
 * `__shareDemoReady`.
 */
export type DemoScene = "pair" | "room";

/** Window flag the screenshot script polls once the staged frame is ready. */
const READY_FLAG = "__shareDemoReady";

// A fixed code, so the QR is pixel-identical across runs. Length and shape match
// a real compacted offer (see webrtc.ts) — the QR's density is part of the shot.
const DEMO_CODE =
  "1t7XkQ2mDfLpR9vAzYc4NbHs8JeWuG3xTMoi5PZqrKdlEnCyU0aBSfVhjw6OtIgXR2mQpLfD9vAz";

export const demoScene = (): DemoScene | null => {
  const v = new URLSearchParams(location.search).get("demo");
  return v === "pair" || v === "room" ? v : null;
};

/** Stage `?demo=<scene>`; a no-op (and a `false` return) without one. */
export function applyDemo(): boolean {
  const scene = demoScene();
  if (!scene) return false;
  batch(() => (scene === "pair" ? stagePair() : stageRoom()));
  // One frame for Preact to render the staged signals, then flag readiness.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    (globalThis as any)[READY_FLAG] = true;
  }));
  return true;
}

function stagePair() {
  const link = location.origin + location.pathname + "#o=" + DEMO_CODE;
  S.screen.value = "pair";
  S.method.value = "camera";
  S.qrUrl.value = link;
  S.myLink.value = link;
  // Show the scan panel without touching getUserMedia: .scanview paints black
  // behind the frame, which is exactly the "camera is up, pointed at nothing"
  // look we want in a still.
  S.camOn.value = true;
  S.pairIntro.value =
    "Point the two devices at each other. Each shows a code and reads the other's. Data goes straight between the devices. Nothing is uploaded.";
  S.pairStatus.value = { text: "Point the devices at each other.", dot: "wait" };
}

function stageRoom() {
  S.screen.value = "room";
  S.roomStatus.value = { text: "Connected", ok: true, showReconnect: false };
  S.saveDirName.value = "Downloads/share";
  // No chat in this scene. The two devices are side by side — that is what the
  // QR pairing is for — so their owners just talk, and what actually goes over
  // the wire is the thing they can't hand over by talking: a build to sideload,
  // a document to read, an archive back. Both directions, so it doesn't read as
  // a one-way upload.
  S.messages.value = [
    { id: S.nextId(), kind: "sys", text: "Connected — nothing is uploaded." },
    {
      id: S.nextId(), kind: "file", mine: true, name: "app-release-v2.4.1.apk",
      size: 47_300_000, progress: 100, done: true,
    },
    {
      id: S.nextId(), kind: "file", mine: false, name: "crash-report.pdf",
      size: 2_140_000, progress: 100, done: true, savedTo: "Downloads/share",
    },
    {
      id: S.nextId(), kind: "batch", mine: false, name: "design-handoff",
      count: 34, doneCount: 34, size: 128_000_000, progress: 100, done: true,
      savedTo: "Downloads/share",
    },
    {
      id: S.nextId(), kind: "file", mine: true, name: "invoices-q3.zip",
      size: 18_900_000, progress: 100, done: true,
    },
    {
      id: S.nextId(), kind: "file", mine: false, name: "contract-signed.pdf",
      size: 3_620_000, progress: 100, done: true, savedTo: "Downloads/share",
    },
    {
      id: S.nextId(), kind: "file", mine: true, name: "logs-2024-09-05.zip",
      size: 96_400_000, progress: 68, done: false,
    },
  ];
}
