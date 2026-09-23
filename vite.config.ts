import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/ui",
  build: {
    outDir: path.resolve(__dirname, "dist", "ui"),
    emptyOutDir: true,
    sourcemap: false,
    cssMinify: true,
    minify: "esbuild",
    chunkSizeWarningLimit: 1000,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3777",
    },
  },
});
