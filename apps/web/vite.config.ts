import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/generate": "http://localhost:3000",
      "/edit": "http://localhost:3000",
    },
  },
});
