// ── QR pairing: embrace the race ─────────────────────────────────────────────
// Both devices show an offer and both scan. When we see their offer we build an
// answer to it — WITHOUT discarding our own offer. Two negotiations then run
// concurrently and the first datachannel to open wins (conn.wireChannel adopts
// it and closes the other).
//
// This is why there is no nonce tiebreak here, and no roles. The old code picked
// a winner up front by comparing nonces, which meant the loser tore down its own
// offer — and since BOTH devices scan, each one independently decided it was the
// loser or the winner and then displayed instructions describing the *other*
// device's job. Racing removes the decision entirely: whoever connects first is
// the winner, discovered rather than negotiated.
//
// The sound route cannot do this — it is half-duplex, so two long transmissions
// collide and exactly one device may talk at a time. That is the whole reason
// these two routes are separate files (see conn.ts).
import jsQR from "jsqr";
import { linkFor, parseCode, freshNonce, decode } from "./webrtc";
import * as C from "./conn";
import * as S from "./state";

// The nonce stays in the wire format (the sound route arbitrates with it, and
// dropping the field would break pairing against older builds) — this route just
// never reads the peer's. Ours is random per session and only pads the packet.
const nonce = freshNonce();

let myOffer: C.Neg | null = null;     // our offer — displayed, never torn down
let myAnswer: C.Neg | null = null;    // our answer to their offer, once seen
let answeredCode: string | null = null;  // which offer myAnswer replies to
const seen = new Set<string>();       // codes already routed (a QR re-reads every frame)

const setStatus = (text: string, dot = "wait") => (S.pairStatus.value = { text, dot });

// ── What we display ──
// Always our newest code: the offer until we've answered theirs, then the answer
// (which is what they still need). Both negotiations stay alive regardless of
// which code is on screen.
function show() {
  const neg = myAnswer || myOffer;
  if (!neg) return;
  S.myLink.value = linkFor(neg.tag === "answer" ? "a" : "o", neg.code);
  S.qrUrl.value = S.method.value === "camera" ? S.myLink.value : "";
}

// One status line, derived from what exists — not set ad-hoc per branch. The old
// code wrote role-specific instructions from five call sites, which is how it
// ended up telling you to scan on the device that had nothing left to scan.
function say() {
  if (C.isEntered()) return setStatus("Connected", "ok");
  if (myAnswer) setStatus("Reply ready — keep both codes facing each other.");
  else setStatus("Point the devices at each other.");
}

// ── Scanning ──
let stream: MediaStream | null = null, scanning = false;
export async function startCamera(video: HTMLVideoElement) {
  if (scanning) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .catch(() => navigator.mediaDevices.getUserMedia({ video: true }));
    video.srcObject = stream;
    // Mirror only for a front (user-facing) camera. We ask for the back camera but
    // fall back to any camera, so trust the resolved track: on desktop the fallback
    // lands on the user-facing webcam (mirror), on mobile we usually get
    // "environment" (don't mirror). Absent facingMode, assume user-facing.
    const facing = stream.getVideoTracks()[0]?.getSettings().facingMode;
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
      if (parsed) void onScan(parsed);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
export function stopCamera() {
  scanning = false;
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}

// ── The whole handshake ──
// Their offer  → build an answer to it (keeping ours alive).
// Their answer → apply it to our offer.
// Both can happen on one device; whichever completes first wins the race.
async function onScan(parsed: { type: string; code: string }) {
  if (C.isEntered()) return;
  // Our own code reflected back off their screen, or a frame we already routed.
  if (parsed.code === myOffer?.code || parsed.code === myAnswer?.code) return;
  if (seen.has(parsed.code)) return;
  seen.add(parsed.code);

  if (parsed.type === "o") {
    // A *different* offer than the one we answered means their code was
    // regenerated (e.g. they turned STUN on) — answer the new one.
    if (answeredCode === parsed.code) return;
    try {
      answeredCode = parsed.code;
      myAnswer = await C.makeAnswer(parsed.code, nonce, C.wireChannel);
      C.track(myAnswer);
      show(); say();
      armWatch();
    } catch (e) {
      console.error("[share] could not answer their offer", e);
      answeredCode = null; seen.delete(parsed.code);
      setStatus("Invalid or expired code", "err");
    }
    return;
  }

  // An answer — it replies to the offer we're showing.
  if (!myOffer) return;
  try {
    await myOffer.pc.setRemoteDescription({ type: "answer", sdp: decodeSdp(parsed.code) } as any);
    armWatch();
    say();
  } catch (e) {
    console.error("[share] could not apply their answer", e);
    seen.delete(parsed.code);   // let the same QR be retried on a later frame
    setStatus("Couldn't read their reply. Keep the codes in view.", "err");
  }
}

// decode() returns {type, sdp, nonce}; we only want the SDP here — the type is
// already known from the URL prefix and the nonce is the sound route's business.
function decodeSdp(code: string): string { return decode(code).sdp; }

// ── Direct-connection watchdog ──
// Once both halves are exchanged a real attempt is underway; on a LAN it lands in
// well under a second. If nothing connects, the devices are probably on different
// networks and need STUN. Armed by whichever half completed — either negotiation
// reaching this point means an exchange is live.
let timer: ReturnType<typeof setTimeout> | null = null;
function clearWatch() { if (timer) { clearTimeout(timer); timer = null; } }
function armWatch() {
  clearWatch();
  timer = setTimeout(() => {
    timer = null;
    if (C.isEntered()) return;
    if (!S.useStun.value) S.stunPrompt.value = true;
    else setStatus("Still couldn't connect. The networks may block direct links.", "err");
  }, 9000);
}

// User confirmed "retry across networks": turn STUN on and rebuild both halves.
// Our new offer carries a reflexive candidate, so the peer answers that instead.
export async function retryWithStun() {
  S.stunPrompt.value = false;
  if (S.useStun.value) return;
  S.useStun.value = true;
  seen.clear(); answeredCode = null;
  C.dropAllBut(null); C.untrackAll();
  myAnswer = null; myOffer = null;
  await start();
}

// ── Entry ──
export async function start() {
  S.pairIntro.value = "Point the two devices at each other. Each shows a code and reads the other's. Data goes straight between the devices. Nothing is uploaded.";
  S.camOn.value = S.method.value === "camera";
  myOffer = await C.makeOffer(nonce, C.wireChannel);
  C.track(myOffer);
  show(); say();
}

// Pasted or opened as a link (#o=…): we only answer, there is no race to run
// because we never showed an offer they could scan.
export async function startFromCode(code: string) {
  S.pairIntro.value = "Almost there. Show this reply code to the other device, or send it back the same way you got their code.";
  S.camOn.value = false;
  try {
    answeredCode = code;
    myAnswer = await C.makeAnswer(code, nonce, C.wireChannel);
    C.track(myAnswer);
    show(); say(); armWatch();
  } catch (e) {
    console.error("[share] invalid offer code", e);
    setStatus("Invalid or expired code", "err");
  }
}

// A pasted/typed code. Same two cases as a scan, minus the reflection guard —
// nobody pastes their own code by accident, and if they do the decode is harmless.
export async function acceptPasted(parsed: { type: string; code: string }) {
  seen.delete(parsed.code);
  await onScan(parsed);
}

// The #a= handoff tab posts the answer SDP here when the user opened an answer
// link in a second tab instead of scanning it. Applies to our live offer.
export function wireHandoff(bc: BroadcastChannel) {
  bc.onmessage = (e) => {
    if (e.data?.type !== "answer" || !myOffer || C.isEntered()) return;
    bc.postMessage({ type: "ack" });
    void myOffer.pc.setRemoteDescription({ type: "answer", sdp: e.data.sdp } as any)
      .then(() => { armWatch(); say(); })
      .catch((err) => console.error("[share] handoff answer failed", err));
  };
}

// Dev/test hook (?debug): drive the handshake without a camera by injecting the
// peer's code, exactly as a scan would. Lets the race be tested deterministically.
if (S.debug || S.loopbackMode) {
  (globalThis as any).__qr = {
    scan: (text: string) => { const p = parseCode(text); return p ? acceptPasted(p) : null; },
    code: () => S.myLink.value,
    state: () => ({ offer: !!myOffer, answer: !!myAnswer, entered: C.isEntered() }),
    // Our offer stays valid even once we're showing an answer — the peer may still
    // scan it and win the race that way. Exposed so tests can exercise exactly that.
    offerLink: () => (myOffer ? linkFor("o", myOffer.code) : null),
  };
}

C.onEnter(() => { clearWatch(); stopCamera(); S.stunPrompt.value = false; });
