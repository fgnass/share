// ── Connection core ──────────────────────────────────────────────────────────
// RTCPeerConnection lifecycle, the datachannel, and everything that rides it
// (chat, files, connection health). Knows nothing about how the two SDPs got
// across — that is qr.ts's job.
//
// A `Neg` is one in-flight negotiation. Pairing holds two of them: our own offer
// and our answer to the peer's. Both stay alive; whichever datachannel opens
// first is adopted and the loser is dropped.
import { CHUNK, HIGH_WATER, LOW_WATER, iceComplete, packDesc, b64u, decode } from "./webrtc";
import * as S from "./state";

export type Neg = {
  tag: string;                      // "offer" | "answer" — for logs only
  pc: RTCPeerConnection;
  code: string;                     // our local description, packed + base64url
};

export const rtcConfig = (): RTCConfiguration =>
  ({ iceServers: S.useStun.value ? [{ urls: "stun:stun.l.google.com:19302" }] : [] });

// The winner. Set exactly once, by adopt(); every send path reads it.
let channel: RTCDataChannel | null = null;
let entered = false;
export const isEntered = () => entered;
export const chan = () => channel;
// The pc backing the adopted channel — connection health is reported for it alone.
let livePc: RTCPeerConnection | null = null;

// Negotiations still racing. Closing one must not report "connection lost", so we
// clear its handlers first — `close()` on a wired pc would otherwise fire markLost.
// Serialises outgoing sends so two sendFiles() calls can't interleave chunks.
let sendQ: Promise<void> = Promise.resolve();
let racing: Neg[] = [];
export function track(n: Neg) { racing.push(n); }
export function untrackAll() { racing = []; }
function drop(n: Neg) {
  try {
    n.pc.onconnectionstatechange = null;
    n.pc.oniceconnectionstatechange = null;
    n.pc.ondatachannel = null;
    n.pc.close();
  } catch {}
}
// Close every negotiation except the winner (pass null to close all — teardown).
export function dropAllBut(keep: RTCPeerConnection | null) {
  for (const n of racing) if (n.pc !== keep) drop(n);
  racing = racing.filter((n) => n.pc === keep);
}

// Each route registers what to tear down once we're connected (stop the camera,
// stop the audio loop). The core owns "we're in the room"; the routes own their
// own hardware, and neither needs to know about the other's.
const teardowns: (() => void)[] = [];
export function onEnter(fn: () => void) { teardowns.push(fn); }

// Called exactly once, by the winning channel's onopen.
function enterRoom() {
  if (entered) return; entered = true;
  console.log("%c[share] connected", "font-weight:bold;color:#acff69");
  for (const fn of teardowns) { try { fn(); } catch {} }
  clearGrace(); setRoom("Connected", true, false);
  S.screen.value = "room";
  S.pushMsg({ id: S.nextId(), kind: "sys", text: "Connected. Say hi" });
}

// ── Building negotiations ──
// Both builders fully gather ICE before returning, so the returned code is final
// and safe to display or transmit. `onChannel` is handed every datachannel that
// belongs to this negotiation; the routes pass wireChannel.
export async function makeOffer(onChannel: (ch: RTCDataChannel, pc: RTCPeerConnection) => void): Promise<Neg> {
  const pc = new RTCPeerConnection(rtcConfig());
  wireHealth(pc);
  onChannel(pc.createDataChannel("data"), pc);
  await pc.setLocalDescription(await pc.createOffer());
  await iceComplete(pc);
  const neg: Neg = { tag: "offer", pc, code: b64u(packDesc(pc.localDescription!)) };
  logGen("offer", pc.localDescription!.sdp, neg);
  return neg;
}

// Throws if `code` isn't a usable offer — callers surface that as "invalid code".
export async function makeAnswer(code: string, onChannel: (ch: RTCDataChannel, pc: RTCPeerConnection) => void): Promise<Neg> {
  const pc = new RTCPeerConnection(rtcConfig());
  wireHealth(pc);
  pc.ondatachannel = (e) => onChannel(e.channel, pc);
  await pc.setRemoteDescription(decode(code) as any);
  await pc.setLocalDescription(await pc.createAnswer());
  await iceComplete(pc);
  const neg: Neg = { tag: "answer", pc, code: b64u(packDesc(pc.localDescription!)) };
  logGen("answer", pc.localDescription!.sdp, neg);
  return neg;
}

function logGen(kind: string, sdp: string, neg: Neg) {
  const cands = [...sdp.matchAll(/a=candidate:\S+ \d+ udp \d+ (\S+) (\d+) typ (host|srflx)/gi)]
    .map((m) => `${m[3]} ${m[1]}:${m[2]}`);
  console.log(`%c[share] ${kind}`, "font-weight:bold;color:#acff69",
    `— code ${neg.code.length} chars, ${cands.length} candidate(s)`);
  console.log("[share] SDP:\n" + sdp);
}

// ── Connection health ──
let connGrace: ReturnType<typeof setTimeout> | null = null;
function clearGrace() { if (connGrace) { clearTimeout(connGrace); connGrace = null; } }
const setRoom = (text: string, ok: boolean, showReconnect: boolean) =>
  (S.roomStatus.value = { text, ok, showReconnect });
export function markLost() { clearGrace(); setRoom("Connection lost", false, true); }
// connectionState is authoritative; fall back to iceConnectionState on browsers
// that lack it (older Safari), where "completed" also counts as connected.
function stateOf(pc: RTCPeerConnection | null): string {
  return pc ? ((pc.connectionState as string) || pc.iceConnectionState) : "closed";
}
export function reflectConn() {
  if (!entered || !livePc) return;
  const st = stateOf(livePc);
  if (st === "connected" || st === "completed") { clearGrace(); setRoom("Connected", true, false); }
  else if (st === "failed" || st === "closed") markLost();
  else if (st === "disconnected") {
    setRoom("Connection unstable", false, true); // may be a blip; let the user bail now
    if (!connGrace) connGrace = setTimeout(() => {
      connGrace = null;
      const s = stateOf(livePc);
      if (s !== "connected" && s !== "completed") markLost();
    }, 6000);
  }
}
function wireHealth(pc: RTCPeerConnection) {
  // Only the adopted pc reports health (reflectConn gates on livePc), so a losing
  // negotiation's state churn can never paint the room.
  pc.onconnectionstatechange = reflectConn;
  pc.oniceconnectionstatechange = reflectConn;
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

// Wire a datachannel belonging to one racing negotiation. Handlers that mutate
// room state are live only for the adopted channel — a loser's close/error must
// never paint "Connection lost" over a working room.
export function wireChannel(ch: RTCDataChannel, pc: RTCPeerConnection) {
  ch.binaryType = "arraybuffer";
  let inc: Incoming | null = null;
  let batch: Batch | null = null;
  const mine = () => channel === ch;
  ch.onopen = () => {
    // First channel to open wins the race. adopt() is idempotent; a later opener
    // finds `entered` already set and closes itself out.
    if (entered) { try { ch.close(); } catch {} return; }
    channel = ch; livePc = pc;
    dropAllBut(pc);
    enterRoom();
  };
  ch.onclose = () => { if (mine()) markLost(); };
  ch.onerror = () => { if (mine()) markLost(); };

  const finish = (i: Incoming) => finalize(i, batch, () => { batch = null; });

  ch.onmessage = (e) => {
    if (!mine()) return;
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
  let url: string | undefined, error = false;
  try {
    if (inc.chunks) {
      // Flatten the relative path into the download name so files from different
      // subfolders don't collide in a flat Downloads folder.
      const dl = inc.path !== inc.name ? inc.path.replace(/\//g, "_") : inc.name;
      url = URL.createObjectURL(new File(inc.chunks, dl, { type: resolveMime(inc.name, inc.mime) }));
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
  else if (inc.chunks) S.updateMsg(inc.id, { done: true, url, progress: 100 });
  else S.updateMsg(inc.id, { done: true, savedTo: S.saveDirName.value, progress: 100 });
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
  sendQ = sendQ.then(task).catch((e: unknown) => { console.error(e); markLost(); });
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
