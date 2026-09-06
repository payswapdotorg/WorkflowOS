/**
 * REALITY-REPAIR-005 — the real-topology browser smoke (deterministic proof
 * over the REAL deployment entry + the REAL product SPA + a REAL browser).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-005.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-005 ACCEPT;
 * GitHub dispatch Issue #26).
 *
 * Required evidence (the Work Order's own words): "an approval-waiting run
 * appears on Home and opens to the run; an installed workflow behind head
 * version appears in Updates; no false 'not part of the product' claims
 * remain" — while the honest device-issues deferral (F-006) is preserved.
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
 *     login → org → public approval-gated workflow → free listing →
 *     publish) and later creates the NEW HEAD VERSION through the REAL
 *     owner-only V2-002 createVersion route. The consumer's journey never
 *     depends on any other fixture.
 *   - the CONSUMER does EVERYTHING through the real browser UI — signup
 *     included: onboarding (RR-002), the marketplace install (RR-003), the
 *     Run command, and every Home assertion of this repair (F-005).
 *
 * LEGS (each a step() with a screenshot + sha-256 digest):
 *   LEG 0a the REAL deployment entry boots (bun src/index.ts, pglite,
 *         role=all, :3001) and a V2 product route answers (401-not-404);
 *   LEG 0b the ACTUAL product SPA is served (Vite dev server on :5188);
 *   LEG 1  the consumer signs up through the real register UI;
 *   LEG 2  the consumer creates their organization through the real Home
 *          onboarding (the RR-002 composed precondition);
 *   LEG 3  Explore → the listing → the entitled free decision → the
 *          EXISTING V2-002 install pins version 1 into the CONSUMER org;
 *   LEG 4  the consumer RUNS the installed workflow through the real
 *          browser Run flow (the real V2-005 request + start commands);
 *   LEG 5  the REAL V2-005 pause command (the t6 e2e pattern: the
 *          consumer's own session, atStepId = the IR approval node) parks
 *          the run in the waiting-for-approval state;
 *   LEG 6  F-005 (a): Home — the approval-waiting run APPEARS in Pending
 *          approvals ("Waiting for you", the workflow name, the
 *          Open-the-run link) with NO Unavailable claim and NO false
 *          "not part of the product" copy;
 *   LEG 7  the Open-the-run link navigates to /workflows/:id?run=:runId
 *          and the run-status surface derives "Waiting for you" (the T10
 *          F02 direct link, end-to-end);
 *   LEG 8  the publisher creates the NEW HEAD VERSION through the REAL
 *          owner-only createVersion route (POST
 *          /workflow-repository/workflows/:id/versions);
 *   LEG 9  F-005 (b): Home (reloaded) — the installed-behind-head
 *          workflow APPEARS in Updates ("Update available", Version 2,
 *          the honest pinned-never-auto-updated vocabulary, the
 *          Open-the-workflow link) with NO adoption action on Home;
 *   LEG 10 the Open-the-workflow link navigates to the workflow detail —
 *          where the REAL adoption action lives (the detail's own §19
 *          update surface with "An update is available" and the
 *          Review/Approve controls; the Home surface never duplicated it);
 *   LEG 11 F-006 preserved: the Device issues panel still renders its
 *          honest Unavailable state on the same Home (the true deferral
 *          copy — unlike the two repaired false claims).
 *
 * Every leg persists a screenshot + a sha-256 digest; the transcript lands
 * in spec/architecture/v2/dogfooding-evidence/assets/reality-repair-005/
 * (journey.json + the screenshots the evidence document references).
 *
 * Run: cd backend && bunx tsx tests/integration/deployment/run-reality-repair-005-browser-smoke.ts
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
  'reality-repair-005',
);

const BACKEND_PORT = 3001; // the Vite dev proxy's fixed target — the REAL entry must own it.
const FRONTEND_PORT = 5188;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

const PUBLISHER_NAME = 'Padma (RR-005 publisher)';
const PUBLISHER_EMAIL = 'reality-repair-005-publisher@deployment.test';
const PUBLISHER_PASSWORD = 'the-reality-repair-005-publisher-42';
const PUBLISHER_ORG_NAME = 'RR-005 Publisher Org';

const CONSUMER_NAME = 'Iris (RR-005 consumer)';
const CONSUMER_EMAIL = 'reality-repair-005-consumer@deployment.test';
const CONSUMER_PASSWORD = 'the-reality-repair-005-consumer-42';
const CONSUMER_ORG_NAME = 'Iris Consumer Org';

const WORKFLOW_NAME = 'Reality repair approval digest';
const LISTING_NAME = 'RR-005 approval listing';
/** The IR approval node the pause command parks the run at (the t6 pattern). */
const APPROVAL_STEP_ID = 'review_gate';

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
    file: `spec/architecture/v2/dogfooding-evidence/assets/reality-repair-005/${name}`,
    sha256: sha,
    bytes: stat.size,
  });
  console.log(`[SHOT] ${name} (${stat.size} bytes, sha-256 ${sha.slice(0, 16)}…)`);
}

/**
 * The approval-gated workflow (modeled on the t6 e2e's digest document:
 * fetch → review_gate (the HUMAN approval node) → send | log). The V2-005
 * pause command parks a run at review_gate, and the IR's approval node is
 * what every "Waiting for you" derivation consumes.
 *
 * The variant parameters exist for the NEW HEAD VERSION (LEG 8): the
 * literal binding is SEMANTIC content (the presentation labels are NOT —
 * the V2-003 digest excludes them, so a presentation-only change would
 * converge on the existing version row instead of creating a new head).
 */
function authorApprovalWorkflow(variant: {
  repository: string;
  sendLabel: string;
}): WorkflowIrDocument {
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
        binding: { kind: 'literal', value: variant.repository },
      },
    ],
    outputs: [{ name: 'tickets', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const reviewGate: WorkflowNode = {
    id: APPROVAL_STEP_ID,
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
        send_digest: variant.sendLabel,
        log_rejection: 'Log the rejection',
      },
    })
    .build();
}

/** v1 (the seeded version): the payswap repository, the plain send label. */
function authorApprovalWorkflowV1(): WorkflowIrDocument {
  return authorApprovalWorkflow({
    repository: 'payswapdotorg/WorkflowOS',
    sendLabel: 'Email the digest',
  });
}

/**
 * v2 (the new head version): a SEMANTICALLY different document (the literal
 * binding changes, so the V2-003 content digest differs and the V2-002
 * createVersion route creates a NEW immutable version row), authored
 * through the SAME real route the product uses.
 */
function authorApprovalWorkflowV2(): WorkflowIrDocument {
  return authorApprovalWorkflow({
    repository: 'pectoraux/WorkflowOS',
    sendLabel: 'Email the digest and archive it',
  });
}

interface SeedFacts {
  listingId: string;
  workflowId: string;
  publisherOrgId: string;
  publisherCookie: string;
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

  info(`REALITY-REPAIR-005 real-deployment browser smoke starting at ${startedAt.toISOString()}`);
  info(`artifacts dir: ${ARTIFACTS_DIR}`);

  // ---- 1. The REAL deployment entry as a process (docker-compose CMD) --------
  const dataDir = mkdtempSync(join(tmpdir(), 'reality-repair-005-smoke-pglite-'));
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
    await step('LEG0a the REAL deployment entry boots (bun src/index.ts, pglite, role=all, :3001) and a V2 product route answers (401-not-404)', async () => {
      await waitHealthy(`http://127.0.0.1:${BACKEND_PORT}`, 60_000);
      const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/marketplace/listings`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(401);
    });

    await step('LEG0b the ACTUAL product SPA is served (Vite dev server)', async () => {
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
    const seed = await step('seed: publisher register → login → org → public APPROVAL-GATED workflow → listing → publish (REAL routes only; the consumer gets NOTHING pre-seeded)', async () => {
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
        slug: 'reality-repair-005-approval-digest',
        name: WORKFLOW_NAME,
        description: 'Collect the open tickets, wait for approval, then email the digest.',
        visibility: 'public', // public: the marketplace publish precondition
        content: versionContentOf(authorApprovalWorkflowV1()),
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
        description: 'The REALITY-REPAIR-005 representative published approval-gated listing.',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      });
      expect(listing.status, JSON.stringify(listing.json)).toBe(201);
      const listingId = listing.json.listing.id as string;

      const publish = await api(cookie, 'POST', `/marketplace/listings/${listingId}/publish`);
      expect(publish.status, JSON.stringify(publish.json)).toBe(200);

      return {
        listingId,
        workflowId,
        publisherOrgId: orgId,
        publisherCookie: cookie,
      } satisfies SeedFacts;
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
      run: 'REALITY-REPAIR-005 real-deployment browser smoke',
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

/** The consumer's FIRST organization id, resolved from the REAL entry. */
async function consumerOrgId(context: BrowserContext): Promise<string> {
  const token = await sessionToken(context);
  expect(token).not.toBe('');
  const orgs = await api(token, 'GET', '/organizations');
  expect(orgs.status).toBe(200);
  const orgId = (orgs.json.organizations as Array<{ id: string }>)[0]?.id ?? '';
  expect(orgId).not.toBe('');
  return orgId;
}

async function journey(page: Page, seed: SeedFacts, context: BrowserContext): Promise<number> {
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

  // ============ LEG 3 — MARKETPLACE: entitled → install version 1 =============
  await step('LEG3 Explore → the listing → the entitled free decision → the EXISTING V2-002 install pins version 1 into the CONSUMER organization', async () => {
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
  await shot(page, '01-consumer-installed-v1.png');

  // ============ LEG 4 — RUN: the real browser Run flow ========================
  await step('LEG4 the consumer RUNS the installed workflow through the real browser Run flow (the real V2-005 request + start commands; the status surface derives Running)', async () => {
    // The F-003-repaired cross-org detail (the consumer's installation org).
    await page.goto(`${FRONTEND_URL}/workflows/${seed.workflowId}`);
    await expect(page.getByRole('heading', { name: WORKFLOW_NAME })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: 'Run' }).first().click();
    const preview = page.getByRole('region', { name: 'Run preview' });
    await expect(preview).toBeVisible();
    await expect(preview.getByText(`Run ${WORKFLOW_NAME}?`)).toBeVisible();
    // The approval gate is a declared consent fact of this version.
    await expect(preview.getByText(/Approval required/i)).toBeVisible();
    await preview.getByRole('button', { name: 'Run' }).click();
    await expect(preview).toHaveCount(0, { timeout: 20_000 });
    const status = page.getByRole('region', { name: 'Run status' });
    await expect(status).toBeVisible({ timeout: 20_000 });
    await expect(status.getByText('Running')).toBeVisible();
  });
  await shot(page, '02-consumer-run-running.png');

  // ============ LEG 5 — the REAL V2-005 pause command at the approval step ====
  const runId = await step('LEG5 the REAL V2-005 pause command (the t6 e2e pattern) parks the run at the IR approval step through the consumer’s own session', async () => {
    const token = await sessionToken(context);
    const orgId = await consumerOrgId(context);
    const runs = await api(token, 'GET', `/organizations/${orgId}/workflow-runs/runs`);
    expect(runs.status).toBe(200);
    const mine = ((runs.json.runs as Array<{ id: string; workflowId: string; state: string }>) ?? []).filter(
      (r) => r.workflowId === seed.workflowId,
    );
    expect(mine.length).toBeGreaterThan(0);
    const id = mine[0]?.id ?? '';
    expect(id).not.toBe('');
    // The executor-side pause report: atStepId = the IR approval node (the
    // authoritative pause point every Waiting-for-you derivation reads).
    const pause = await api(token, 'POST', `/workflow-runs/runs/${id}/pause`, {
      commandId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      atStepId: APPROVAL_STEP_ID,
    });
    expect(pause.status, JSON.stringify(pause.json)).toBe(200);
    expect((pause.json.run as { state: string }).state).toBe('paused');
    // The reconstructed history carries the pause entry with detail.atStepId.
    const history = await api(token, 'GET', `/workflow-runs/runs/${id}/history`);
    expect(history.status).toBe(200);
    const pauseEntries = ((history.json.timeline as Array<{
      eventName: string;
      detail: { atStepId?: string } | null;
    }>) ?? []).filter((e) => e.eventName === 'workflow.run.paused');
    expect(pauseEntries.length).toBeGreaterThan(0);
    expect(pauseEntries[pauseEntries.length - 1]?.detail?.atStepId).toBe(APPROVAL_STEP_ID);
    return id;
  });

  // ============ LEG 6 — F-005 (a): Home Pending approvals =====================
  await step('LEG6 F-005 (a): Home — the approval-waiting run APPEARS in Pending approvals ("Waiting for you", the workflow name, the Open-the-run link) — no Unavailable claim, no false "not part of the product" copy', async () => {
    await page.goto(`${FRONTEND_URL}/`);
    const approvals = page.getByRole('region', { name: 'Pending approvals' });
    await expect(approvals.getByText('Waiting for you')).toBeVisible({ timeout: 20_000 });
    await expect(approvals.getByText(WORKFLOW_NAME)).toBeVisible();
    await expect(approvals.getByText(/paused for your approval/i)).toBeVisible();
    const link = approvals.getByRole('link', { name: 'Open the run' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', `/workflows/${seed.workflowId}?run=${runId}`);
    // The composed surface — never the false unavailability claims.
    await expect(approvals.getByRole('status', { name: 'Unavailable' })).toHaveCount(0);
    await expect(approvals.getByText(/becomes? part of the product/i)).toHaveCount(0);
    // The record fact stays honest in Needs attention (Paused).
    const attention = page.getByRole('region', { name: 'Needs attention' });
    await expect(attention.getByText('Paused')).toBeVisible();
  });
  await shot(page, '03-home-pending-approvals.png');

  // ============ LEG 7 — the direct link opens the run =========================
  await step('LEG7 the Open-the-run link navigates to /workflows/:id?run=:runId and the run-status surface derives "Waiting for you" (the T10 F02 direct link, end-to-end)', async () => {
    const approvals = page.getByRole('region', { name: 'Pending approvals' });
    await approvals.getByRole('link', { name: 'Open the run' }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${seed.workflowId}\\?run=${runId}$`));
    const status = page.getByRole('region', { name: 'Run status' });
    await expect(status).toBeVisible({ timeout: 20_000 });
    await expect(status.getByText('Waiting for you')).toBeVisible();
  });
  await shot(page, '04-run-detail-waiting-for-you.png');

  // ============ LEG 8 — the publisher creates the NEW HEAD VERSION ===========
  await step('LEG8 the publisher creates the NEW HEAD VERSION through the REAL owner-only createVersion route (POST /workflow-repository/workflows/:id/versions)', async () => {
    const created = await api(
      seed.publisherCookie,
      'POST',
      `/workflow-repository/workflows/${seed.workflowId}/versions`,
      {
        content: versionContentOf(authorApprovalWorkflowV2()),
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect((created.json.version as { versionNumber: number }).versionNumber).toBe(2);
    // The public versions read confirms head 2 with the consumer's pin at 1.
    const token = await sessionToken(context);
    const versions = await api(
      token,
      'GET',
      `/workflow-repository/workflows/${seed.workflowId}/versions`,
    );
    expect(versions.status).toBe(200);
    const numbers = ((versions.json.versions as Array<{ versionNumber: number }>) ?? []).map(
      (v) => v.versionNumber,
    );
    expect(Math.max(...numbers)).toBe(2);
  });

  // ============ LEG 9 — F-005 (b): Home Updates ===============================
  await step('LEG9 F-005 (b): Home (reloaded) — the installed-behind-head workflow APPEARS in Updates ("Update available", Version 2, the pinned-never-auto-updated vocabulary, the Open-the-workflow link) — and NO adoption action on Home', async () => {
    await page.goto(`${FRONTEND_URL}/`);
    const updates = page.getByRole('region', { name: 'Updates' });
    await expect(updates.getByText('Update available')).toBeVisible({ timeout: 20_000 });
    await expect(updates.getByText(WORKFLOW_NAME)).toBeVisible();
    await expect(updates.getByText(/Version 2 is available/i)).toBeVisible();
    await expect(updates.getByText(/stays pinned/i)).toBeVisible();
    await expect(
      updates.getByText(/Nothing changes until you approve the update/i),
    ).toBeVisible();
    const link = updates.getByRole('link', { name: 'Open the workflow' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', `/workflows/${seed.workflowId}`);
    // The adoption action lives on the workflow detail — NEVER on Home.
    await expect(updates.getByRole('button', { name: /approve|install|update/i })).toHaveCount(0);
    // The composed surface — never the false unavailability claims.
    await expect(updates.getByRole('status', { name: 'Unavailable' })).toHaveCount(0);
    await expect(updates.getByText(/becomes? part of the product/i)).toHaveCount(0);
  });
  await shot(page, '05-home-updates.png');

  // ============ LEG 10 — the link goes where the real action lives ============
  await step('LEG10 the Open-the-workflow link navigates to the workflow detail — where the REAL adoption action lives (the detail’s own §19 update surface; Home never duplicated it)', async () => {
    const updates = page.getByRole('region', { name: 'Updates' });
    await updates.getByRole('link', { name: 'Open the workflow' }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${seed.workflowId}$`));
    await expect(page.getByRole('heading', { name: WORKFLOW_NAME })).toBeVisible({
      timeout: 20_000,
    });
    // The detail's own §19 update surface: the immutable-pin facts + the
    // explicit Review/Approve controls (the real adoption action).
    const detailUpdates = page.getByRole('region', { name: 'Update available' });
    await expect(detailUpdates.getByText('An update is available')).toBeVisible({
      timeout: 20_000,
    });
    await expect(detailUpdates.getByRole('button', { name: /review update/i })).toBeVisible();
    // The pin facts stay honest on the detail too.
    await expect(page.getByText(/Version 2 — immutable/)).toBeVisible();
    await expect(page.getByText(/Installed: Version 1 — pinned · Enabled/)).toBeVisible();
  });
  await shot(page, '06-workflow-detail-adoption-action.png');

  // ============ LEG 11 — F-006 preserved: Device issues stays honest ==========
  await step('LEG11 F-006 preserved: the Device issues panel still renders its honest Unavailable state on Home (the TRUE deferral copy — unlike the two repaired false claims)', async () => {
    await page.goto(`${FRONTEND_URL}/`);
    const devices = page.getByRole('region', { name: 'Device issues' });
    await expect(devices.getByRole('status', { name: 'Unavailable' })).toBeVisible();
    await expect(
      devices.getByText(/device status becomes part of the product/i),
    ).toBeVisible();
    // The composed surfaces remain composed on this same visit.
    const approvals = page.getByRole('region', { name: 'Pending approvals' });
    await expect(approvals.getByText('Waiting for you')).toBeVisible({ timeout: 20_000 });
    const updates = page.getByRole('region', { name: 'Updates' });
    await expect(updates.getByText('Update available')).toBeVisible();
  });
  await shot(page, '07-home-device-issues-honest.png');

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
