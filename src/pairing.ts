import jsQR from "jsqr";
import {
  b64u, decode, packDesc, withType, encode, iceComplete, linkFor, parseCode,
  freshNonce, CHUNK, HIGH_WATER, LOW_WATER,
} from "./webrtc";
import {
  playFrame, listenFor, stopAudio, setUltrasound, resetAuto, abortAuto,
  isOffer, isAnswer, isAck, ACK, rxBand,
} from "./music";
import * as S from "./state";
import { method as methodS } from "./state";

const bc = new BroadcastChannel("share.gnass.buzz");
const rtcConfig = (): RTCConfiguration =>
  ({ iceServers: S.useStun.value ? [{ urls: "stun:stun.l.google.com:19302" }] : [] });

let myNonce = freshNonce();
let pc: RTCPeerConnection | null = null;
let role: "offerer" | "answerer" | null = null;
let committed = false, applied = false, entered = false;
let myCode: string | null = null, myAudio: Uint8Array | null = null, lastOfferCode: string | null = null;
let channel: RTCDataChannel | null = null;
let sendQ: Promise<void> = Promise.resolve();

const method = () => methodS.value;
const setStatus = (text: string, dot = "wait") => (S.pairStatus.value = { text, dot });

// ── Console log of what this device generated (inspect candidates/sizes) ──
function logGen(kind: string, sdp: string) {
  const cands = [...sdp.matchAll(/a=candidate:\S+ \d+ udp \d+ (\S+) (\d+) typ (host|srflx)/gi)]
    .map((m) => `${m[3]} ${m[1]}:${m[2]}`);
  console.log(`%c[share] ${kind}`, "font-weight:bold;color:#acff69",
    `— code ${myCode?.length} chars, audio ${myAudio?.length} bytes, ${cands.length} candidate(s)`);
  console.log("[share] SDP:\n" + sdp);
}

// ── Camera QR scanning ──
let scanStream: MediaStream | null = null, scanning = false;
const handled = new Set<string>();
export async function startCamera(video: HTMLVideoElement) {
  if (scanning) return;
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .catch(() => navigator.mediaDevices.getUserMedia({ video: true }));
    video.srcObject = scanStream;
    await video.play();
  } catch {
    S.camOn.value = false; S.camError.value = true;
    setStatus("Camera unavailable. Use a different method.", "err");
    return;
  }
  scanning = true;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const tick = () => {
    if (!scanning) return;
    if (video.readyState >= 2 && video.videoWidth) {
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      const parsed = hit && parseCode(hit.data);
      if (parsed && !handled.has(parsed.code)) { handled.add(parsed.code); onScan(parsed); }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
export function stopCamera() {
  scanning = false;
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
}
// The Pair component registers its <video> when the camera panel mounts; we
// start scanning as long as we're in camera mode and not yet connected (an
// answerer keeps scanning with the view hidden, to recover a both-answerer race).
let videoEl: HTMLVideoElement | null = null;
export function registerVideo(el: HTMLVideoElement | null) {
  videoEl = el;
  if (el && methodS.value === "camera" && !entered) startCamera(el);
  else if (!el) stopCamera();
}

// ── DataChannel: chat + files ──
function setupChannel(ch: RTCDataChannel) {
  channel = ch;
  ch.binaryType = "arraybuffer";
  let inc: { name: string; size: number; mime: string; chunks: ArrayBuffer[]; got: number; id: number } | null = null;
  ch.onopen = enterRoom;
  ch.onclose = () => { S.roomStatus.value = { text: "Connection lost", ok: false, showReconnect: true }; };
  ch.onmessage = (e) => {
    if (typeof e.data === "string") {
      const m = JSON.parse(e.data);
      if (m.k === "chat") { S.pushMsg({ id: S.nextId(), kind: "chat", mine: false, text: m.t }); return; }
      if (m.k === "file") {
        const id = S.nextId();
        S.pushMsg({ id, kind: "file", mine: false, name: m.n, size: m.s, progress: 0, done: false });
        inc = { name: m.n, size: m.s, mime: m.m, chunks: [], got: 0, id };
        if (m.s === 0) { finalize(inc); inc = null; }
      }
      return;
    }
    if (!inc) return;
    inc.chunks.push(e.data); inc.got += e.data.byteLength;
    S.updateMsg(inc.id, { progress: (inc.got / inc.size) * 100 });
    if (inc.got >= inc.size) { finalize(inc); inc = null; }
  };
}
function finalize(inc: { chunks: ArrayBuffer[]; mime: string; id: number; name: string }) {
  const blob = new Blob(inc.chunks, { type: inc.mime || "application/octet-stream" });
  S.updateMsg(inc.id, { done: true, url: URL.createObjectURL(blob), progress: 100 });
}

function enterRoom() {
  if (entered) return; entered = true;
  autoRunning = false; stopCamera(); stopAudio();
  S.screen.value = "room";
  S.pushMsg({ id: S.nextId(), kind: "sys", text: "Connected. Say hi" });
}

export function sendMessage(text: string) {
  const t = text.trim();
  if (!t || !channel || channel.readyState !== "open") return false;
  channel.send(JSON.stringify({ k: "chat", t }));
  S.pushMsg({ id: S.nextId(), kind: "chat", mine: true, text: t });
  return true;
}
export function sendFiles(files: File[]) {
  for (const f of files) sendQ = sendQ.then(() => sendOne(f)).catch(console.error);
}
async function sendOne(file: File) {
  if (!channel || channel.readyState !== "open") return;
  const id = S.nextId();
  S.pushMsg({ id, kind: "file", mine: true, name: file.name, size: file.size, progress: 0, done: false });
  channel.send(JSON.stringify({ k: "file", n: file.name, s: file.size, m: file.type }));
  let sent = 0;
  for (let off = 0; off < file.size; off += CHUNK) {
    const buf = await file.slice(off, off + CHUNK).arrayBuffer();
    channel.send(buf); sent += buf.byteLength;
    S.updateMsg(id, { progress: (sent / file.size) * 100 });
    if (channel.bufferedAmount > HIGH_WATER) {
      await new Promise<void>((res) => {
        channel!.bufferedAmountLowThreshold = LOW_WATER;
        channel!.addEventListener("bufferedamountlow", () => res(), { once: true });
      });
    }
  }
  S.updateMsg(id, { done: true }); // sent (no download link on the sender)
}
export const reconnect = () => location.replace(location.origin + location.pathname);

// ── Present the right pieces for the chosen method / role ──
function applyPairUI() {
  S.camOn.value = method() === "camera" && role === "offerer" && !committed;
}

// ── Offerer ──
export async function startOfferer(m: S.Method) {
  role = "offerer"; methodS.value = m;
  S.pairIntro.value = "Point the two devices at each other. This QR code is yours; the camera reads theirs. Data goes straight between the devices. Nothing is uploaded.";
  S.screen.value = "pair";
  applyPairUI();
  await mintOffer();
}
async function mintOffer() {
  try { pc?.close(); } catch {}
  applied = false; entered = false; channel = null;
  pc = new RTCPeerConnection(rtcConfig());
  setupChannel(pc.createDataChannel("data"));
  await pc.setLocalDescription(await pc.createOffer());
  await iceComplete(pc);
  const packed = packDesc(pc.localDescription!, myNonce);
  myCode = b64u(packed); myAudio = withType(0x6f, packed);
  S.myLink.value = linkFor("o", myCode);
  S.qrUrl.value = method() === "camera" ? S.myLink.value : "";
  logGen("offer", pc.localDescription!.sdp);
  applyPairUI();
  setStatus(method() === "sound" ? "Play your code, or listen for theirs." : "Looking for the other device…");
  bc.onmessage = (e) => {
    if (e.data.type === "answer" && role === "offerer" && !applied) {
      bc.postMessage({ type: "ack" });
      applyAnswer({ type: "answer", sdp: e.data.sdp } as any);
    }
  };
}
async function applyAnswer(sdp: RTCSessionDescriptionInit) {
  if (applied) return; applied = true; committed = true;
  await pc!.setRemoteDescription(sdp);
  setStatus("Connecting…");
}

// ── Answerer ──
export async function startAnswerer(code: string) {
  role = "answerer"; methodS.value = "camera"; committed = true; lastOfferCode = code;
  S.screen.value = "pair";
  S.pairIntro.value = "Almost there. Show this new code to the other device’s camera to finish connecting. If they sent you a link instead, use a different method to send this reply back.";
  await buildAnswer(code);
}
async function becomeAnswerer(code: string) {
  committed = true; role = "answerer"; lastOfferCode = code;
  // Keep the camera AND (in sound mode) the auto loop running: the camera view is
  // hidden by applyPairUI but still scans to detect a both-answerer race, and the
  // sound loop must stay alive to send our answer.
  try { pc?.close(); } catch {}
  applied = false; entered = false; channel = null; bc.onmessage = null;
  if (method() !== "sound") S.pairIntro.value = "Got their code. Now show this new code to the other device’s camera to finish connecting.";
  await buildAnswer(code);
}
async function buildAnswer(code: string) {
  try { pc?.close(); } catch {}
  entered = false; channel = null;
  pc = new RTCPeerConnection(rtcConfig());
  pc.ondatachannel = (e) => setupChannel(e.channel);
  try {
    await pc.setRemoteDescription(decode(code) as any);
    await pc.setLocalDescription(await pc.createAnswer());
    await iceComplete(pc);
  } catch { setStatus("Invalid or expired code", "err"); return; }
  const packed = packDesc(pc.localDescription!, myNonce);
  myCode = b64u(packed); myAudio = withType(0x61, packed);
  S.myLink.value = linkFor("a", myCode);
  S.qrUrl.value = method() === "camera" ? S.myLink.value : "";
  logGen("answer", pc.localDescription!.sdp);
  applyPairUI();
  setStatus(method() === "sound" ? "Now play your code so they can hear it." : "Waiting for them to scan this…");
}

// Every scanned/pasted/heard code lands here. manual = pasted (skip tiebreak).
function onScan(parsed: { type: string; code: string }, manual = false) {
  if (parsed.code === myCode) return;      // our own reflection
  let dec;
  try { dec = decode(parsed.code); } catch { return; }
  if (parsed.type === "a") {               // an answer
    if (role === "offerer" && !applied) applyAnswer(dec as any);
    else if (role === "answerer" && !applied && !entered && myNonce > dec.nonce) {
      committed = false; role = "offerer"; mintOffer(); // both answered → higher nonce reverts
    }
    return;
  }
  if (manual) return void becomeAnswerer(parsed.code);
  if (role === "answerer") {
    if (!entered && parsed.code !== lastOfferCode) becomeAnswerer(parsed.code); // recovery: new offer
    return;
  }
  if (committed) return;
  if (dec.nonce === myNonce) { myNonce = freshNonce(); mintOffer(); return; } // tie → reroll
  if (myNonce < dec.nonce) becomeAnswerer(parsed.code);
  else setStatus("Saw their code. Now point their camera at yours");
}

// ── Handoff tab (#a=) ──
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

// ── Method chooser / navigation ──
export function chooseMethod(m: S.Method) {
  if (!role) { S.screen.value = "pair"; startOfferer(m); return; }
  methodS.value = m;
  stopCamera(); stopSoundAuto();
  S.screen.value = "pair";
  applyPairUI();
  if (m === "camera" && role === "offerer" && !committed) S.camOn.value = true; // component (re)starts scanning
  else S.qrUrl.value = method() === "camera" ? S.myLink.value : "";
}
export const chooseBack = () => (S.screen.value = role ? "pair" : "start");
export function switchMethod() { stopCamera(); stopSoundAuto(); S.screen.value = "choose"; }

export function applyPaste(text: string) {
  const parsed = parseCode(text);
  if (!parsed) { alert("Invalid code"); return; }
  onScan(parsed, true);
}
export async function share(url: string) {
  try { if (navigator.share) return await navigator.share({ url, title: "share.gnass.buzz" }); } catch {}
  try { await navigator.clipboard.writeText(url); alert("Link copied"); } catch {}
}
export function toggleStun(on: boolean) {
  S.useStun.value = on; localStorage.setItem("useStun", on ? "1" : "0");
  handled.clear();
  role === "answerer" ? buildAnswer(lastOfferCode!) : mintOffer();
}

// ── Automatic sound pairing: ACK-gated, half-duplex code exchange ──
// Invariant: a device NEVER transmits its code (offer/answer) except in the very
// step after it has heard a *peer's* ACK. So a device alone in a room never
// sends anything but short ACK beacons — it can't mistake its own echo for a
// reply, because its ACK carries its own nonce and is filtered out. Both sides
// start holding an offer; role, tiebreak and recovery all run through onScan
// (shared with the QR path), which flips a device to answerer when appropriate.
const LISTEN_MS = 18000; // long enough to capture one full payload in a single listen
let autoRunning = false, bandMatched = false, ackTick = 0;

const setAudioStatus = (t: string) => (S.audioStatus.value = t);
const setProgress = (f: number | null) => (S.audioProgress.value = f);
function soundBusyUI(on: boolean) { S.audioBusy.value = on; if (!on) { setAudioStatus("Pair by sound"); setProgress(null); } }
export function stopSoundAuto() { autoRunning = false; abortAuto(); soundBusyUI(false); }

const rand = (min: number, span: number) => min + Math.floor(Math.random() * span);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ackFrame = () => new Uint8Array([ACK, (myNonce >> 8) & 255, myNonce & 255]);
const ackNonce = (f: Uint8Array) => (f[1] << 8) | f[2];
const codeOf = (f: Uint8Array) => b64u(f.subarray(1));
const alive = () => autoRunning && !entered;
function matchBand() { if (S.bandMode.value === "auto") { setUltrasound(rxBand() === "ultrasound"); bandMatched = true; } }
function pickTxBand(i: number) { if (S.bandMode.value === "auto" && !bandMatched) setUltrasound(i % 2 === 0); }

export async function soundAuto() {
  if (autoRunning) return;
  autoRunning = true; resetAuto(); soundBusyUI(true);
  bandMatched = false; ackTick = 0;
  if (S.bandMode.value !== "auto") { setUltrasound(S.bandMode.value === "ultrasound"); bandMatched = true; }
  try {
    while (alive()) {
      // A little jitter so two devices don't lock into playing over each other.
      await sleep(rand(0, 700));
      if (!alive()) break;
      // Announce we're here and ready to receive. ACK is a control frame, safe to
      // send unsolicited; the Mario theme rides along every few beats for flavour.
      pickTxBand(ackTick);
      setAudioStatus(role === "answerer" ? "Ready — waiting for their go-ahead…" : "Looking for the other device…");
      await playFrame(ackFrame(), { intro: ackTick % 3 === 0 });
      ackTick++;
      if (!alive()) break;

      const f = await listenFor(LISTEN_MS, setProgress); setProgress(null);
      if (!alive()) break;

      if (isAck(f) && ackNonce(f!) !== myNonce) {
        // A peer signalled ready → transmit our current code exactly once.
        matchBand();
        setAudioStatus("Sending your code…"); setProgress(0);
        await playFrame(myAudio!, { intro: false, onprogress: setProgress }); setProgress(null);
      } else if (isAnswer(f)) {
        const code = codeOf(f!);
        if (code !== myCode) { matchBand(); setAudioStatus("Got their reply — connecting…"); onScan({ type: "a", code }); }
      } else if (isOffer(f)) {
        const code = codeOf(f!);
        if (code !== myCode) { matchBand(); onScan({ type: "o", code }); }
      }
    }
  } catch { setAudioStatus("Audio/mic unavailable on this device."); }
  autoRunning = false; soundBusyUI(false);
}

// ── Init: route by URL hash ──
export function initRouting() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.has("o")) startAnswerer(hash.get("o")!);
  else if (hash.has("a")) startHandoff(hash.get("a")!);
  else S.screen.value = "start";
}
