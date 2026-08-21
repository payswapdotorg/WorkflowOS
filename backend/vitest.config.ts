import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@platform': fileURLToPath(new URL('./src/platform', import.meta.url)),
      '@api': fileURLToPath(new URL('./src/api', import.meta.url)),
      '@modules': fileURLToPath(new URL('./src/modules', import.meta.url)),
      '@root': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/architecture/**/*.test.ts',
    ],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
