import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * WORK-022 frontend test config.
 *
 * The rendered-UI tests mount real React pages in jsdom against a real Fastify
 * backend instance (started per suite in the test setup). This is genuine
 * end-to-end rendered-UI coverage — NOT `server.inject` API testing.
 *
 * WORK-022 product UI: mirror the `@/*` path alias from vite.config.ts so
 * tests resolve shadcn/ui imports identically.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
});
