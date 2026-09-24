import path from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import ldtkbuddy from "./vite-plugin-ldtkbuddy.js";

// vite-plugin-singlefile handles one HTML entry per build, so build.sh runs
// `vite build` once per test page, with PAGE set to its directory (e.g. tests/1).
const page = process.env.PAGE;

export default defineConfig({
  base: '/',
  plugins: [ldtkbuddy(), viteSingleFile({
    useRecommendedBuildConfig: false,
    removeViteModuleLoader: true,
    inlinePattern: [`${page}/index-*.js`],
  })],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    assetsInlineLimit: () => true,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 100000000,
    rollupOptions: page ? {
      input: path.resolve(page, "index.html"),
      output: {
        codeSplitting: true,
        entryFileNames: `${page}/[name]-[hash].js`,
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name]-[hash].[ext]',
      }
    } : undefined,
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: '[name]-[hash].js',
        chunkFileNames: '[name]-[hash].js',
      }
    }
  },
});