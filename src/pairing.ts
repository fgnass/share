// ── Pairing router ──────────────────────────────────────────────────────────
// Thin shell over three pieces that no longer know about each other:
//
//   conn.ts   — RTCPeerConnection lifecycle, the datachannel, chat + files.
//               Shared: both routes end in exactly the same room.
//   qr.ts     — QR route. Both devices offer AND answer; first channel to open
//               wins. No roles, no nonce tiebreak (both codes are visible at
//               once, so there is nothing to arbitrate).
//   sound.ts  — Sound route. Half-duplex, so one device talks at a time and the
//               roles MUST be agreed up front; nonces do that.
//
// The two routes used to share one `onScan` plus one set of role/committed/applied
// singletons. They pulled in opposite directions: the sound path needs roles, the
// QR path is better off without them, and the compromise produced a QR handshake
// that told each device to perform the other one's step. Keeping them apart is the
// point of this file being boring.
import * as C from "./conn";
import * as QR from "./qr";
import * as Sound from "./sound";
import * as S from "./state";
import { decode, linkFor, parseCode } from "./webrtc";
import { method as methodS } from "./state";

const bc = new BroadcastChannel("share.gnass.buzz");
const setStatus = (text: string, dot = "wait") => (S.pairStatus.value = { text, dot });

// Which route is live. null = still on the chooser.
let active: "camera" | "sound" | "link" | null = null;
export const inPairing = () => active !== null;

// ── Re-exports: the UI talks to one module ──
export const sendMessage = C.sendMessage;
export const sendFiles = C.sendFiles;
export const fromFileList = C.fromFileList;
export const fromDataTransfer = C.fromDataTransfer;
export const pickSaveDir = C.pickSaveDir;
export const clearSaveDir = C.clearSaveDir;
export type Upload = C.Upload;
export const stopSoundAuto = Sound.stopSoundAuto;
export const soundAuto = Sound.soundAuto;
export const slogBuf = Sound.slogBuf;
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
export async function chooseMethod(m: S.Method) {
  methodS.value = m;
  S.screen.value = "pair";
  if (active === m) return;          // already running this route
  QR.stopCamera(); Sound.stopSoundAuto();
  active = m;
  if (m === "sound") return void Sound.start();
  // "link" shares the same offer as the QR route — it just shows a URL instead of
  // a QR code, and the peer opens it (arriving via startFromCode on their side).
  await QR.start();
  if (m === "link") { S.camOn.value = false; S.qrUrl.value = ""; }
}

export const chooseBack = () => (S.screen.value = "pair");
export function switchMethod() { QR.stopCamera(); Sound.stopSoundAuto(); S.screen.value = "choose"; }

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
  // Dev/test: ?autosound jumps straight into sound pairing (needs a browser that
  // allows AudioContext without a gesture, e.g. --autoplay-policy=...).
  else if (new URLSearchParams(location.search).has("autosound")) {
    active = "sound"; methodS.value = "sound";
    S.screen.value = "pair";
    Sound.start().then(Sound.soundAuto);
  }
  else S.screen.value = "choose";
}

// The QR route's offer tab listens for a handed-off answer from the #a= tab.
QR.wireHandoff(bc);
