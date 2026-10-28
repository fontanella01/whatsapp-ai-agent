import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// API_PORT lets the API run on another port when 3333 is taken
const apiPort = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.API_PORT ?? "3333";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    // In development the browser talks to /api on the same origin and Vite
    // forwards it to the API (live events included), so no CORS setup is needed.
    proxy: {
      "/api": { target: `http://localhost:${apiPort}`, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
});
