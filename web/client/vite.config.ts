import { defineConfig } from 'vite';

// In development the gateway (default :8080) handles /api and proxies /v1 to SpacetimeDB.
const gateway = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8080';

// OFFLINE=1 builds the single-player page (no server, relative paths, own output folder).
const offline = process.env.OFFLINE === '1';

export default defineConfig({
  base: offline ? './' : '/',
  define: { __OFFLINE__: JSON.stringify(offline) },
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
    outDir: offline ? 'dist-offline' : 'dist',
    target: 'es2022',
    assetsDir: 'assets/js',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: { manualChunks: offline ? { three: ['three'] } : { three: ['three'], spacetimedb: ['spacetimedb'] } },
    },
  },
});
