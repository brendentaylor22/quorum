import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiPort = process.env.QUORUM_API_PORT ?? '3000';

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
  },
  server: {
    port: Number(process.env.QUORUM_WEB_PORT ?? 5173),
    // Bind every interface so phones on the same WAN can open the invite
    // link. The API stays on loopback and is reached through the proxy below.
    host: process.env.QUORUM_WEB_HOST ?? '0.0.0.0',
    // Vite blocks unknown Host headers by default; LAN IPs are fine here.
    allowedHosts: true,
    // Capability paths are served by the SPA; only /api reaches Fastify.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
});
