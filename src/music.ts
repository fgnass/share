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

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
// Audible band: 16 notes of C major pentatonic (C D E G A) from C5 up — a bright
// music-box register, sparkly, consecutive notes never clash, and the wide
// spacing is easy to resolve. Marker C#8 (outside the scale). A C3 bass drone
// (below) adds the low end back. Change 72 -> 60 for a warmer/lower voice.
const PENT = [0, 2, 4, 7, 9];
const AUD_NOTES = Array.from({ length: 16 }, (_, i) => midiHz(72 + 12 * Math.floor(i / 5) + PENT[i % 5]));
const AUD_MARKER = midiHz(109);
// Ultrasound band: 16 tones 15.6–18.0 kHz, marker just below. Kept ≤18 kHz on
// purpose — most laptop/phone speakers and MEMS mics roll off steeply above
// ~18 kHz, and at a 44.1 kHz context 20 kHz sits right under Nyquist where the
// anti-alias filter eats it. ggwave's ultrasonic band started at 15 kHz and
// worked; the previous 17.6–20 kHz plan here did not. Near-silent to most
// adults; the self-test + audible fallback cover devices that still can't manage
// it. No 2nd harmonic (it would alias into the audible range). These frequencies
// are FIXED: two devices must agree on them, so the self-test only chooses WHICH
// band to use, never invents per-device frequencies.
const US_NOTES = Array.from({ length: 16 }, (_, i) => 15600 + i * 160);
const US_MARKER = 15400;
const BANDS = {
  // detMs: how much of each note to integrate when decoding. Audible notes are
  // plucked (they decay), so detect on the loud attack; ultrasound is held, so
  // use the full note for max energy/resolution.
  // chirp: [f0,f1] of the sync sweep (see buildChirp). The two bands sweep
  // disjoint ranges so a matched filter also tells the receiver which band it is.
  // chirp sweep BW is kept moderate (~1.2–1.6 kHz): a wider sweep compresses to
  // a peak narrower than the coarse scan hop and gets stepped over.
  audible: { name: "audible", notes: AUD_NOTES, marker: AUD_MARKER, harm: 0.15, detMs: DET_MS, chirp: [2100, 3300] },
  ultrasound: { name: "ultrasound", notes: US_NOTES, marker: US_MARKER, harm: 0, detMs: TONE_MS, chirp: [15700, 17300] },
};
// Which band we TRANSMIT in. The receiver auto-detects, so this need not match
// the other device.
let txMode = "audible";
export function setUltrasound(on: boolean) { txMode = on ? "ultrasound" : "audible"; }

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

// Add one tone into `data` at sample `off`. Options: wave = "sine" (with `harm`
// 2nd-harmonic amount) or "square" (buzzy 8-bit chiptune, a few odd harmonics);
// amp; pluck = struck/decaying (music-box / NES-staccato) vs. held envelope.
function addTone(data, off, freq, n, sr, { harm = 0, amp = 0.32, pluck = false, wave = "sine" } = {}) {
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
    const s = wave === "square"
      ? 0.6 * (Math.sin(ph) + Math.sin(3 * ph) / 3 + Math.sin(5 * ph) / 5 + Math.sin(7 * ph) / 7)
      : Math.sin(ph) + harm * Math.sin(2 * ph);
    data[idx] += amp * env * s;
  }
}

// Opening of the Super Mario Bros. ground theme (E E · E · C E · G ··· g), in
// chiptune, with its real syncopated rhythm. [midi | null=rest, ms]. Same square
// voice/register as the data so it blends. Purely cosmetic — the decoder locks
// onto the chirp preamble after it and ignores these notes.
const MARIO_RIFF = [
  [76, 100], [76, 100], [null, 100], [76, 100], [null, 100],
  [72, 100], [76, 100], [null, 100], [79, 200], [null, 200], [67, 200],
];
const riffSamples = (sr) => MARIO_RIFF.reduce((s, [, ms]) => s + Math.round(ms / 1000 * sr), 0);
function renderRiff(data, off, sr) {
  let p = off;
  for (const [m, ms] of MARIO_RIFF) {
    const n = Math.round(ms / 1000 * sr);
    if (m != null) addTone(data, p, midiHz(m), n, sr, { pluck: true, wave: "square", amp: 0.26 });
    p += n;
  }
  return p - off;
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

export function encodeWaveform(payload, sr, mode = txMode, withIntro = true) {
  const B = BANDS[mode] || BANDS.audible, audible = mode !== "ultrasound";
  const toneN = Math.round(TONE_MS / 1000 * sr), symN = toneN + Math.round(GAP_MS / 1000 * sr);
  const chirpN = Math.round(CHIRP_MS / 1000 * sr), sgN = Math.round(SYNC_GAP_MS / 1000 * sr);
  const nibs = frameNibbles(payload);
  const riffN = (audible && withIntro) ? riffSamples(sr) + Math.round(sr * 0.12) : 0; // riff + a short gap before the chirp
  const dataStart = riffN + chirpN + sgN;
  const data = new Float32Array(dataStart + nibs.length * symN + Math.round(sr * 0.05));
  if (audible) renderRiff(data, 0, sr);                             // cosmetic Mario intro
  data.set(buildChirp(B, sr, audible ? 0.5 : 0.6), riffN);        // sync preamble (frequency sweep), region is silent
  // Data notes are plucky sine (robust: square's harmonics collide with other
  // note bins and can flip a symbol). The chiptune character lives in the intro.
  for (let s = 0; s < nibs.length; s++)
    addTone(data, dataStart + s * symN, B.notes[nibs[s]], toneN, sr,
      audible ? { pluck: true, wave: "sine", harm: 0.15, amp: 0.3 } : { harm: B.harm });
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
    audible: { marker: AUD_MARKER, notes: AUD_NOTES },
    ultrasound: { marker: US_MARKER, notes: US_NOTES },
  };
}
// Goertzel power at every marker/note of both bands over samples[start..start+n).
function spectrumAt(buf, start, n, sr) {
  const P = bandFreqs();
  const one = (fl: number[]) => fl.map((f) => goertzel(buf, start, n, f, sr));
  return {
    audible: { marker: goertzel(buf, start, n, P.audible.marker, sr), notes: one(P.audible.notes) },
    ultrasound: { marker: goertzel(buf, start, n, P.ultrasound.marker, sr), notes: one(P.ultrasound.notes) },
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
  const decodeSym = (s) => {
    const p = dataStart + s * symN;
    const win = Math.min(toneN, Math.round(band.detMs / 1000 * sr));
    let best = -1, bi = 0;
    for (let i = 0; i < 16; i++) { const g = goertzel(buf, p, win, band.notes[i], sr); if (g > best) { best = g; bi = i; } }
    return bi;
  };
  const reset = () => { state = "search"; scan = Math.max(0, buf.length - chirpN); band = null; sym = 0; need = 0; nibs = []; curK = 0; curP = 0; bodyBytes = 0; };

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
        nibs.push(decodeSym(sym)); sym++;
        if (sym === 6 && !need) {
          // Three length bytes were sent; majority-vote so one flipped symbol
          // doesn't derail the whole frame, then derive the RS body size.
          const b0 = (nibs[0] << 4) | nibs[1], b1 = (nibs[2] << 4) | nibs[3], b2 = (nibs[4] << 4) | nibs[5];
          curK = majority3(b0, b1, b2);
          if (curK < 1 || curK > 254) { reset(); break; } // implausible length → resync
          curP = parityFor(curK);
          bodyBytes = curK + 1 + curP;
          need = 6 + 2 * bodyBytes;
        }
        if (need && onProgress) onProgress(Math.min(1, sym / need)); // length is sent first → we know the total
        if (need && sym >= need) {
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
  }
  return { push, reset };
}

// ── Web Audio wrappers ─────────────────────────────────────────────────────
let ctx = null;
const audioCtx = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());

let txSource = null, txRaf = 0;
export async function playBytes(payload, { loop = false, onended, onprogress, intro = true } = {}) {
  const c = audioCtx();
  await c.resume().catch(() => {});
  stopTx();
  const data = encodeWaveform(payload, c.sampleRate, txMode, intro);
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

let rxStream = null, rxNode = null, rxSrc = null, rxMute = null;
export async function startListening(onComplete, onProgress) {
  const c = audioCtx();
  await c.resume().catch(() => {});
  stopRx();
  rxStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
  });
  rxSrc = c.createMediaStreamSource(rxStream);
  rxNode = c.createScriptProcessor(2048, 1, 1);
  const dec = makeDecoder(c.sampleRate, onComplete, onProgress);
  rxNode.onaudioprocess = (e) => dec.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  rxMute = c.createGain(); rxMute.gain.value = 0; // keep the processor pulling without echoing to speakers
  rxSrc.connect(rxNode); rxNode.connect(rxMute); rxMute.connect(c.destination);
}
function stopRx() {
  if (rxNode) { rxNode.onaudioprocess = null; try { rxNode.disconnect(); } catch {} rxNode = null; }
  if (rxSrc) { try { rxSrc.disconnect(); } catch {} rxSrc = null; }
  if (rxMute) { try { rxMute.disconnect(); } catch {} rxMute = null; }
  if (rxStream) { rxStream.getTracks().forEach((t) => t.stop()); rxStream = null; }
}

export function stopAudio() { stopTx(); stopRx(); }

// ── Capability self-test (loopback) ─────────────────────────────────────────
// Play a comb of every candidate tone through this device's own speaker while
// recording its own mic, then measure received SNR per bin. Tells us (a) which
// band this device can actually hear itself on and (b) whether it's loud enough.
// It characterises THIS device's hardware — a good proxy for whether it can take
// part in a band at all: if your own mic can't hear your own 17 kHz, it won't
// hear the peer's either. Frequencies are fixed, so both ends stay compatible.
const MIC = { echoCancellation: false, autoGainControl: false, noiseSuppression: false };
const naptime = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type BandTest = { name: string; markerSnr: number; noteSnr: number[]; good: number; ok: boolean };
export type SelfTest = { sampleRate: number; bands: BandTest[]; recommend: string; quiet: boolean };

export async function selfTest(): Promise<SelfTest> {
  const c = audioCtx();
  await c.resume().catch(() => {});
  const sr = c.sampleRate;
  const P = bandFreqs();
  const order = ["audible", "ultrasound"] as const;
  const seq: number[] = [];
  for (const b of order) seq.push(P[b].marker, ...P[b].notes);

  const toneN = Math.round(0.07 * sr), gapN = Math.round(0.03 * sr), leadN = Math.round(0.3 * sr);
  const data = new Float32Array(leadN + seq.length * (toneN + gapN) + Math.round(0.15 * sr));
  let p = leadN;
  for (const f of seq) { addTone(data, p, f, toneN, sr, { amp: 0.45, harm: f < 10000 ? 0.15 : 0 }); p += toneN + gapN; }

  // Record from before playback so the lead-in captures the ambient noise floor.
  const chunks: Float32Array[] = [];
  const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC });
  const src = c.createMediaStreamSource(stream);
  const node = c.createScriptProcessor(2048, 1, 1);
  node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  const mute = c.createGain(); mute.gain.value = 0;
  src.connect(node); node.connect(mute); mute.connect(c.destination);

  const buffer = c.createBuffer(1, data.length, sr);
  buffer.getChannelData(0).set(data);
  const bsrc = c.createBufferSource(); bsrc.buffer = buffer; bsrc.connect(c.destination);
  await new Promise<void>((res) => { bsrc.onended = () => res(); bsrc.start(); });
  await naptime(200);
  node.onaudioprocess = null; src.disconnect(); node.disconnect(); mute.disconnect();
  stream.getTracks().forEach((t) => t.stop());

  let total = 0; for (const ch of chunks) total += ch.length;
  const buf = new Float32Array(total);
  { let o = 0; for (const ch of chunks) { buf.set(ch, o); o += ch.length; } }

  const win = toneN, leadWin = Math.min(leadN, buf.length);
  // Noise floor for a freq: mean Goertzel power over same-size windows in the
  // silent lead-in — directly comparable to the signal peak below.
  const floorOf = (f: number) => {
    let sum = 0, cnt = 0;
    for (let s = 0; s + win <= leadWin; s += win) { sum += goertzel(buf, s, win, f, sr); cnt++; }
    return Math.max(cnt ? sum / cnt : 1e-12, 1e-12);
  };
  // Signal for a freq: the strongest window anywhere (the tone was emitted, so
  // its peak ≈ how loudly it came back).
  const peakOf = (f: number) => {
    let best = 0;
    for (let s = 0; s + win <= buf.length; s += Math.round(win / 2)) {
      const g = goertzel(buf, s, win, f, sr); if (g > best) best = g;
    }
    return best;
  };
  const snrDb = (f: number) => 10 * Math.log10(peakOf(f) / floorOf(f));

  const SNR_OK = 10;
  const bands: BandTest[] = order.map((name) => {
    const markerSnr = snrDb(P[name].marker);
    const noteSnr = P[name].notes.map((f) => snrDb(f));
    const good = noteSnr.filter((s) => s >= SNR_OK).length;
    return { name, markerSnr, noteSnr, good, ok: markerSnr >= SNR_OK && good >= 14 };
  });

  const us = bands.find((b) => b.name === "ultrasound")!;
  const aud = bands.find((b) => b.name === "audible")!;
  const quiet = !aud.ok && aud.markerSnr < 6;   // can't even hear our own audible → muted / too quiet
  const recommend = us.ok ? "ultrasound" : aud.ok ? "audible" : quiet ? "louder" : "audible";
  const report: SelfTest = { sampleRate: sr, bands, recommend, quiet };
  dbg({ t: "selftest", report });
  return report;
}

// ── Carrier sense ───────────────────────────────────────────────────────────
// Briefly open the mic and report whether a peer is transmitting right now — a
// marker tone dominating either band's note bins. Used by the half-duplex loop
// to hold off before it talks (CSMA/CA), so two devices don't step on each
// other. Detects the frame's leading sync marker (and the ACK beacon's), which
// is enough to defer; false on ambient noise (no dominant marker).
export async function senseBusy(ms = 160): Promise<boolean> {
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
          const g = B.notes.map((f) => goertzel(buf, p, toneN, f, sr));
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
// the beacon is a 1-byte "I'm ready to receive" (played as the Mario theme).
export const BEACON = 0xb0;
// ACK = "I'm here and ready to receive" — a control frame carrying the sender's
// nonce so a device can tell a peer's ACK from its own echo. A payload (offer/
// answer) is only ever transmitted right after hearing a *peer's* ACK.
export const ACK = 0xac;
export const isOffer = (b: Uint8Array | null): boolean => !!b && b[0] === 0x6f;
export const isAnswer = (b: Uint8Array | null): boolean => !!b && b[0] === 0x61;
export const isBeacon = (b: Uint8Array | null): boolean => !!b && b[0] === BEACON;
export const isAck = (b: Uint8Array | null): boolean => !!b && b[0] === ACK && b.length >= 3;

let aborted = false, activeListen = null, lastRxBand = null;
export function resetAuto() { aborted = false; }
export function abortAuto() { aborted = true; if (activeListen) activeListen(null); stopAudio(); }
export const autoAborted = () => aborted;
export const rxBand = (): string | null => lastRxBand; // band ("audible"/"ultrasound") of the last decoded frame

// Play a payload once; resolves when it finishes (or immediately if aborted).
export function playFrame(payload: Uint8Array, { intro = false, onprogress }: { intro?: boolean; onprogress?: (f: number) => void } = {}): Promise<void> {
  return new Promise((resolve) => {
    if (aborted) return resolve();
    playBytes(payload, { loop: false, intro, onprogress, onended: resolve });
  });
}
// Listen until a frame decodes (resolve its payload) or the timeout (resolve null).
// onProgress(fraction) fires as symbols arrive once the length is known.
export function listenFor(timeoutMs: number, onProgress?: (f: number) => void): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    if (aborted) return resolve(null);
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); activeListen = null; stopRx(); resolve(v); };
    activeListen = finish;
    const t = setTimeout(() => finish(null), timeoutMs);
    startListening((bytes, band) => { lastRxBand = band; finish(bytes); }, onProgress)
      .catch(() => finish(null)); // e.g. mic permission denied → treat as "heard nothing"
  });
}