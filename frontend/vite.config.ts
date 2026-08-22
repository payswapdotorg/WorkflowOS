import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * WORK-023: the dev proxy rewrites /api/* → /* before forwarding to the
 * backend. This mirrors the nginx reverse proxy in production so the
 * frontend code uses the same /api prefix in both dev and prod.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
