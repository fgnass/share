// Reed–Solomon (GF(256), systematic) — forward error correction for the
// data-over-sound frame. The acoustic channel drops or flips whole MFSK symbols
// (a tone landing in a dead bin, a burst of room noise); RS lets the receiver
// repair a bounded number of byte errors instead of failing CRC and forcing the
// sender to replay the whole tune. Pairs with the frame's CRC-8, the final
// arbiter should RS ever mis-correct.
//
// A faithful port of the well-known "Reed–Solomon codes for coders"
// (Wikiversity) errors-only decoder: GF(256), prim poly 0x11d, generator α=2,
// first consecutive root fcr=0. Pure arithmetic, no DOM — unit-tested in Node
// (see scripts/rs.test.mjs). Polynomials are lists, highest degree first.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const divg = (a: number, b: number) => (a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]); // b ≠ 0
const powg = (a: number, n: number) => EXP[(((LOG[a] * n) % 255) + 255) % 255];             // handles negative n
const inv = (a: number) => EXP[255 - LOG[a]];

const polyScale = (p: number[], s: number) => p.map((c) => mul(c, s));
function polyAdd(p: number[], q: number[]): number[] {
  const r = new Array(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}
function polyMul(p: number[], q: number[]): number[] {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++)
    for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
  return r;
}
function polyEval(p: number[], x: number): number {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

function genPoly(nsym: number): number[] {
  let g = [1];
  for (let i = 0; i < nsym; i++) g = polyMul(g, [1, powg(2, i)]);
  return g;
}

// Systematic encode → Uint8Array of [...msg, ...parity(nsym)].
export function rsEncode(msg: Uint8Array, nsym: number): Uint8Array {
  const gen = genPoly(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef !== 0) for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
  }
  out.set(msg); // division clobbered the message region; the parity tail is intact
  return out;
}

// Syndromes, padded with a leading 0 (Forney convenience): length nsym+1.
function calcSyndromes(msg: number[], nsym: number): number[] {
  const s = [0];
  for (let i = 0; i < nsym; i++) s.push(polyEval(msg, powg(2, i)));
  return s;
}

function findErrorLocator(synd: number[], nsym: number): number[] | null {
  let errLoc = [1], oldLoc = [1];
  const syndShift = synd.length - nsym;
  for (let i = 0; i < nsym; i++) {
    const K = i + syndShift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    oldLoc = [...oldLoc, 0];
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, inv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  const errs = errLoc.length - 1;
  if (errs * 2 > nsym) return null; // too many errors
  return errLoc;
}

// Chien search. err_loc must be lowest-degree first here (caller reverses).
function findErrors(errLoc: number[], nmess: number): number[] | null {
  const errs = errLoc.length - 1;
  const pos: number[] = [];
  for (let i = 0; i < nmess; i++) if (polyEval(errLoc, powg(2, i)) === 0) pos.push(nmess - 1 - i);
  if (pos.length !== errs) return null;
  return pos;
}

function errataLocator(coefPos: number[]): number[] {
  let eLoc = [1];
  for (const p of coefPos) eLoc = polyMul(eLoc, polyAdd([1], [powg(2, p), 0]));
  return eLoc;
}
function errorEvaluator(synd: number[], errLoc: number[], nsym: number): number[] {
  const r = polyMul(synd, errLoc);
  return r.slice(r.length - (nsym + 1));
}

function correctErrata(msg: number[], synd: number[], errPos: number[]): number[] | null {
  const coefPos = errPos.map((p) => msg.length - 1 - p);
  const errLoc = errataLocator(coefPos);
  const errEval = errorEvaluator(synd.slice().reverse(), errLoc, errLoc.length - 1).reverse();

  const X: number[] = coefPos.map((cp) => powg(2, -(255 - cp)));
  const E = new Array(msg.length).fill(0);
  for (let i = 0; i < X.length; i++) {
    const Xi = X[i], XiInv = inv(Xi);
    let denom = 1;
    for (let j = 0; j < X.length; j++) if (j !== i) denom = mul(denom, 1 ^ mul(XiInv, X[j]));
    if (denom === 0) return null;
    let y = polyEval(errEval.slice().reverse(), XiInv);
    y = mul(powg(Xi, 1), y); // fcr = 0 → power is (1 - fcr) = 1
    E[errPos[i]] = divg(y, denom);
  }
  return polyAdd(msg, E);
}

// Correct up to nsym/2 byte errors. Input = codeword ([...msg, ...parity]).
// Returns the corrected message (parity stripped), or null if unrecoverable.
export function rsDecode(received: Uint8Array, nsym: number): Uint8Array | null {
  let msg = Array.from(received);
  const synd = calcSyndromes(msg, nsym);
  if (Math.max(...synd) === 0) return received.subarray(0, received.length - nsym); // clean

  const fsynd = synd.slice(1); // Forney syndromes (no erasures) — drop the pad
  const errLoc = findErrorLocator(fsynd, nsym);
  if (!errLoc) return null;
  const errPos = findErrors(errLoc.slice().reverse(), msg.length);
  if (!errPos) return null;

  const corrected = correctErrata(msg, synd, errPos);
  if (!corrected) return null;
  if (Math.max(...calcSyndromes(corrected, nsym)) !== 0) return null; // still bad
  return Uint8Array.from(corrected.slice(0, corrected.length - nsym));
}
