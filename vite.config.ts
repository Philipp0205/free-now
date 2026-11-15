import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");

/** Served as they are, at the same URLs. The app entry (index.html, js/, css/styles.css) is bundled instead. */
const COPY = [
  "vendor",
  "icons",
  "backgrounds",
  "manifest.webmanifest",
  "whats-new.json",
  "robots.txt",
  "googlee48df27048aaa965.html",
  "welcome.html",
  "privacy.html",
  "css/welcome.css",
];

function copyThrough(): Plugin {
  return {
    name: "hangry-copy-through",
    generateBundle() {
      const emit = (rel: string) => {
        const full = path.join(PUBLIC, rel);
        if (fs.statSync(full).isDirectory()) {
          for (const name of fs.readdirSync(full)) emit(path.posix.join(rel, name));
          return;
        }
        this.emitFile({ type: "asset", fileName: rel, source: fs.readFileSync(full) });
      };
      COPY.forEach(emit);
    },
  };
}

export default defineConfig({
  // The page sources live in public/. Its files are copied by copyThrough, not by Vite's publicDir.
  root: PUBLIC,
  publicDir: false,
  build: {
    // dist/ is where tsc writes the server. The client goes in its own folder.
    outDir: path.join(ROOT, "dist", "client"),
    emptyOutDir: true,
    rollupOptions: {
      // The buzzer overlay is its own entry so /js/buzzer.js stays a real module (test/ui/buzzer.spec.ts imports it).
      input: { index: path.join(PUBLIC, "index.html"), buzzer: path.join(PUBLIC, "js", "buzzer.js") },
      output: {
        // Stable names: existing installs, the share page and the tests all use /js/app.js and /css/styles.css.
        entryFileNames: (chunk) => (chunk.name === "index" ? "js/app.js" : "js/[name].js"),
        chunkFileNames: "js/[name].js",
        assetFileNames: (asset) => (asset.names.some((name) => name.endsWith(".css")) ? "css/styles.css" : "assets/[name][extname]"),
      },
    },
  },
  plugins: [
    copyThrough(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: path.join(ROOT, "sw"),
      filename: "sw.js",
      // app.js registers /sw.js itself, and public/manifest.webmanifest stays as it is.
      injectRegister: false,
      manifest: false,
      injectManifest: {
        rollupFormat: "iife",
        globPatterns: [
          "index.html",
          "js/**/*.js",
          "css/styles.css",
          "whats-new.json",
          "manifest.webmanifest",
          "icons/*.png",
          "vendor/leaflet/leaflet.{js,css}",
          "vendor/protomaps-leaflet/protomaps-leaflet.js",
        ],
        // The app shell is served at "/", and "/" is what the worker falls back to offline.
        manifestTransforms: [
          async (entries) => ({
            manifest: entries.map((entry) => (entry.url === "index.html" ? { ...entry, url: "/" } : entry)),
            warnings: [],
          }),
        ],
      },
    }),
  ],
});
