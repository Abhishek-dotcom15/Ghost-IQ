import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the dashboard calls the API with relative URLs and Vite proxies them.
// In production the server serves the built dashboard from the same origin.
const apiTarget = process.env.GHOSTIQ_API_URL ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/healthz': { target: apiTarget, changeOrigin: true },
      '/screenshots': { target: apiTarget, changeOrigin: true },
      '/socket.io': { target: apiTarget, ws: true, changeOrigin: true },
    },
  },
});
