import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Preact + a single self-contained index.html (JS, CSS and the web font all
// inlined) that can be hosted anywhere — no separate asset files.
export default defineConfig({
  base: "./",
  plugins: [preact(), viteSingleFile()],
  build: {
    assetsInlineLimit: 100000000, // inline assets of any size (e.g. the 250 KB font)
    cssCodeSplit: false,
  },
});
