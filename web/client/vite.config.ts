import { defineConfig } from 'vite';

// In development the gateway (default :8080) handles /api and proxies /v1 to SpacetimeDB.
const gateway = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  server: {
    host: process.env.VITE_HOST ?? '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: gateway, changeOrigin: false },
      '/v1': { target: gateway, ws: true, changeOrigin: false },
    },
  },
  preview: { port: 4173 },
  build: {
    target: 'es2022',
    assetsDir: 'assets/js',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: { manualChunks: { three: ['three'], spacetimedb: ['spacetimedb'] } },
    },
  },
});
