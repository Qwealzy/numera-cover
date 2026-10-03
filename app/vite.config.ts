import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Dev-only same-origin path to a local engine (no CORS needed): VITE_ENGINE_URL=/engine
    proxy: {
      '/engine': {
        target: process.env.NUMERA_ENGINE_PROXY || 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/engine/, ''),
      },
    },
  },
  build: { chunkSizeWarningLimit: 900 }, // viem + react in one chunk (~200 kB gzip) is fine for a demo app
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
} as Parameters<typeof defineConfig>[0]);
