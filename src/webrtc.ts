// ─────────── SDP compaction + small WebRTC helpers ───────────
// A data-channel SDP is ~90% fixed boilerplate. We ship only the variable
// fields (ice creds, DTLS fingerprint, setup role, udp host/srflx candidates)
// packed into a tiny binary blob and rebuild a full, valid SDP from a template
// on the other side. Cuts the link/QR payload from ~720 to ~170 chars.

export type Cand = { addr: string; port: number; type: string };
export type Fields = { u: string; p: string; f: string; s: string; c: Cand[]; nonce: number };

const _enc = new TextEncoder(), _dec = new TextDecoder();
const SETUP = ["actpass", "active", "passive", "holdconn"];
const CTYPE = ["host", "srflx"]; // host = same LAN, srflx = across NATs (needs STUN)

export const CHUNK = 16 * 1024;
export const HIGH_WATER = 4 * 1024 * 1024, LOW_WATER = 1 * 1024 * 1024;

// A per-device 16-bit tiebreaker. On a tie we reroll to a fresh random value
// (NOT +1, which would keep two equal nonces equal forever → livelock).
export const freshNonce = () => { const r = crypto.getRandomValues(new Uint8Array(2)); return (r[0] << 8) | r[1]; };

export function b64u(b: Uint8Array): string {
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(str), o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
}

// Pull the variable fields out of a real localDescription SDP.
export function extract(sdp: string): Omit<Fields, "nonce"> {
  let c: Cand[] = [...sdp.matchAll(/a=candidate:\S+ \d+ (udp) \d+ (\S+) (\d+) typ (host|srflx)/gi)]
    .map((m) => ({ addr: m[2], port: +m[3], type: m[4] }));
  // Drop literal IPv6 candidates (address contains ':') as long as something
  // else remains — on a shared LAN the IPv4/mDNS host candidate carries the
  // connection, and IPv6 literals (link-local, srflx) are long and rarely the
  // working path in the same room. mDNS "uuid.local" candidates hide their
  // family and are kept regardless, so an IPv6-only network still works.
  const v6 = (x: Cand) => x.addr.includes(":");
  if (c.some((x) => !v6(x))) c = c.filter((x) => !v6(x));
  return {
    u: sdp.match(/a=ice-ufrag:(\S+)/)![1],
    p: sdp.match(/a=ice-pwd:(\S+)/)![1],
    f: sdp.match(/a=fingerprint:sha-256 (\S+)/i)![1],
    s: sdp.match(/a=setup:(\S+)/)![1],
    c,
  };
}
// Rebuild a full valid SDP from the fields (foundation/priority synthesized).
export function build(x: Fields): string {
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
// Binary pack/unpack. A leading 16-bit nonce is the per-device tiebreaker.
export function pack(x: Fields): Uint8Array {
  const b: number[] = [];
  const put = (s: string) => { const e = _enc.encode(s); b.push(e.length, ...e); };
  b.push((x.nonce >> 8) & 255, x.nonce & 255);
  b.push(Math.max(0, SETUP.indexOf(x.s)));
  put(x.u); put(x.p);
  b.push(...x.f.split(":").map((h) => parseInt(h, 16))); // 32 bytes
  b.push(x.c.length);
  for (const c of x.c) { b.push(Math.max(0, CTYPE.indexOf(c.type))); put(c.addr); b.push((c.port >> 8) & 255, c.port & 255); }
  return Uint8Array.from(b);
}
export function unpack(b: Uint8Array): Fields {
  let i = 0;
  const get = () => { const n = b[i++]; const s = _dec.decode(b.slice(i, i + n)); i += n; return s; };
  const nonce = (b[i] << 8) | b[i + 1]; i += 2;
  const s = SETUP[b[i++]];
  const u = get(), p = get();
  const f = [...b.slice(i, i + 32)].map((x) => x.toString(16).padStart(2, "0")).join(":"); i += 32;
  const n = b[i++], c: Cand[] = [];
  for (let k = 0; k < n; k++) { const type = CTYPE[b[i++]]; const addr = get(); const port = (b[i] << 8) | b[i + 1]; i += 2; c.push({ type, addr, port }); }
  return { u, p, f, s, c, nonce };
}

export const packDesc = (desc: RTCSessionDescription, nonce: number) => pack({ ...extract(desc.sdp), nonce });
export const encode = (desc: RTCSessionDescription, nonce: number) => b64u(packDesc(desc, nonce));
export function decode(code: string) {
  const f = unpack(unb64u(code));
  return { type: f.s === "actpass" ? "offer" : "answer", sdp: build(f), nonce: f.nonce } as
    { type: "offer" | "answer"; sdp: string; nonce: number };
}
// Prefix a 1-byte role marker ('o'/'a') so the audio receiver knows offer vs answer.
export const withType = (t: number, bytes: Uint8Array) => { const a = new Uint8Array(bytes.length + 1); a[0] = t; a.set(bytes, 1); return a; };

// Resolve once ICE gathering is done. Some networks (blocked STUN, VPN, privacy
// extensions) never reach "complete", so also resolve on the end-of-candidates
// signal and a timeout — host candidates alone are enough on a LAN.
export function iceComplete(pc: RTCPeerConnection, timeout = 3000): Promise<void> {
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
    const onCand = (e: RTCPeerConnectionIceEvent) => { if (!e.candidate) finish(); };
    const timer = setTimeout(finish, timeout);
    pc.addEventListener("icegatheringstatechange", onState);
    pc.addEventListener("icecandidate", onCand);
  });
}

export const linkFor = (key: string, code: string) => location.origin + location.pathname + "#" + key + "=" + code;

// Pull the role + code out of a scanned/pasted link (handles full URLs).
export function parseCode(text: string): { type: string; code: string } | null {
  const m = String(text).match(/[#&?](o|a)=([^&\s]+)/);
  return m ? { type: m[1], code: m[2] } : null;
}
