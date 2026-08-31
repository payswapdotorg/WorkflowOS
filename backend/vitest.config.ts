import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

/**
 * WORK-022 backend vitest config.
 *
 * Added React plugin + `.tsx` include so rendered-UI tests can mount real
 * React pages against a real Fastify server (PR #21 issue 2 correction).
 *
 * The default environment stays `node` (so existing tests don't change AND so
 * `import.meta.url` keeps working for backend modules that locate files on
 * disk). Rendered-UI `.tsx` tests set up DOM globals manually by importing
 * `./rendered-ui-dom-setup.ts` at the top of the test file instead of using
 * `@vitest-environment jsdom` (which would transform `import.meta.url` for
 * every backend module the test imports and break the migration runner +
 * object store).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // WORK-022 rendered-UI tests: force a SINGLE React + react-router-dom
    // instance. The backend has its own devDep copies of React (for
    // @testing-library/react) and the frontend has its own copies. Without
    // dedupe, two module instances coexist, react-router's context is null,
    // and `useParams`/`useRef` throw. `dedupe` tells vite to resolve every
    // import of these packages to a single physical copy.
    dedupe: ['react', 'react-dom', 'react-router', 'react-router-dom', 'scheduler'],
    alias: {
      '@platform': fileURLToPath(new URL('./src/platform', import.meta.url)),
      '@api': fileURLToPath(new URL('./src/api', import.meta.url)),
      '@modules': fileURLToPath(new URL('./src/modules', import.meta.url)),
      '@onboarding': fileURLToPath(new URL('./src/onboarding', import.meta.url)),
      '@repository-intelligence': fileURLToPath(new URL('./src/repository-intelligence', import.meta.url)),
      '@development-planner': fileURLToPath(new URL('./src/development-planner', import.meta.url)),
      '@maintenance': fileURLToPath(new URL('./src/maintenance', import.meta.url)),
      '@root': fileURLToPath(new URL('./src', import.meta.url)),
      '@': fileURLToPath(new URL('../frontend/src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/integration/**/*.test.tsx',
      'tests/architecture/**/*.test.ts',
      // WORK-064: the continuous-validation domain suite (pure domain +
      // composition tests — no database required).
      'tests/continuous-validation/**/*.test.ts',
      // WORK-065: the synthetic browser validation agent suite (pure domain +
      // composition + a real-browser integration test that launches Playwright
      // against a tiny local HTTP server — no database required for the unit
      // tests; the real-browser test gates on PLAYWRIGHT being available).
      'tests/browser-validation/**/*.test.ts',
      // WORK-066: the validation scheduling suite (the trigger/scheduling
      // decision layer — pure domain + composition tests; the real-PG
      // two-actor concurrency proofs live under tests/integration/
      // validation-scheduling/ and gate on WORKFLOWOS_DATABASE_URL).
      'tests/validation-scheduling/**/*.test.ts',
    ],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
