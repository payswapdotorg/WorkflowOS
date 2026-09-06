/**
 * REALITY-REPAIR-002 — the real-topology browser smoke (deterministic proof
 * over the REAL deployment entry + the REAL product SPA + a REAL browser).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-002.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-002 ACCEPT).
 *
 * Required evidence (the Work Order's own words): "Fresh signup with zero
 * pre-seeded organizations. Organization creation through the real browser UI
 * only. Post-onboarding GET /organizations resolves the created organization
 * and product selection uses it. Marketplace access/purchase path no longer
 * silently no-ops. Existing authenticated journeys remain green."
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
 *     has one published free listing to act on. The fresh user's journey
 *     never depends on any other fixture.
 *   - the FRESH USER has ZERO pre-seeded organizations and does EVERYTHING
 *     through the real browser UI — signup included:
 *
 *   LEG 1  SIGNUP  — the real LoginPage's register surface (Create one →
 *                    Create account) lands the fresh user on Home with ZERO
 *                    organizations (the F-002 base condition).
 *   LEG 2  ONBOARD — Home renders the explicit first-run organization
 *                    onboarding (the repair): the named region + form.
 *   LEG 3  CREATE  — the organization is created through the real browser
 *                    UI ONLY (type the name → submit) and the onboarding
 *                    resolves off the landing surface.
 *   LEG 4  RESOLVE — the browser session's GET /organizations (the REAL
 *                    entry, same cookie) resolves the created organization;
 *                    the product selection uses it: the listing's per-org
 *                    access decision resolves (entitled, free listing) —
 *                    never the base's perpetual "Checking your access…".
 *   LEG 5  ACTION  — the org-scoped product action, end to end: the
 *                    EXISTING V2-002 install command pins the exact
 *                    published version into the created organization —
 *                    the exact silent no-op the audit recorded at base.
 *                    (The paid offer-acceptance branch of the same §23
 *                    flow is proven deterministically in the component
 *                    contract tests; this topology has no payment
 *                    provider configured — honestly so — so the honest
 *                    browser purchase-path journey is free-listing access
 *                    + install.)
 *   LEG 6  LIBRARY — the Workflows library lists the installed workflow
 *                    (the org-scoped read aggregated across the created —
 *                    and only — organization of the fresh user).
 *
 * Every leg persists a screenshot + a sha-256 digest; the transcript lands
 * in spec/architecture/v2/dogfooding-evidence/assets/reality-repair-002/
 * (journey.json + the screenshots the evidence document references).
 *
 * Run: cd backend && bunx tsx tests/integration/deployment/run-reality-repair-002-browser-smoke.ts
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
import { chromium, expect } from '@playwright/test';
import {
  createWorkflowIrBuilder,
  type WorkflowIrDocument,
  type WorkflowNode,
} from '../../../src/workflow-ir/index.js';
import {
  authorNotifyDocument,
  versionContentOf,
} from '../workflow-deployments/trigger-test-support.js';
import type { Page } from '@playwright/test';

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
  'reality-repair-002',
);

const BACKEND_PORT = 3001; // the Vite dev proxy's fixed target — the REAL entry must own it.
const FRONTEND_PORT = 5188;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

const PUBLISHER_NAME = 'Perrin (RR-002 publisher)';
const PUBLISHER_EMAIL = 'reality-repair-002-publisher@deployment.test';
const PUBLISHER_PASSWORD = 'the-reality-repair-publisher-42';
const PUBLISHER_ORG_NAME = 'RR-002 Publisher Org';

const FRESH_NAME = 'Nova (RR-002 fresh user)';
const FRESH_EMAIL = 'reality-repair-002-fresh@deployment.test';
const FRESH_PASSWORD = 'the-reality-repair-fresh-42';
const FRESH_ORG_NAME = 'Nova First Org';

const WORKFLOW_NAME = 'Reality repair onboarding digest';
const LISTING_NAME = 'RR-002 onboarding listing';

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
    file: `spec/architecture/v2/dogfooding-evidence/assets/reality-repair-002/${name}`,
    sha256: sha,
    bytes: stat.size,
  });
  console.log(`[SHOT] ${name} (${stat.size} bytes, sha-256 ${sha.slice(0, 16)}…)`);
}

/** The digest fixture with presentation labels (the T15 shape, own-org detail page). */
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
  const reviewGate: WorkflowNode = {
    id: 'review_gate',
    executionClass: 'human',
    spec: {
      class: 'human',
      human: { kind: 'approval', instruction: 'Approve the digest before it is sent.' },
    },
    capabilityRequirements: [],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'tickets',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'fetch_tickets', output: 'tickets' },
      },
    ],
    outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'human_confirmation',
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
  const logRejection: WorkflowNode = {
    id: 'log_rejection',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'github.repository.read' },
    capabilityRequirements: ['github.repository.read'],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'literal', value: 'digest rejected' },
      },
    ],
    outputs: [{ name: 'logged', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart('fetch_tickets')
    .addNode(fetchTickets)
    .addNode(reviewGate)
    .addNode(sendDigest)
    .addNode(logRejection)
    .addEdge({ from: 'fetch_tickets', to: 'review_gate', on: 'success' })
    .addEdge({ from: 'review_gate', to: 'send_digest', on: { outcome: 'approved' } })
    .addEdge({ from: 'review_gate', to: 'log_rejection', on: { outcome: 'rejected' } })
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
        review_gate: 'Your approval before sending',
        send_digest: 'Email the digest',
        log_rejection: 'Log the rejection',
      },
    })
    .build();
}

interface SeedFacts {
  listingId: string;
  workflowId: string;
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

  info(`REALITY-REPAIR-002 real-deployment browser smoke starting at ${startedAt.toISOString()}`);
  info(`artifacts dir: ${ARTIFACTS_DIR}`);

  // ---- 1. The REAL deployment entry as a process (docker-compose CMD) --------
  const dataDir = mkdtempSync(join(tmpdir(), 'reality-repair-002-smoke-pglite-'));
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
    //         The FRESH USER is NOT seeded: zero pre-seeded organizations —
    //         their entire journey happens through the real browser UI. -------
    const seed = await step('seed: publisher register → login → org → public workflow → listing → publish (REAL routes; the fresh user gets NOTHING pre-seeded)', async () => {
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
        slug: 'reality-repair-002-digest',
        name: WORKFLOW_NAME,
        description: 'Collect the open tickets, approve, and email the digest.',
        visibility: 'public', // public: the marketplace publish precondition
        content: versionContentOf(authorSmokeWorkflow()),
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      });
      expect(wf.status, JSON.stringify(wf.json)).toBe(201);
      const workflowId = wf.json.workflow.id as string;
      const versionId = wf.json.initialVersion.id as string;

      // The listing carries a FREE offer: the fresh user's purchase path is
      // the offer acceptance (a real marketplace command), not a payment
      // provider (none is configured on this topology — honestly so).
      const listing = await api(cookie, 'POST', '/marketplace/listings', {
        organizationId: orgId,
        workflowId,
        versionId,
        name: LISTING_NAME,
        description: 'The REALITY-REPAIR-002 representative published listing.',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      });
      expect(listing.status, JSON.stringify(listing.json)).toBe(201);
      const listingId = listing.json.listing.id as string;

      const publish = await api(cookie, 'POST', `/marketplace/listings/${listingId}/publish`);
      expect(publish.status, JSON.stringify(publish.json)).toBe(200);

      return { listingId, workflowId } satisfies SeedFacts;
    });

    // ---- 4. A REAL browser against the REAL topology -------------------------
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      baseURL: FRONTEND_URL,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    exitCode = await journey(page, seed, context);
  } catch (err) {
    console.log(`\n[JOURNEY FAILED] ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    const finishedAt = new Date();
    const summary = {
      run: 'REALITY-REPAIR-002 real-deployment browser smoke',
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

async function journey(
  page: Page,
  seed: SeedFacts,
  context: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newContext']>>,
): Promise<number> {
  // ============ LEG 1 — FRESH SIGNUP (the real register surface) ==============
  // The F-002 base condition: a brand-new account, ZERO organizations, first
  // contact with the product shell. Everything happens in the REAL browser.
  await step('LEG1 the fresh user signs up through the real register UI (Create one → Create account) and lands on Home', async () => {
    await page.goto(`${FRONTEND_URL}/`);
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill(FRESH_NAME);
    await page.locator('#email').fill(FRESH_EMAIL);
    await page.locator('#password').fill(FRESH_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible();
  });

  // ============ LEG 2 — HOME: the zero-org onboarding (the repair) ============
  await step('LEG2 Home renders the explicit first-run organization onboarding for the zero-org fresh user (F-002 repaired)', async () => {
    await expect(
      page.getByRole('region', { name: 'Organization onboarding' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Set up your organization/i }),
    ).toBeVisible();
    await expect(page.locator('#organization-name')).toBeVisible();
    // The reason is stated — not a silent generic empty.
    await expect(
      page.getByText(/workflows you install and buy belong to an organization/i),
    ).toBeVisible();
  });
  await shot(page, '01-fresh-signup-home-zero-org.png');

  // ============ LEG 3 — CREATE the organization through the real UI ===========
  await step('LEG3 the organization is created through the real browser UI only (type the name → Create organization)', async () => {
    await page.locator('#organization-name').fill(FRESH_ORG_NAME);
    await page.getByRole('button', { name: 'Create organization' }).click();
    // The onboarding resolves off the landing surface: the zero-org
    // condition is gone (the F-002 dead end no longer exists).
    await expect(
      page.getByRole('region', { name: 'Organization onboarding' }),
    ).toHaveCount(0);
  });
  await shot(page, '02-home-after-org-creation.png');

  // ============ LEG 4 — RESOLVE: the created org + the product selection ======
  await step('LEG4 GET /organizations resolves the created organization for the browser session (the REAL entry, same cookie)', async () => {
    const cookies = await context.cookies(FRONTEND_URL);
    const token = cookies.find((c) => c.name === 'wfos_session')?.value ?? '';
    expect(token).not.toBe('');
    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/organizations`, {
      headers: { cookie: `wfos_session=${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      organizations: Array<{ id: string; name: string; roleId: string }>;
    };
    // The created organization resolves — with the creator as its owner
    // (the existing authority's own semantics, unchanged).
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0]!.name).toBe(FRESH_ORG_NAME);
    expect(body.organizations[0]!.roleId).toBe('owner');
  });

  await step('LEG4b the product selection uses the created organization (the per-org access decision resolves — no perpetual checking)', async () => {
    await page.goto(`${FRONTEND_URL}/explore/${seed.listingId}`);
    await expect(page.getByRole('heading', { name: LISTING_NAME })).toBeVisible();
    // The zero-org onboarding is NOT on this surface anymore (the org
    // exists), and the per-org decision resolves for the created org —
    // the exact state that sat in a perpetual "Checking your access…"
    // dead end at base. The listing is FREE, so the honest decision for
    // the created organization is ENTITLED (basis: free listing) — the
    // marketplace access path resolving against the created organization.
    await expect(
      page.getByRole('region', { name: 'Organization onboarding' }),
    ).toHaveCount(0);
    const access = page.getByRole('region', { name: 'Your access' });
    await expect(
      access.getByText("You're entitled to this workflow."),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      access.getByText('Access through the free listing.'),
    ).toBeVisible();
    await expect(access.getByText(/Checking your access/i)).toHaveCount(0);
  });
  await shot(page, '03-listing-detail-created-org.png');

  // ============ LEG 5 — ACTION: the org-scoped install command ================
  // The org-scoped product action, end to end: the EXISTING V2-002 install
  // command pins the exact published version into the CREATED organization.
  // At base this path silently no-oped for a fresh signup (no org → no
  // decision, no install target, no feedback). The offer-acceptance branch
  // of the same §23 flow (the paid command + its honest payment-failure
  // state) is covered deterministically in the component contract tests —
  // on this topology no payment provider is configured, so the honest
  // purchase-path journey is the free-listing access + install.
  await step('LEG5 the EXISTING V2-002 install command installs the exact published version into the created organization', async () => {
    const access = page.getByRole('region', { name: 'Your access' });
    await access.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(
      access.getByText(/Installed — pinned to version 1/i),
    ).toBeVisible({ timeout: 20_000 });
  });
  await shot(page, '04-listing-detail-installed.png');

  // ============ LEG 6 — LIBRARY: the org-scoped read for the new org ==========
  await step('LEG6 the Workflows library lists the installed workflow (the org-scoped read across the created — and only — organization)', async () => {
    await page.goto(`${FRONTEND_URL}/workflows`);
    // The fresh user's library opens on "My Workflows" (empty — the fresh
    // user authored nothing); the installation lives under "Installed".
    await page.getByRole('tab', { name: 'Installed' }).click();
    const panel = page.getByRole('tabpanel');
    // The publisher's workflow is NOT in the created org's repository read
    // (it belongs to the publisher's org), so the installation card renders
    // the honest fallback name — never a fabricated one — with the pinned
    // version fact from the installation read itself. (The generic
    // "No workflows yet" copy must NOT swallow a real installation: the
    // fresh org holds zero AUTHORED workflows — the same silent-no-op class
    // F-002 recorded, repaired by this slice on the library surface.)
    await expect(
      panel.getByRole('heading', { name: 'Installed workflow' }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText('Version 1 — pinned')).toBeVisible();
    await expect(panel.getByText('Enabled', { exact: true })).toBeVisible();
    expect(
      await panel.getByRole('link', { name: 'Open' }).getAttribute('href'),
    ).toMatch(/\/workflows\//);
    // OUT OF BOUNDARY (recorded, not repaired here): opening a CROSS-ORG
    // public workflow detail composes org-scoped reads (runs/installations/
    // deployments/repository list) with the workflow's OWN organization —
    // the publisher's — and the backend correctly 403s the non-member fresh
    // user. That is the existing authorization semantics (unchanged by this
    // repair); the cross-org public detail-page UX belongs to a serialized
    // successor, not this slice.
  });
  await shot(page, '05-workflows-installed.png');

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
