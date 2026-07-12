// Screen Wake Lock — keep the display (and thus the tab, its AudioContext and
// mic) awake during pairing and in the room. Without it a phone dims and locks
// mid-handshake, suspending the tab and killing the sound loop. The lock is
// released automatically whenever the page is hidden, so we re-acquire it on
// return to the foreground. Unsupported / denied → silent no-op (older Safari).

let sentinel: any = null;
let want = false;

async function acquire() {
  if (!want || sentinel || document.hidden) return;
  try {
    sentinel = await (navigator as any).wakeLock?.request("screen");
    sentinel?.addEventListener?.("release", () => { sentinel = null; });
  } catch { /* denied or unsupported */ }
}

export function keepAwake(on: boolean) {
  want = on;
  if (on) acquire();
  else { const s = sentinel; sentinel = null; try { s?.release(); } catch {} }
}

// The lock drops when the tab is hidden; grab it again once we're visible.
document.addEventListener("visibilitychange", () => { if (!document.hidden) acquire(); });
