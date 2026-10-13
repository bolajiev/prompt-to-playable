import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
  },
  server: {
    port: 5173,
    proxy: {
      "/generate": "http://localhost:3000",
      "/edit": "http://localhost:3000",
    },
  },
});
