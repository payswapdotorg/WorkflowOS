/**
 * REALITY-REPAIR-003 — the real-topology browser smoke (deterministic proof
 * over the REAL deployment entry + the REAL product SPA + a REAL browser).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-003.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-003 ACCEPT;
 * GitHub dispatch Issue #23).
 *
 * Required evidence (the Work Order's own words): "Browser: customer
 * purchases and installs a public marketplace workflow, then opens it from
 * Installed/My Workflows. Detail loads without publisher-org 403s.
 * Customer-local installation/run/deployment facts remain isolated to the
 * caller's org. Regression for own-org workflow detail remains green."
 *
 * Topology (the REAL one — NOT a test harness composition):
 *   - the backend is the REAL deployment entrypoint spawned as a process:
 *     `bun src/index.ts` (the docker-compose CMD) on the WORK-071 pglite
 *     dev runtime (real PostgreSQL-WASM DatabaseClient + the SAME
 *     migrations as production), WORKFLOWOS_ROLE=all, a fresh temp data
 *     directory, listening on :3001;
 *   - the frontend is the ACTUAL Vite dev server serving the product SPA
 *     (its /api proxy targets :3001 exactly as deployed);
 *   - the browser is a REAL headless Chromium (Playwright).
 *
 * Personas:
 *   - the PUBLISHER is seeded through the REAL HTTP routes only (register →
 *     login → org → public workflow → listing → publish) so the marketplace
 *     has one published free listing to act on. The consumer's journey
 *     never depends on any other fixture.
 *   - the CONSUMER does EVERYTHING through the real browser UI — signup
 *     included — and ends with TWO real browser sessions (theirs + the
 *     publisher's own-org regression pass):
 *
 *   LEG 1  SIGNUP   — the real LoginPage's register surface lands the
 *                     consumer on Home.
 *   LEG 2  ORG      — the RR-002 first-run onboarding creates the
 *                     consumer's organization through the real browser UI
 *                     (the composed precondition of this slice).
 *   LEG 3  MARKET   — Explore → the listing → the entitled free decision →
 *                     the EXISTING V2-002 Install pins version 1 into the
 *                     CONSUMER org.
 *   LEG 4  OPEN     — the library's Installed tab → Open: THE DETAIL LOADS
 *                     for the cross-org public workflow (the F-003 repair)
 *                     — the heading, the description, the Public line, the
 *                     presentation-label steps, the consumer's installation
 *                     pin, "Not run yet", and NO honest-error state.
 *   LEG 5  NO PUBLISHER READS — the browser's own network capture: during
 *                     the detail load ZERO requests target the publisher
 *                     organization's org-scoped routes; the caller-org
 *                     reads are present instead.
 *   LEG 6  RUN      — the Run action (the real preview → confirm): the run
 *                     request + re-read land in the CONSUMER organization
 *                     (the installation org), the run-status surface
 *                     renders, and the API runs read resolves the run for
 *                     THIS workflow in the consumer org.
 *   LEG 7  BOUNDARY — the consumer's cookie against the publisher org's
 *                     member-only runs read → 403 (the existing
 *                     authorization semantics, UNCHANGED by this repair).
 *   LEG 8  OWN-ORG  — the publisher (a second real browser session) opens
 *                     the same workflow's detail: it loads with their facts
 *                     (the own-org regression, in the real browser).
 *
 * Every leg persists a screenshot + a sha-256 digest; the transcript lands
 * in spec/architecture/v2/dogfooding-evidence/assets/reality-repair-003/
 * (journey.json + the screenshots the evidence document references).
 *
 * Run: cd backend && bunx tsx tests/integration/deployment/run-reality-repair-003-browser-smoke.ts
 * Exit code 0 = every leg passed. Non-zero = a leg failed (printed).
 */
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page, type BrowserContext } from '@playwright/test';
import {
  createWorkflowIrBuilder,
  type WorkflowIrDocument,
  type WorkflowNode,
} from '../../../src/workflow-ir/index.js';
import { versionContentOf } from '../workflow-deployments/trigger-test-support.js';

expect.configure({ timeout: 20_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = join(HERE, '..', '..', '..');
const REPO_ROOT = join(BACKEND_ROOT, '..');
const ARTIFACTS_DIR = join(
  REPO_ROOT,
  'spec',
  'architecture',
  'v2',
  'dogfooding-evidence',
  'assets',
  'reality-repair-003',
);

const BACKEND_PORT = 3001; // the Vite dev proxy's fixed target — the REAL entry must own it.
const FRONTEND_PORT = 5188;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

const PUBLISHER_NAME = 'Perrin (RR-003 publisher)';
const PUBLISHER_EMAIL = 'reality-repair-003-publisher@deployment.test';
const PUBLISHER_PASSWORD = 'the-reality-repair-publisher-42';
const PUBLISHER_ORG_NAME = 'RR-003 Publisher Org';

const CONSUMER_NAME = 'Ilex (RR-003 consumer)';
const CONSUMER_EMAIL = 'reality-repair-003-consumer@deployment.test';
const CONSUMER_PASSWORD = 'the-reality-repair-consumer-42';
const CONSUMER_ORG_NAME = 'Ilex Consumer Org';

const WORKFLOW_NAME = 'Reality repair consumer digest';
const LISTING_NAME = 'RR-003 consumer listing';

interface TranscriptEntry {
  at: string;
  label: string;
  status: 'PASS' | 'FAIL' | 'INFO';
  ms: number;
  detail?: string;
}

const transcript: TranscriptEntry[] = [];
const artifacts: Array<{ file: string; sha256: string; bytes: number }> = [];
const startedAt = new Date();

function info(label: string): void {
  transcript.push({ at: new Date().toISOString(), label, status: 'INFO', ms: 0 });
  console.log(`[INFO] ${label}`);
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await fn();
    const entry: TranscriptEntry = {
      at: new Date().toISOString(),
      label,
      status: 'PASS',
      ms: Date.now() - t0,
    };
    transcript.push(entry);
    console.log(`[PASS] (${entry.ms}ms) ${label}`);
    return out;
  } catch (err) {
    const entry: TranscriptEntry = {
      at: new Date().toISOString(),
      label,
      status: 'FAIL',
      ms: Date.now() - t0,
      detail: err instanceof Error ? `${err.name}: ${err.message.split('\n').slice(0, 6).join(' | ')}` : String(err),
    };
    transcript.push(entry);
    console.log(`[FAIL] (${entry.ms}ms) ${label}\n      ${entry.detail}`);
    throw err;
  }
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function shot(page: Page, name: string): Promise<void> {
  const path = join(ARTIFACTS_DIR, name);
  await page.screenshot({ path, fullPage: true });
  const stat = statSync(path);
  const sha = sha256OfFile(path);
  artifacts.push({
    file: `spec/architecture/v2/dogfooding-evidence/assets/reality-repair-003/${name}`,
    sha256: sha,
    bytes: stat.size,
  });
  console.log(`[SHOT] ${name} (${stat.size} bytes, sha-256 ${sha.slice(0, 16)}…)`);
}

/** The digest fixture with presentation labels (the consumer detail surface). */
function authorSmokeWorkflow(): WorkflowIrDocument {
  const fetchTickets: WorkflowNode = {
    id: 'fetch_tickets',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'github.repository.read' },
    capabilityRequirements: ['github.repository.read'],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'repository',
        type: { kind: 'string' },
        binding: { kind: 'literal', value: 'payswapdotorg/WorkflowOS' },
      },
    ],
    outputs: [{ name: 'tickets', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const sendDigest: WorkflowNode = {
    id: 'send_digest',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'messaging.send' },
    capabilityRequirements: ['messaging.send'],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'fetch_tickets', output: 'tickets' },
      },
    ],
    outputs: [{ name: 'messageId', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart('fetch_tickets')
    .addNode(fetchTickets)
    .addNode(sendDigest)
    .addEdge({ from: 'fetch_tickets', to: 'send_digest', on: 'success' })
    .addWorkflowOutput({
      name: 'messageId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_digest', output: 'messageId' },
    })
    .withDefaultPlacement('any_supported_node')
    .withProvenance({ origin: 'authored' })
    .withPresentation({
      title: WORKFLOW_NAME,
      nodeLabels: {
        fetch_tickets: 'Collect the open tickets',
        send_digest: 'Email the digest',
      },
    })
    .build();
}

interface SeedFacts {
  listingId: string;
  workflowId: string;
  publisherOrgId: string;
}

/** A JSON call against the REAL entry (the seed channel — same session cookie). */
async function api(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      cookie: `wfos_session=${cookie}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function waitHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'unknown';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`never became healthy: ${url} (last: ${last})`);
}

async function main(): Promise<number> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  for (const entry of readdirSync(ARTIFACTS_DIR)) {
    if (entry.endsWith('.png') || entry.endsWith('.json')) {
      rmSync(join(ARTIFACTS_DIR, entry));
    }
  }

  info(`REALITY-REPAIR-003 real-deployment browser smoke starting at ${startedAt.toISOString()}`);
  info(`artifacts dir: ${ARTIFACTS_DIR}`);

  // ---- 1. The REAL deployment entry as a process (docker-compose CMD) --------
  const dataDir = mkdtempSync(join(tmpdir(), 'reality-repair-003-smoke-pglite-'));
  const backend: ChildProcessByStdio<null, Readable, Readable> = spawn(
    'bun',
    ['src/index.ts'],
    {
      cwd: BACKEND_ROOT,
      env: {
        ...process.env,
        WORKFLOWOS_DEV_RUNTIME: 'pglite',
        WORKFLOWOS_ROLE: 'all',
        WORKFLOWOS_DEV_DATABASE_DIR: dataDir,
        PORT: String(BACKEND_PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        NODE_ENV: 'test',
        DATABASE_URL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const backendErr: string[] = [];
  backend.stderr.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) backendErr.push(s);
  });

  // ---- 2. The ACTUAL product frontend (the Vite dev server) ------------------
  const vite = spawn('bun', ['run', 'dev', '--', '--port', String(FRONTEND_PORT)], {
    cwd: join(REPO_ROOT, 'frontend'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  vite.stderr.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) console.log(`[vite] ${s}`);
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let exitCode = 1;
  try {
    await step('the REAL deployment entry boots (bun src/index.ts, pglite, role=all, :3001)', () =>
      waitHealthy(`http://127.0.0.1:${BACKEND_PORT}`, 60_000),
    );
    await step('a V2 product route answers on the real entry (GET /marketplace/listings is 401-not-404)', async () => {
      const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/marketplace/listings`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(401);
    });

    await step('the ACTUAL product SPA is served (Vite dev server)', async () => {
      for (let i = 0; i < 120; i += 1) {
        try {
          const res = await fetch(`${FRONTEND_URL}/`, { signal: AbortSignal.timeout(1000) });
          if (res.ok) return;
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('the Vite dev server never became ready');
    });

    // ---- 3. The PUBLISHER seed through the REAL routes (no direct DB writes).
    //         The CONSUMER is NOT seeded: their entire journey happens through
    //         the real browser UI. ------------------------------------------------
    const seed = await step('seed: publisher register → login → org → public workflow → listing → publish (REAL routes; the consumer gets NOTHING pre-seeded)', async () => {
      const reg = await fetch(`http://127.0.0.1:${BACKEND_PORT}/auth/password/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: PUBLISHER_EMAIL,
          password: PUBLISHER_PASSWORD,
          displayName: PUBLISHER_NAME,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      expect(reg.status, `register: ${await reg.text()}`).toBe(201);
      const login = await fetch(`http://127.0.0.1:${BACKEND_PORT}/auth/password/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: PUBLISHER_EMAIL, password: PUBLISHER_PASSWORD }),
        signal: AbortSignal.timeout(15_000),
      });
      expect(login.status).toBe(200);
      const setCookie = login.headers.get('set-cookie') ?? '';
      const cookie = /wfos_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
      expect(cookie).not.toBe('');

      const org = await api(cookie, 'POST', '/organizations', { name: PUBLISHER_ORG_NAME });
      expect(org.status, JSON.stringify(org.json)).toBe(201);
      const orgId = org.json.organization.id as string;

      const wf = await api(cookie, 'POST', `/organizations/${orgId}/workflow-repository/workflows`, {
        slug: 'reality-repair-003-digest',
        name: WORKFLOW_NAME,
        description: 'Collect the open tickets and email the digest.',
        visibility: 'public', // public: the marketplace publish precondition
        content: versionContentOf(authorSmokeWorkflow()),
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      });
      expect(wf.status, JSON.stringify(wf.json)).toBe(201);
      const workflowId = wf.json.workflow.id as string;
      const versionId = wf.json.initialVersion.id as string;

      // The listing carries a FREE offer: the consumer's purchase path is the
      // offer acceptance (a real marketplace command), not a payment provider
      // (none is configured on this topology — honestly so).
      const listing = await api(cookie, 'POST', '/marketplace/listings', {
        organizationId: orgId,
        workflowId,
        versionId,
        name: LISTING_NAME,
        description: 'The REALITY-REPAIR-003 representative published listing.',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      });
      expect(listing.status, JSON.stringify(listing.json)).toBe(201);
      const listingId = listing.json.listing.id as string;

      const publish = await api(cookie, 'POST', `/marketplace/listings/${listingId}/publish`);
      expect(publish.status, JSON.stringify(publish.json)).toBe(200);

      return { listingId, workflowId, publisherOrgId: orgId } satisfies SeedFacts;
    });

    // ---- 4. A REAL browser against the REAL topology -------------------------
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      baseURL: FRONTEND_URL,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    exitCode = await journey(page, seed, context, browser);
  } catch (err) {
    console.log(`\n[JOURNEY FAILED] ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    const finishedAt = new Date();
    const summary = {
      run: 'REALITY-REPAIR-003 real-deployment browser smoke',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      exitCode,
      backendPort: BACKEND_PORT,
      frontendPort: FRONTEND_PORT,
      transcript,
      artifacts,
    };
    writeFileSync(join(ARTIFACTS_DIR, 'journey.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      `\n[DONE] exitCode=${exitCode} duration=${summary.durationMs}ms legs=${transcript.filter((t) => t.status === 'PASS').length} passed / ${transcript.filter((t) => t.status === 'FAIL').length} failed`,
    );
    if (backendErr.length > 0) {
      console.log(`[backend stderr tail]\n${backendErr.slice(-10).join('\n')}`);
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        // best effort
      }
    }
    vite.kill('SIGTERM');
    backend.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    vite.kill('SIGKILL');
    backend.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  }
  return exitCode;
}

/** The session cookie of a Playwright browser context (the REAL session). */
async function sessionToken(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(FRONTEND_URL);
  return cookies.find((c) => c.name === 'wfos_session')?.value ?? '';
}

async function journey(
  page: Page,
  seed: SeedFacts,
  context: BrowserContext,
  browser: Awaited<ReturnType<typeof chromium.launch>>,
): Promise<number> {
  // ============ LEG 1 — SIGNUP (the real register surface) ====================
  await step('LEG1 the consumer signs up through the real register UI (Create one → Create account) and lands on Home', async () => {
    await page.goto(`${FRONTEND_URL}/`);
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill(CONSUMER_NAME);
    await page.locator('#email').fill(CONSUMER_EMAIL);
    await page.locator('#password').fill(CONSUMER_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible();
  });

  // ============ LEG 2 — ORG: the composed RR-002 onboarding ===================
  await step('LEG2 the consumer creates their organization through the real Home onboarding (the RR-002 composed precondition)', async () => {
    await page.locator('#organization-name').fill(CONSUMER_ORG_NAME);
    await page.getByRole('button', { name: 'Create organization' }).click();
    await expect(
      page.getByRole('region', { name: 'Organization onboarding' }),
    ).toHaveCount(0);
  });
  await shot(page, '01-consumer-org-created.png');

  // ============ LEG 3 — MARKETPLACE: entitled → install =======================
  await step('LEG3 Explore → the listing → the entitled free decision → Install pins version 1 into the CONSUMER organization', async () => {
    await page.goto(`${FRONTEND_URL}/explore/${seed.listingId}`);
    await expect(page.getByRole('heading', { name: LISTING_NAME })).toBeVisible();
    const access = page.getByRole('region', { name: 'Your access' });
    await expect(
      access.getByText("You're entitled to this workflow."),
    ).toBeVisible({ timeout: 20_000 });
    await access.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(
      access.getByText(/Installed — pinned to version 1/i),
    ).toBeVisible({ timeout: 20_000 });
  });
  await shot(page, '02-listing-installed.png');

  // ============ LEG 4 — OPEN FROM INSTALLED: the detail LOADS (F-003) =========
  // The F-003 repair, in the real browser: the cross-org public workflow's
  // detail composes its org-scoped reads against the CALLER's organizations,
  // so NO publisher-org 403 kills the page. The network capture (LEG 5) is
  // armed BEFORE the navigation.
  const detailRequests: string[] = [];
  page.on('request', (req) => {
    detailRequests.push(req.url());
  });

  await step('LEG4 the library Installed tab → Open: the cross-org public workflow DETAIL LOADS (heading, description, Public line, steps, the consumer pin, Not run yet — no honest-error state)', async () => {
    await page.goto(`${FRONTEND_URL}/workflows`);
    await page.getByRole('tab', { name: 'Installed' }).click();
    const panel = page.getByRole('tabpanel');
    await expect(
      panel.getByRole('heading', { name: 'Installed workflow' }),
    ).toBeVisible({ timeout: 20_000 });
    await panel.getByRole('link', { name: 'Open' }).click();
    // THE F-003 assertion: the detail renders (at base the publisher-org 403
    // killed the page into the honest error state — never a detail).
    await expect(
      page.getByRole('heading', { name: WORKFLOW_NAME }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Collect the open tickets and email the digest.')).toBeVisible();
    await expect(page.getByText(/Public — any signed-in user/i)).toBeVisible();
    // The steps from the presentation layer (the public version read).
    const steps = page.getByRole('list', { name: /what it does/i });
    await expect(steps.getByRole('listitem')).toHaveCount(2);
    await expect(steps.getByText('Collect the open tickets')).toBeVisible();
    await expect(steps.getByText('Email the digest')).toBeVisible();
    // The CONSUMER's installation pin (the caller-org read).
    await expect(page.getByText(/Installed: Version 1 — pinned · Enabled/)).toBeVisible();
    // Honest no-facts states (no runs / deployments yet in the consumer org).
    await expect(page.getByText(/Not run yet/i)).toBeVisible();
    await expect(page.getByText(/not deployed yet/i)).toBeVisible();
    // NO honest-error state — the detail is NOT the error surface.
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
  await shot(page, '03-consumer-workflow-detail.png');

  // ============ LEG 5 — NO PUBLISHER-ORG READS (the browser's capture) ========
  await step('LEG5 the detail load issued ZERO publisher-org requests; the caller-org reads are present (the browser network capture)', async () => {
    // The consumer's organization id (resolved from the REAL entry).
    const token = await sessionToken(context);
    expect(token).not.toBe('');
    const orgs = await api(token, 'GET', '/organizations');
    expect(orgs.status).toBe(200);
    const consumerOrgId = (orgs.json.organizations as Array<{ id: string; name: string }>)[0]?.id ?? '';
    expect(consumerOrgId).not.toBe('');

    const publisherPrefix = `/api/organizations/${seed.publisherOrgId}/`;
    const toPublisher = detailRequests.filter((u) => u.includes(publisherPrefix));
    expect(
      toPublisher,
      `publisher-org requests issued during the consumer detail load: ${toPublisher.join(', ')}`,
    ).toEqual([]);

    const consumerPrefix = `/api/organizations/${consumerOrgId}/`;
    const consumerRuns = detailRequests.filter(
      (u) => u.includes(`${consumerPrefix}workflow-runs/runs`),
    );
    const consumerInstallations = detailRequests.filter(
      (u) => u.includes(`${consumerPrefix}workflow-repository/installations`),
    );
    expect(consumerRuns.length).toBeGreaterThan(0);
    expect(consumerInstallations.length).toBeGreaterThan(0);

    // The unchanged PUBLIC reads are present.
    const publicWorkflowRead = detailRequests.filter((u) =>
      u.includes(`/api/workflow-repository/workflows/${seed.workflowId}`),
    );
    expect(publicWorkflowRead.length).toBeGreaterThan(0);
  });

  // ============ LEG 6 — RUN: the org-scoped action in the CONSUMER org ========
  const runRequests: string[] = [];
  await step('LEG6 the Run action requests the run in the CONSUMER organization (the installation org): the run-status surface renders and the API run read resolves THIS workflow', async () => {
    // Arm the network capture for the command sequence.
    const onRequest = (req: import('@playwright/test').Request) => {
      runRequests.push(`${req.method()} ${req.url()}`);
    };
    page.on('request', onRequest);

    const token = await sessionToken(context);
    const orgs = await api(token, 'GET', '/organizations');
    const consumerOrgId = (orgs.json.organizations as Array<{ id: string }>)[0]?.id ?? '';
    expect(consumerOrgId).not.toBe('');

    // The consumer has an installation but no runs yet — the honest base.
    const runsBefore = await api(
      token,
      'GET',
      `/organizations/${consumerOrgId}/workflow-runs/runs`,
    );
    expect(runsBefore.status).toBe(200);
    expect(
      ((runsBefore.json.runs as Array<{ workflowId: string }>) ?? []).filter(
        (r) => r.workflowId === seed.workflowId,
      ).length,
    ).toBe(0);

    // Run → the consequential-action preview → confirm.
    await page.getByRole('button', { name: 'Run' }).first().click();
    const preview = page.getByRole('region', { name: 'Run preview' });
    await expect(preview).toBeVisible();
    await expect(preview.getByText(`Run ${WORKFLOW_NAME}?`)).toBeVisible();
    await preview.getByRole('button', { name: 'Run' }).click();
    await expect(preview).toHaveCount(0, { timeout: 20_000 });

    // The run-status surface renders (the authoritative run record).
    const status = page.getByRole('region', { name: 'Run status' });
    await expect(status).toBeVisible({ timeout: 20_000 });

    // The command network capture: the run REQUEST targeted the CONSUMER org.
    const requestCall = runRequests.find(
      (u) =>
        u.startsWith('POST') &&
        u.includes(`/api/organizations/${consumerOrgId}/workflow-runs/runs`),
    );
    expect(requestCall, `run request calls: ${runRequests.join(' | ')}`).toBeDefined();
    const publisherCommand = runRequests.find(
      (u) =>
        u.startsWith('POST') &&
        u.includes(`/api/organizations/${seed.publisherOrgId}/workflow-runs/runs`),
    );
    expect(publisherCommand).toBeUndefined();

    // The API run read resolves THIS workflow's run IN the consumer org.
    const runsAfter = await api(
      token,
      'GET',
      `/organizations/${consumerOrgId}/workflow-runs/runs`,
    );
    expect(runsAfter.status).toBe(200);
    const mine = ((runsAfter.json.runs as Array<{ workflowId: string; state: string }>) ?? []).filter(
      (r) => r.workflowId === seed.workflowId,
    );
    expect(mine.length).toBeGreaterThan(0);

    page.off('request', onRequest);
  });
  await shot(page, '04-consumer-run-status.png');

  // ============ LEG 7 — BOUNDARY: the member-only 403, unchanged ==============
  await step('LEG7 the consumer cookie against the PUBLISHER org runs read → 403 (the existing member-only authorization, unchanged)', async () => {
    const token = await sessionToken(context);
    const res = await api(
      token,
      'GET',
      `/organizations/${seed.publisherOrgId}/workflow-runs/runs`,
    );
    expect(res.status).toBe(403);
  });

  // ============ LEG 8 — OWN-ORG regression (the publisher's session) ==========
  await step('LEG8 the publisher opens the SAME workflow detail (own org): it loads with their facts (the own-org regression, in the real browser)', async () => {
    const publisherContext = await browser.newContext({
      baseURL: FRONTEND_URL,
      viewport: { width: 1280, height: 800 },
    });
    try {
      const ppage = await publisherContext.newPage();
      await ppage.goto(`${FRONTEND_URL}/`);
      // The real sign-in surface (the page's default mode).
      await ppage.locator('#email').fill(PUBLISHER_EMAIL);
      await ppage.locator('#password').fill(PUBLISHER_PASSWORD);
      await ppage.getByRole('button', { name: 'Sign in' }).click();
      await expect(
        ppage.getByRole('heading', { name: /What do you want to get done\?/i }),
      ).toBeVisible();

      // The own-org detail: loads with every fact (the publisher IS a member
      // of the workflow's org — the pre-repair behavior, unchanged).
      await ppage.goto(`${FRONTEND_URL}/workflows/${seed.workflowId}`);
      await expect(ppage.getByRole('heading', { name: WORKFLOW_NAME })).toBeVisible({
        timeout: 20_000,
      });
      await expect(ppage.getByText('Collect the open tickets and email the digest.')).toBeVisible();
      const steps = ppage.getByRole('list', { name: /what it does/i });
      await expect(steps.getByRole('listitem')).toHaveCount(2);
      // No installation in the publisher org (they authored, never installed)
      // — the honest own-org no-pin state.
      await expect(ppage.getByText(/No installs — run it from the library/i)).toBeVisible();
      await expect(ppage.getByRole('alert')).toHaveCount(0);
      await shot(ppage, '05-publisher-own-org-detail.png');
    } finally {
      await publisherContext.close();
    }
  });

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
