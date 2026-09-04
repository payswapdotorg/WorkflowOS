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

    // The protected shell (the V2-017 universal product Home) appears
    // synchronously — the post-login landing is the product root.
    await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible({ timeout: 15_000 });

    // 3. Refresh persistence — a full reload keeps the authenticated shell.
    await page.reload();
    await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible({ timeout: 15_000 });

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

  // V2-017 T2 — the workflow-first Home honest-state journey, real topology:
  // the identity stack serves the real session + /organizations reads (but
  // no V2-002/V2-005 product routes), so this journey proves in a real
  // browser: the goal/search/creation entry, the honest SUCCESSFUL-EMPTY
  // states for a member of no organization, the honest Unavailable surfaces
  // without an exposed read, the entry-mode landing on /create, and — after
  // creating an organization through the public route — the honest ERROR
  // states when the org-scoped reads fail (404 on this stack): failed reads
  // NEVER render as successful empty states.
  test('T2 Home: goal entry, honest empty → error transitions, and Unavailable surfaces', async ({ page }) => {
    // Fresh user (no organization): the derivable-empty Home.
    await page.goto('/');
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill('Bob (T2)');
    await page.locator('#email').fill('bob-t2@e2e.example.com');
    await page.locator('#password').fill('the-t2-password-42');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible({ timeout: 15_000 });

    // The goal/search/creation entry exists with the three entry modes.
    await expect(page.getByRole('search')).toBeVisible();
    await expect(page.getByRole('textbox', { name: /goal or search/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Describe it' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show me' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Describe + show' })).toBeVisible();

    // Honest SUCCESSFUL-EMPTY (real /organizations read: no organization).
    await expect(page.getByText(/No workflows yet/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Nothing needs your attention/i)).toBeVisible();
    // Surfaces without an exposed read are honestly Unavailable — not fake-empty.
    await expect(page.getByRole('status', { name: 'Unavailable' })).toHaveCount(3);

    // Entry-mode journey: Describe + show lands on /create with the mode active.
    await page.getByRole('button', { name: 'Describe + show' }).click();
    await expect(page.getByRole('heading', { name: /Create a workflow/i })).toBeVisible();
    await expect(page).toHaveURL(/mode=tell-show/);
    await expect(page.locator('li[aria-current="true"]')).toContainText('Tell + Show');

    // Search journey: a typed goal starts creation with the goal as context.
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible();
    await page.getByRole('textbox', { name: /goal or search/i }).fill('Send the weekly invoice digest');
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page).toHaveURL(/\/create\?mode=tell&q=/);
    await expect(page.getByText(/Send the weekly invoice digest/i)).toBeVisible();

    // Failed reads stay visibly FAILED, never successful-empty: create an
    // organization through the public route; the org-scoped workflow/run
    // reads then 404 on this identity-only topology → honest error states.
    const res = await page.request.post('/api/organizations', { data: { name: 'Acme T2' } });
    expect(res.ok()).toBeTruthy();
    await page.goto('/');
    await expect(page.getByRole('alert')).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: /try again/i })).toHaveCount(2);
    await expect(page.getByText(/No workflows yet/i)).toHaveCount(0);
    await expect(page.getByText(/Nothing needs your attention/i)).toHaveCount(0);
    await expect(page.getByRole('status', { name: 'Unavailable' })).toHaveCount(3);
  });
});
