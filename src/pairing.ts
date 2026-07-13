import jsQR from "jsqr";
import {
  b64u, decode, packDesc, withType, encode, iceComplete, linkFor, parseCode,
  freshNonce, CHUNK, HIGH_WATER, LOW_WATER,
} from "./webrtc";
import {
  playFrame, listenFor, stopAudio, setUltrasound, resetAuto, abortAuto,
  isOffer, isAnswer, isAck, isGot, ACK, GOT, rxBand, selfTest,
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
    // Mirror the preview only for a front (user-facing) camera. We ask for the
    // back camera but fall back to any camera, so trust the resolved track: on
    // desktop the fallback lands on the user-facing webcam (mirror), on mobile
    // we usually get "environment" (don't mirror). Absent facingMode, assume
    // user-facing since that's the common no-back-camera case.
    const facing = scanStream.getVideoTracks()[0]?.getSettings().facingMode;
    video.classList.toggle("mirror", facing !== "environment");
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

// ── Live connection health ──
// A datachannel's onclose does NOT fire reliably when a mobile tab is suspended
// (backgrounded to install an APK, switch apps, lock the screen…), so the UI
// could sit on "Connected" while nothing actually gets through. We watch the
// peer connection's own state changes and also re-check on return to foreground.
let connGrace: ReturnType<typeof setTimeout> | null = null;
function clearGrace() { if (connGrace) { clearTimeout(connGrace); connGrace = null; } }
function setRoom(text: string, ok: boolean, showReconnect: boolean) { S.roomStatus.value = { text, ok, showReconnect }; }
function markLost() { clearGrace(); setRoom("Connection lost", false, true); }
// connectionState is authoritative; fall back to iceConnectionState on browsers
// that lack it (older Safari), where "completed" also counts as connected.
function connState(): string { return pc ? ((pc.connectionState as string) || pc.iceConnectionState) : "closed"; }
function reflectConn() {
  if (!entered || !pc) return;
  const st = connState();
  if (st === "connected" || st === "completed") { clearGrace(); setRoom("Connected", true, false); }
  else if (st === "failed" || st === "closed") markLost();
  else if (st === "disconnected") {
    setRoom("Connection unstable", false, true);  // may be a blip; give it a moment, but let the user bail now
    if (!connGrace) connGrace = setTimeout(() => { connGrace = null; if (connState() !== "connected" && connState() !== "completed") markLost(); }, 6000);
  }
}
function wireConn(p: RTCPeerConnection) { p.onconnectionstatechange = reflectConn; p.oniceconnectionstatechange = reflectConn; }

// ── Direct-connection watchdog (pairing phase) ──
// Once both descriptions are exchanged, a real connection attempt is underway.
// On the same LAN this succeeds in well under a second; if it hasn't connected
// after a while the two devices are likely on different networks and need STUN
// to find each other. Only the offerer arms this (it applies the answer, so it
// knows the exchange completed) and it drives the escalation for both — the peer
// adopts STUN on its own by spotting the reflexive candidate in the new offer.
let pairTimer: ReturnType<typeof setTimeout> | null = null;
function clearPairWatch() { if (pairTimer) { clearTimeout(pairTimer); pairTimer = null; } }
function armPairWatch() {
  clearPairWatch();
  pairTimer = setTimeout(() => {
    pairTimer = null;
    if (entered) return;
    const st = connState();
    if (st === "connected" || st === "completed") return;
    if (!S.useStun.value) S.stunPrompt.value = true;            // offer to retry with STUN
    else setStatus("Still couldn't connect. The networks may block direct links.", "err");
  }, 9000);
}

// ── DataChannel: chat + files ──
// An incoming file is either streamed straight to disk (a folder was picked, so
// `writable` is set and chunks never accumulate) or buffered in RAM as `chunks`
// and offered as a download. `writeQ` serialises the async disk writes and keeps
// them ordered behind the (also async) createWritable().
type Incoming = {
  name: string; path: string; size: number; mime: string; got: number; id: number;
  grouped: boolean;          // part of a batch → progress rolls up into the batch bubble
  chunks?: ArrayBuffer[];
  writable?: any;            // FileSystemWritableFileStream
  writeQ: Promise<void>;
};
// A batch (multi-file / folder send) rolls up into one bubble. We only group on
// the receiver when streaming to a folder — without one, each file falls back to
// its own download bubble (grouping N download links helps nobody).
type Batch = { id: number; count: number; done: number; size: number; got: number; errors: number };

// Reject ".."/"." segments so a peer-supplied path can't escape the chosen
// folder (getDirectoryHandle would throw on them anyway, but be explicit).
function relParts(path: string) {
  return path.split("/").map((s) => s.trim()).filter((s) => s && s !== "." && s !== "..");
}
async function openWritable(dir: any, path: string): Promise<any> {
  const parts = relParts(path);
  const name = parts.pop()!;
  let d = dir;
  for (const seg of parts) d = await d.getDirectoryHandle(seg, { create: true });
  const fh = await d.getFileHandle(name, { create: true });
  return fh.createWritable();
}

function setupChannel(ch: RTCDataChannel) {
  channel = ch;
  ch.binaryType = "arraybuffer";
  let inc: Incoming | null = null;
  let batch: Batch | null = null;
  ch.onopen = enterRoom;
  ch.onclose = markLost;
  ch.onerror = markLost;

  const finish = (i: Incoming) => finalize(i, batch, () => { batch = null; });

  ch.onmessage = (e) => {
    if (typeof e.data === "string") {
      const m = JSON.parse(e.data);
      if (m.k === "chat") { S.pushMsg({ id: S.nextId(), kind: "chat", mine: false, text: m.t }); return; }
      if (m.k === "batch") {
        // Group only when we can stream into a folder; otherwise ignore the
        // header and let each file arrive as its own bubble (RAM fallback).
        if (S.saveDir.value) {
          const id = S.nextId();
          S.pushMsg({ id, kind: "batch", mine: false, name: m.n, count: m.c, doneCount: 0, size: m.s, progress: 0, done: false });
          batch = { id, count: m.c, done: 0, size: m.s, got: 0, errors: 0 };
        } else batch = null;
        return;
      }
      if (m.k === "file") {
        const dir = S.saveDir.value;
        const path = m.p || m.n;
        const grouped = !!batch;
        const id = grouped ? batch!.id : S.nextId();
        if (!grouped) S.pushMsg({ id, kind: "file", mine: false, name: m.n, size: m.s, progress: 0, done: false });
        inc = { name: m.n, path, size: m.s, mime: m.m, got: 0, id, grouped, writeQ: Promise.resolve() };
        // Stream to disk when a folder is set; else buffer in RAM. Open the
        // target up front so every write chains after it, ordered.
        if (dir) inc.writeQ = openWritable(dir, path).then((w) => { inc!.writable = w; });
        else inc.chunks = [];
        if (m.s === 0) { finish(inc); inc = null; }
      }
      return;
    }
    if (!inc) return;
    // Capture the current file object: the disk write runs as a later microtask,
    // by which point the outer `inc` may be null or the next file — the closure
    // must not read `writable` through the mutable `inc`.
    const cur = inc, chunk = e.data;
    cur.got += chunk.byteLength;
    if (cur.chunks) cur.chunks.push(chunk);
    else cur.writeQ = cur.writeQ.then(() => cur.writable.write(chunk));
    if (cur.grouped && batch) { batch.got += chunk.byteLength; S.updateMsg(batch.id, { progress: batch.size ? (batch.got / batch.size) * 100 : 0 }); }
    else S.updateMsg(cur.id, { progress: (cur.got / cur.size) * 100 });
    if (cur.got >= cur.size) { finish(cur); inc = null; }
  };
}
// Some senders report no (or a generic) MIME type; fill it in from the file
// extension so Android's download manager offers the right handler — e.g. tapping
// a received .apk's notification opens the package installer instead of nothing.
const EXT_MIME: Record<string, string> = {
  apk: "application/vnd.android.package-archive",
  pdf: "application/pdf", zip: "application/zip",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  mp4: "video/mp4", mp3: "audio/mpeg", txt: "text/plain",
};
function resolveMime(name: string, given: string): string {
  if (given && given !== "application/octet-stream") return given;
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return EXT_MIME[ext] || given || "application/octet-stream";
}
async function finalize(inc: Incoming, batch: Batch | null, closeBatch: () => void) {
  let file: File | undefined, url: string | undefined, error = false;
  try {
    if (inc.chunks) {
      // Flatten the relative path into the download name so files from different
      // subfolders don't collide in a flat Downloads folder.
      const dl = inc.path !== inc.name ? inc.path.replace(/\//g, "_") : inc.name;
      file = new File(inc.chunks, dl, { type: resolveMime(inc.name, inc.mime) });
      url = URL.createObjectURL(file);
    } else {
      await inc.writeQ;
      await inc.writable.close();
    }
  } catch (e) {
    console.error(e);
    try { await inc.writable?.abort(); } catch {}
    error = true;
  }

  if (inc.grouped && batch) {
    batch.done++;
    if (error) batch.errors++;
    S.updateMsg(batch.id, { doneCount: batch.done });
    if (batch.done >= batch.count) {
      S.updateMsg(batch.id, { done: true, progress: 100, savedTo: S.saveDirName.value, error: batch.errors > 0 });
      closeBatch();
    }
    return;
  }
  if (error) S.updateMsg(inc.id, { done: true, error: true });
  else if (inc.chunks) S.updateMsg(inc.id, { done: true, url, file, progress: 100 });
  else S.updateMsg(inc.id, { done: true, savedTo: S.saveDirName.value, progress: 100 });
}

function enterRoom() {
  if (entered) return; entered = true;
  slog("✅ CONNECTED — data channel open");
  autoRunning = false; stopCamera(); stopAudio();
  clearGrace(); clearPairWatch(); S.stunPrompt.value = false; setRoom("Connected", true, false);
  S.screen.value = "room";
  S.pushMsg({ id: S.nextId(), kind: "sys", text: "Connected. Say hi" });
}

export function sendMessage(text: string) {
  const t = text.trim();
  if (!t) return false;
  if (!channel || channel.readyState !== "open") { markLost(); return false; }
  try { channel.send(JSON.stringify({ k: "chat", t })); }
  catch { markLost(); return false; }
  S.pushMsg({ id: S.nextId(), kind: "chat", mine: true, text: t });
  return true;
}
// One item to send: the File plus its relative path (equal to the name for a
// loose file; "folder/sub/file" for a picked/dropped folder).
export type Upload = { file: File; path: string };

// Normalise a FileList (from a <input multiple> or <input webkitdirectory>).
// webkitRelativePath carries the folder structure when a directory was picked.
export const fromFileList = (list: FileList | File[] | null): Upload[] =>
  [...(list || [])].map((f) => ({ file: f, path: (f as any).webkitRelativePath || f.name }));

// Walk a dropped DataTransfer, recursing into folders via the entries API so a
// dropped directory keeps its structure. Falls back to the flat file list when
// entries aren't exposed.
export async function fromDataTransfer(dt: DataTransfer): Promise<Upload[]> {
  const roots = [...dt.items].map((it) => (it as any).webkitGetAsEntry?.()).filter(Boolean);
  if (!roots.length) return fromFileList(dt.files);
  const out: Upload[] = [];
  const walk = async (entry: any, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file: File = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const dir = prefix + entry.name + "/";
      for (;;) {
        const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, dir);
      }
    }
  };
  for (const r of roots) await walk(r, "");
  return out;
}

// Name the batch bubble after the common top-level folder, else "N files".
function batchLabel(items: Upload[]): string {
  const tops = new Set(items.map((i) => (i.path.includes("/") ? i.path.split("/")[0] : "")));
  const only = tops.size === 1 ? [...tops][0] : "";
  return only || items.length + " files";
}

export function sendFiles(items: Upload[]) {
  if (!items.length) return;
  const grouped = items.length > 1 || items.some((i) => i.path.includes("/"));
  const task = () => (grouped ? sendBatch(items) : sendSingle(items[0]));
  sendQ = sendQ.then(task).catch((e) => { console.error(e); markLost(); });
}

async function sendSingle(it: Upload) {
  if (!channel || channel.readyState !== "open") { markLost(); return; }
  const id = S.nextId();
  S.pushMsg({ id, kind: "file", mine: true, name: it.file.name, size: it.file.size, progress: 0, done: false });
  let sent = 0;
  await sendFile(it, (n) => { sent += n; S.updateMsg(id, { progress: (sent / (it.file.size || 1)) * 100 }); });
  S.updateMsg(id, { done: true }); // sent (no download link on the sender)
}

async function sendBatch(items: Upload[]) {
  if (!channel || channel.readyState !== "open") { markLost(); return; }
  const total = items.reduce((n, i) => n + i.file.size, 0);
  const id = S.nextId();
  S.pushMsg({ id, kind: "batch", mine: true, name: batchLabel(items), count: items.length, doneCount: 0, size: total, progress: 0, done: false });
  channel.send(JSON.stringify({ k: "batch", n: batchLabel(items), c: items.length, s: total }));
  let bytes = 0, done = 0;
  for (const it of items) {
    await sendFile(it, (n) => { bytes += n; S.updateMsg(id, { progress: total ? (bytes / total) * 100 : 100 }); });
    S.updateMsg(id, { doneCount: ++done });
  }
  S.updateMsg(id, { done: true, progress: 100 });
}

async function sendFile(it: Upload, onProgress: (n: number) => void) {
  if (!channel || channel.readyState !== "open") throw new Error("channel closed");
  const { file, path } = it;
  const rel = path !== file.name ? path : undefined; // omit for loose files
  channel.send(JSON.stringify({ k: "file", n: file.name, s: file.size, m: file.type, p: rel }));
  for (let off = 0; off < file.size; off += CHUNK) {
    const buf = await file.slice(off, off + CHUNK).arrayBuffer();
    channel.send(buf); onProgress(buf.byteLength);
    if (channel.bufferedAmount > HIGH_WATER) {
      await new Promise<void>((res) => {
        channel!.bufferedAmountLowThreshold = LOW_WATER;
        channel!.addEventListener("bufferedamountlow", () => res(), { once: true });
      });
    }
  }
}
// Pick a folder to stream incoming files into (one gesture covers every file
// that follows). Requires the File System Access API — see S.canSaveToDir.
export async function pickSaveDir() {
  try {
    const dir = await (globalThis as any).showDirectoryPicker({ mode: "readwrite" });
    S.saveDir.value = dir;
    S.saveDirName.value = dir.name;
  } catch { /* cancelled */ }
}
export function clearSaveDir() { S.saveDir.value = null; S.saveDirName.value = ""; }

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
  clearPairWatch();
  applied = false; entered = false; channel = null;
  pc = new RTCPeerConnection(rtcConfig());
  wireConn(pc);
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
  armPairWatch();
}

// ── Answerer ──
export async function startAnswerer(code: string) {
  role = "answerer"; methodS.value = "camera"; committed = true; lastOfferCode = code;
  S.screen.value = "pair";
  S.pairIntro.value = "Almost there. Show this new code to the other device’s camera to finish connecting. If they sent you a link instead, use a different method to send this reply back.";
  await buildAnswer(code);
}
async function becomeAnswerer(code: string) {
  slog("becomeAnswerer — building answer");
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
  clearPairWatch();
  entered = false; channel = null;
  pc = new RTCPeerConnection(rtcConfig());
  wireConn(pc);
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
  slog("answer ready", { bytes: myAudio?.length });
  applyPairUI();
  setStatus(method() === "sound" ? "Now play your code so they can hear it." : "Waiting for them to scan this…");
}

// Every scanned/pasted/heard code lands here. manual = pasted (skip tiebreak).
function onScan(parsed: { type: string; code: string }, manual = false) {
  if (parsed.code === myCode) return;      // our own reflection
  let dec;
  try { dec = decode(parsed.code); } catch (e) { slog("onScan decode failed", e); return; }
  slog("onScan", { type: parsed.type, peerNonce: dec.nonce, myNonce, role, committed, applied, entered });
  // STUN propagation: a peer's code carrying a reflexive (srflx) candidate means
  // it turned STUN on. A one-sided srflx rarely connects, so we adopt it too and
  // regenerate our side with STUN — which then carries srflx to them in turn.
  if (!S.useStun.value && dec.sdp.includes("typ srflx")) {
    S.useStun.value = true; S.stunPrompt.value = false; handled.clear();
    if (role === "offerer") { mintOffer(); return; } // re-mint so our offer has srflx too
    // answerer: fall through — becomeAnswerer below rebuilds the answer with STUN on.
  }
  if (parsed.type === "a") {               // an answer
    if (role === "offerer" && !applied) { slog("apply their answer → connecting"); applyAnswer(dec as any); }
    else if (role === "answerer" && !applied && !entered && myNonce > dec.nonce) {
      slog("both answered → higher nonce reverts to offerer"); committed = false; role = "offerer"; mintOffer();
    }
    return;
  }
  if (manual) return void becomeAnswerer(parsed.code);
  if (role === "answerer") {
    if (!entered && parsed.code !== lastOfferCode) { slog("new offer → rebuild answer"); becomeAnswerer(parsed.code); }
    return;
  }
  if (committed) return;
  if (dec.nonce === myNonce) { slog("nonce tie → reroll"); myNonce = freshNonce(); mintOffer(); return; } // tie → reroll
  if (myNonce < dec.nonce) { slog("lower nonce → become answerer"); becomeAnswerer(parsed.code); }
  else { slog("higher nonce → stay offerer, wait for their answer"); setStatus("Saw their code. Now point their camera at yours"); }
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
// The chooser is the landing screen; "Back" only exists when we reached it from
// an in-progress pairing (via "Use a different method"), and returns there.
export const inPairing = () => role !== null;
export const chooseBack = () => (S.screen.value = "pair");
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
// User confirmed the "retry across networks" prompt: turn STUN on and regenerate
// our current code. It now carries a reflexive candidate, so the peer adopts STUN
// automatically (see onScan) and both ends end up gathering one.
export function retryWithStun() {
  S.stunPrompt.value = false;
  if (S.useStun.value) return;
  S.useStun.value = true; handled.clear();
  role === "answerer" && lastOfferCode ? buildAnswer(lastOfferCode) : mintOffer();
}

// ── Automatic sound pairing: two-phase, directed half-duplex ──
// Phase 1 (discovery): both devices trade tiny nonce beacons. These short frames
// land reliably, and crucially NO long code is sent yet — so two long offers can
// never collide. Once each knows the other's nonce, the roles are fixed with no
// app-level fixed roles: higher nonce = offerer, lower = answerer.
// Phase 2 (directed): only ONE side transmits a long frame at a time. The offerer
// loops its offer and listens for the answer; the answerer listens for the offer,
// then sends a tiny GOT (handoff: "I have your offer, stop offering") followed by
// its answer. The offerer hears GOT → goes quiet and just listens → gets the
// answer → WebRTC connects (the open data channel is the final ack). The answer
// causally depends on the offer, so the exchange is inherently sequential and
// half-duplex is no handicap. Role/tiebreak/recovery still run through onScan.
let autoRunning = false, bandMatched = false, bandGuess = false, volumeLow = false, ackTick = 0;

const setAudioStatus = (t: string) => (S.audioStatus.value = t);
const setProgress = (f: number | null) => (S.audioProgress.value = f);
function soundBusyUI(on: boolean) { S.audioBusy.value = on; if (!on) { setAudioStatus("Pair by sound"); setProgress(null); } }
export function stopSoundAuto() { autoRunning = false; abortAuto(); soundBusyUI(false); }

const rand = (min: number, span: number) => min + Math.floor(Math.random() * span);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Verbose handshake logging (?debug or ?loopback). Prefixed with our nonce so two
// tabs' logs are easy to tell apart in one console.
const slog = (...a: any[]) => { if (S.debug || S.loopbackMode) console.log(`%c[sound ${myNonce}]`, "color:#6ea8ff;font-weight:bold", ...a); };
const ackFrame = () => new Uint8Array([ACK, (myNonce >> 8) & 255, myNonce & 255]);
const gotFrame = () => new Uint8Array([GOT, (myNonce >> 8) & 255, myNonce & 255]);
const ctlNonce = (f: Uint8Array) => (f[1] << 8) | f[2]; // ACK/GOT payload = [type, nonceHi, nonceLo]
const codeOf = (f: Uint8Array) => b64u(f.subarray(1));
const peerNonceOf = (code: string): number | null => { try { return decode(code).nonce; } catch { return null; } };
const alive = () => autoRunning && !entered;
function matchBand() { volumeLow = false; if (S.bandMode.value === "auto") { setUltrasound(rxBand() === "ultrasound"); bandMatched = true; } }
// In auto mode we alternate bands to probe — UNLESS the self-test already gave a
// hardware-informed guess (then hold it until we actually receive a frame, which
// locks the band via matchBand). Once matched, never override.
function pickTxBand(i: number) { if (S.bandMode.value === "auto" && !bandMatched && !bandGuess) setUltrasound(i % 2 === 0); }
const heardStr = (f: Uint8Array | null) => f ? (isAck(f) ? `ACK ${ctlNonce(f)}` : isGot(f) ? `GOT ${ctlNonce(f)}` : isOffer(f) ? "OFFER" : isAnswer(f) ? "ANSWER" : `0x${f[0].toString(16)}`) : "nothing";

export async function soundAuto() {
  if (autoRunning) return;
  autoRunning = true; resetAuto(); soundBusyUI(true);
  bandMatched = false; bandGuess = false; volumeLow = false; ackTick = 0;
  slog("soundAuto start", { role, myNonce, band: S.bandMode.value, loopback: S.loopbackMode });
  if (S.loopbackMode) {
    bandMatched = true; // no bands over the loopback channel
  } else if (S.bandMode.value !== "auto") {
    setUltrasound(S.bandMode.value === "ultrasound"); bandMatched = true;
  } else {
    // Capability check first: play tones through our own speaker and see which
    // band our own mic hears. Pick the highest band that round-trips; if we can't
    // even hear our own audible, the device is muted / too quiet — tell the user.
    setAudioStatus("Checking speaker & mic…");
    try {
      const r = await selfTest();
      slog("self-test", { recommend: r.recommend });
      if (alive()) { setUltrasound(r.recommend === "ultrasound"); bandGuess = true; volumeLow = r.recommend === "louder"; }
    } catch (e) { slog("self-test failed", e); /* mic denied etc. → blind band alternation */ }
  }
  if (!alive()) { autoRunning = false; soundBusyUI(false); return; }

  let peerNonce: number | null = null;
  try {
    // ── PHASE 1: DISCOVERY ── learn the peer's nonce via short beacons only.
    while (alive() && !committed && peerNonce === null) {
      setAudioStatus(volumeLow ? "Turn the volume up — this device can't hear itself." : "Looking for the other device…");
      const f = await listenFor(rand(2500, 2500));
      if (!alive()) break;
      slog("discover heard", heardStr(f));
      if ((isAck(f) || isGot(f)) && ctlNonce(f!) !== myNonce) { peerNonce = ctlNonce(f!); matchBand(); }
      else if (isOffer(f)) { const code = codeOf(f!); if (code !== myCode) { matchBand(); peerNonce = peerNonceOf(code); onScan({ type: "o", code }); } }
      else if (isAnswer(f)) { const code = codeOf(f!); if (code !== myCode) { matchBand(); onScan({ type: "a", code }); } }
      else if (Math.random() < 0.55) { // beacon only some rounds → breaks lockstep
        // Two devices started together tend to beacon in sync and collide forever
        // (their chirps overlap → neither syncs). Skipping the beacon ~45% of the
        // time, plus the randomized listen window, desyncs them within a few rounds.
        await sleep(rand(0, 400));
        if (!alive()) break;
        pickTxBand(ackTick++);
        slog("discover beacon");
        await playFrame(ackFrame(), { intro: false });
      } else slog("discover listen-only round");
    }
    if (peerNonce !== null) slog(`role resolved: ${myNonce > peerNonce ? "OFFERER" : "answerer"} (peer ${peerNonce})`);

    // ── PHASE 2: DIRECTED EXCHANGE ──
    // Offerer = higher nonce and still holding an offer. The lower-nonce device is
    // the answerer, but can only build its answer once it has received the offer.
    const iAmOfferer = () => role === "offerer" && (peerNonce === null || myNonce > peerNonce);
    while (alive()) {
      if (iAmOfferer()) {
        if (applied) { await listenFor(rand(4000, 2000)); continue; } // answer applied → just wait for connect
        setAudioStatus("Sending your code…"); setProgress(0);
        slog("send OFFER");
        await playFrame(myAudio!, { intro: false, onprogress: setProgress }); setProgress(null);
        if (!alive()) break;
        setAudioStatus("Waiting for their reply…");
        let rounds = 2; // a couple of shortish listens; extend if we hear GOT
        for (let i = 0; alive() && i < rounds; i++) {
          const f = await listenFor(rand(3500, 2500));
          if (!alive()) break;
          slog("offerer heard", heardStr(f));
          if (isAnswer(f)) { const code = codeOf(f!); if (code !== myCode) { matchBand(); slog("→ onScan(answer)"); onScan({ type: "a", code }); } break; }
          if (isGot(f) && ctlNonce(f!) !== myNonce) { rounds = 4; continue; }        // answer imminent → keep listening
          if (isOffer(f)) { const code = codeOf(f!); if (code !== myCode) onScan({ type: "o", code }); } // both offered → tiebreak
        }
      } else if (role === "answerer" && isAnswer(myAudio)) {
        // Answer is built → tell the offerer to stop offering, then send the answer.
        slog("send GOT + ANSWER");
        await playFrame(gotFrame(), { intro: false });
        if (!alive()) break;
        setAudioStatus("Sending your reply…"); setProgress(0);
        await playFrame(myAudio!, { intro: false, onprogress: setProgress }); setProgress(null);
        if (!alive()) break;
        await listenFor(rand(2500, 1500)); // brief listen; a re-heard offer means our answer missed → loop resends
      } else {
        // Designated answerer without the offer yet (or answer still building).
        // Mostly listen for the offer (our own beacon would clobber the offer's
        // chirp). Beacon only occasionally — just enough that an offerer still in
        // discovery can hear us — otherwise stay quiet and catch the offer.
        setAudioStatus("Waiting for their code…");
        if (Math.random() < 0.3) {
          pickTxBand(ackTick++);
          slog("answerer beacon");
          await playFrame(ackFrame(), { intro: false });
          if (!alive()) break;
        }
        const f = await listenFor(rand(6000, 3000));
        if (!alive()) break;
        slog("answerer heard", heardStr(f));
        if (isOffer(f)) { const code = codeOf(f!); if (code !== myCode) { matchBand(); slog("→ onScan(offer)"); onScan({ type: "o", code }); } }
        else if ((isAck(f) || isGot(f)) && ctlNonce(f!) !== myNonce && peerNonce === null) peerNonce = ctlNonce(f!);
      }
    }
  } catch (e) { slog("error", e); setAudioStatus("Audio/mic unavailable on this device."); }
  autoRunning = false; soundBusyUI(false);
}

// ── Init: route by URL hash ──
export function initRouting() {
  // Re-check the live connection whenever the tab comes back to the foreground:
  // a suspended mobile tab often drops the connection without firing any event.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) reflectConn(); });
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.has("o")) startAnswerer(hash.get("o")!);
  else if (hash.has("a")) startHandoff(hash.get("a")!);
  else S.screen.value = "choose";
}
