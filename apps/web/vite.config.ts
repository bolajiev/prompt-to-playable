import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        landing: fileURLToPath(new URL("./index.html", import.meta.url)),
        app: fileURLToPath(new URL("./app.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/generate": "http://localhost:3000",
      "/edit": "http://localhost:3000",
    },
  },
});
