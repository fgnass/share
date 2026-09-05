/**
 * Portfolio screenshot generator.
 *
 * Spins up the Vite dev server and captures the app at an iPhone-class viewport
 * scaled 2× → exactly 780 × 1688. Each shot loads a `?demo` staging mode
 * (src/demo.ts), which arranges a deterministic frame of the *real* UI — the
 * actual QR renderer, the actual message list, never a mockup — so the shots
 * stay correct as the app evolves.
 *
 * They land in public/screenshots/ so the deployed site serves them at
 * https://share.gnass.buzz/screenshots/*.png — the portfolio links those URLs
 * directly, so it stays in sync without copying files around.
 *
 *   public/screenshots/pair.png   the QR route mid-pairing: our code plus the
 *                                 camera panel (no getUserMedia, so the scan
 *                                 area shows its black backdrop)
 *   public/screenshots/room.png   a connected room: chat plus two transfers,
 *                                 one finished and one still streaming
 *
 * Re-run any time the UI changes:  npm run screenshot
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "public", "screenshots");

// Target output is 780 × 1688. We render at half that on a high-DPI viewport so
// the QR and text render crisply, then capture at the native device pixels.
const VIEWPORT = { width: 390, height: 844 };
const SCALE = 2; // 390×844 @2x = 780×1688

const PORT = 5170;
const BASE = `http://127.0.0.1:${PORT}/`;

// Cap any wait so a regression can't hang the run.
const WAIT_TIMEOUT_MS = 30_000;

const SHOTS = ["pair", "room"];

function startServer() {
  const child = spawn(
    "npx",
    ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
  );
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("Vite did not start in time")), 30_000);
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      if (/Local:.*http/.test(String(chunk))) {
        clearTimeout(timer);
        res(child);
      }
    });
    child.on("exit", (code) => rej(new Error(`Vite exited early (code ${code})`)));
  });
}

/** Capture one shot on its own page, then dispose it. */
async function capture(context, name) {
  const url = `${BASE}?demo=${name}`;
  const page = await context.newPage();
  try {
    console.log(`Opening ${url}`);
    await page.goto(url, { waitUntil: "networkidle" });
    // The variable font swaps in async; wait so text isn't captured mid-fallback.
    await page.evaluate(() => document.fonts.ready);
    // The staging marks itself ready once the frame is rendered.
    await page.waitForFunction(() => window.__shareDemoReady === true, null, {
      timeout: WAIT_TIMEOUT_MS,
    });
    const out = resolve(outDir, `${name}.png`);
    await page.screenshot({ path: out });
    console.log(`Saved ${out} (${VIEWPORT.width * SCALE} × ${VIEWPORT.height * SCALE})`);
  } finally {
    await page.close();
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });

  console.log("Starting Vite…");
  const server = await startServer();

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      isMobile: true,
      hasTouch: true,
      // Freeze CSS transitions/keyframes so the captured frame is deterministic.
      reducedMotion: "reduce",
    });
    for (const name of SHOTS) {
      await capture(context, name);
    }
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
