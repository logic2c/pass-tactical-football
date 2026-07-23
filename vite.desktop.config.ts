import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./desktop", import.meta.url)),
  base: "./",
  plugins: [react()],
  css: {
    postcss: fileURLToPath(new URL("./postcss.config.mjs", import.meta.url)),
  },
  build: {
    outDir: fileURLToPath(new URL("./desktop-dist", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        game: fileURLToPath(new URL("./desktop/index.html", import.meta.url)),
        tutorial: fileURLToPath(new URL("./desktop/tutorial.html", import.meta.url)),
      },
    },
  },
});
