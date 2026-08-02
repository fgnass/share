import { signal } from "@preact/signals";

// Build identifier (git hash · UTC date), injected by Vite's `define` (in both
// dev and build). The `typeof` guard just keeps this safe if the constant is
// ever absent (e.g. a raw test runner). Surfaced in the landing footer, logged
// at boot, and — since it's baked into the content-hashed bundle — a device
// pinning a stale cache will visibly show an older id than a fresh one.
export const BUILD_ID = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

export type Screen = "choose" | "how" | "pair" | "handoff" | "room";
export type Method = "camera" | "sound" | "link";
export type BandMode = "auto" | "audible" | "ultrasound";

export type Msg =
  | { id: number; kind: "sys"; text: string }
  | { id: number; kind: "chat"; mine: boolean; text: string }
  | { id: number; kind: "file"; mine: boolean; name: string; size: number; progress: number; url?: string; done: boolean; savedTo?: string; error?: boolean }
  | { id: number; kind: "batch"; mine: boolean; name: string; count: number; doneCount: number; size: number; progress: number; done: boolean; savedTo?: string; error?: boolean };

export const screen = signal<Screen>("choose");
export const method = signal<Method>("camera");

// Pair screen
export const pairIntro = signal("");
export const pairStatus = signal<{ text: string; dot: string }>({ text: "", dot: "wait" });
export const qrUrl = signal("");            // URL rendered as the QR (empty = none)
export const myLink = signal("");           // shareable link (link method)
export const camOn = signal(false);         // camera preview visible
export const camError = signal(false);

// Sound
export const audioStatus = signal("Pair by sound");
export const audioBusy = signal(false);
export const audioProgress = signal<number | null>(null); // 0..1 or null
// Which stage of the sound handshake we're in. The progress bar tracks a single
// frame, so it legitimately restarts several times per pairing — without a coarser
// indicator that reads as "it keeps retrying" rather than "it moved on".
//
// Deliberately NOUNS: the two devices traverse the exchange in opposite orders (one
// sends the offer and waits for the reply, the other waits then replies), so a verb
// would be wrong on one of them. "Offer" is a thing that exists, not an act — true on
// both sides, one label set, no role-awareness needed.
//   check — audio confirmed working (we heard our own beacon, or the peer's frame)
//   find  — the other device has been heard and who-offers is resolved
//   offer — the offer exists here, sent or received
//   reply — the answer exists here, sent or received
//   done  — both descriptions exchanged; WebRTC takes over from here
//
// "find" exists because discovery is a real phase the rail used to hide: after the
// audio check passes, the two devices beacon at each other and compare nonces to settle
// who sends the offer. That is what "Looking for the other device…" IS — it is neither
// part of the audio check nor the offer, and leaving it inside "check" meant the first
// step stayed active while showing a message about something else entirely.
export type SoundStep = "check" | "find" | "offer" | "reply" | "done";
export const STEPS: { key: SoundStep; label: string }[] = [
  { key: "check", label: "Check" },
  { key: "find", label: "Find" },
  { key: "offer", label: "Offer" },
  { key: "reply", label: "Reply" },
  { key: "done", label: "Done" },
];
export const audioStep = signal<SoundStep>("check");
// True while the Check gate is failing (nothing audible came back, or the mic never
// delivered audio). Marks the first step as a problem rather than letting the rail
// look like it simply hasn't got there yet.
export const audioTrouble = signal(false);
// We can hear the peer but don't know how much of the frame we'll get (no chirp lock,
// so no length). The bar sweeps instead of claiming a percentage it doesn't have.
export const audioIndeterminate = signal(false);
// ?band=audible|ultrasound presets the band (handy for testing); default auto.
const bandParam = new URLSearchParams(location.search).get("band") as BandMode | null;
export const bandMode = signal<BandMode>(bandParam === "audible" || bandParam === "ultrasound" ? bandParam : "auto");

// STUN is off by default (same-network pairing contacts nothing external). It is
// turned on automatically when a direct attempt fails and the user confirms, or
// when the peer's code shows it already uses STUN — no manual checkbox, no persist.
export const useStun = signal(false);
export const stunPrompt = signal(false);   // "couldn't connect directly — retry across networks?"

// Handoff (#a=)
export const handoff = signal<{ title: string; text: string; fallback: boolean; blob: string }>(
  { title: "Connecting…", text: "Handing the answer to the other tab…", fallback: false, blob: "" },
);

// Room
// Optional: stream incoming files straight into a chosen folder instead of
// buffering the whole file in RAM and downloading it (File System Access API,
// Chromium only). Picking the folder is the one user gesture the save needs.
export const canSaveToDir = typeof (globalThis as any).showDirectoryPicker === "function";
export const saveDir = signal<any>(null);   // FileSystemDirectoryHandle | null
export const saveDirName = signal("");
export const dragging = signal(false);       // a file/folder is being dragged over the room

export const roomStatus = signal<{ text: string; ok: boolean; showReconnect: boolean }>(
  { text: "Connected", ok: true, showReconnect: false },
);
export const messages = signal<Msg[]>([]);

// PWA install
export const canInstall = signal(false);
export const isIOS = signal(/iphone|ipad|ipod/i.test(navigator.userAgent) &&
  !(matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true));

// ── Dev debug view (add ?debug to the URL) ──
// Fed by music.ts's debug sink (wired in App). Lets us see, on a real device,
// exactly which tones the mic picks up and how the decoder/self-test behave.
export const debug = new URLSearchParams(location.search).has("debug");
// ?loopback: two tabs pair over a BroadcastChannel instead of real audio — lets
// us test the handshake locally without a mic/speaker. Implies verbose logging.
export const loopbackMode = new URLSearchParams(location.search).has("loopback");
export const dbgSpectrum = signal<any>(null);   // latest {sr, state, spectrum:{audible,ultrasound}}
export const dbgState = signal<string>("idle");
export const dbgMonitor = signal(false);        // standalone live monitor running
export const dbgLog = signal<string[]>([]);
export function dbgPush(line: string) {
  const stamp = new Date().toLocaleTimeString().split(" ")[0];
  dbgLog.value = [...dbgLog.value.slice(-40), `${stamp}  ${line}`];
}

let msgId = 0;
export const nextId = () => ++msgId;
export function pushMsg(m: Msg) { messages.value = [...messages.value, m]; }
export function updateMsg(id: number, patch: Partial<Msg>) {
  messages.value = messages.value.map((m) => (m.id === id ? { ...m, ...patch } as Msg : m));
}
