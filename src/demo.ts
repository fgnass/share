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

// What the staged QR encodes. Fixed, so the code is pixel-identical across runs.
const DEMO_QR_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

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
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      (globalThis as any)[READY_FLAG] = true;
    }),
  );
  return true;
}

function stagePair() {
  S.screen.value = "pair";
  S.method.value = "camera";
  S.qrUrl.value = DEMO_QR_URL;
  S.myLink.value = DEMO_QR_URL;
  // Show the scan panel without touching getUserMedia: .scanview paints black
  // behind the frame, which is exactly the "camera is up, pointed at nothing"
  // look we want in a still.
  S.camOn.value = true;
  S.pairIntro.value =
    "Point the two devices at each other. Each shows a code and reads the other's. Data goes straight between the devices. Nothing is uploaded.";
  S.pairStatus.value = {
    text: "Point the devices at each other.",
    dot: "wait",
  };
}

function stageRoom() {
  S.screen.value = "room";
  S.roomStatus.value = { text: "Connected", ok: true, showReconnect: false };
  S.saveDirName.value = "Downloads/share";
  // No chat in this scene. The two devices are side by side — that is what the
  // QR pairing is for — so their owners just talk, and what crosses the wire is
  // what they can't hand over by talking. The order is a test loop: a build
  // goes out, screenshots come back, a fixed build goes out, more screenshots
  // and the log come back. Both directions, so it doesn't read as an upload.
  S.messages.value = [
    { id: S.nextId(), kind: "sys", text: "Connected. Nothing is uploaded." },
    {
      id: S.nextId(),
      kind: "file",
      mine: true,
      name: "app-release-v2.4.0.apk",
      size: 47_300_000,
      progress: 100,
      done: true,
    },
    {
      id: S.nextId(),
      kind: "batch",
      mine: false,
      name: "screenshots",
      count: 6,
      doneCount: 6,
      size: 14_800_000,
      progress: 100,
      done: true,
      savedTo: "Downloads/share",
    },
    {
      id: S.nextId(),
      kind: "file",
      mine: false,
      name: "logcat-v2.4.0.zip",
      size: 6_120_000,
      progress: 100,
      done: true,
      savedTo: "Downloads/share",
    },
    {
      id: S.nextId(),
      kind: "file",
      mine: true,
      name: "app-release-v2.4.1.apk",
      size: 47_400_000,
      progress: 100,
      done: true,
    },
    {
      id: S.nextId(),
      kind: "batch",
      mine: false,
      name: "screenshots-v2.4.1",
      count: 9,
      doneCount: 9,
      size: 22_100_000,
      progress: 100,
      done: true,
      savedTo: "Downloads/share",
    },
    {
      id: S.nextId(),
      kind: "file",
      mine: false,
      name: "logcat-v2.4.1.zip",
      size: 8_640_000,
      progress: 74,
      done: false,
    },
  ];
}
