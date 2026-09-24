import path from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import ldtkbuddy from "./vite-plugin-ldtkbuddy.js";

// vite-plugin-singlefile handles one HTML entry per build, so build.sh runs
// `vite build` once per test page, with PAGE set to its directory (e.g. tests/1).
const page = process.env.PAGE;

export default defineConfig({
  plugins: [ldtkbuddy(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: page ? { input: path.resolve(page, "index.html") } : undefined,
  },
});