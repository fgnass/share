import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Inline everything (JS, CSS, the web font) into one self-contained index.html
// that can be downloaded and hosted anywhere — no separate asset files.
export default defineConfig({
  base: "./",
  plugins: [viteSingleFile()],
  build: {
    assetsInlineLimit: 100000000, // inline assets of any size (e.g. the 250 KB font)
    cssCodeSplit: false,
  },
});
