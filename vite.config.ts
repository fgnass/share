import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { execSync } from "node:child_process";

// A short build identifier so you can tell at a glance whether two devices run
// the same version (a stale service-worker cache on one device is the usual
// culprit). "<git short hash><-dirty?> · <UTC build date>", frozen at build time.
function buildId(): string {
  let rev = "nogit";
  try {
    rev = execSync("git rev-parse --short HEAD").toString().trim();
    if (execSync("git status --porcelain").toString().trim()) rev += "-dirty";
  } catch { /* not a git checkout */ }
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `${rev} · ${stamp}`;
}

// Relative base so the built assets work no matter what path the app is hosted at.
export default defineConfig({
  base: "./",
  plugins: [preact()],
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
});
