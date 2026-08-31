/**
 * WORK-074 — Browser-level E2E: the identity runtime activation (finding F-1
 * resolved).
 *
 * Real topology (Fastify API on 127.0.0.1:3001 + the Vite dev server on :5173
 * via the Playwright webServer + pglite PostgreSQL). A FRESH browser context
 * (no cookies, no storage — the dogfooding gate's precondition) drives the
 * actual SPA through the normal human login journey.
 *
 * Flows proven (the WORK-074 proof #15 — the dogfooding gate's authentication
 * precondition):
 *   1. the LoginPage is the HUMAN login: Google/GitHub buttons (honest
 *      not-configured states on this deployment) + the email/password form;
 *      NO API-key/demo-key input exists anywhere;
 *   2. email sign-UP produces an authenticated session SYNCHRONOUSLY
 *      observable by the application shell — the protected routes appear
 *      WITHOUT a manual reload;
 *   3. refresh persistence: a full page reload keeps the session;
 *   4. logout removes access: the session is revoked server-side and the App
 *      shell returns to the LoginPage (no reload required);
 *   5. protected-route rejection: after logout, the protected route shows the
 *      LoginPage again (unauthenticated rejection through the real UI);
 *   6. wrong credentials are rejected with an honest error (the backend is
 *      the authority).
 */
import { test, expect } from '@playwright/test';
import {
  buildIdentityStack,
  type TestIdentityStack,
} from '../helpers/test-identity-stack.js';
import { buildIdentityTestServer } from '../helpers/test-identity-server.js';
import type { FastifyInstance } from 'fastify';

let stack: TestIdentityStack;
let server: FastifyInstance;

const ALICE_EMAIL = 'alice@e2e.example.com';
const ALICE_PASSWORD = 'the-e2e-password-42';

test.beforeAll(async () => {
  stack = await buildIdentityStack();
  server = await buildIdentityTestServer(stack);
  await server.listen({ port: 3001, host: '127.0.0.1' });
});

test.afterAll(async () => {
  await server.close();
  await stack.teardown();
});

test.describe('WORK-074 — fresh-browser identity journey', () => {
  test('fresh browser → human login → authenticated shell WITHOUT reload → logout → rejection', async ({ page }) => {
    // Fresh context: no cookies, no storage (Playwright default per test).
    await page.goto('/');

    // 1. The human login surface (no demo-key input anywhere).
    await expect(page.getByRole('heading', { name: 'WorkflowOS' })).toBeVisible();
    await expect(page.getByText(/Continue with GitHub/i)).toBeVisible();
    await expect(page.getByText(/Continue with Google/i)).toBeVisible();
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    const apiKeyInput = page.locator('input[type="password"][id="api-key"]');
    await expect(apiKeyInput).toHaveCount(0);
    // No wfos_api_key in localStorage (the demo-key path is retired).
    const stored = await page.evaluate(() => localStorage.getItem('wfos_api_key'));
    expect(stored).toBeNull();

    // 2. Email sign-UP — the session must be observable by the shell with NO reload.
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill('Alice (E2E)');
    await page.locator('#email').fill(ALICE_EMAIL);
    await page.locator('#password').fill(ALICE_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    // The protected shell (Projects dashboard) appears synchronously.
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible({ timeout: 15_000 });

    // 3. Refresh persistence — a full reload keeps the authenticated shell.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible({ timeout: 15_000 });

    // 4. Logout — server-side revocation; the shell returns to the login page.
    await page.getByRole('button', { name: 'Sign Out' }).click();
    await expect(page.getByText(/Continue with GitHub/i)).toBeVisible({ timeout: 15_000 });

    // 5. Protected-route rejection: navigating to a protected route shows the
    //    LoginPage again (the backend rejected the revoked session).
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: 'WorkflowOS' })).toBeVisible({ timeout: 15_000 });
  });

  test('wrong credentials are rejected with an honest error', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#email')).toBeVisible();
    await page.locator('#email').fill('ghost@e2e.example.com');
    await page.locator('#password').fill('not-the-right-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText(/Invalid email or password/i)).toBeVisible({ timeout: 15_000 });
    // Still unauthenticated: the login surface remains.
    await expect(page.getByRole('heading', { name: 'WorkflowOS' })).toBeVisible();
  });
});
