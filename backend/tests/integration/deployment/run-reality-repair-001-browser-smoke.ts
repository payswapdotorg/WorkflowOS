/**
 * REALITY-REPAIR-001 — the real-topology browser smoke (deterministic proof
 * over the REAL deployment entry + the REAL product SPA + a REAL browser).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-001.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-001 ACCEPT).
 *
 * Required evidence (the Work Order's own words): "Browser smoke reaches
 * Home, Workflows, Explore, and at least one detail page against the real
 * deployment composition."
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
 * The seed (register → login → org → public workflow → install → listing →
 * publish) flows through the REAL HTTP routes of the REAL entry — no direct
 * DB writes, no second authority. The browser then SIGNS IN through the
 * product UI (the real login surface) and walks the required surfaces:
 *
 *   LEG 1  LOGIN   — the real LoginPage (email/password → session cookie),
 *                    landing on Home.
 *   LEG 2  HOME    — the §4 attention surfaces render behind the universal
 *                    shell (h1 + the attention-surfaces section).
 *   LEG 3  WORKFLOWS — the library lists the installed workflow (the
 *                    Installed tab's tabpanel).
 *   LEG 4  DETAIL  — the OWN-ORG workflow detail page: the presentation
 *                    steps, the immutable version pin, access/safety, the
 *                    primary actions (Run / Teach Me). (One detail page is
 *                    required; this is the audit's full-surface case.)
 *   LEG 5  EXPLORE — the published marketplace listing is browsable.
 *   LEG 6  LISTING DETAIL — the §22/§23 listing detail (the second detail
 *                    surface: Back to Explore + the Version-and-trust
 *                    region).
 *
 * Every leg persists a screenshot + a sha-256 digest; the transcript lands
 * in spec/architecture/v2/dogfooding-evidence/REALITY-REPAIR-001-real-deployment-composition.md
 * (the evidence document is written by hand after the run — this runner
 * persists journey.json + the screenshots it references).
 *
 * Run: cd backend && bunx tsx tests/integration/deployment/run-reality-repair-001-browser-smoke.ts
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
  'reality-repair-001',
);

const BACKEND_PORT = 3001; // the Vite dev proxy's fixed target — the REAL entry must own it.
const FRONTEND_PORT = 5188;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

const PERSONA_NAME = 'Remi (RR-001)';
const PERSONA_EMAIL = 'reality-repair-001-smoke@deployment.test';
const PERSONA_PASSWORD = 'the-reality-repair-smoke-42';
const ORG_NAME = 'Reality Repair Smoke Org';
const WORKFLOW_NAME = 'Reality repair digest';
const LISTING_NAME = 'Reality repair digest listing';

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
    file: `spec/architecture/v2/dogfooding-evidence/assets/reality-repair-001/${name}`,
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
  orgId: string;
  workflowId: string;
  versionId: string;
  listingId: string;
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

  info(`REALITY-REPAIR-001 real-deployment browser smoke starting at ${startedAt.toISOString()}`);
  info(`artifacts dir: ${ARTIFACTS_DIR}`);

  // ---- 1. The REAL deployment entry as a process (docker-compose CMD) --------
  const dataDir = mkdtempSync(join(tmpdir(), 'reality-repair-001-smoke-pglite-'));
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
    // The V2 product route groups must be registered on THIS entry (F-001):
    // an auth-gated product route answers 401 (unauthenticated), NOT the
    // unrouted 404 the audit recorded at base.
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

    // ---- 3. The seed through the REAL routes (no direct DB writes) -----------
    const seed = await step('seed: register → login → org → public workflow → install → listing → publish (REAL routes)', async () => {
      const reg = await fetch(`http://127.0.0.1:${BACKEND_PORT}/auth/password/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: PERSONA_EMAIL,
          password: PERSONA_PASSWORD,
          displayName: PERSONA_NAME,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      expect(reg.status, `register: ${await reg.text()}`).toBe(201);
      const login = await fetch(`http://127.0.0.1:${BACKEND_PORT}/auth/password/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: PERSONA_EMAIL, password: PERSONA_PASSWORD }),
        signal: AbortSignal.timeout(15_000),
      });
      expect(login.status).toBe(200);
      const setCookie = login.headers.get('set-cookie') ?? '';
      const cookie = /wfos_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
      expect(cookie).not.toBe('');

      const org = await api(cookie, 'POST', '/organizations', { name: ORG_NAME });
      expect(org.status, JSON.stringify(org.json)).toBe(201);
      const orgId = org.json.organization.id as string;

      const wf = await api(cookie, 'POST', `/organizations/${orgId}/workflow-repository/workflows`, {
        slug: 'reality-repair-001-digest',
        name: WORKFLOW_NAME,
        description: 'Collect the open tickets, approve, and email the digest.',
        visibility: 'public', // public: the marketplace publish precondition
        content: versionContentOf(authorSmokeWorkflow()),
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      });
      expect(wf.status, JSON.stringify(wf.json)).toBe(201);
      const workflowId = wf.json.workflow.id as string;
      const versionId = wf.json.initialVersion.id as string;

      const install = await api(
        cookie,
        'POST',
        `/organizations/${orgId}/workflow-repository/installations`,
        { workflowId, versionId },
      );
      expect(install.status, JSON.stringify(install.json)).toBe(201);

      const listing = await api(cookie, 'POST', '/marketplace/listings', {
        organizationId: orgId,
        workflowId,
        versionId,
        name: LISTING_NAME,
        description: 'The REALITY-REPAIR-001 representative published listing.',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      });
      expect(listing.status, JSON.stringify(listing.json)).toBe(201);
      const listingId = listing.json.listing.id as string;

      const publish = await api(cookie, 'POST', `/marketplace/listings/${listingId}/publish`);
      expect(publish.status, JSON.stringify(publish.json)).toBe(200);

      // A second authored workflow (private) so the library also shows the
      // own-org Drafts surface exactly as the audit saw them.
      const draft = await api(cookie, 'POST', `/organizations/${orgId}/workflow-repository/workflows`, {
        slug: 'reality-repair-001-notify',
        name: 'Notify the channel',
        description: 'The trigger-test fixture workflow.',
        visibility: 'private',
        content: versionContentOf(authorNotifyDocument()),
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      });
      expect(draft.status).toBe(201);

      return { orgId, workflowId, versionId, listingId } satisfies SeedFacts;
    });

    // ---- 4. A REAL browser against the REAL topology -------------------------
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      baseURL: FRONTEND_URL,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    exitCode = await journey(page, seed);
  } catch (err) {
    console.log(`\n[JOURNEY FAILED] ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    const finishedAt = new Date();
    const summary = {
      run: 'REALITY-REPAIR-001 real-deployment browser smoke',
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

async function journey(page: Page, seed: SeedFacts): Promise<number> {
  // ================= LEG 1 — LOGIN (the real product surface) ==================
  await step('LEG1 the product login surface (email/password → session)', async () => {
    await page.goto(`${FRONTEND_URL}/`);
    await expect(page.getByText('Create one', { exact: true })).toBeVisible();
    await page.locator('#email').fill(PERSONA_EMAIL);
    await page.locator('#password').fill(PERSONA_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible();
  });

  // ================= LEG 2 — HOME (the §4 attention surfaces) ==================
  await step('LEG2 Home renders behind the universal shell (attention surfaces)', async () => {
    await expect(
      page.getByRole('heading', { name: /What do you want to get done\?/i }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Home attention surfaces' })).toBeVisible();
    await expect(page.getByRole('search')).toBeVisible();
  });
  await shot(page, '01-home.png');

  // ================= LEG 3 — WORKFLOWS (the library) ===========================
  await step('LEG3 the Workflows library lists the installed workflow', async () => {
    await page.goto(`${FRONTEND_URL}/workflows`);
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByRole('heading', { name: WORKFLOW_NAME })).toBeVisible();
  });
  await shot(page, '02-workflows.png');

  // ================= LEG 4 — DETAIL (own-org workflow detail) ==================
  await step('LEG4 the workflow detail page (steps, immutable version, actions)', async () => {
    await page.goto(`${FRONTEND_URL}/workflows/${seed.workflowId}`);
    await expect(page.getByRole('heading', { name: WORKFLOW_NAME })).toBeVisible();
    const does = page.getByRole('region', { name: 'What it does' });
    await expect(does.getByText('Collect the open tickets')).toBeVisible();
    await expect(does.getByText('Your approval before sending')).toBeVisible();
    const version = page.getByRole('region', { name: 'Version' });
    await expect(version.getByText('Version 1 — immutable')).toBeVisible();
    const actions = page.getByRole('region', { name: 'Primary actions' });
    await expect(actions.getByRole('button', { name: 'Run' }).first()).toBeVisible();
    await expect(actions.getByRole('button', { name: 'Teach Me' }).first()).toBeVisible();
  });
  await shot(page, '03-workflow-detail.png');

  // ================= LEG 5 — EXPLORE (the published listing) ===================
  await step('LEG5 Explore lists the published marketplace listing', async () => {
    await page.goto(`${FRONTEND_URL}/explore`);
    const listings = page.getByRole('list', { name: 'Marketplace listings' });
    await expect(listings.getByRole('heading', { name: LISTING_NAME })).toBeVisible();
  });
  await shot(page, '04-explore.png');

  // ================= LEG 6 — LISTING DETAIL (the §22/§23 surface) ==============
  await step('LEG6 the listing detail page (back-nav + the version-and-trust region)', async () => {
    await page.goto(`${FRONTEND_URL}/explore/${seed.listingId}`);
    await expect(page.getByRole('navigation', { name: 'Back to Explore' })).toBeVisible();
    await expect(page.getByRole('heading', { name: LISTING_NAME })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Version and trust' })).toBeVisible();
  });
  await shot(page, '05-listing-detail.png');

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
