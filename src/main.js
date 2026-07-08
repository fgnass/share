import QRCode from "qrcode";
import jsQR from "jsqr";
import { createElement, Paperclip, Send, FileText, Download, QrCode, ScanLine, X, Share2, Copy, Link2, Github } from "lucide";
import "./style.css";

// ─────────── Lucide icons ───────────
const ICONS = {
  paperclip: Paperclip, send: Send, file: FileText, download: Download,
  "qr-code": QrCode, scan: ScanLine, x: X, share: Share2, copy: Copy, link: Link2, github: Github,
};
function icon(name) { return createElement(ICONS[name]); }
// Replace every <span data-icon="…"> with its SVG (once).
function mountIcons(root = document) {
  root.querySelectorAll("[data-icon]:not([data-mounted])").forEach((el) => {
    if (!ICONS[el.dataset.icon]) return;
    el.replaceChildren(icon(el.dataset.icon));
    el.dataset.mounted = "1";
  });
}
mountIcons();

// ─────────── Config ───────────
// STUN is opt-in: off by default so a local-network connection touches ZERO
// external servers. Turning it on contacts a STUN server (reveals your public
// IP to it) but enables connecting across different networks.
let useStun = localStorage.getItem("useStun") === "1";
const rtcConfig = () => ({ iceServers: useStun ? [{ urls: "stun:stun.l.google.com:19302" }] : [] });
// Per-device 16-bit tiebreaker embedded in our offer (see onScan).
let myNonce = (() => { const r = crypto.getRandomValues(new Uint8Array(2)); return (r[0] << 8) | r[1]; })();
const CHUNK = 16 * 1024;
const HIGH_WATER = 4 * 1024 * 1024, LOW_WATER = 1 * 1024 * 1024;
const bc = new BroadcastChannel("share.gnass.buzz");

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n) => n < 1024 ? n + " B"
  : n < 1048576 ? (n / 1024).toFixed(1) + " KB"
  : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB"
  : (n / 1073741824).toFixed(2) + " GB";

// ─────────── SDP compaction ───────────
// A data-channel SDP is ~90% fixed boilerplate. We ship only the variable
// fields (ice creds, DTLS fingerprint, setup role, udp host/srflx candidates)
// packed into a tiny binary blob and rebuild a full, valid SDP from a template
// on the other side. Cuts the link/QR payload from ~720 to ~170 chars.
const _enc = new TextEncoder(), _dec = new TextDecoder();
const SETUP = ["actpass", "active", "passive", "holdconn"];
const CTYPE = ["host", "srflx"]; // host = same LAN, srflx = across NATs (needs STUN)

function b64u(b) {
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(str), o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
}

// Pull the variable fields out of a real localDescription SDP.
function extract(sdp) {
  const c = [...sdp.matchAll(/a=candidate:\S+ \d+ (udp) \d+ (\S+) (\d+) typ (host|srflx)/gi)]
    .map((m) => ({ addr: m[2], port: +m[3], type: m[4] }));
  return {
    u: sdp.match(/a=ice-ufrag:(\S+)/)[1],
    p: sdp.match(/a=ice-pwd:(\S+)/)[1],
    f: sdp.match(/a=fingerprint:sha-256 (\S+)/i)[1],
    s: sdp.match(/a=setup:(\S+)/)[1],
    c,
  };
}
// Rebuild a full valid SDP from the fields (foundation/priority synthesized).
function build(x) {
  const cands = x.c.map((c, i) =>
    `a=candidate:${i + 1} 1 udp ${2113937151 - i} ${c.addr} ${c.port} typ ${c.type}`);
  return [
    "v=0", "o=- 0 0 IN IP4 0.0.0.0", "s=-", "t=0 0",
    "a=group:BUNDLE 0", "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0",
    "a=ice-ufrag:" + x.u, "a=ice-pwd:" + x.p, "a=ice-options:trickle",
    "a=fingerprint:sha-256 " + x.f, "a=setup:" + x.s, "a=mid:0",
    "a=sctp-port:5000", "a=max-message-size:262144", ...cands, "",
  ].join("\r\n");
}
// Binary pack/unpack of the extracted fields. A leading 16-bit `nonce` is a
// per-device tiebreaker: when two fresh devices scan each other's offers at the
// same time, only the lower-nonce one yields and answers — no double-answer.
function pack(x) {
  const b = [];
  const put = (s) => { const e = _enc.encode(s); b.push(e.length, ...e); };
  b.push((x.nonce >> 8) & 255, x.nonce & 255);
  b.push(Math.max(0, SETUP.indexOf(x.s)));
  put(x.u); put(x.p);
  b.push(...x.f.split(":").map((h) => parseInt(h, 16))); // 32 bytes
  b.push(x.c.length);
  for (const c of x.c) { b.push(Math.max(0, CTYPE.indexOf(c.type))); put(c.addr); b.push((c.port >> 8) & 255, c.port & 255); }
  return Uint8Array.from(b);
}
function unpack(b) {
  let i = 0;
  const get = () => { const n = b[i++]; const s = _dec.decode(b.slice(i, i + n)); i += n; return s; };
  const nonce = (b[i] << 8) | b[i + 1]; i += 2;
  const s = SETUP[b[i++]];
  const u = get(), p = get();
  const f = [...b.slice(i, i + 32)].map((x) => x.toString(16).padStart(2, "0")).join(":"); i += 32;
  const n = b[i++], c = [];
  for (let k = 0; k < n; k++) { const type = CTYPE[b[i++]]; const addr = get(); const port = (b[i] << 8) | b[i + 1]; i += 2; c.push({ type, addr, port }); }
  return { u, p, f, s, c, nonce };
}

function encode(desc) { return b64u(pack({ ...extract(desc.sdp), nonce: myNonce })); }
function decode(code) {
  const f = unpack(unb64u(code));
  return { type: f.s === "actpass" ? "offer" : "answer", sdp: build(f), nonce: f.nonce };
}
// Resolve once ICE gathering is done. Some networks (blocked STUN, VPN,
// privacy extensions) never reach "complete", so also resolve on the
// end-of-candidates signal and fall back to a timeout — host candidates
// alone are enough on a LAN.
function iceComplete(pc, timeout = 3000) {
  return new Promise((res) => {
    if (pc.iceGatheringState === "complete") return res();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onState);
      pc.removeEventListener("icecandidate", onCand);
      res();
    };
    const onState = () => { if (pc.iceGatheringState === "complete") finish(); };
    const onCand = (e) => { if (!e.candidate) finish(); };
    const timer = setTimeout(finish, timeout);
    pc.addEventListener("icegatheringstatechange", onState);
    pc.addEventListener("icecandidate", onCand);
  });
}
const linkFor = (key, code) => location.origin + location.pathname + "#" + key + "=" + code;

// Pull the role + code out of a scanned/pasted link (handles full URLs).
function parseCode(text) {
  const m = String(text).match(/[#&?](o|a)=([^&\s]+)/);
  return m ? { type: m[1], code: m[2] } : null;
}

async function share(url) {
  try { if (navigator.share) return await navigator.share({ url, title: "share.gnass.buzz" }); } catch {}
  try { await navigator.clipboard.writeText(url); alert("Link copied"); } catch {}
}

// Render a QR for `url` into a white framed box (fixed square canvas, no distortion).
async function renderQr(box, url) {
  const canvas = document.createElement("canvas");
  // 440px bitmap for crispness; low error-correction keeps a long payload scannable.
  await QRCode.toCanvas(canvas, url, { errorCorrectionLevel: "L", margin: 1, width: 440 });
  // qrcode sets an inline style width/height — override it to a fixed square so
  // the stylesheet size wins and the aspect ratio can never distort.
  canvas.style.width = canvas.style.height = "216px";
  const frame = document.createElement("div");
  frame.className = "qr-frame";
  frame.appendChild(canvas);
  box.replaceChildren(frame);
  box.dataset.url = url;
  box.classList.remove("hidden");
}
// ─────────── Live camera: runs continuously alongside the shown QR ───────────
let scanStream = null, scanning = false;
const handled = new Set(); // codes already acted on (debounce the per-frame loop)
async function startCamera(onScan) {
  if (scanning) return;
  const video = $("pairVideo");
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .catch(() => navigator.mediaDevices.getUserMedia({ video: true }));
    video.srcObject = scanStream;
    await video.play();
  } catch {
    hide("pairCam");
    document.querySelector(".fallback").open = true; // surface the link path
    setStatus("Camera unavailable", "");
    return;
  }
  scanning = true;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
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
function stopCamera() {
  scanning = false;
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
}

// ─────────── Chat room UI ───────────
const logEl = () => $("log");
function bubble(cls) {
  const el = document.createElement("div");
  el.className = "msg " + cls;
  logEl().appendChild(el);
  logEl().scrollTop = logEl().scrollHeight;
  return el;
}
function addChat(mine, text) { bubble(mine ? "mine" : "their").textContent = text; }
function addSys(text) { bubble("sys").textContent = text; }
function addFile(mine, name, size) {
  const el = bubble(mine ? "mine" : "their");
  el.innerHTML =
    `<div class="fname"></div>` +
    `<div class="fmeta"><span class="stat">${mine ? "Sending" : "Receiving"}…</span> · ${fmt(size)}</div>` +
    `<div class="bar"><i></i></div>`;
  const fname = el.querySelector(".fname");
  fname.append(icon("file"), document.createTextNode(name));
  return {
    progress: (p) => { el.querySelector(".bar>i").style.width = p + "%"; },
    done: (url, dl) => {
      el.querySelector(".bar").remove();
      const stat = el.querySelector(".stat");
      if (url) {
        stat.replaceChildren();
        const a = document.createElement("a");
        a.href = url; a.download = dl;
        a.append(icon("download"), document.createTextNode("Download"));
        stat.appendChild(a);
      } else stat.textContent = "Sent";
      logEl().scrollTop = logEl().scrollHeight;
    },
  };
}

// ─────────── DataChannel: chat + files (bidirectional) ───────────
let channel = null;
let sendQ = Promise.resolve();
let entered = false;

function setupChannel(ch) {
  channel = ch;
  ch.binaryType = "arraybuffer";
  let inc = null; // in-flight incoming file transfer
  ch.onopen = enterRoom;
  ch.onclose = () => {
    $("roomDot").className = "dot err";
    $("roomStatus").textContent = "Connection lost";
    // A closed data channel can't be revived — reconnecting means a fresh pairing.
    const btn = $("reconnect");
    btn.classList.remove("hidden");
    btn.onclick = () => location.replace(location.origin + location.pathname);
  };
  ch.onmessage = (e) => {
    if (typeof e.data === "string") {
      const m = JSON.parse(e.data);
      if (m.k === "chat") return addChat(false, m.t);
      if (m.k === "file") {
        inc = { name: m.n, size: m.s, mime: m.m, chunks: [], got: 0, h: addFile(false, m.n, m.s) };
        if (m.s === 0) { finalizeIncoming(inc); inc = null; }
      }
      return;
    }
    if (!inc) return;
    inc.chunks.push(e.data); inc.got += e.data.byteLength;
    inc.h.progress(inc.got / inc.size * 100);
    if (inc.got >= inc.size) { finalizeIncoming(inc); inc = null; }
  };
}
function finalizeIncoming(inc) {
  const blob = new Blob(inc.chunks, { type: inc.mime || "application/octet-stream" });
  inc.h.done(URL.createObjectURL(blob), inc.name);
}

function enterRoom() {
  if (entered) return; entered = true;
  stopCamera();
  ["pair", "handoff"].forEach(hide);
  show("room");
  addSys("Connected. Say hi");
  const input = $("input"), fileEl = $("file");
  const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; };
  input.addEventListener("input", grow);
  const send = () => {
    const t = input.value.trim();
    if (!t || !channel || channel.readyState !== "open") return;
    channel.send(JSON.stringify({ k: "chat", t }));
    addChat(true, t);
    input.value = ""; grow(); input.focus();
  };
  $("send").onclick = send;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $("attach").onclick = () => fileEl.click();
  fileEl.onchange = () => { sendFiles([...fileEl.files]); fileEl.value = ""; };
  input.focus();
}

function sendFiles(files) {
  for (const f of files) sendQ = sendQ.then(() => sendOne(f)).catch(console.error);
}
async function sendOne(file) {
  if (!channel || channel.readyState !== "open") return;
  const h = addFile(true, file.name, file.size);
  channel.send(JSON.stringify({ k: "file", n: file.name, s: file.size, m: file.type }));
  let sent = 0;
  for (let off = 0; off < file.size; off += CHUNK) {
    const buf = await file.slice(off, off + CHUNK).arrayBuffer();
    channel.send(buf); sent += buf.byteLength;
    h.progress(sent / file.size * 100);
    if (channel.bufferedAmount > HIGH_WATER) {
      await new Promise((res) => {
        channel.bufferedAmountLowThreshold = LOW_WATER;
        channel.addEventListener("bufferedamountlow", res, { once: true });
      });
    }
  }
  h.done(null);
}

// ─────────── Pairing flow ───────────
// Idea A: one screen shows YOUR QR and runs the camera at once — no mode
// switch. Both fresh devices start as offerers; the first to see the other's
// offer yields and answers (lower nonce wins the tiebreak), the other scans
// the resulting answer. The whole thing is "point them at each other".
let pc;
let role = null;          // "offerer" | "answerer"
let committed = false;    // decided to answer, or applied an answer, or connected
let applied = false;      // an answer has been applied to our offer
let myLink = null;        // our current QR/link URL
let lastOfferCode = null; // offer we're answering (for regenerate on toggle)

function setStatus(text, dot = "wait") { $("pairStatus").textContent = text; $("pairDot").className = "dot " + dot; }
function flash(text) { setStatus(text); }
function setStun(on) { useStun = on; localStorage.setItem("useStun", on ? "1" : "0"); }

// ─────────── Start screen + PWA install ───────────
let deferredInstall = null;
const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();          // keep our own button in charge of when to prompt
  deferredInstall = e;
  if (!isStandalone()) show("installBtn");
});
window.addEventListener("appinstalled", () => { deferredInstall = null; hide("installBtn"); });

function startStart() {
  show("start");
  $("startBtn").onclick = () => { hide("start"); startOfferer(); };
  $("howLink").onclick = () => { hide("start"); show("how"); };
  $("howBack").onclick = () => { hide("how"); show("start"); };
  $("installBtn").onclick = async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    hide("installBtn");
  };
  // iOS Safari never fires beforeinstallprompt — offer manual instructions.
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !isStandalone()) show("iosInstall");
}

if ("serviceWorker" in navigator)
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));

// ─────────── Route by URL hash ───────────
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.has("o")) startAnswerer(hash.get("o"));       // scanned their offer → show our answer
else if (hash.has("a")) startHandoff(hash.get("a"));   // same-browser answer hand-off
else startStart();                                     // fresh visit → intro screen

function wireFallback() {
  $("stunToggle").checked = useStun;
  $("stunToggle").onchange = () => {
    setStun($("stunToggle").checked);
    handled.clear();
    role === "answerer" ? buildAnswer(lastOfferCode) : mintOffer();
  };
  $("shareLink").onclick = () => share(myLink);
  $("copyLink").onclick = () => share(myLink);
  $("applyPaste").onclick = () => {
    const parsed = parseCode($("pasteCode").value);
    if (!parsed) return alert("Invalid code");
    onScan(parsed, true); // explicit paste — skip the nonce tiebreak
  };
}

// ── OFFERER: show offer QR + run the camera ──
async function startOfferer() {
  role = "offerer";
  show("pair");
  wireFallback();
  await mintOffer();
  startCamera(onScan);
}

async function mintOffer() {
  try { if (pc) pc.close(); } catch {}
  applied = false; entered = false; channel = null;
  pc = new RTCPeerConnection(rtcConfig());
  setupChannel(pc.createDataChannel("data"));
  await pc.setLocalDescription(await pc.createOffer());
  await iceComplete(pc);
  myLink = linkFor("o", encode(pc.localDescription));
  $("pairLink").textContent = myLink;
  await renderQr($("pairQr"), myLink);
  setStatus("Looking for the other device…");
  // Same-browser link handoff (see startHandoff): answer arrives over BroadcastChannel.
  bc.onmessage = (e) => {
    if (e.data.type === "answer" && role === "offerer" && !applied) {
      bc.postMessage({ type: "ack" });
      applyAnswer({ type: "answer", sdp: e.data.sdp });
    }
  };
}

async function applyAnswer(sdp) {
  if (applied) return; applied = true; committed = true;
  await pc.setRemoteDescription(sdp);
  setStatus("Connecting…");
}

// ── ANSWERER: reached by yielding to a scanned offer, or via an #o= link ──
async function startAnswerer(code) {
  role = "answerer"; committed = true; lastOfferCode = code;
  show("pair");
  hide("pairCam"); // reached by scanning their offer — we only need to show OUR answer back
  $("pairIntro").innerHTML =
    "You scanned their code. Now show <strong>this new code</strong> to the other " +
    "device’s camera to finish connecting. It’s a different QR from the one you just scanned.";
  wireFallback();
  await buildAnswer(code);
}

// Turn a running offerer into the answerer for a scanned offer.
async function becomeAnswerer(code) {
  committed = true; role = "answerer"; lastOfferCode = code;
  stopCamera();
  try { if (pc) pc.close(); } catch {}
  applied = false; entered = false; channel = null; bc.onmessage = null;
  hide("pairCam");
  $("pairIntro").innerHTML =
    "Got their code. Now show <strong>this new code</strong> to the other " +
    "device’s camera to finish connecting.";
  await buildAnswer(code);
}

async function buildAnswer(code) {
  try { if (pc) pc.close(); } catch {}
  entered = false; channel = null;
  pc = new RTCPeerConnection(rtcConfig());
  pc.ondatachannel = (e) => setupChannel(e.channel);
  try {
    await pc.setRemoteDescription(decode(code));
    await pc.setLocalDescription(await pc.createAnswer());
    await iceComplete(pc);
  } catch {
    setStatus("Invalid or expired code", "err");
    return;
  }
  myLink = linkFor("a", encode(pc.localDescription));
  $("pairLink").textContent = myLink;
  await renderQr($("pairQr"), myLink);
  setStatus("Waiting for them to scan this…");
}

// Every scanned/pasted code lands here. `manual` = pasted (skip tiebreak).
function onScan(parsed, manual = false) {
  let dec;
  try { dec = decode(parsed.code); } catch { return; }
  if (parsed.type === "a") {                 // an answer to our offer
    if (role === "offerer" && !applied) applyAnswer(dec);
    return;
  }
  // an offer from the other device
  if (committed || role !== "offerer") return;
  if (manual) return becomeAnswerer(parsed.code);
  if (dec.nonce === myNonce) { myNonce = (myNonce + 1) & 0xffff; mintOffer(); return; } // tie → reroll
  if (myNonce < dec.nonce) becomeAnswerer(parsed.code);
  else flash("Saw their code. Now point their camera at yours");
}

// ── HANDOFF tab (#a=): push the answer to the original tab (same browser) ──
async function startHandoff(code) {
  show("handoff");
  const sdp = decode(code);
  let acked = false;
  bc.onmessage = (e) => {
    if (e.data.type === "ack") {
      acked = true;
      $("handoffTitle").textContent = "Connected";
      $("handoffText").textContent = "All done. You can close this tab and continue in the other one.";
    }
  };
  bc.postMessage({ type: "answer", sdp });
  setTimeout(() => {
    if (acked) return;
    $("handoffTitle").textContent = "Manual hand-over needed";
    $("handoffText").textContent = "The original tab isn't reachable.";
    show("handoffFallback");
    $("handoffFallback").open = true;
    $("handoffBlob").value = linkFor("a", code);
    $("copyHandoff").onclick = () => navigator.clipboard.writeText($("handoffBlob").value);
  }, 1500);
}
