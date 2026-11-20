import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const server = process.env.OJAS_SERVER ?? "http://127.0.0.1:4870";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative asset paths: the same build is served by the Ojas server on the LAN.
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: server, ws: true } },
  },
  build: { outDir: "dist", target: "es2022" },
});
