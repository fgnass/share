// @ts-nocheck — ported DSP module; kept loosely typed.
// ─────────── "Musical" data-over-sound codec ───────────
// A gentle alternative to ggwave's harsh modem chirp, meant to be bearable in a
// room full of people. Bytes are sent as a sequence of soft notes drawn from a
// major-pentatonic scale (so consecutive notes never clash), each with a smooth
// attack/release so it sounds like a music box rather than a screech.
//
// Scheme: simple single-note MFSK. 16 notes → 4 bits per note (one nibble). A
// distinct high "ping" marks the start (sync); the frame is [len, ...payload,
// crc8] so the receiver knows the length and can reject a bad decode — a wrong
// note just fails the CRC and the sender's loop replays the tune.
//
// The pure codec (encodeWaveform / makeDecoder) takes an explicit sample rate so
// it can be unit-tested in Node; the Web-Audio wrappers are below.

import { rsEncode, rsDecode } from "./rs";

const TONE_MS = 36, GAP_MS = 6, CHIRP_MS = 80, SYNC_GAP_MS = 40, DET_MS = 28;

// Multi-tone MFSK (ggwave-style). Each band splits a frequency range into
// `groups` blocks of 16 bins spaced `df` Hz apart. Every symbol lights up ONE
// tone per group simultaneously → `groups` nibbles (groups/2 bytes) per symbol,
// several × the throughput of one-tone-per-symbol. A dead bin then costs only one
// nibble per symbol (Reed-Solomon repairs it) instead of a whole run — which is
// what made the single-tone version's long frames never arrive.
//
// Audible has SNR headroom for more parallel tones over a wide range. Ultrasound
// is kept ≤18 kHz (speakers/mics roll off above that, and 20 kHz sits under
// Nyquist at 44.1 kHz) so it uses fewer, louder, more closely spaced tones.
// Frequencies are FIXED: both devices must agree, so the self-test only chooses
// WHICH band to use, never invents per-device frequencies.
const GROUP_BINS = 16;
const BANDS = {
  // detMs: integration window when decoding. chirp: [f0,f1] of the sync sweep
  // (buildChirp); the two bands sweep disjoint ranges so the matched filter also
  // tells the receiver which band it is.
  audible:    { name: "audible",    f0: 800,   df: 100, groups: 4, harm: 0.15, detMs: DET_MS,  pluck: true,  chirp: [2100, 3300] },
  ultrasound: { name: "ultrasound", f0: 15000, df: 60,  groups: 3, harm: 0,    detMs: TONE_MS, pluck: false, chirp: [15700, 17300] },
};
// Frequency of bin `bin` (0..15) in group `g` (0..groups-1) of band B.
const freqOf = (B, g: number, bin: number) => B.f0 + (g * GROUP_BINS + bin) * B.df;
// All bin frequencies of a band, group-major (used for probing/monitoring).
const binFreqs = (B) => { const o: number[] = []; for (let g = 0; g < B.groups; g++) for (let b = 0; b < GROUP_BINS; b++) o.push(freqOf(B, g, b)); return o; };
// Which band we TRANSMIT in. The receiver auto-detects, so this need not match
// the other device.
let txMode = "audible";
export function setUltrasound(on: boolean) { txMode = on ? "ultrasound" : "audible"; }
export const txBand = (): string => txMode; // which band the next frame will use

function crc8(bytes) {
  let c = 0;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

// Reed-Solomon parity budget as a function of message length — ~30% overhead,
// clamped so it stays useful for tiny frames and never overruns GF(256)'s 255-
// byte codeword. A pure function of K, so encoder and decoder agree without
// negotiating: the decoder derives it from the length it reads.
function parityFor(k: number): number {
  return Math.min(255 - (k + 1), Math.max(8, Math.round((k + 1) * 0.3)));
}

// Frame = [K, K, K] (length byte, sent thrice → majority vote survives a flipped
// symbol) followed by an RS codeword over [...payload, crc8(payload)]. RS repairs
// a bounded number of bad symbols so the sender needn't replay the whole tune;
// the CRC is the final check after correction. Every byte → two 4-bit nibbles.
function frameNibbles(payload) {
  const K = payload.length & 0xff;
  const msg = new Uint8Array(K + 1);
  msg.set(payload.subarray(0, K));
  msg[K] = crc8(payload.subarray(0, K));
  const body = rsEncode(msg, parityFor(K));
  const all = new Uint8Array(3 + body.length);
  all[0] = all[1] = all[2] = K;
  all.set(body, 3);
  const nibs = [];
  for (const b of all) nibs.push(b >> 4, b & 0x0f);
  return nibs;
}
const majority3 = (a: number, b: number, c: number) => (a === b || a === c ? a : b === c ? b : a);

// Add one tone into `data` at sample `off`. Options: `harm` = 2nd-harmonic
// amount; amp; pluck = struck/decaying (music-box) vs. held envelope.
function addTone(data, off, freq, n, sr, { harm = 0, amp = 0.32, pluck = false } = {}) {
  const end = Math.min(off + n, data.length);
  const atk = pluck ? sr * 0.003 : Math.min(n * 0.3, sr * 0.008);
  const rel = Math.min(n * 0.4, sr * 0.016), relP = sr * 0.006, tau = sr * 0.05;
  for (let idx = off, i = 0; idx < end; idx++, i++) {
    let env;
    if (pluck) {
      env = i < atk ? i / atk : Math.exp(-(i - atk) / tau);
      if (i > n - relP) env *= Math.max(0, (n - i) / relP); // avoid a click if clipped
    } else {
      env = 1;
      if (i < atk) env = 0.5 - 0.5 * Math.cos(Math.PI * i / atk);
      else if (i > n - rel) env = 0.5 - 0.5 * Math.cos(Math.PI * (n - i) / rel);
    }
    const ph = 2 * Math.PI * freq * (i / sr);
    data[idx] += amp * env * (Math.sin(ph) + harm * Math.sin(2 * ph));
  }
}

// Linear frequency-sweep preamble. Replaces the held marker tone: a chirp gives
// the receiver a sharp matched-filter correlation peak (see the decoder), so
// sync survives reverb and noise far better than thresholding one tone's power,
// and it pins the data-start to a few ms. Hann-tapered ends to avoid clicks.
function buildChirp(band, sr, amp = 1) {
  const n = Math.round(CHIRP_MS / 1000 * sr);
  const out = new Float32Array(n);
  const [f0, f1] = band.chirp, T = n / sr, k = (f1 - f0) / T, edge = Math.max(1, Math.round(n * 0.15));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let e = 1;
    if (i < edge) e = 0.5 - 0.5 * Math.cos(Math.PI * i / edge);
    else if (i > n - edge) e = 0.5 - 0.5 * Math.cos(Math.PI * (n - i) / edge);
    out[i] = amp * e * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
  }
  return out;
}

export function encodeWaveform(payload, sr, mode = txMode) {
  const B = BANDS[mode] || BANDS.audible, audible = mode !== "ultrasound";
  const toneN = Math.round(TONE_MS / 1000 * sr), symN = toneN + Math.round(GAP_MS / 1000 * sr);
  const chirpN = Math.round(CHIRP_MS / 1000 * sr), sgN = Math.round(SYNC_GAP_MS / 1000 * sr);
  const nibs = frameNibbles(payload);
  const G = B.groups, nSym = Math.ceil(nibs.length / G);
  const dataStart = chirpN + sgN;
  const data = new Float32Array(dataStart + nSym * symN + Math.round(sr * 0.05));
  data.set(buildChirp(B, sr, audible ? 0.5 : 0.6), 0);            // sync preamble (frequency sweep)
  // Each symbol lights one tone per group simultaneously. Per-tone amplitude is
  // scaled down by the group count so the summed waveform doesn't clip.
  const amp = Math.min(0.85 / G, 0.3);
  for (let s = 0; s < nSym; s++)
    for (let g = 0; g < G; g++) {
      const idx = s * G + g;
      const nib = idx < nibs.length ? nibs[idx] : 0; // pad the last symbol
      addTone(data, dataStart + s * symN, freqOf(B, g, nib), toneN, sr, { pluck: B.pluck, harm: B.harm, amp });
    }
  return data;
}

// Goertzel power of `freq` over samples[start .. start+n).
function goertzel(s, start, n, freq, sr) {
  const k = 2 * Math.cos(2 * Math.PI * freq / sr);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s0 = s[start + i] + k * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}

// ── Debug instrumentation ───────────────────────────────────────────────────
// A single optional sink the dev debug view subscribes to. music.ts stays free
// of app/state imports (so the codec is still unit-testable in Node); the UI
// wires this up. Events: {t:"spectrum", ...}, {t:"frame", ok, ...}, {t:"note"}.
let debugSink: ((e: any) => void) | null = null;
export function setDebugSink(fn: ((e: any) => void) | null) { debugSink = fn; }
const dbg = (e: any) => { if (debugSink) try { debugSink(e); } catch {} };

// The fixed frequency plan, exposed so the debug view can label bars and the
// self-test can probe every candidate tone.
export function bandFreqs() {
  return {
    audible: { marker: 0, notes: binFreqs(BANDS.audible), groups: BANDS.audible.groups },
    ultrasound: { marker: 0, notes: binFreqs(BANDS.ultrasound), groups: BANDS.ultrasound.groups },
  };
}
// Goertzel power at every bin of both bands over samples[start..start+n).
function spectrumAt(buf, start, n, sr) {
  const one = (B) => binFreqs(B).map((f) => goertzel(buf, start, n, f, sr));
  return {
    audible: { marker: 0, notes: one(BANDS.audible) },
    ultrasound: { marker: 0, notes: one(BANDS.ultrasound) },
  };
}

// Incremental decoder: feed mic sample chunks via push(); calls onComplete(payload)
// when a CRC-valid frame is recovered.
export function makeDecoder(sr, onComplete, onProgress) {
  const toneN = Math.round(TONE_MS / 1000 * sr), symN = toneN + Math.round(GAP_MS / 1000 * sr);
  const chirpN = Math.round(CHIRP_MS / 1000 * sr), sgN = Math.round(SYNC_GAP_MS / 1000 * sr);
  // Coarse scan step. The chirp compresses to a peak a few ms wide, so the coarse
  // hop must be smaller than the main lobe (≈ sr/bandwidth) or it steps over it.
  const COARSE = Math.max(8, Math.round(sr * 0.0003)); // ~0.3 ms
  // Matched-filter references: each band's exact chirp plus its energy, so a
  // normalized cross-correlation gives a scale-free peak in [0,1]. The band with
  // the strongest peak both syncs and tells us which band the sender used.
  const refs = [BANDS.audible, BANDS.ultrasound].map((B) => {
    const sig = buildChirp(B, sr, 1); let e = 0; for (const x of sig) e += x * x;
    return { band: B, sig, e: Math.max(e, 1e-12) };
  });
  const CHIRP_THRESH = 0.35;
  let buf = new Float32Array(0), state = "search", scan = 0;
  let band = null, dataStart = 0, sym = 0, need = 0, nibs = [], curK = 0, curP = 0, bodyBytes = 0;

  // Normalized cross-correlation of the buffer at offset p against a chirp ref.
  const corrAt = (p, ref) => {
    let dot = 0, be = 0; const sig = ref.sig;
    for (let i = 0; i < chirpN; i++) { const x = buf[p + i]; dot += x * sig[i]; be += x * x; }
    return dot / Math.sqrt((be || 1e-12) * ref.e);
  };
  // Decode one symbol → `groups` nibbles: for each group pick its loudest bin.
  const decodeSym = (s) => {
    const p = dataStart + s * symN;
    const win = Math.min(toneN, Math.round(band.detMs / 1000 * sr));
    const out: number[] = [];
    for (let g = 0; g < band.groups; g++) {
      let best = -1, bi = 0;
      for (let bin = 0; bin < GROUP_BINS; bin++) { const gz = goertzel(buf, p, win, freqOf(band, g, bin), sr); if (gz > best) { best = gz; bi = bin; } }
      out.push(bi);
    }
    return out;
  };
  const reset = () => { state = "search"; scan = Math.max(0, buf.length - chirpN); band = null; sym = 0; need = 0; nibs = []; curK = 0; curP = 0; bodyBytes = 0; };
  // How many ms of the current frame are still in the air. Known as soon as the
  // length bytes (first 2 symbols) are in; before that, the time to those bytes.
  const etaMs = () => {
    if (state !== "data") return 0;
    const totalSym = need ? Math.ceil(need / band.groups) : 2;
    return Math.max(0, ((dataStart + totalSym * symN + toneN - buf.length) / sr) * 1000);
  };

  function push(chunk) {
    const nb = new Float32Array(buf.length + chunk.length);
    nb.set(buf); nb.set(chunk, buf.length); buf = nb;

    if (debugSink && buf.length >= toneN)
      dbg({ t: "spectrum", sr, state, spectrum: spectrumAt(buf, buf.length - toneN, toneN, sr) });

    if (state === "search") {
      for (; scan + chirpN <= buf.length; scan += COARSE) {
        let c0 = 0, r0 = null;
        for (const ref of refs) { const c = corrAt(scan, ref); if (c > c0) { c0 = c; r0 = ref; } }
        if (c0 < CHIRP_THRESH) continue;
        // Coarse hit → refine to the true peak in a ±COARSE neighbourhood, then
        // lock: the chirp starts at bp, so data begins one chirp + gap later.
        let bp = scan, bc = c0, br = r0;
        for (let q = Math.max(0, scan - COARSE); q <= scan + COARSE && q + chirpN <= buf.length; q += 3) {
          for (const ref of refs) { const c = corrAt(q, ref); if (c > bc) { bc = c; bp = q; br = ref; } }
        }
        state = "data"; band = br.band; dataStart = bp + chirpN + sgN; sym = 0; need = 0; nibs = [];
        dbg({ t: "sync", band: band.name, corr: Math.round(bc * 100) / 100 });
        break;
      }
    }
    if (state === "data") {
      while (dataStart + sym * symN + toneN <= buf.length) {
        for (const n of decodeSym(sym)) nibs.push(n); // `groups` nibbles per symbol
        sym++;
        if (!need && nibs.length >= 6) {
          // Three length bytes were sent; majority-vote so one flipped symbol
          // doesn't derail the whole frame, then derive the RS body size.
          const b0 = (nibs[0] << 4) | nibs[1], b1 = (nibs[2] << 4) | nibs[3], b2 = (nibs[4] << 4) | nibs[5];
          curK = majority3(b0, b1, b2);
          if (curK < 1 || curK > 254) { reset(); break; } // implausible length → resync
          curP = parityFor(curK);
          bodyBytes = curK + 1 + curP;
          need = 6 + 2 * bodyBytes; // total nibbles
        }
        if (need && onProgress) onProgress(Math.min(1, nibs.length / need)); // length is sent first → we know the total
        if (need && nibs.length >= need) {
          const body = new Uint8Array(bodyBytes);
          for (let i = 0; i < bodyBytes; i++) body[i] = (nibs[6 + 2 * i] << 4) | nibs[6 + 2 * i + 1];
          const msg = rsDecode(body, curP);            // repair up to curP/2 bad symbols
          let ok = false, payload: Uint8Array | null = null;
          if (msg) { payload = msg.subarray(0, curK); ok = crc8(payload) === msg[curK]; }
          dbg({ t: "frame", ok, band: band.name, len: curK, bytes: bodyBytes, corrected: !!msg });
          if (ok) onComplete(payload, band.name);
          reset();
          break;
        }
      }
    }
    // Trim consumed samples so a long-lived decoder (the persistent rx session
    // keeps one open for the whole pairing) doesn't grow its buffer forever —
    // the concat above copies the WHOLE buffer per push. Rebase all positions.
    const cut = state === "search"
      ? Math.min(scan, Math.max(0, buf.length - (chirpN + 2 * COARSE)))
      : Math.max(0, Math.min(dataStart + sym * symN, buf.length)); // symbols already decoded
    if (cut > 0) { buf = buf.slice(cut); scan = Math.max(0, scan - cut); dataStart -= cut; }
  }
  return { push, reset, inFrame: () => state === "data", etaMs };
}

// ── Web Audio wrappers ─────────────────────────────────────────────────────
let ctx = null;
const audioCtx = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());

let txSource = null, txRaf = 0;
export async function playBytes(payload, { loop = false, onended, onprogress } = {}) {
  const c = audioCtx();
  await c.resume().catch(() => {});
  stopTx();
  const data = encodeWaveform(payload, c.sampleRate, txMode);
  const buffer = c.createBuffer(1, data.length, c.sampleRate);
  buffer.getChannelData(0).set(data);
  const src = c.createBufferSource();
  src.buffer = buffer; src.loop = loop;
  if (!loop && onended) src.onended = () => { if (txSource === src) txSource = null; onended(); };
  src.connect(c.destination); src.start();
  txSource = src;
  if (onprogress) {
    const startAt = c.currentTime, dur = buffer.duration;
    const tick = () => {
      if (txSource !== src) return;
      let f = (c.currentTime - startAt) / dur;
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

let rxStream = null, rxNode = null, rxSrc = null, rxMute = null, rxDec = null;
export const rxInFrame = () => !!rxDec && rxDec.inFrame(); // decoder is mid-frame (don't talk over it)
export const rxEtaMs = (): number => (rxDec ? rxDec.etaMs() : 0); // ms until that frame should finish

// ── Persistent receive session ──────────────────────────────────────────────
// The mic opens ONCE per pairing session and a single decoder runs continuously;
// finished frames land in a small queue that listenFor() consumes. The previous
// open/close-per-listen design left a getUserMedia-sized (~100–400 ms) deaf gap
// between listens — exactly where the peer's next sync chirp lands after we
// decode a frame (GOT → answer follows within ~100 ms). Missing that 80 ms chirp
// costs the whole multi-second frame behind it, which is what kept real
// ultrasound pairing from ever converging: offer re-sends then collide with
// answer re-sends, forever. A side bonus: frames decoded while WE transmit (our
// own echo, or a peer on hardware that manages full duplex) queue up instead of
// being lost.
type RxItem = { bytes: Uint8Array; band: string; at: number };
let rxQ: RxItem[] = [];
let rxWaiter: ((item: RxItem) => void) | null = null; // pending listenFor, if any
let rxProgress: ((f: number) => void) | null = null;  // its progress callback
let rxStarting: Promise<void> | null = null;
let rxGen = 0; // bumped by stopRx so an in-flight open knows it lost the race

async function ensureRx(): Promise<void> {
  if (rxNode) return;
  if (rxStarting) return rxStarting;
  const gen = ++rxGen;
  rxStarting = (async () => {
    const c = audioCtx();
    await c.resume().catch(() => {});
    const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC });
    if (gen !== rxGen) { stream.getTracks().forEach((t) => t.stop()); return; } // stopped while opening
    rxStream = stream;
    rxSrc = c.createMediaStreamSource(stream);
    rxNode = c.createScriptProcessor(2048, 1, 1);
    const dec = makeDecoder(c.sampleRate, (bytes, band) => {
      lastRxBand = band;
      const item = { bytes, band, at: performance.now() };
      const w = rxWaiter; rxWaiter = null;
      if (w) w(item); else rxQ.push(item);
    }, (f) => { if (rxProgress) rxProgress(f); });
    rxDec = dec;
    rxNode.onaudioprocess = (e) => {
      const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
      if (echoCap) echoCap.push(chunk);   // shadow copy while WE transmit (see selfHeard)
      dec.push(chunk);
    };
    rxMute = c.createGain(); rxMute.gain.value = 0; // keep the processor pulling without echoing to speakers
    rxSrc.connect(rxNode); rxNode.connect(rxMute); rxMute.connect(c.destination);
  })().finally(() => { rxStarting = null; });
  return rxStarting;
}
function stopRx() {
  rxGen++;
  rxQ = []; rxWaiter = null; rxProgress = null;
  if (rxNode) { rxNode.onaudioprocess = null; try { rxNode.disconnect(); } catch {} rxNode = null; }
  if (rxSrc) { try { rxSrc.disconnect(); } catch {} rxSrc = null; }
  if (rxMute) { try { rxMute.disconnect(); } catch {} rxMute = null; }
  if (rxStream) { rxStream.getTracks().forEach((t) => t.stop()); rxStream = null; }
  rxDec = null;
}

export function stopAudio() { stopTx(); stopRx(); }

// ── Self-hearing (the beacon IS the capability test) ────────────────────────
// There is no separate probe any more. Every frame we transmit is also a test of
// our own speaker: the mic stays open while we play (the persistent rx session),
// so our own signal comes back through the room and can be decoded like any other
// frame. `withEchoCapture` buffers the mic during a transmission and decodes that
// buffer AFTERWARDS, on a throwaway decoder.
//
// Why a shadow decoder instead of just reading the live one: playFrame() calls
// rxDec.reset() the instant transmission ends, deliberately dropping the in-flight
// echo so the decoder is immediately ready for the peer's reply chirp. That reset
// is what fixed the missed-chirp livelock (a peer's answer follows a GOT within
// ~100 ms, and losing that 80 ms chirp costs the multi-second frame behind it).
// Decoding the echo off the hot path keeps that fix untouched: the live decoder
// still resets, and the capability verdict is computed from a copy.
//
// This replaces a two-phase design (probe, then discover) that cost ~2.4s of
// startup and re-probed on a timer to keep its verdict fresh. Folding the test
// into the beacon makes staleness structurally impossible — the verdict is a
// property of the last frame sent, not a flag that has to be invalidated.
const MIC = { echoCancellation: false, autoGainControl: false, noiseSuppression: false };
const naptime = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Mic samples captured during our own transmission, or null when not capturing.
let echoCap: Float32Array[] | null = null;

// Run `send` with the mic shadow-captured, then report whether our own `payload`
// decoded out of that capture. Returns:
//   heard    — our frame decoded back ⇒ speaker + mic + this band all work
//   micDead  — the capture had no usable audio at all (see below) ⇒ mic problem,
//              which says NOTHING about the speaker, so it must not be reported
//              as "too quiet".
// A mic that works always delivers samples with a non-zero noise floor, so an
// empty or exactly-silent capture means we never heard anything — ours or anyone
// else's. On iOS a track can resolve already muted (or go muted when another app
// takes the mic, or on an incoming call) with no exception thrown, and the
// give-away is the OS recording indicator never appearing.
export async function withEchoCapture(
  payload: Uint8Array,
  send: () => Promise<void>,
): Promise<{ heard: boolean; micDead: boolean }> {
  if (loopback) { await send(); return { heard: true, micDead: false }; } // no acoustic path to test
  const c = audioCtx();
  if (c.state !== "running") { await send(); return { heard: false, micDead: false }; } // suspended ⇒ inconclusive
  // The capture rides on the persistent rx session, so it has to be open BEFORE we
  // transmit. In the pairing loop hear() has usually opened it already, but the
  // first beacon can precede any listen — without this the capture is empty and we
  // would report micDead on a perfectly good mic.
  try { await ensureRx(); } catch { return { heard: false, micDead: true }; } // permission denied etc.
  const cap: Float32Array[] = [];
  echoCap = cap;
  try {
    await send();
    // Keep capturing past the end of playback: propagation delay plus the last
    // symbols still in the air mean the tail of our own frame arrives at the mic
    // AFTER the buffer source has finished. Cutting the capture at send() clips it
    // and the frame never decodes — a false "not heard" on a perfectly loud device.
    await naptime(250);
  } finally { if (echoCap === cap) echoCap = null; }

  let total = 0; for (const ch of cap) total += ch.length;
  const buf = new Float32Array(total);
  { let o = 0; for (const ch of cap) { buf.set(ch, o); o += ch.length; } }

  const sr = c.sampleRate;
  const track = rxStream?.getAudioTracks()[0];
  let rms = 0; for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / Math.max(1, buf.length));
  const micDead = !track || track.muted || !track.enabled || track.readyState !== "live"
    || buf.length < Math.round(0.1 * sr) || rms === 0;

  let heard = false;
  if (!micDead) {
    const dec = makeDecoder(sr, (bytes) => {
      if (bytes.length === payload.length && bytes.every((v, i) => v === payload[i])) heard = true;
    });
    for (let p = 0; p < buf.length; p += 2048) dec.push(buf.slice(p, Math.min(p + 2048, buf.length)));
  }
  dbg({ t: "selfheard", band: txMode, heard, micDead, samples: buf.length, rms });
  return { heard, micDead };
}

// ── Carrier sense ───────────────────────────────────────────────────────────
// Briefly open the mic and report whether a peer is transmitting right now — a
// marker tone dominating either band's note bins. Used by the half-duplex loop
// to hold off before it talks (CSMA/CA), so two devices don't step on each
// other. Detects the frame's leading sync marker (and the ACK beacon's), which
// is enough to defer; false on ambient noise (no dominant marker).
export async function senseBusy(ms = 160): Promise<boolean> {
  if (loopback) return false; // no shared carrier in loopback
  const c = audioCtx();
  await c.resume().catch(() => {});
  return new Promise((resolve) => {
    let stream: MediaStream | null = null, node: any = null, src: any = null, mute: any = null;
    let buf = new Float32Array(0), done = false;
    const sr = c.sampleRate, toneN = Math.round(TONE_MS / 1000 * sr);
    const finish = (v: boolean) => {
      if (done) return; done = true;
      if (node) { node.onaudioprocess = null; try { node.disconnect(); } catch {} }
      if (src) try { src.disconnect(); } catch {}
      if (mute) try { mute.disconnect(); } catch {}
      if (stream) stream.getTracks().forEach((t) => t.stop());
      resolve(v);
    };
    navigator.mediaDevices.getUserMedia({ audio: MIC }).then((s) => {
      if (done) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s; src = c.createMediaStreamSource(s); node = c.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e: any) => {
        const ch = new Float32Array(e.inputBuffer.getChannelData(0));
        const nb = new Float32Array(buf.length + ch.length); nb.set(buf); nb.set(ch, buf.length); buf = nb;
        if (buf.length < toneN) return;
        const p = buf.length - toneN;
        // Busy if a single note bin dominates — a peer's data tone (or its chirp
        // sweeping through the band). Ambient noise spreads across bins evenly and
        // stays below the ratio, so it doesn't false-trigger.
        for (const B of [BANDS.audible, BANDS.ultrasound]) {
          const g = binFreqs(B).map((f) => goertzel(buf, p, toneN, f, sr));
          let mx = 0; for (const v of g) if (v > mx) mx = v;
          const med = g.slice().sort((a, b) => a - b)[g.length >> 1];
          if (mx > 4 * (med || 1e-12) && mx > 1e-3) return finish(true);
        }
      };
      mute = c.createGain(); mute.gain.value = 0;
      src.connect(node); node.connect(mute); mute.connect(c.destination);
      setTimeout(() => finish(false), ms);
    }).catch(() => finish(false));
  });
}

// ── Live spectrum monitor (debug) ───────────────────────────────────────────
// Opens the mic and streams per-bin Goertzel power to the debug sink, so you can
// watch what a device picks up while it is NOT mid-pairing.
let monNode: any = null, monSrc: any = null, monStream: MediaStream | null = null, monMute: any = null;
export async function startMonitor() {
  const c = audioCtx();
  await c.resume().catch(() => {});
  stopMonitor();
  const sr = c.sampleRate, toneN = Math.round(TONE_MS / 1000 * sr);
  monStream = await navigator.mediaDevices.getUserMedia({ audio: MIC });
  monSrc = c.createMediaStreamSource(monStream);
  monNode = c.createScriptProcessor(2048, 1, 1);
  let buf = new Float32Array(0);
  monNode.onaudioprocess = (e: any) => {
    const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
    const nb = new Float32Array(Math.min(buf.length + chunk.length, toneN * 2));
    const keep = nb.length - chunk.length;
    if (keep > 0) nb.set(buf.subarray(buf.length - keep));
    nb.set(chunk, Math.max(0, keep)); buf = nb;
    if (buf.length >= toneN) dbg({ t: "spectrum", sr, state: "monitor", spectrum: spectrumAt(buf, buf.length - toneN, toneN, sr) });
  };
  monMute = c.createGain(); monMute.gain.value = 0;
  monSrc.connect(monNode); monNode.connect(monMute); monMute.connect(c.destination);
}
export function stopMonitor() {
  if (monNode) { monNode.onaudioprocess = null; try { monNode.disconnect(); } catch {} monNode = null; }
  if (monSrc) { try { monSrc.disconnect(); } catch {} monSrc = null; }
  if (monMute) { try { monMute.disconnect(); } catch {} monMute = null; }
  if (monStream) { monStream.getTracks().forEach((t) => t.stop()); monStream = null; }
}

// ── Handshake primitives (used by the automatic ack-handshake) ──────────────
// Frame type = first payload byte. Offer/answer carry the packed SDP after it;
// the beacon is a 1-byte "I'm ready to receive".
export const BEACON = 0xb0;
// ACK = "I'm here and ready to receive" — a control frame carrying the sender's
// nonce so a device can tell a peer's ACK from its own echo. A payload (offer/
// answer) is only ever transmitted right after hearing a *peer's* ACK.
export const ACK = 0xac;
// GOT = "I have decoded your offer" — the handoff signal. When the offerer hears
// it, it stops re-sending the offer and just listens for the incoming answer,
// so its offer re-sends can't collide with the answer. Carries the sender nonce.
export const GOT = 0x67;
export const isOffer = (b: Uint8Array | null): boolean => !!b && b[0] === 0x6f;
export const isAnswer = (b: Uint8Array | null): boolean => !!b && b[0] === 0x61;
export const isBeacon = (b: Uint8Array | null): boolean => !!b && b[0] === BEACON;
export const isAck = (b: Uint8Array | null): boolean => !!b && b[0] === ACK && b.length >= 3;
export const isGot = (b: Uint8Array | null): boolean => !!b && b[0] === GOT && b.length >= 3;

let aborted = false, activeListen = null, lastRxBand = null;
export function resetAuto() { aborted = false; }
export function abortAuto() { aborted = true; if (activeListen) activeListen(null); stopAudio(); }
export const autoAborted = () => aborted;
export const rxBand = (): string | null => lastRxBand; // band ("audible"/"ultrasound") of the last decoded frame

// ── Loopback transport (dev, ?loopback) ─────────────────────────────────────
// Two tabs on the same machine "hear" each other over a BroadcastChannel instead
// of a real mic/speaker, so the handshake logic can be tested without audio at
// all. A frame is delivered only when the sender finishes transmitting AND a
// peer is currently in listenFor — so the half-duplex turn-taking (and misses)
// behave like the acoustic channel, minus codec/SNR effects.
let loopback = false, lbCh: BroadcastChannel | null = null;
const lbId = Math.random().toString(36).slice(2);
export function setLoopback(on: boolean) { loopback = on; if (on && !lbCh) lbCh = new BroadcastChannel("share-sound-loopback"); }
export const isLoopback = () => loopback;
function lbPlay(payload: Uint8Array, onprogress?: (f: number) => void): Promise<void> {
  return new Promise((resolve) => {
    if (aborted) return resolve();
    const durMs = 250 + payload.length * 30, start = performance.now();
    // A timer, NOT requestAnimationFrame: rAF pauses in hidden tabs, which
    // deadlocked two-tab loopback tests when one tab was in the background.
    const iv = setInterval(() => {
      if (aborted) { clearInterval(iv); return resolve(); }
      const f = Math.min(1, (performance.now() - start) / durMs);
      onprogress?.(f);
      if (f >= 1) { clearInterval(iv); lbCh?.postMessage({ from: lbId, bytes: Array.from(payload) }); resolve(); }
    }, 50);
  });
}
function lbListen(timeoutMs: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    if (aborted) return resolve(null);
    let done = false;
    const finish = (v: Uint8Array | null) => { if (done) return; done = true; clearTimeout(t); lbCh?.removeEventListener("message", onmsg); activeListen = null; resolve(v); };
    const onmsg = (e: MessageEvent) => { if (done || !e.data || e.data.from === lbId) return; lastRxBand = "loopback"; finish(new Uint8Array(e.data.bytes)); };
    activeListen = () => finish(null);
    lbCh?.addEventListener("message", onmsg);
    const t = setTimeout(() => finish(null), timeoutMs);
  });
}

// Play a payload once; resolves when it finishes (or immediately if aborted).
export function playFrame(payload: Uint8Array, { onprogress }: { onprogress?: (f: number) => void } = {}): Promise<void> {
  if (loopback) return lbPlay(payload, onprogress);
  return new Promise((resolve) => {
    if (aborted) return resolve();
    playBytes(payload, { loop: false, onprogress, onended: () => {
      // We just filled the air with our own signal, so whatever the decoder is
      // mid-way through is (almost certainly) our own echo. Reset it: instantly
      // ready for the peer's reply chirp instead of finishing our own frame.
      if (rxDec) rxDec.reset();
      resolve();
    } });
  });
}
// Listen until a frame decodes (resolve its payload) or the timeout (resolve null).
// Consumes the persistent rx session: frames that completed while nobody was
// listening (e.g. during our own transmission) are handed over immediately.
// onProgress(fraction) fires as symbols arrive once the length is known.
export function listenFor(timeoutMs: number, onProgress?: (f: number) => void): Promise<Uint8Array | null> {
  if (loopback) return lbListen(timeoutMs);
  return new Promise((resolve) => {
    if (aborted) return resolve(null);
    while (rxQ.length && performance.now() - rxQ[0].at > 8000) rxQ.shift(); // drop stale frames
    if (rxQ.length) { const it = rxQ.shift()!; lastRxBand = it.band; return resolve(it.bytes); }
    let done = false, extended = 0, t: any;
    const finish = (v: Uint8Array | null) => {
      if (done) return; done = true; clearTimeout(t);
      if (rxWaiter === waiter) rxWaiter = null;
      rxProgress = null; activeListen = null;
      resolve(v);
    };
    const waiter = (item: RxItem) => finish(item.bytes);
    rxWaiter = waiter; rxProgress = onProgress || null;
    activeListen = finish;
    // On timeout, never abandon a frame that's mid-decode: the decoder learns the
    // frame's length up front, so extend until its expected end (bounded, in case
    // the sync was a false positive that never completes).
    const onTimeout = () => {
      const eta = rxEtaMs();
      if (eta > 0 && extended < 15000) { const step = Math.min(eta + 400, 2500); extended += step; t = setTimeout(onTimeout, step); return; }
      finish(null);
    };
    t = setTimeout(onTimeout, timeoutMs);
    ensureRx().catch(() => finish(null)); // e.g. mic permission denied → treat as "heard nothing"
  });
}