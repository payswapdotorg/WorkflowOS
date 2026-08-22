import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * WORK-022 frontend test config.
 *
 * The rendered-UI tests mount real React pages in jsdom against a real Fastify
 * backend instance (started per suite in the test setup). This is genuine
 * end-to-end rendered-UI coverage — NOT `server.inject` API testing.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
});
