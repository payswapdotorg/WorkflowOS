import { defineConfig } from '@playwright/test';

/**
 * Playwright config for WorkflowOS browser E2E tests.
 *
 * The tests run against a REAL backend topology (Fastify API + WorkerHost +
 * pglite PostgreSQL + in-memory queue). The browser drives the actual
 * frontend React pages — no API mocking.
 */
export default defineConfig({
  testDir: './tests/e2e-browser',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    headless: true,
    baseURL: 'http://localhost:5173',
    actionTimeout: 15_000,
    navigationTimeout: 15_000,
  },
  webServer: {
    command: 'cd ../frontend && bun run dev -- --port 5173 &',
    port: 5173,
    timeout: 30_000,
    reuseExistingServer: true,
  },
});
