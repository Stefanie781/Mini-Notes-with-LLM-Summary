import { defineConfig } from "vite";

// The Anna App bundle is served from /anna-apps/<slug>/dev/ inside the
// host iframe, so assets must use relative URLs (base: "./").
// Output goes to <repo>/bundle which `anna-app dev` loads by default
// and which manifest.json ui.bundle.entry ("index.html") refers to.
export default defineConfig({
  base: "./",
  build: {
    outDir: "../bundle",
    emptyOutDir: true,
    target: "es2020",
  },
});
