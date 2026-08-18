import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiPort = process.env.QUORUM_API_PORT ?? '3000';

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
    /*
     * Ship small assets as files rather than inlining them. Vite's data-URI
     * inlining re-encodes an SVG — it URL-escapes it and rewrites attribute
     * quoting — which is fine for a decoration and not fine for TMDB's logo,
     * which their terms require be used unmodified. As a file it stays
     * byte-identical to what TMDB published, and `shasum` can prove it.
     * See apps/web/src/assets/README.md.
     */
    assetsInlineLimit: 0,
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
