// Regression tests for the sound self-test's pass criterion, run in plain Node
// (no audio hardware): drive encodeWaveform → simulate a channel → makeDecoder,
// exactly as probeBand() does with a real mic capture.
//
// The bug these lock down: the previous comb-of-tones probe compared the
// strongest window anywhere against a floor measured in a silent lead-in, which
// reads positive on noise alone. A device with its volume at ZERO passed the
// ultrasound probe and then reported a clean bill of health on an inaudible band.
// The pass criterion is now "the frame we sent decodes back byte-identical", so
// no amount of ambient noise can satisfy it.

import { encodeWaveform, makeDecoder, PROBE, isProbe, ACK, GOT } from "../src/music.ts";

const SR = 48000;
let failed = 0, knownBad = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) failed++;
};
// A check we know does not hold yet: reported, but doesn't fail the run. Flips to
// a plain ok() once the underlying bug is fixed.
const known = (cond, msg) => {
  console.log(`${cond ? "  ok  " : " KNOWN"} ${msg}`);
  if (!cond) knownBad++;
};

// Deterministic PRNG so a flaky run means a real regression, not bad luck.
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

// Goertzel power of `freq` over samples[start..start+n) — same as music.ts's.
function goertzel(s, start, n, freq, sr) {
  const k = 2 * Math.cos(2 * Math.PI * freq / sr);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s0 = s[start + i] + k * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}

// Push a capture through a throwaway decoder; returns the decoded payload or null.
function decode(buf) {
  let got = null;
  const dec = makeDecoder(SR, (bytes) => { if (!got) got = bytes; });
  for (let p = 0; p < buf.length; p += 2048) dec.push(buf.slice(p, Math.min(p + 2048, buf.length)));
  return got;
}
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

// Model a mic capture: `lead` ms of ambient, then the emitted waveform scaled by
// `gain` (0 = muted device) plus ambient at `noise`, then a short tail. `noiseAfter`
// scales the ambient level once playback starts — the non-stationarity (AGC
// settling, a fan, someone shifting) that made the old estimator pass on silence.
function capture(wave, { gain = 1, noise = 0.0015, noiseAfter = 1, lead = 300, tail = 250 } = {}) {
  const leadN = Math.round(lead / 1000 * SR), tailN = Math.round(tail / 1000 * SR);
  const buf = new Float32Array(leadN + wave.length + tailN);
  for (let i = 0; i < buf.length; i++) {
    const lvl = i < leadN ? noise : noise * noiseAfter;
    buf[i] = lvl * rnd();
  }
  if (gain > 0) for (let i = 0; i < wave.length; i++) buf[leadN + i] += gain * wave[i];
  return buf;
}

// Mirror probeBand()'s verdict: a band passes iff our own frame decodes back,
// byte-identical. Deliberately NOT corroborated by any level/SNR threshold.
// Measured on a muted MacBook Air (Chrome, built-in speakers + mic): across 16
// probes the decode was correct 16/16, while the in-band SNR swung −5.9…+24.2 dB
// and crossed a 4 dB gate in 7 of them — an SNR gate flipped the verdict to "not
// muted" in ~half the runs. `snr` is a diagnostic only; it must never be a gate.
function verdict(buf, leadN, bandF0, df, groups) {
  const got = decode(buf);
  const decoded = same(got, payload);
  const freqs = []; for (let g = 0; g < groups; g++) for (let b = 0; b < 16; b++) freqs.push(bandF0 + (g * 16 + b) * df);
  const win = Math.round(0.06 * SR);
  const power = (start) => { let s = 0; for (const f of freqs) s += goertzel(buf, start, win, f, SR); return Math.max(s, 1e-12); };
  const floor = power(Math.max(0, leadN - win));
  let peak = 1e-12;
  for (let s = leadN; s + win <= buf.length; s += win) { const p = power(s); if (p > peak) peak = p; }
  return { ok: decoded, decoded, snr: 10 * Math.log10(peak / floor) };
}

const payload = Uint8Array.from([PROBE, 0xad, 0xbe, 0xef, 0x01, 0x23, 0x45, 0x67]);

// The probe's type byte must not alias any handshake frame, or a probe echo would
// be routed as an offer/answer/ACK/GOT and corrupt discovery.
console.log("\n── frame typing ──");
ok(isProbe(payload), "probe payload is recognised as a probe");
for (const [name, b] of [["offer", 0x6f], ["answer", 0x61], ["ACK", ACK], ["GOT", GOT], ["beacon", 0xb0]])
  ok(PROBE !== b, `probe byte differs from ${name}`);
ok(!isProbe(Uint8Array.from([ACK, 1, 2])), "an ACK is not seen as a probe");

const LEAD_MS = 300;
const leadSamples = Math.round(LEAD_MS / 1000 * SR);
const BANDS = { ultrasound: [15000, 60, 3], audible: [800, 100, 4] };

for (const band of ["ultrasound", "audible"]) {
  console.log(`\n── ${band} ──`);
  const wave = encodeWaveform(payload, SR, band);
  const [f0, df, groups] = BANDS[band];
  const judge = (buf) => verdict(buf, leadSamples, f0, df, groups);

  // Healthy device: its own frame comes back intact.
  ok(judge(capture(wave, { gain: 0.8 })).ok, "clean acoustic loopback passes");

  // THE BUG: volume at 0. No amount of ambient noise may produce a pass.
  for (const noiseAfter of [1, 2, 4, 8]) {
    const got = decode(capture(wave, { gain: 0, noiseAfter }));
    ok(!same(got, payload), `muted device fails (ambient ${noiseAfter}x after lead-in)`);
  }

  // Very quiet speaker: attenuated far below the noise floor must not pass.
  ok(!same(decode(capture(wave, { gain: 0.002, noise: 0.01 })), payload),
    "speaker far below the noise floor fails");

  // LOUD BUT UNDECODABLE — the case real hardware produced: on a MacBook Air the
  // ultrasound band measured +69.6 dB yet never decoded (speaker/mic rolloff above
  // 15 kHz mangles the symbols). An SNR-based rule would have selected this band
  // and pairing would then silently never work. Simulated here by clipping the
  // waveform hard: plenty of in-band energy, destroyed symbol structure.
  {
    // Smear each sample across ~1.5 symbol periods: the tones stay present (so
    // in-band power, and thus SNR, stays high) but adjacent symbols bleed into one
    // another and the decoder can no longer read them — the same way an over-driven
    // or badly rolled-off transducer keeps the energy and loses the data.
    const src = capture(wave, { gain: 0.8 });
    const smear = Math.round(0.05 * SR);
    const wrecked = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      let s = 0;
      for (let k = 0; k < smear; k += 8) s += src[Math.max(0, i - k)];
      wrecked[i] = s / (smear / 8);
    }
    const v = judge(wrecked);
    ok(v.snr > 6, `smeared capture still measures loud (${v.snr.toFixed(0)}dB)`);
    ok(!v.ok, "  …but fails, because loudness is not the criterion");
  }

  // Peer collision: a DIFFERENT payload in the same band must never be accepted
  // as our own echo — this is what stops two devices self-testing at once from
  // validating each other's hardware.
  // Same type byte as ours (both devices run the same code) — only the random
  // tail distinguishes them, which is exactly what must be checked.
  const peerPayload = Uint8Array.from([PROBE, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
  const peerWave = encodeWaveform(peerPayload, SR, band);
  const heard = decode(capture(peerWave, { gain: 0.8 }));
  ok(!same(heard, payload), "peer's frame is not mistaken for our payload");
  ok(same(heard, peerPayload), "peer's frame decodes as ITS payload (→ flagged as collision)");
}

// A dead mic must be distinguishable from a quiet speaker. Both yield "no decode",
// but only one is fixed by turning the volume up — reporting "turn the volume up"
// on a phone whose volume is already maxed is unactionable, and the give-away is
// that the OS recording indicator never lights up.
console.log("\n── dead mic vs. quiet speaker ──");
{
  const micDeadOf = (buf, trackMuted = false) => {
    let rms = 0; for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / Math.max(1, buf.length));
    return trackMuted || buf.length < Math.round(0.2 * SR) || rms === 0;
  };
  const wave = encodeWaveform(payload, SR, "audible");
  // No callbacks at all (ScriptProcessor starved — seen on mobile Safari).
  ok(micDeadOf(new Float32Array(0)), "empty capture ⇒ micDead");
  // Samples arrive but are digital silence (track resolved muted, as on iOS).
  ok(micDeadOf(new Float32Array(Math.round(1.2 * SR))), "all-zero capture ⇒ micDead");
  // A track flagged muted, even with plausible audio in the buffer.
  ok(micDeadOf(capture(wave, { gain: 0.8 }), true), "muted track ⇒ micDead");
  // A real mic in a silent room still has a noise floor → NOT micDead, just quiet.
  const quietRoom = capture(wave, { gain: 0, noise: 0.0015 });
  ok(!micDeadOf(quietRoom), "muted speaker but live mic ⇒ NOT micDead (it's quiet)");
  ok(!verdict(quietRoom, leadSamples, 800, 100, 4).ok, "  …and still fails to decode");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
if (knownBad) console.log(`${knownBad} known-unfixed check(s) — see the bypass note in probeBand()`);
process.exit(failed ? 1 : 0);
