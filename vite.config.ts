import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Relative base so the built assets work no matter what path the app is hosted at.
export default defineConfig({
  base: "./",
  plugins: [preact()],
});
