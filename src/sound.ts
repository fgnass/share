import {
  playFrame, listenFor, stopAudio, setUltrasound, resetAuto, abortAuto,
  isOffer, isAnswer, isAck, isGot, ACK, GOT, rxBand, txBand, withEchoCapture, rxInFrame, rxEtaMs, rxCarrier,
} from "./music";
import { b64u, decode, withType, freshNonce, linkFor } from "./webrtc";
import * as C from "./conn";
import * as S from "./state";

// This route's own handshake state. Nothing outside this file reads it — the QR
// route has no roles at all, and the shared core only knows about datachannels.
let myNonce = freshNonce();
let role: "offerer" | "answerer" | null = null;
let committed = false, applied = false;
let neg: C.Neg | null = null;                 // our single negotiation
let myCode: string | null = null;             // what we last transmitted (echo suppression)
let myAudio: Uint8Array | null = null;        // that code as an audio frame
const setStatus = (text: string, dot = "wait") => (S.pairStatus.value = { text, dot });

// ── Sound pairing: directed half-duplex ─────────────────────────────────────
// The opposite trade-off from the QR route (see qr.ts). Audio is a SHARED medium:
// two devices transmitting long frames at once collide and neither decodes. So
// this route cannot race — exactly one device may talk at a time, which means the
// roles must be agreed BEFORE any code is sent. That is what the nonces are for,
// and why all the role machinery lives here and nowhere else.
//
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
//
// The mic stays open for the WHOLE session (music.ts's persistent rx): listens
// consume a queue, so there is never a deaf gap between two listens and a chirp
// can't slip by while we re-open the mic. Consequences here: we may decode our
// own transmissions (hear() drops those echoes), and before sending anything
// long we check rxInFrame() so we don't talk over a frame that's coming in.
// ── This route's handshake ──
// Mint our offer. Sound sends its code as audio, so we keep the packed bytes too.
async function mintOffer() {
  C.dropAllBut(null); C.untrackAll();
  applied = false;
  neg = await C.makeOffer(myNonce, C.wireChannel);
  C.track(neg);
  myCode = neg.code; myAudio = withType(0x6f, neg.packed);
  S.myLink.value = linkFor("o", myCode);
  role = "offerer";
}

// Build our answer to their offer. This DOES discard our own offer — correct here,
// because roles were agreed first: the peer knows it is the offerer and is waiting
// for exactly this reply. (The QR route keeps both alive; it has no such agreement.)
async function buildAnswer(code: string): Promise<boolean> {
  C.dropAllBut(null); C.untrackAll();
  applied = false;
  try {
    neg = await C.makeAnswer(code, myNonce, C.wireChannel);
  } catch (e) {
    slog("buildAnswer failed", e);
    setStatus("Invalid or expired code", "err");
    return false;
  }
  C.track(neg);
  myCode = neg.code; myAudio = withType(0x61, neg.packed);
  S.myLink.value = linkFor("a", myCode);
  role = "answerer"; committed = true;
  slog("answer ready", { bytes: myAudio.length });
  return true;
}

// Apply the answer to our offer — the exchange is complete, WebRTC takes over.
async function applyAnswer(code: string) {
  if (applied || !neg) return;
  try {
    await neg.pc.setRemoteDescription({ type: "answer", sdp: decode(code).sdp } as any);
  } catch (e) {
    slog("applyAnswer failed", e);
    return;
  }
  applied = true; committed = true;
  slog("answer applied — connecting");
}

// A decoded frame carrying a peer code. Unlike the QR route there is no ambiguity
// about what to do with it: roles are already settled, so an offer can only arrive
// at the designated answerer and an answer only at the offerer.
async function heardCode(type: "o" | "a", code: string) {
  if (code === myCode) return;
  if (type === "a") { await applyAnswer(code); return; }
  if (role === "answerer" && committed) return;   // already answering this exchange
  await buildAnswer(code);
}

let autoRunning = false, bandMatched = false, ackTick = 0;

// ── Sound pairing state machine ─────────────────────────────────────────────
// A real state machine: ONE `st` variable holding ONE of eight states, and a `go()`
// that only permits declared transitions. The previous version derived a state from ten
// independent booleans — 1024 combinations of which 8 were legal — and every bug came
// from an illegal one (roles resolved while nothing was being sent, "both descriptions"
// true on one side only). Deriving state from a bit-soup is not a state machine.
//
// The machine models the PROTOCOL, which is genuinely asymmetric: one device offers and
// waits for a reply, the other answers and waits for the link. The RAIL is a separate
// projection onto steps that are identical on both devices (see RAIL below), so the two
// can hold different internal states and still show the same step.
//
//   checking     no audio proven yet
//   finding      audio works, peer not heard
//   negotiating  peer heard, who-offers not settled
//   offering     I offer; offer not yet acknowledged        ─┐ role fork
//   answering    I answer; reply not yet sent               ─┘
//   waitingReply my offer is out, awaiting their reply      ─┐ rejoins
//   waitingLink  my reply is out, awaiting the datachannel  ─┘
//   linked       datachannel open                            (terminal)
//   failed       audio unavailable                           (terminal)
type St =
  | "checking" | "finding" | "negotiating"
  | "offering" | "answering" | "waitingReply" | "waitingLink"
  | "linked" | "failed";

// Declared transitions. Anything absent is illegal and is refused with a log rather
// than silently corrupting the display. `failed` and `linked` are reachable from
// anywhere (audio can die, and the datachannel can open before we notice our own send).
const NEXT: Record<St, St[]> = {
  checking:     ["finding", "negotiating", "linked", "failed"],
  finding:      ["negotiating", "linked", "failed"],
  negotiating:  ["offering", "answering", "linked", "failed"],
  offering:     ["waitingReply", "answering", "linked", "failed"],  // role can flip on a tiebreak
  answering:    ["waitingLink", "offering", "linked", "failed"],
  waitingReply: ["answering", "offering", "linked", "failed"],      // re-offer / role flip
  waitingLink:  ["offering", "answering", "linked", "failed"],      // resend if the reply was missed
  linked:       [],
  failed:       [],
};

// What the user is doing right now, within a state. Momentary and orthogonal to `st`:
// a device in `offering` is either mid-transmission or between attempts.
type Doing =
  | { t: "idle" }
  | { t: "tx"; frac: number | null }          // transmitting our own frame
  | { t: "rx"; frac: number }                 // receiving a frame we locked onto
  | { t: "hearing" };                         // tones audible, no lock → no length known

let st: St = "checking";
let doing: Doing = { t: "idle" };
let running = false;

// Audio-capability evidence. Deliberately NOT part of `st`: it answers "does this
// device's audio work", which is orthogonal to protocol progress, and it is only ever
// *reported* in the `checking` state.
let micDead = false;
let spoke = false;                            // we have conclusively transmitted
const echo: Record<string, { heard: number; missed: number }> =
  { ultrasound: { heard: 0, missed: 0 }, audible: { heard: 0, missed: 0 } };
const heardOn = (b: string) => echo[b].heard > 0;
const totalMissed = () => echo.ultrasound.missed + echo.audible.missed;

// Give up on ultrasound only with positive evidence the problem is ultrasound-specific:
// several US misses AND a confirmed audible round-trip. US self-echo is marginal (~2/5
// on real hardware) even when peer-to-peer ultrasound works, so misses alone prove
// nothing about the band.
const US_MISSES_BEFORE_FALLBACK = 3;
const ultrasoundHopeless = () =>
  !heardOn("ultrasound") && echo.ultrasound.missed >= US_MISSES_BEFORE_FALLBACK
  && heardOn("audible");

// The volume hint belongs to ONE state. Not a predicate consulted from anywhere: once we
// leave `checking` it is unreachable, which is why it can no longer pop up mid-send.
// Hysteresis because beacons fire on ~55% of rounds and US self-echo is ~2/5, so one or
// two early misses are routine; a silent speaker misses every single time.
const MIN_MISSES_BEFORE_HINT = 3;
const volumeLow = () =>
  st === "checking" && spoke && !micDead
  && !heardOn("ultrasound") && !heardOn("audible")
  && totalMissed() >= MIN_MISSES_BEFORE_HINT;

// ── Projection: state → rail ────────────────────────────────────────────────
// The rail deliberately collapses the role fork so BOTH devices show the same step:
// offering and answering are both "the offer/reply exchange has begun", and both waits
// are "my half is out". Only `linked`, which both devices learn together, reaches Done.
const RAIL: Record<St, S.SoundStep> = {
  checking: "check",
  finding: "find",
  negotiating: "find",
  offering: "offer",
  answering: "offer",
  waitingReply: "reply",
  waitingLink: "reply",
  linked: "done",
  failed: "check",
};

// ── Projection: state → status line ─────────────────────────────────────────
// `doing` wins when something is actually in the air, because that is the most specific
// truth. Offer/reply wording only exists in states that are reachable only AFTER roles
// are settled, so it can never leak into discovery.
function say(): string {
  if (st === "failed") return "Audio/mic unavailable on this device.";
  if (doing.t === "hearing") return "Hearing the other device…";
  if (doing.t === "tx") {
    return st === "offering" ? "Sending offer…"
      : st === "answering" ? "Sending reply…"
      : "Saying hello…";                      // a beacon, pre-roles
  }
  if (doing.t === "rx") {
    // What's arriving is the counterpart of what we sent.
    return st === "waitingReply" ? "Receiving reply…"
      : st === "waitingLink" ? "Receiving offer…"
      : "Receiving code…";
  }
  switch (st) {
    case "checking":
      return micDead ? "Can't hear the mic — check microphone access for this site."
        : volumeLow() ? "Turn the volume up — this device can't hear itself."
        : "Checking speaker & mic…";
    case "finding": return "Looking for the other device…";
    case "negotiating": return "Working out who sends…";
    case "offering": return "Ready to send offer…";
    case "answering": return "Ready to send reply…";
    case "waitingReply": return "Waiting for their reply…";
    case "waitingLink": return "Connecting…";
    case "linked": return "Connected";
  }
}

// The ONLY writer of sound-flow UI signals.
function render() {
  if (!running) return;
  S.audioStep.value = RAIL[st];
  S.audioStatus.value = say();
  S.audioTrouble.value = st === "checking" && (micDead || volumeLow());
  S.audioIndeterminate.value = doing.t === "hearing";
  S.audioProgress.value = doing.t === "tx" ? doing.frac : doing.t === "rx" ? doing.frac : null;
}

// Attempt a transition. Illegal moves are refused, not applied — so a stray call can no
// longer put the display into a state the protocol never reached.
function go(to: St) {
  if (to === st) return;
  if (!NEXT[st].includes(to)) { slog(`illegal transition ${st} → ${to} (ignored)`); return; }
  slog(`state ${st} → ${to}`);
  st = to;
  doing = { t: "idle" };      // a new state starts quiet; callers set `doing` as they act
  render();
}
const setDoing = (d: Doing) => { doing = d; render(); };
// Record capability evidence (never a state change) and re-render.
const evidence = (patch: () => void) => { patch(); render(); };

function soundBusyUI(on: boolean) {
  S.audioBusy.value = on;
  if (on) return;
  // A run that reached `linked` SUCCEEDED — leave the rail on Done rather than snapping
  // back to Check, which reads as "it gave up". Any other ending resets to the control.
  const succeeded = st === "linked";
  st = "checking"; doing = { t: "idle" }; running = false;
  micDead = false; spoke = false;
  for (const b of Object.keys(echo)) echo[b] = { heard: 0, missed: 0 };
  S.audioProgress.value = null;
  S.audioTrouble.value = false;
  S.audioIndeterminate.value = false;
  if (succeeded) { S.audioStep.value = "done"; S.audioStatus.value = "Connecting…"; }
  else { S.audioStep.value = "check"; S.audioStatus.value = "Pair by sound"; }
}
export function stopSoundAuto() { autoRunning = false; abortAuto(); soundBusyUI(false); }

const rand = (min: number, span: number) => min + Math.floor(Math.random() * span);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Verbose handshake logging (?debug or ?loopback). Prefixed with our nonce so two
// tabs' logs are easy to tell apart in one console. Also kept in a ring buffer
// (slogBuf) so automated tests can read the trace back out via CDP.
export const slogBuf: string[] = [];
const slog = (...a: any[]) => {
  if (!S.debug && !S.loopbackMode) return;
  console.log(`%c[sound ${myNonce}]`, "color:#6ea8ff;font-weight:bold", ...a);
  slogBuf.push(`${(performance.now() / 1000).toFixed(1)} ${a.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ")}`);
  if (slogBuf.length > 400) slogBuf.shift();
};
const ackFrame = () => new Uint8Array([ACK, (myNonce >> 8) & 255, myNonce & 255]);
const gotFrame = () => new Uint8Array([GOT, (myNonce >> 8) & 255, myNonce & 255]);
const ctlNonce = (f: Uint8Array) => (f[1] << 8) | f[2]; // ACK/GOT payload = [type, nonceHi, nonceLo]
const codeOf = (f: Uint8Array) => b64u(f.subarray(1));
const peerNonceOf = (code: string): number | null => { try { return decode(code).nonce; } catch { return null; } };
const alive = () => autoRunning && !C.isEntered();
// Decoding anything at all proves the mic works, and pins the band we heard it on.
function matchBand() {
  micDead = false;
  if (st === "checking") go("finding");
  if (st === "finding") go("negotiating");
  if (S.bandMode.value === "auto") { setUltrasound(rxBand() === "ultrasound"); bandMatched = true; }
}
// Which band to beacon in. Ultrasound is the default and we STAY there: it is
// inaudible to most adults, so a wrong guess is usually cheap (note: children and
// teenagers often DO hear 15–18 kHz, which is why the band is user-overridable and
// why we don't beacon more than we must), whereas audible beacons are
// loud and genuinely unpleasant at close range. We leave it only on positive
// evidence that this device can't hear its own ultrasound but CAN hear lower
// frequencies (ultrasoundHopeless) — a device-specific verdict, not a reaction to
// one unlucky echo.
//
// The earlier version alternated bands every round and forced audible whenever the
// last frame wasn't self-heard. Both were wrong: ultrasound self-echo is marginal
// on real hardware (measured 2/5 on a MacBook Air) even when peer-to-peer
// ultrasound works fine, so devices bailed to audible almost immediately and then
// blasted each other at full volume without connecting.
//
// While we're still gathering evidence we drop into audible only occasionally (every
// 4th beacon), which is enough to learn "audible round-trips on this hardware"
// without turning discovery into a siren. Once a received frame locks the band
// (matchBand) this stops mattering.
function pickTxBand(i: number) {
  if (S.bandMode.value !== "auto" || bandMatched) return;
  if (ultrasoundHopeless()) { setUltrasound(false); return; }   // settled: audible from here on
  // Otherwise stay on ultrasound, but sample audible every 4th round while we still
  // lack the comparison ultrasoundHopeless() needs. Sampling — not switching: even
  // when nothing has been heard at all, at most 1 beacon in 4 is audible. Making
  // that case go fully audible (an earlier version did) turns a run of unlucky
  // ultrasound echoes into a continuous siren, which is exactly the complaint.
  const needAudibleEvidence = !heardOn("audible") && !heardOn("ultrasound");
  setUltrasound(!(needAudibleEvidence && i % 4 === 3));
}
const heardStr = (f: Uint8Array | null) => f ? (isAck(f) ? `ACK ${ctlNonce(f)}` : isGot(f) ? `GOT ${ctlNonce(f)}` : isOffer(f) ? "OFFER" : isAnswer(f) ? "ANSWER" : `0x${f[0].toString(16)}`) : "nothing";

// Listen via the persistent receiver, discarding echoes of our own frames (the
// mic stays open while we transmit, so we decode ourselves too).
async function hear(ms: number, onProgress?: (f: number) => void): Promise<Uint8Array | null> {
  const end = performance.now() + Math.max(0, ms);
  for (;;) {
    const left = end - performance.now();
    if (left <= 0 || !alive()) return null;
    const f = await listenFor(Math.max(60, left), onProgress);
    if (!f) return null;
    // Decoding ANYTHING proves the mic works — peer's frame or our own echo, it
    // doesn't matter, because mic health is a property of the receiver alone. Latch
    // it here, the one place every decode passes through. That also clears the Check
    // step: we demonstrably have working audio.
    micDead = false;
    if (st === "checking") go("finding");
    const own = (isAck(f) || isGot(f)) ? ctlNonce(f) === myNonce : codeOf(f) === myCode;
    if (!own) { if (st === "finding") go("negotiating"); return f; }
    // Our own frame came back through the room: the speaker works on that band too.
    // (sendHeard's shadow decoder is the primary path; a long transmission can also
    // land here if the echo finishes decoding after playFrame's reset.)
    const b = rxBand(); evidence(() => { if (b && echo[b]) echo[b].heard++; });
    slog("own echo ignored", heardStr(f));
  }
}

// Latch end-to-end proof that our sound reached the peer. Only GOT/ANSWER qualify;
// once set it is never cleared, and it retires the volume hint even if self-echo
// failed (e.g. a marginal band that round-trips only sometimes).


// Progress callback for a listen: report a frame WHILE it arrives, not only once it
// decodes. A code frame is several seconds of air time, so without this the receiving
// device sat on "Check" showing nothing — looking stuck — for the whole transfer, while
// the sender had already moved on. Any frame arriving is also proof our own mic works,
// which is exactly what the Check gate asks.
//
// Only long frames get narrated: beacons are 3 bytes and finish almost immediately, so
// announcing a code transfer for one would flash a message that's both wrong and gone
// before it can be read. rxEtaMs() is the decoder's own estimate of the time remaining
// in the frame it locked onto.
// A frame is arriving. Any decode proves the mic, so that fact is recorded regardless;
// only a LONG frame is narrated, because a 3-byte beacon completes almost instantly and
// would flash a message gone before it can be read.
// A frame is arriving. Any decode proves the mic, so leave `checking` immediately; only
// a LONG frame is narrated, because a 3-byte beacon finishes before a label can be read.
const receiving = () => (frac: number) => {
  micDead = false;
  if (st === "checking") go("finding");
  if (rxEtaMs() > 900) setDoing({ t: "rx", frac }); else render();
};

// Wait out a frame we can HEAR but couldn't decode. Missing the 80 ms sync chirp (we
// were transmitting, or it arrived inside the peer's own reverb tail) leaves the
// decoder in "search" for the whole multi-second frame — so rxInFrame() is false and
// nothing stops us talking straight over it. That collision is what made both devices
// send everything twice. Staying quiet until the carrier clears turns it into an
// orderly turn instead, and meanwhile we can honestly say we hear them.
async function waitOutCarrier(): Promise<boolean> {
  if (S.loopbackMode) return false;
  const band = rxCarrier();
  if (!band || rxInFrame()) return false;    // nothing there, or already locked (hear() handles it)
  slog("carrier without lock — holding TX", { band });
  micDead = false;
  if (st === "checking") go("finding");
  setDoing({ t: "hearing" });
  // Bounded: a stuck "carrier" (a fan, a tone in the room) must not deadlock us.
  const until = performance.now() + 6000;
  while (alive() && performance.now() < until && rxCarrier() && !rxInFrame()) {
    await sleep(120);
  }
  setDoing({ t: "idle" });
  // If it turned into a real frame, let the caller listen for it properly.
  return alive() && rxInFrame();
}


// Transmit a frame while shadow-capturing the mic, and fold the result into the
// capability evidence. This is the ONLY capability test: every frame we send is
// also a check that our speaker works, so there is no separate probe phase.
async function sendHeard(payload: Uint8Array, onprogress?: (f: number) => void) {
  const band = txBand();
  const { heard, micDead: dead, inconclusive } = await withEchoCapture(payload, () => playFrame(payload, { onprogress }));
  // An inconclusive attempt tells us NOTHING: no sound was emitted (suspended
  // AudioContext — routine on mobile whenever the page backgrounds or the screen
  // dims) or we were torn down mid-frame. Counting those as misses is what made a
  // phone with perfectly good audio drift into "Turn the volume up" after a while:
  // each phantom miss accumulated even though the real checks had passed.
  if (inconclusive) { slog("self-heard inconclusive — not counted", { band }); return; }
  evidence(() => {
    spoke = true;
    // Tally per band: the fallback decision is comparative (see ultrasoundHopeless).
    if (heard) echo[band].heard++; else echo[band].missed++;
    micDead = heard ? false : dead && !heardOn(band) && !heardOn("ultrasound") && !heardOn("audible");
  });
  // Hearing our own frame proves the audio path, so the check is done.
  if (heard && st === "checking") go("finding");
  // A decode of our own echo is still a decode: it proves the mic works too. And
  // once micOk has ever latched, a dead-looking capture can't be a mic problem —
  // we demonstrably heard something before, so don't send the user chasing
  // permissions. Report it as "not heard" (a speaker/volume question) instead.
  slog("self-heard", { band, heard, micDead, rawMicDead: dead, echo });
}

// Entry: prepare this route (mint the offer we may transmit) and run the loop.
export async function start() {
  S.pairIntro.value = "Hold the devices near each other. They exchange a code by sound — one talks at a time. Data goes straight between the devices. Nothing is uploaded.";
  await mintOffer();
}

export async function soundAuto() {
  if (autoRunning) return;
  autoRunning = true; resetAuto(); soundBusyUI(true);
  bandMatched = false; ackTick = 0;
  st = "checking"; doing = { t: "idle" };
  micDead = false; spoke = false;
  for (const b of Object.keys(echo)) echo[b] = { heard: 0, missed: 0 };
  running = true; render();
  slog("soundAuto start", { role, myNonce, band: S.bandMode.value, loopback: S.loopbackMode });
  // No probe phase: we go straight to discovery, and the first beacon doubles as the
  // capability test. If a peer answers it we never pay for a self-check at all.
  if (S.loopbackMode) bandMatched = true;                                  // no bands over loopback
  else if (S.bandMode.value !== "auto") { setUltrasound(S.bandMode.value === "ultrasound"); bandMatched = true; }
  if (!alive()) { autoRunning = false; soundBusyUI(false); return; }

  let peerNonce: number | null = null;
  // Route one heard frame into the handshake; returns what it was. hear() has
  // already dropped our own echoes, so anything here is genuinely the peer's.
  const route = (f: Uint8Array | null): "answer" | "offer" | "got" | "ack" | null => {
    if (!f) return null;
    // An ANSWER or GOT can only exist because the peer decoded something we sent, so
    // either one is causal proof our speaker reached them — strictly better evidence
    // than self-echo, which only proves speaker→own-mic. An OFFER or ACK proves
    // nothing about our TX: both are sent unprompted (and an ACK during our offer
    // means the peer was transmitting and CANNOT have heard us).
    if (isAnswer(f)) { matchBand(); void heardCode("a", codeOf(f)); return "answer"; }
    if (isOffer(f)) { matchBand(); if (peerNonce === null) peerNonce = peerNonceOf(codeOf(f)); void heardCode("o", codeOf(f)); return "offer"; }
    // GOT proves the peer decoded our offer, so our half is delivered and we are now
    // simply waiting for their reply.
    if (isGot(f)) { matchBand(); if (peerNonce === null) peerNonce = ctlNonce(f); go("waitingReply"); return "got"; }
    if (isAck(f)) { matchBand(); if (peerNonce === null) peerNonce = ctlNonce(f); return "ack"; }
    return null;
  };
  try {
    // ── PHASE 1: DISCOVERY ── learn the peer's nonce via short beacons only.
    // Each beacon is also the capability test (see sendHeard), so the verdict is
    // always as fresh as the last frame we sent — no re-probe schedule to maintain,
    // and turning the volume up clears the hint on the very next beacon.
    while (alive() && !committed && peerNonce === null) {
      setDoing({ t: "idle" });   // status is derived from the state
      const f = await hear(rand(2500, 2500), receiving());
      setDoing({ t: "idle" });
      if (!alive()) break;
      slog("discover heard", heardStr(f));
      if (f) route(f);
      else if (Math.random() < 0.55) { // beacon only some rounds → breaks lockstep
        // Two devices started together tend to beacon in sync and collide forever
        // (their chirps overlap → neither syncs). Skipping the beacon ~45% of the
        // time, plus the randomized listen window and a wide pre-beacon jitter,
        // desyncs them within a few rounds.
        await sleep(rand(0, 900));
        if (!alive() || rxInFrame()) continue; // a frame started while we dawdled → listen instead
        if (await waitOutCarrier()) continue;  // hearing them but not locked → let them finish
        if (!alive()) break;
        pickTxBand(ackTick++);
        slog("discover beacon");
        setDoing({ t: "tx", frac: null });
        await sendHeard(ackFrame());
        setDoing({ t: "idle" });
      } else slog("discover listen-only round");
    }
    // Roles are settled: fork on who offers. This is the ONLY way into offering/answering,
    // which is why offer/reply wording can never appear before negotiation is done.
    if (peerNonce !== null) go(role === "offerer" && myNonce > peerNonce ? "offering" : "answering");
    if (peerNonce !== null) slog(`role resolved: ${myNonce > peerNonce ? "OFFERER" : "answerer"} (peer ${peerNonce})`);

    // ── PHASE 2: DIRECTED EXCHANGE ──
    // Offerer = higher nonce and still holding an offer. The lower-nonce device is
    // the answerer, but can only build its answer once it has received the offer.
    const iAmOfferer = () => role === "offerer" && (peerNonce === null || myNonce > peerNonce);
    // Don't start a long transmission over a frame that's mid-air — take it first.
    const politeWait = async () => {
      if (!rxInFrame()) return false;
      slog("incoming frame — holding TX");
      const f = await hear(rxEtaMs() + 1500);
      slog("held for", heardStr(f));
      return !!route(f);
    };
    while (alive()) {
      if (iAmOfferer()) {
        if (applied) { await hear(rand(4000, 2000)); continue; } // answer applied → just wait for connect
        if (await politeWait()) continue;
        if (!alive()) break;
        // Turn-around guard: we often get here right after decoding the peer's
        // frame — let their speaker tail/reverb die down so our sync chirp
        // doesn't land in it (that's how offers get missed at close range).
        await sleep(rand(200, 200));
        if (!alive() || rxInFrame()) continue;
        if (await waitOutCarrier()) continue;   // audible frame we can't decode → wait our turn
        if (!alive()) break;
        slog("send OFFER");
        go("offering");
        setDoing({ t: "tx", frac: 0 });
        await sendHeard(myAudio!, (frac) => setDoing({ t: "tx", frac }));
        setDoing({ t: "idle" });
        if (alive()) go("waitingReply");
        if (!alive()) break;
        // One long listen; GOT means the answer (itself several seconds of air
        // time) is under way → extend rather than barge in with a re-offer. An
        // ACK means the peer was transmitting during our offer, i.e. it can't
        // have received it → re-offer right away.
        let until = performance.now() + rand(7000, 2000);
        while (alive() && !applied && performance.now() < until) {
          const f = await hear(until - performance.now(), receiving());
          setDoing({ t: "idle" });
          if (!alive()) break;
          slog("offerer heard", heardStr(f));
          const r = route(f);
          if (r === "got") until = performance.now() + 15000;    // answer imminent → keep listening
          else if (r !== null || !f) break;                      // handled / tiebreak / peer offerless / silence → re-offer
        }
      } else if (role === "answerer" && isAnswer(myAudio)) {
        // Answer is built → tell the offerer to stop offering, then send the answer.
        if (await politeWait()) continue;
        if (!alive()) break;
        await sleep(rand(200, 200)); // turn-around guard (see the offer send)
        if (!alive() || rxInFrame()) continue;
        if (await waitOutCarrier()) continue;   // audible frame we can't decode → wait our turn
        if (!alive()) break;
        slog("send GOT + ANSWER");
        await sendHeard(gotFrame());
        if (!alive()) break;
        go("answering");
        setDoing({ t: "tx", frac: 0 });
        await sendHeard(myAudio!, (frac) => setDoing({ t: "tx", frac }));
        setDoing({ t: "idle" });
        if (!alive()) break;
        // Our reply is out. The offerer only has both halves once it lands, and "WebRTC
        // connecting is the real ack" — so this is NOT Done; only `linked` is.
        if (alive()) go("waitingLink");
        // Brief listen; silence or a re-heard offer both mean our answer may have
        // missed → the loop resends. WebRTC connecting is the real ack.
        const f = await hear(rand(3500, 2000));
        slog("answerer post-answer heard", heardStr(f));
        route(f);
      } else {
        // Designated answerer without the offer yet (or answer still building).
        // Mostly listen for the offer (our own beacon would clobber the offer's
        // chirp). Beacon only occasionally — just enough that an offerer still in
        // discovery can hear us — otherwise stay quiet and catch the offer.
        // buildAnswer is in flight (route → heardCode runs async):
        // poll in short slices so the GOT+ANSWER goes out the moment it's ready,
        // instead of sitting deaf-to-our-own-state through a long listen.
        const building = role === "answerer";
        if (!building && !rxInFrame() && Math.random() < 0.3) {
          pickTxBand(ackTick++);
          slog("answerer beacon");
          setDoing({ t: "tx", frac: null });
          await sendHeard(ackFrame());
          setDoing({ t: "idle" });
          if (!alive()) break;
        }
        const f = await hear(building ? 500 : rand(6000, 3000), receiving());
        setDoing({ t: "idle" });
        if (!alive()) break;
        if (f) slog("answerer heard", heardStr(f));
        if (route(f) === "ack" && !rxInFrame()) {
          // Peer is still in discovery — it hasn't heard us. Answer promptly so
          // it resolves roles now rather than waiting out our sparse beacons.
          await sleep(rand(150, 250));
          if (!alive() || rxInFrame()) continue;
          pickTxBand(ackTick++);
          slog("ack-reply beacon");
          await sendHeard(ackFrame());
        }
      }
    }
  } catch (e) { slog("error", e); go("failed"); }
  autoRunning = false; soundBusyUI(false);
}
