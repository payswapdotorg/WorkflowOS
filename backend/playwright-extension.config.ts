import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the WORK-028 Companion EXTENSION browser E2E.
 *
 * Unlike the default config (which drives the SPA in a plain page), these
 * tests launch a PERSISTENT Chromium context with the built Companion
 * extension loaded (Manifest V3 service worker + content scripts), proving
 * the REAL extension communicates with the REAL WorkflowOS backend:
 *
 *   WorkflowOS → Open with Companion → extension redeems the one-time
 *   handoff → fake provider page runs a deterministic lifecycle → callback
 *   events reach WorkflowOS → execution completes.
 *
 * The extension must be built first: `cd extension && bun install && bun run build`.
 */
export default defineConfig({
  testDir: './tests/e2e-browser-extension',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    headless: true,
    baseURL: 'http://localhost:5173',
  },
  webServer: {
    command: 'cd ../frontend && bun run dev -- --port 5173',
    port: 5173,
    timeout: 60_000,
    reuseExistingServer: true,
  },
});
