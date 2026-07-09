import { signal } from "@preact/signals";

export type Screen = "start" | "choose" | "how" | "pair" | "handoff" | "room";
export type Method = "camera" | "sound" | "link";
export type BandMode = "auto" | "audible" | "ultrasound";

export type Msg =
  | { id: number; kind: "sys"; text: string }
  | { id: number; kind: "chat"; mine: boolean; text: string }
  | { id: number; kind: "file"; mine: boolean; name: string; size: number; progress: number; url?: string; file?: File; done: boolean };

export const screen = signal<Screen>("start");
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
export const bandMode = signal<BandMode>("auto");

export const useStun = signal(localStorage.getItem("useStun") === "1");

// Handoff (#a=)
export const handoff = signal<{ title: string; text: string; fallback: boolean; blob: string }>(
  { title: "Connecting…", text: "Handing the answer to the other tab…", fallback: false, blob: "" },
);

// Room
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
