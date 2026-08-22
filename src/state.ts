import { signal } from "@preact/signals";

// Build identifier (git hash · UTC date), injected by Vite's `define` (in both
// dev and build). The `typeof` guard just keeps this safe if the constant is
// ever absent (e.g. a raw test runner). Surfaced in the landing footer, logged
// at boot, and — since it's baked into the content-hashed bundle — a device
// pinning a stale cache will visibly show an older id than a fresh one.
export const BUILD_ID = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

export type Screen = "choose" | "how" | "pair" | "handoff" | "room";
export type Method = "camera" | "link";

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

let msgId = 0;
export const nextId = () => ++msgId;
export function pushMsg(m: Msg) { messages.value = [...messages.value, m]; }
export function updateMsg(id: number, patch: Partial<Msg>) {
  messages.value = messages.value.map((m) => (m.id === id ? { ...m, ...patch } as Msg : m));
}
