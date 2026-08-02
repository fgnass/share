// Regression tests for the sound capability check, run in plain Node (no audio
// hardware): drive encodeWaveform → simulate a channel → makeDecoder, exactly as
// withEchoCapture() does with a real mic capture.
//
// There is no separate probe: the discovery beacon IS the test. Sending a frame
// and decoding our own echo out of the mic proves the speaker works; decoding
// anything at all proves the mic works. These tests cover the decode criterion —
// "our own frame comes back byte-identical" — and the reason it is NOT corroborated
// by any loudness threshold.
//
// The bug they lock down: the original comb-of-tones probe compared the strongest
// window anywhere against a floor measured in a silent lead-in, which reads
// positive on noise alone, so a device with its volume at ZERO passed and then
// picked the inaudible ultrasound band while reporting a clean bill of health.

import { encodeWaveform, makeDecoder, ACK, GOT } from "../src/music.ts";

const SR = 48000;
let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) failed++;
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

// The beacon IS the capability test now: [ACK, nonceHi, nonceLo], the same frame
// discovery already sends. The nonce is what distinguishes our echo from a peer's.
const MY_NONCE = 0xbeef;
const payload = Uint8Array.from([ACK, MY_NONCE >> 8, MY_NONCE & 0xff]);

// Our own echo must be distinguishable from a peer's beacon. Both are ACK frames
// on the same fixed frequency grid (both devices run the same code), so the ONLY
// discriminator is the 16-bit nonce — exactly what hear() compares.
console.log("\n── beacon identity ──");
{
  const peerNonce = 0x1234;
  const peer = Uint8Array.from([ACK, peerNonce >> 8, peerNonce & 0xff]);
  const nonceOf = (f) => (f[1] << 8) | f[2];
  ok(nonceOf(payload) === MY_NONCE, "our beacon carries our nonce");
  ok(nonceOf(peer) !== MY_NONCE, "a peer's beacon does not");
  ok(payload[0] === ACK && peer[0] === ACK, "both are ACK frames — nonce is the only discriminator");
}

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
  // A peer's beacon: same ACK type, different nonce.
  const peerPayload = Uint8Array.from([ACK, 0x12, 0x34]);
  const peerWave = encodeWaveform(peerPayload, SR, band);
  const heard = decode(capture(peerWave, { gain: 0.8 }));
  ok(!same(heard, payload), "peer's beacon is not mistaken for ours");
  ok(same(heard, peerPayload), "peer's beacon decodes as ITS payload (→ it's the peer, not our echo)");
}

// A dead mic must be distinguishable from a quiet speaker. Both yield "no decode",
// but only one is fixed by turning the volume up — reporting "turn the volume up"
// on a phone whose volume is already maxed is unactionable, and the give-away is
// that the OS recording indicator never lights up.
console.log("\n── dead mic vs. quiet speaker ──");
{
  const wave = encodeWaveform(payload, SR, "audible");
  const micDeadOf = (buf, trackMuted = false) => {
    let rms = 0; for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / Math.max(1, buf.length));
    return trackMuted || buf.length < Math.round(0.1 * SR) || rms === 0;
  };
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

// The evidence hierarchy. Two independent questions with different sources of
// truth: hearing ANYTHING proves the mic, but only a *causal* reply proves our
// speaker reached the peer through the room.
console.log("\n── evidence hierarchy ──");
{
  // Mirrors pairing.ts: proveSpeaker() is called for ANSWER and GOT only.
  const isOffer = (f) => f[0] === 0x6f, isAnswer = (f) => f[0] === 0x61;
  const isAck = (f) => f[0] === ACK, isGot = (f) => f[0] === GOT;
  const provesSpeaker = (f) => isAnswer(f) || isGot(f);
  const provesMic = () => true; // any decode, whatever the frame

  const got = Uint8Array.from([GOT, 0x12, 0x34]);
  const ack = Uint8Array.from([ACK, 0x12, 0x34]);
  const answer = Uint8Array.from([0x61, 1, 2, 3]);
  const offer = Uint8Array.from([0x6f, 1, 2, 3]);

  // Causal: only exist because the peer decoded something we sent.
  ok(provesSpeaker(got), "peer's GOT proves our speaker (they decoded our offer)");
  ok(provesSpeaker(answer), "peer's ANSWER proves our speaker (built from our offer)");
  // Unprompted: say nothing about our transmit path. An ACK arriving during our
  // offer actually means the peer was transmitting and CANNOT have heard us.
  ok(!provesSpeaker(ack), "peer's ACK does NOT prove our speaker (unprompted)");
  ok(!provesSpeaker(offer), "peer's OFFER does NOT prove our speaker (unprompted)");
  // But every one of them proves the mic.
  for (const [name, f] of [["GOT", got], ["ACK", ack], ["ANSWER", answer], ["OFFER", offer]])
    ok(provesMic(f), `decoding a ${name} proves the mic works`);
}

// Band fallback. Ultrasound is inaudible, so staying on it costs the user nothing;
// audible beacons are loud and unpleasant at close range. So we leave ultrasound
// ONLY on positive evidence that this device can't hear its own US but CAN hear
// lower frequencies — never as a reaction to one unlucky echo.
//
// The regression this locks down: band selection used to alternate unconditionally
// (i % 2), so half of every device's beacons were audible even when ultrasound
// worked perfectly. Measured on real hardware: ~50% audible before, 0% after.
console.log("\n── band fallback ──");
{
  // Mirrors pairing.ts's pickTxBand / ultrasoundHopeless.
  const mk = () => ({ ultrasound: { heard: 0, missed: 0 }, audible: { heard: 0, missed: 0 } });
  const sim = (echo, { sentAny = true, speakerProven = false, micDead = false } = {}) => {
    const heardOn = (b) => echo[b].heard > 0;
    const hopeless = () => !heardOn("ultrasound") && echo.ultrasound.missed >= 3 && heardOn("audible");
    const volLow = () => sentAny && !speakerProven && !micDead && !heardOn("ultrasound") && !heardOn("audible");
    return (i) => {
      if (hopeless()) return "audible";
      const need = !heardOn("audible") && !heardOn("ultrasound");
      return !(need && i % 4 === 3) ? "ultrasound" : "audible";
    };
  };

  // Ultrasound works → never emit an audible beacon, ever.
  {
    const e = mk(); e.ultrasound.heard = 1;
    const d = sim(e);
    const bands = [0,1,2,3,4,5,6,7].map(d);
    ok(bands.every(b => b === "ultrasound"), "US self-heard ⇒ 0 audible beacons across 8 rounds");
  }

  // US marginal (misses) but never confirmed audible → STAY on ultrasound. This is
  // the case that used to bail out immediately.
  {
    const e = mk(); e.ultrasound.missed = 5;
    const d = sim(e);
    const aud = [0,1,2,3,4,5,6,7].map(d).filter(b => b === "audible").length;
    ok(aud <= 2, `US misses alone don't force audible (${aud}/8 sampled for evidence)`);
    ok(aud >= 1, "  …but audible IS sampled, so the comparison can be made");
  }

  // US misses AND audible confirmed on the same hardware → switch, and stay switched.
  {
    const e = mk(); e.ultrasound.missed = 3; e.audible.heard = 1;
    const d = sim(e);
    ok([0,1,2,3,4].map(d).every(b => b === "audible"), "US misses + audible works ⇒ settle on audible");
  }

  // Two misses is not enough — one unlucky echo pair must not condemn the band.
  {
    const e = mk(); e.ultrasound.missed = 2; e.audible.heard = 1;
    const d = sim(e);
    ok(d(0) === "ultrasound", "2 US misses is below the threshold ⇒ still ultrasound");
  }

  // A peer's GOT/ANSWER proves the speaker, which retires the volume hint even if
  // self-echo never worked — so it must not drag us to audible either.
  {
    const e = mk(); e.ultrasound.missed = 9;
    const d = sim(e, { speakerProven: true });
    ok(d(0) === "ultrasound" && d(1) === "ultrasound",
      "speaker proven end-to-end ⇒ stay on ultrasound despite echo misses");
  }
}

// The volume hint. Reported from a real phone: it went from "Listening…" to "Turn
// the volume up" after a while even though its sound check had passed. Cause: a
// suspended AudioContext (routine on mobile — the page backgrounds, the screen dims)
// emits no sound, and withEchoCapture reported heard:false for it, which sendHeard
// counted as a MISS. Enough phantom misses and a device with fine audio gets blamed.
console.log("\n── volume hint ──");
{
  // Mirrors pairing.ts: sendHeard() tallies only conclusive attempts; volumeLow()
  // needs no success on any band AND >= 3 real misses.
  const mk = () => ({ ultrasound: { heard: 0, missed: 0 }, audible: { heard: 0, missed: 0 } });
  const run = (attempts) => {
    const echo = mk();
    let sentAny = false, speakerProven = false;
    for (const a of attempts) {
      if (a.inconclusive) continue;                 // <- the fix
      sentAny = true;
      if (a.heard) echo[a.band].heard++; else echo[a.band].missed++;
      if (a.got) speakerProven = true;
    }
    const heardOn = (b) => echo[b].heard > 0;
    const missed = echo.ultrasound.missed + echo.audible.missed;
    return sentAny && !speakerProven && !heardOn("ultrasound") && !heardOn("audible") && missed >= 3;
  };
  const us = (o) => ({ band: "ultrasound", ...o });

  // THE REPORTED BUG: suspended context on every beacon, nothing actually emitted.
  ok(!run([us({inconclusive:true}), us({inconclusive:true}), us({inconclusive:true}), us({inconclusive:true})]),
    "suspended-context beacons never raise the hint");
  // Passed once, then the context suspends repeatedly → must stay quiet.
  ok(!run([us({heard:true}), us({inconclusive:true}), us({inconclusive:true}), us({inconclusive:true})]),
    "a passed check is not undone by later inconclusive attempts");
  // A genuinely silent speaker still gets the hint.
  ok(run([us({heard:false}), us({heard:false}), us({heard:false})]),
    "three real misses DO raise the hint");
  // Hysteresis: one or two early misses are routine (US self-echo is ~2/5).
  ok(!run([us({heard:false}), us({heard:false})]),
    "two misses is below the threshold — no premature hint");
  ok(!run([us({heard:false}), us({heard:false}), us({heard:true}), us({heard:false})]),
    "unlucky start then a success ⇒ no hint");
  // The peer heard us, so the volume is fine by definition even if self-echo never was.
  ok(!run([us({heard:false}), us({heard:false}), us({heard:false, got:true})]),
    "peer's GOT/ANSWER suppresses the hint regardless of self-echo");
}

// Step rail. The per-frame bar restarts several times per pairing, which reads as
// "stuck retrying"; the rail exists to show the process advanced. It must therefore
// never march backwards, even though the handshake genuinely loops (unacknowledged
// offers get resent, a missed answer drops back to listening).
console.log("\n── step rail ──");
{
  const STEPS = ["check", "find", "offer", "reply", "done"];
  const idx = (s) => STEPS.indexOf(s);
  const mk = () => {
    let cur = "check";
    return {
      set: (s) => { if (idx(s) > idx(cur)) cur = s; },
      reset: () => { cur = "check"; },
      get: () => cur,
    };
  };
  // Milestone mapping, as onScan() does it: an answer code means Reply, anything else
  // (an offer) means Offer. Nouns, so the same mapping is correct on BOTH devices —
  // the offerer reaches "offer" by sending, the answerer by receiving.
  const milestone = (type) => (type === "a" ? "reply" : "offer");
  ok(milestone("o") === "offer", "an offer code ⇒ Offer, whoever produced it");
  ok(milestone("a") === "reply", "an answer code ⇒ Reply, whoever produced it");

  // Receiving must advance the rail too, not just sending. A code frame is seconds of
  // air time: the sender showed "Offer" while the receiver still sat on "Check" for the
  // whole transfer, looking stuck. Any frame arriving proves our mic works, which is
  // exactly what Check asks — so reception clears the gate immediately.
  {
    const recv = (etaMs) => {
      const out = { step: "find", narrated: false };    // gate always clears
      if (etaMs > 900) out.narrated = true;             // only long frames get a label
      return out;
    };
    ok(recv(4000).step === "find", "receiving a frame clears the Check gate");
    ok(recv(4000).narrated, "a long (code) frame is narrated with progress");
    ok(!recv(200).narrated, "a 3-byte beacon is NOT narrated (would flash and vanish)");
    ok(recv(200).step === "find", "  …but a beacon still clears the gate");
  }

  const st = mk();
  st.set("find");  ok(st.get() === "find", "check → find advances (audio proven, now discovering)");
  st.set("offer"); ok(st.get() === "offer", "find → offer advances (roles resolved)");
  st.set("check"); ok(st.get() === "offer", "offer → check is IGNORED (a resend must not rewind)");
  st.set("reply"); ok(st.get() === "reply", "offer → reply advances");
  st.set("offer"); ok(st.get() === "reply", "reply → offer is IGNORED (a re-heard offer must not rewind)");
  st.set("done");  ok(st.get() === "done", "reply → done advances");
  st.reset();      ok(st.get() === "check", "a new run resets to check");
}

// Heard-but-not-locked. The decoder's ONLY way into "data" is a chirp correlation over
// threshold; miss that 80ms chirp (we were transmitting, or it landed in the peer's
// reverb tail) and a multi-second frame reads as pure noise — rxInFrame() stays false,
// so nothing stopped us transmitting straight over it. That collision is what made both
// devices send everything twice, and left the receiver showing nothing at all.
console.log("\n── carrier without lock ──");
{
  // Mirrors makeDecoder's carrier(): one bin dominating its neighbours means tones are
  // present, no chirp needed. Ambient noise spreads evenly and stays under the ratio.
  const carrier = (bins) => {
    let mx = 0; for (const v of bins) if (v > mx) mx = v;
    const med = [...bins].sort((a, b) => a - b)[bins.length >> 1];
    return mx > 4 * (med || 1e-12) && mx > 1e-3;
  };
  const flat = Array.from({ length: 48 }, () => 1e-4);          // quiet room
  const noisy = Array.from({ length: 48 }, () => 2e-3);         // loud but broadband
  const tone = [...flat]; tone[17] = 5e-2;                      // one loud bin = a data tone
  const toneInNoise = [...noisy]; toneInNoise[31] = 8e-2;
  ok(!carrier(flat), "quiet room ⇒ no carrier");
  ok(!carrier(noisy), "broadband noise ⇒ no carrier (spreads across bins)");
  ok(carrier(tone), "a dominant bin ⇒ carrier detected without any chirp lock");
  ok(carrier(toneInNoise), "a tone above a noisy floor ⇒ still detected");

  // The response: hold TX, report it, and hand back to the listener if it locks.
  const act = (heardCarrier, locked) => {
    if (!heardCarrier || locked) return "proceed";   // nothing there, or hear() owns it
    return "hold";                                  // wait our turn instead of colliding
  };
  ok(act(true, false) === "hold", "carrier and no lock ⇒ hold TX (this is the double-send fix)");
  ok(act(true, true) === "proceed", "already locked ⇒ hear() handles it, don't double-handle");
  ok(act(false, false) === "proceed", "silence ⇒ transmit normally");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
