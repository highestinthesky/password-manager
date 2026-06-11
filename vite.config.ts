import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves from /<repo-name>/ — relative base works for both targets.
  base: "./",
  build: { target: "es2022" },
  // Tauri expects a fixed dev port (see src-tauri/tauri.conf.json devUrl)
  server: { port: 5173, strictPort: true },
});
