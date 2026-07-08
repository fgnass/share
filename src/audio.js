// ─────────── Audio handshake (data-over-sound via ggwave) ───────────
// An alternative to the QR/camera path: one device *plays* its pairing code as
// a short burst of sound while the other *listens* on the mic. Because the air
// is a shared, half-duplex medium (both devices can't talk at once like two
// screens can), pairing here is turn-based — play, then swap and listen back.
//
// ggwave ships as an Emscripten UMD module with the WASM inlined as a data URI.
// We import it as a raw string and eval it lazily: that keeps the bundler from
// trying to resolve its Node `require("fs")` branches, and nothing is ever
// fetched, so the single-file build stays a single file.
import ggwaveSrc from "ggwave/ggwave.js?raw";

let factory = null;
function getFactory() {
  if (!factory) {
    const m = { exports: {} };
    new Function("module", "exports", ggwaveSrc)(m, m.exports);
    factory = m.exports;
  }
  return factory;
}

let ggwave = null, instance = null, ctx = null;
async function ready() {
  if (instance) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  // Swallow ggwave's native stdout/stderr (e.g. its "n = …" encode debug line
  // and "Receiving sound data…" chatter) so it doesn't drown the app's own logs.
  ggwave = await getFactory()({ print: () => {}, printErr: () => {} });
  const p = ggwave.getDefaultParameters();
  p.sampleRateInp = ctx.sampleRate;
  p.sampleRateOut = ctx.sampleRate;
  instance = ggwave.init(p);
}
// FASTEST roughly doubles throughput vs FAST. It's less robust on a noisy
// channel, but pairing is meant for two devices in the same room at close range,
// so we trade that margin for speed. Ultrasound is opt-in: near-silent and the
// same speed, but not every laptop speaker/mic reproduces >15kHz cleanly.
let ultrasound = false;
export function setUltrasound(on) { ultrasound = !!on; }
const proto = () => ultrasound
  ? ggwave.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FASTEST
  : ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST;

// ggwave hands back / expects raw byte views; reinterpret the same bytes as the
// type Web Audio wants (Float32 samples) or that ggwave wants (Int8/Uint8 bytes).
function reinterpret(src, Type) {
  const buf = new ArrayBuffer(src.byteLength);
  new src.constructor(buf).set(src);
  return new Type(buf);
}

// ── Framing ──────────────────────────────────────────────────────────────
// We transmit the RAW pairing bytes (no base64), so a single ggwave frame is a
// Uint8Array [tag, seq, total, ...chunk]. ggwave carries arbitrary bytes, so no
// base64 overhead. A frame stays under ggwave's ~140-byte per-transmission cap.
// tag = checksum of the payload, so a listener never mixes chunks from a stale,
// different transmission.
const CHUNK = 115;
function framesFor(bytes) {
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK));
  let tag = 0;
  for (const b of bytes) tag = (tag + b) & 0xff;
  const out = [];
  for (let i = 0; i < total; i++) {
    const chunk = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
    const frame = new Uint8Array(3 + chunk.length);
    frame[0] = tag; frame[1] = i; frame[2] = total; frame.set(chunk, 3);
    out.push(frame);
  }
  return out;
}

// ── Transmit ─────────────────────────────────────────────────────────────
// bytes: a Uint8Array payload. loop=false plays it once (then onended fires);
// loop=true repeats it so a listener can join late or recover a lost frame.
// onprogress(fraction 0..1) is called each frame during playback.
let txSource = null, txRaf = 0;
export async function playBytes(bytes, { loop = false, onended, onprogress } = {}) {
  await ready();
  await ctx.resume().catch(() => {});
  stopTx();
  const gap = Math.floor(ctx.sampleRate * 0.10); // 100ms silence between frames
  const parts = framesFor(bytes).map((f) => reinterpret(ggwave.encode(instance, f, proto(), 15), Float32Array));
  const len = parts.reduce((n, p) => n + p.length + gap, gap);
  const data = new Float32Array(len);
  let off = gap;
  for (const p of parts) { data.set(p, off); off += p.length + gap; }
  const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buffer.getChannelData(0).set(data);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = loop;
  if (!loop && onended) src.onended = () => { if (txSource === src) txSource = null; onended(); };
  src.connect(ctx.destination); src.start();
  txSource = src;
  if (onprogress) {
    const startAt = ctx.currentTime, dur = buffer.duration;
    const tick = () => {
      if (txSource !== src) return;                 // stopped or ended
      let f = (ctx.currentTime - startAt) / dur;
      f = loop ? f % 1 : Math.min(1, f);
      onprogress(f);
      txRaf = requestAnimationFrame(tick);
    };
    txRaf = requestAnimationFrame(tick);
  }
}
function stopTx() {
  if (txRaf) { cancelAnimationFrame(txRaf); txRaf = 0; }
  if (txSource) { try { txSource.stop(); } catch {} txSource = null; }
}

// ── Listen ───────────────────────────────────────────────────────────────
let rxStream = null, rxNode = null, rxSrc = null, rxMute = null;
export async function startListening(onComplete) {
  await ready();
  await ctx.resume().catch(() => {});
  stopRx();
  rxStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
  });
  rxSrc = ctx.createMediaStreamSource(rxStream);
  rxNode = ctx.createScriptProcessor(1024, 1, 1);
  const parts = new Map(); // tag -> { total, chunks: Map<seq, Uint8Array> }
  rxNode.onaudioprocess = (e) => {
    const samples = new Float32Array(e.inputBuffer.getChannelData(0));
    const res = ggwave.decode(instance, reinterpret(samples, Int8Array));
    if (!res || res.length < 3) return;
    const b = reinterpret(res, Uint8Array); // copy out as unsigned bytes
    const tag = b[0], seq = b[1], total = b[2], chunk = b.slice(3);
    if (!(total >= 1) || seq >= total) return;
    let acc = parts.get(tag);
    if (!acc) { acc = { total, chunks: new Map() }; parts.set(tag, acc); }
    acc.chunks.set(seq, chunk);
    if (acc.chunks.size < acc.total) return;
    let size = 0;
    for (let i = 0; i < acc.total; i++) { const c = acc.chunks.get(i); if (!c) return; size += c.length; }
    const msg = new Uint8Array(size);
    let off = 0;
    for (let i = 0; i < acc.total; i++) { msg.set(acc.chunks.get(i), off); off += acc.chunks.get(i).length; }
    onComplete(msg);
  };
  // Route the processor through a muted gain node: ScriptProcessor only runs
  // while connected to the graph, but we must NOT echo the mic to the speakers.
  rxMute = ctx.createGain(); rxMute.gain.value = 0;
  rxSrc.connect(rxNode); rxNode.connect(rxMute); rxMute.connect(ctx.destination);
}
function stopRx() {
  if (rxNode) { rxNode.onaudioprocess = null; try { rxNode.disconnect(); } catch {} rxNode = null; }
  if (rxSrc) { try { rxSrc.disconnect(); } catch {} rxSrc = null; }
  if (rxMute) { try { rxMute.disconnect(); } catch {} rxMute = null; }
  if (rxStream) { rxStream.getTracks().forEach((t) => t.stop()); rxStream = null; }
}

export function stopAudio() { stopTx(); stopRx(); }
