// ── Pairing router ──────────────────────────────────────────────────────────
// Thin shell over two pieces:
//
//   conn.ts — RTCPeerConnection lifecycle, the datachannel, chat + files.
//   qr.ts   — the handshake. Both devices offer AND answer; the first
//             datachannel to open wins. No roles, no tiebreak: both codes are
//             visible at once, so there is nothing to arbitrate.
//
// "camera" and "link" are the same negotiation — they differ only in how the
// offer reaches the peer (a QR their camera reads, or a URL you send them).
import * as C from "./conn";
import * as QR from "./qr";
import * as S from "./state";
import { decode, linkFor, parseCode } from "./webrtc";
import { method as methodS } from "./state";

const bc = new BroadcastChannel("share.gnass.buzz");
const setStatus = (text: string, dot = "wait") => (S.pairStatus.value = { text, dot });

// Whether pairing has started. null = still on the chooser.
let active: S.Method | null = null;
export const inPairing = () => active !== null;

// ── Re-exports: the UI talks to one module ──
export const sendMessage = C.sendMessage;
export const sendFiles = C.sendFiles;
export const fromFileList = C.fromFileList;
export const fromDataTransfer = C.fromDataTransfer;
export const pickSaveDir = C.pickSaveDir;
export const clearSaveDir = C.clearSaveDir;
export type Upload = C.Upload;
export const stopCamera = QR.stopCamera;
export const retryWithStun = QR.retryWithStun;

export const reconnect = () => location.replace(location.origin + location.pathname);

// The Pair component registers its <video> when the camera panel mounts. We scan
// for as long as we're on the QR route and not yet connected — both devices keep
// scanning the whole time, because either one's answer may be the winner.
export function registerVideo(el: HTMLVideoElement | null) {
  if (el && methodS.value === "camera" && !C.isEntered()) QR.startCamera(el);
  else if (!el) QR.stopCamera();
}

// ── Method selection ──
// Both methods run the same handshake; "link" just hides the QR and shows a URL
// (the peer opens it and lands in startFromCode).
export async function chooseMethod(m: S.Method) {
  S.screen.value = "pair";
  if (active) return QR.setMethod(m);   // already pairing — just re-present it
  active = m;
  methodS.value = m;
  await QR.start();
}

export const chooseBack = () => (S.screen.value = "pair");
export function switchMethod() { QR.stopCamera(); S.screen.value = "choose"; }

export function applyPaste(text: string) {
  const parsed = parseCode(text);
  if (!parsed) { alert("Invalid code"); return; }
  // A pasted offer makes us the answerer for it; a pasted answer completes ours.
  void QR.acceptPasted(parsed);
}

export async function share(url: string) {
  try { if (navigator.share) return await navigator.share({ url, title: "share.gnass.buzz" }); } catch {}
  try { await navigator.clipboard.writeText(url); alert("Link copied"); } catch {}
}

// ── Handoff tab (#a=) ──
// Opening an answer link in a new tab: hand the SDP to the original tab over a
// BroadcastChannel so it can finish there, and fall back to a copyable code.
async function startHandoff(code: string) {
  S.screen.value = "handoff";
  const sdp = decode(code);
  let acked = false;
  bc.onmessage = (e) => {
    if (e.data.type === "ack") {
      acked = true;
      S.handoff.value = { ...S.handoff.value, title: "Connected", text: "All done. You can close this tab and continue in the other one." };
    }
  };
  bc.postMessage({ type: "answer", sdp });
  setTimeout(() => {
    if (acked) return;
    S.handoff.value = { title: "Manual hand-over needed", text: "The original tab isn't reachable.", fallback: true, blob: linkFor("a", code) };
  }, 1500);
}

// ── Init: route by URL hash ──
export function initRouting() {
  // Re-check the live connection whenever the tab comes back to the foreground:
  // a suspended mobile tab often drops the connection without firing any event.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) C.reflectConn(); });
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.has("o")) { active = "camera"; QR.startFromCode(hash.get("o")!); S.screen.value = "pair"; }
  else if (hash.has("a")) startHandoff(hash.get("a")!);
  else S.screen.value = "choose";
}

// The QR route's offer tab listens for a handed-off answer from the #a= tab.
QR.wireHandoff(bc);
