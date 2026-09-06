/**
 * REALITY-REPAIR-007 — the real-topology browser smoke (deterministic proof
 * over the REAL deployment entry + the REAL product SPA + a REAL browser).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-007.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-008 ACCEPT;
 * GitHub dispatch Issue #28).
 *
 * Required evidence (the Work Order's own words): "Browser proof of a run
 * reaching a waiting-for-user/approval state, then user action returning it
 * to execution. Browser proof of safe cancel/pause where applicable.
 * Idempotency and forbidden-transition behavior remain enforced by V2-005
 * command envelopes. Existing run/start/recovery/failure journeys remain
 * green."
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
 *     login → org → public workflow WITH an approval node → free listing →
 *     publish) so the marketplace has one published free listing to act
 *     on. The consumer's journey never depends on any other fixture.
 *   - the CONSUMER does EVERYTHING through the real browser UI — signup
 *     included — and exercises the REALITY-REPAIR-007 lifecycle controls:
 *
 *   LEG 1  SIGNUP   — the real LoginPage's register surface lands the
 *                     consumer on Home.
 *   LEG 2  ORG      — the RR-002 first-run onboarding creates the
 *                     consumer's organization through the real browser UI
 *                     (the composed precondition of this slice).
 *   LEG 3  MARKET   — Explore → the listing → the entitled free decision →
 *                     the EXISTING V2-002 Install pins version 1 (the
 *                     approval-gated workflow) into the CONSUMER org.
 *   LEG 4  OPEN     — the library's Installed tab → Open: the cross-org
 *                     detail loads (the RR-003 composed precondition — the
 *                     existing run journey's regression base).
 *   LEG 5  RUN      — the EXISTING run journey (the t6/RR-003 pattern):
 *                     the real Run preview → confirm → the REAL V2-005
 *                     request+start commands through the browser → the
 *                     run-status surface renders Running.
 *   LEG 6  PAUSE    — SAFE PAUSE through the USER's control (F-008): the
 *                     user clicks Pause in the run-status surface → the
 *                     REAL V2-005 pause command (running → paused) → the
 *                     surface shows Paused; the history read shows the
 *                     workflow.run.paused timeline entry.
 *   LEG 7  RESUME   — the user clicks Resume (the generic label — the run
 *                     is not at an approval gate) → the REAL V2-005
 *                     resume command → the run returns to execution
 *                     (Running; the history read shows workflow.run.resumed).
 *   LEG 8  WAITING  — the run reaches the waiting-for-user/approval state
 *                     (the RR-005 LEG5 / t6 pattern): the consumer's OWN
 *                     session drives the REAL executor-side pause AT the
 *                     IR approval node (atStepId = 'review_gate') →
 *                     reload → the run-status surface shows the
 *                     history-derived "Waiting for you".
 *   LEG 9  APPROVE  — THE F-008 CORE: the user clicks Approve in the
 *                     browser → the REAL V2-005 resume command (the
 *                     resume-with-human-confirmation semantics — "Approve"
 *                     is its user-facing label) → the user's action
 *                     returns the run to execution, verified through the
 *                     history read (workflow.run.resumed after the pause
 *                     at the approval node) and the runs read (running).
 *  LEG 10  CANCEL   — SAFE CANCEL through the USER's control (the §2.4
 *                     explicit choice): the executor-side pause at the
 *                     approval gate again → reload → "Waiting for you" →
 *                     the user clicks Stop → the explicit-choice panel →
 *                     Stop it → the REAL V2-005 cancel command → the
 *                     surface shows Cancelled and NO lifecycle control
 *                     remains (terminal honesty).
 *  LEG 11  BOUNDARY — the honest forbidden-transition rejection (the
 *                     envelope stays the authority): a SECOND run → the
 *                     waiting state → the run is cancelled CONCURRENTLY
 *                     through the REAL route (the consumer's own session)
 *                     → the user's stale Approve click → the backend
 *                     envelope's typed 409 workflow-run-terminal
 *                     rejection renders VERBATIM (never a fabricated
 *                     success) → the re-read record shows Cancelled.
 *  LEG 12  IDEMPOTENCY — the V2-005 envelope's exactly-once boundary
 *                     (server-side, on the REAL routes the UI composes):
 *                     the same pause envelope re-delivered → the second
 *                     delivery converges (executed: false, the same run
 *                     identity) and the timeline records the pause ONCE.
 *
 * Every leg persists a screenshot + a sha-256 digest; the transcript lands
 * in spec/architecture/v2/dogfooding-evidence/assets/reality-repair-007/
 * (journey.json + the screenshots the evidence document references).
 *
 * Run: cd backend && bunx tsx tests/integration/deployment/run-reality-repair-007-browser-smoke.ts
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
  'reality-repair-007',
);

const BACKEND_PORT = 3001; // the Vite dev proxy's fixed target — the REAL entry must own it.
const FRONTEND_PORT = 5188;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

const PUBLISHER_NAME = 'Petra (RR-007 publisher)';
const PUBLISHER_EMAIL = 'reality-repair-007-publisher@deployment.test';
const PUBLISHER_PASSWORD = 'the-reality-repair-publisher-42';
const PUBLISHER_ORG_NAME = 'RR-007 Publisher Org';

const CONSUMER_NAME = 'Iris (RR-007 consumer)';
const CONSUMER_EMAIL = 'reality-repair-007-consumer@deployment.test';
const CONSUMER_PASSWORD = 'the-reality-repair-consumer-42';
const CONSUMER_ORG_NAME = 'Iris Consumer Org';

const WORKFLOW_NAME = 'Reality repair approval digest';
const LISTING_NAME = 'RR-007 approval-gated listing';

/** The IR approval node the waiting/approval legs pause at. */
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
    file: `spec/architecture/v2/dogfooding-evidence/assets/reality-repair-007/${name}`,
    sha256: sha,
    bytes: stat.size,
  });
  console.log(`[SHOT] ${name} (${stat.size} bytes, sha-256 ${sha.slice(0, 16)}…)`);
}

/**
 * The approval-gated digest fixture: fetch → review (the IR approval node)
 * → send. The presentation labels are the consumer-facing step names; the
 * approval node carries the human-confirmation consent boundary
 * (spec.human.kind === 'approval').
 */
function authorApprovalWorkflow(): WorkflowIrDocument {
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
  return createWorkflowIrBuilder()
    .withStart('fetch_tickets')
    .addNode(fetchTickets)
    .addNode(reviewGate)
    .addNode(sendDigest)
    .addEdge({ from: 'fetch_tickets', to: 'review_gate', on: 'success' })
    .addEdge({ from: 'review_gate', to: 'send_digest', on: { outcome: 'approved' } })
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
      },
    })
    .build();
}

interface SeedFacts {
  listingId: string;
  workflowId: string;
  publisherOrgId: string;
}

/** A JSON call against the REAL entry (the seed/command channel — same session cookie). */
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

  info(`REALITY-REPAIR-007 real-deployment browser smoke starting at ${startedAt.toISOString()}`);
  info(`artifacts dir: ${ARTIFACTS_DIR}`);

  // ---- 1. The REAL deployment entry as a process (docker-compose CMD) --------
  const dataDir = mkdtempSync(join(tmpdir(), 'reality-repair-007-smoke-pglite-'));
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
    const seed = await step('seed: publisher register → login → org → public approval-gated workflow → listing → publish (REAL routes; the consumer gets NOTHING pre-seeded)', async () => {
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
        slug: 'reality-repair-007-approval-digest',
        name: WORKFLOW_NAME,
        description: 'Collect the open tickets, wait for your approval, then email the digest.',
        visibility: 'public', // public: the marketplace publish precondition
        content: versionContentOf(authorApprovalWorkflow()),
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
        description: 'The REALITY-REPAIR-007 representative published approval-gated listing.',
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
    exitCode = await journey(page, seed, context);
  } catch (err) {
    console.log(`\n[JOURNEY FAILED] ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    const finishedAt = new Date();
    const summary = {
      run: 'REALITY-REPAIR-007 real-deployment browser smoke',
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

/** The consumer's newest run of THIS workflow (the authoritative runs read). */
async function newestRun(
  token: string,
  consumerOrgId: string,
  workflowId: string,
): Promise<{ id: string; state: string }> {
  const runs = await api(token, 'GET', `/organizations/${consumerOrgId}/workflow-runs/runs`);
  expect(runs.status).toBe(200);
  const mine = ((runs.json.runs as Array<{ id: string; workflowId: string; state: string; updatedAt: string }>) ?? [])
    .filter((r) => r.workflowId === workflowId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  expect(mine.length, 'no run of the workflow in the consumer org').toBeGreaterThan(0);
  return mine[0]!;
}

/** The command envelope (the deterministic idempotency identity). */
function envelope(): { commandId: string; correlationId: string } {
  return { commandId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
}

/** The executor-side pause AT the approval node (the t6 pattern, the consumer's own session). */
async function pauseAtApproval(
  token: string,
  runId: string,
): Promise<void> {
  const res = await api(token, 'POST', `/workflow-runs/runs/${runId}/pause`, {
    ...envelope(),
    atStepId: APPROVAL_STEP_ID,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

/** The reconstructed history of one run (the V2-005 read). */
async function runHistory(token: string, runId: string): Promise<{
  run: { state: string };
  timeline: Array<{ eventName: string; detail: Record<string, unknown> | null; sequence: number }>;
}> {
  const res = await api(token, 'GET', `/workflow-runs/runs/${runId}/history`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json;
}

async function journey(page: Page, seed: SeedFacts, context: BrowserContext): Promise<number> {
  // The consumer's organization (resolved from the REAL entry after onboarding).
  const token = await sessionToken(context);
  expect(token).not.toBe('');
  const orgs = await api(token, 'GET', '/organizations');
  expect(orgs.status).toBe(200);
  const consumerOrgId = (orgs.json.organizations as Array<{ id: string; name: string }>)[0]?.id ?? '';
  expect(consumerOrgId).not.toBe('');

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
  await step('LEG3 Explore → the listing → the entitled free decision → Install pins the approval-gated version 1 into the CONSUMER organization', async () => {
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

  // ============ LEG 4 — OPEN FROM INSTALLED (the RR-003 regression) ===========
  await step('LEG4 the library Installed tab → Open: the cross-org approval-gated workflow detail loads (the RR-003 composed precondition — the existing run journey base)', async () => {
    await page.goto(`${FRONTEND_URL}/workflows`);
    await page.getByRole('tab', { name: 'Installed' }).click();
    const panel = page.getByRole('tabpanel');
    await expect(
      panel.getByRole('heading', { name: 'Installed workflow' }),
    ).toBeVisible({ timeout: 20_000 });
    await panel.getByRole('link', { name: 'Open' }).click();
    await expect(
      page.getByRole('heading', { name: WORKFLOW_NAME }),
    ).toBeVisible({ timeout: 20_000 });
    // The consumer's installation pin + the honest no-facts states.
    await expect(page.getByText(/Installed: Version 1 — pinned · Enabled/)).toBeVisible();
    await expect(page.getByText(/Not run yet/i)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  // ============ LEG 5 — RUN: the existing run journey (regression) ============
  const runRequests: string[] = [];
  await step('LEG5 the EXISTING run journey: the real Run preview → confirm → the REAL V2-005 request+start commands → the run-status surface renders Running', async () => {
    const onRequest = (req: import('@playwright/test').Request) => {
      runRequests.push(`${req.method()} ${req.url()}`);
    };
    page.on('request', onRequest);

    await page.getByRole('button', { name: 'Run' }).first().click();
    const preview = page.getByRole('region', { name: 'Run preview' });
    await expect(preview).toBeVisible();
    await expect(preview.getByText(`Run ${WORKFLOW_NAME}?`)).toBeVisible();
    // The approval node is declared by the IR — the consent boundary fact.
    await expect(preview.getByText(/Approval required/i)).toBeVisible();
    await preview.getByRole('button', { name: 'Run' }).click();
    await expect(preview).toHaveCount(0, { timeout: 20_000 });

    const status = page.getByRole('region', { name: 'Run status' });
    await expect(status).toBeVisible({ timeout: 20_000 });
    await expect(status.getByText('Running')).toBeVisible({ timeout: 20_000 });

    // The command network capture: the request targeted the CONSUMER org.
    const requestCall = runRequests.find(
      (u) =>
        u.startsWith('POST') &&
        u.includes(`/api/organizations/${consumerOrgId}/workflow-runs/runs`),
    );
    expect(requestCall, `run request calls: ${runRequests.join(' | ')}`).toBeDefined();
    const startCall = runRequests.find((u) => u.startsWith('POST') && /\/workflow-runs\/runs\/[^/]+\/start/.test(u));
    expect(startCall).toBeDefined();
    page.off('request', onRequest);

    // The authoritative runs read resolves THIS workflow's run, running.
    const run1 = await newestRun(token, consumerOrgId, seed.workflowId);
    expect(run1.state).toBe('running');
  });
  await shot(page, '03-run-running.png');

  // ============ LEG 6 — SAFE PAUSE through the USER's control (F-008) =========
  const run1Id = (await newestRun(token, consumerOrgId, seed.workflowId)).id;
  await step('LEG6 SAFE PAUSE: the user clicks Pause in the run-status surface → the REAL V2-005 pause command → Paused (verified through the history read)', async () => {
    const status = page.getByRole('region', { name: 'Run status' });
    await status.getByRole('button', { name: 'Pause' }).click();
    // The state word derives from the AUTHORITATIVE refetched record.
    await expect(status.getByText('Paused')).toBeVisible({ timeout: 20_000 });
    // The run record (the API read) + the timeline entry (the history read).
    const record = await newestRun(token, consumerOrgId, seed.workflowId);
    expect(record.id).toBe(run1Id);
    expect(record.state).toBe('paused');
    const history = await runHistory(token, run1Id);
    expect(history.run.state).toBe('paused');
    const pauses = history.timeline.filter((e) => e.eventName === 'workflow.run.paused');
    expect(pauses.length).toBe(1);
  });
  await shot(page, '04-user-pause-paused.png');

  // ============ LEG 7 — RESUME through the USER's control =====================
  await step('LEG7 the user clicks Resume (the generic label — not at an approval gate) → the REAL V2-005 resume command → the run returns to execution', async () => {
    const status = page.getByRole('region', { name: 'Run status' });
    await status.getByRole('button', { name: 'Resume' }).click();
    await expect(status.getByText('Running')).toBeVisible({ timeout: 20_000 });
    const record = await newestRun(token, consumerOrgId, seed.workflowId);
    expect(record.id).toBe(run1Id);
    expect(record.state).toBe('running');
    const history = await runHistory(token, run1Id);
    expect(history.run.state).toBe('running');
    const resumed = history.timeline.filter((e) => e.eventName === 'workflow.run.resumed');
    expect(resumed.length).toBe(1);
  });

  // ============ LEG 8 — WAITING: the run reaches the approval gate ============
  await step('LEG8 the run reaches the waiting-for-user/approval state: the consumer\'s own session drives the REAL pause AT the IR approval node (atStepId = review_gate) → reload → "Waiting for you"', async () => {
    await pauseAtApproval(token, run1Id);
    await page.reload();
    const status = page.getByRole('region', { name: 'Run status' });
    await expect(status.getByText('Waiting for you')).toBeVisible({ timeout: 20_000 });
    // The internal state word stays expert-only (the §15 discipline).
    await expect(status.getByText(/^paused$/)).toHaveCount(0);
  });
  await shot(page, '05-waiting-for-you.png');

  // ============ LEG 9 — APPROVE: the F-008 core (user action → execution) =====
  await step('LEG9 THE F-008 CORE: the user clicks Approve in the browser → the REAL V2-005 resume command (the resume-with-human-confirmation semantics) → the run returns to execution (verified through the history + runs reads)', async () => {
    const status = page.getByRole('region', { name: 'Run status' });
    await status.getByRole('button', { name: 'Approve' }).click();
    await expect(status.getByText('Running')).toBeVisible({ timeout: 20_000 });
    // The authoritative runs read: THIS run is running again.
    const record = await newestRun(token, consumerOrgId, seed.workflowId);
    expect(record.id).toBe(run1Id);
    expect(record.state).toBe('running');
    // The history read: the full ordered lifecycle the USER drove —
    // pause (LEG6) → resume (LEG7) → pause AT the approval node (LEG8) →
    // the user's Approve/resume (LEG9) — the timeline order proves the
    // user action returned the run to execution after the approval gate.
    const history = await runHistory(token, run1Id);
    expect(history.run.state).toBe('running');
    const ordered = history.timeline
      .filter((e) => e.eventName === 'workflow.run.paused' || e.eventName === 'workflow.run.resumed')
      .sort((a, b) => a.sequence - b.sequence);
    expect(ordered.length).toBe(4); // LEG6 pause + LEG7 resume + LEG8 approval pause + LEG9 resume
    expect(ordered[0]!.eventName).toBe('workflow.run.paused');
    expect(ordered[1]!.eventName).toBe('workflow.run.resumed');
    expect(ordered[2]!.eventName).toBe('workflow.run.paused');
    expect(ordered[2]!.detail?.atStepId).toBe(APPROVAL_STEP_ID);
    expect(ordered[3]!.eventName).toBe('workflow.run.resumed');
  });
  await shot(page, '06-approve-returned-to-execution.png');

  // ============ LEG 10 — SAFE CANCEL through the USER's control (§2.4) ========
  await step('LEG10 SAFE CANCEL: the waiting run → the user clicks Stop → the §2.4 explicit choice → Stop it → the REAL V2-005 cancel command → Cancelled with NO lifecycle control remaining', async () => {
    // Back to the approval gate, then the user's cancel journey.
    await pauseAtApproval(token, run1Id);
    await page.reload();
    const status = page.getByRole('region', { name: 'Run status' });
    await expect(status.getByText('Waiting for you')).toBeVisible({ timeout: 20_000 });

    // The explicit choice BEFORE any command.
    await status.getByRole('button', { name: 'Stop' }).click();
    await expect(
      status.getByText(/This ends the run — it can't be restarted/i),
    ).toBeVisible();
    await status.getByRole('button', { name: 'Stop it' }).click();

    // The authoritative terminal record.
    await expect(status.getByText('Cancelled')).toBeVisible({ timeout: 20_000 });
    const record = await newestRun(token, consumerOrgId, seed.workflowId);
    expect(record.id).toBe(run1Id);
    expect(record.state).toBe('cancelled');
    // Terminal honesty: NO lifecycle control remains on the cancelled run.
    await expect(status.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(status.getByRole('button', { name: 'Resume' })).toHaveCount(0);
    await expect(status.getByRole('button', { name: 'Pause' })).toHaveCount(0);
    await expect(status.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  });
  await shot(page, '07-cancelled-no-controls.png');

  // ============ LEG 11 — the honest forbidden-transition rejection ============
  await step('LEG11 BOUNDARY: a concurrently-cancelled waiting run → the user\'s stale Approve → the envelope\'s typed 409 workflow-run-terminal rejection rendered VERBATIM (never a fabricated success)', async () => {
    // A SECOND run through the real browser Run flow (the existing journey).
    await page.getByRole('button', { name: 'Run' }).first().click();
    const preview = page.getByRole('region', { name: 'Run preview' });
    await expect(preview).toBeVisible();
    await preview.getByRole('button', { name: 'Run' }).click();
    await expect(preview).toHaveCount(0, { timeout: 20_000 });
    const status = page.getByRole('region', { name: 'Run status' });
    await expect(status.getByText('Running')).toBeVisible({ timeout: 20_000 });
    const run2 = await newestRun(token, consumerOrgId, seed.workflowId);
    expect(run2.id).not.toBe(run1Id);
    expect(run2.state).toBe('running');

    // The waiting state, then a CONCURRENT cancel through the REAL route
    // (the consumer's own session — the same authority, another surface).
    await pauseAtApproval(token, run2.id);
    await page.reload();
    await expect(status.getByText('Waiting for you')).toBeVisible({ timeout: 20_000 });
    const cancelled = await api(token, 'POST', `/workflow-runs/runs/${run2.id}/cancel`, {
      ...envelope(),
      reason: 'the concurrent command from another surface',
    });
    expect(cancelled.status, JSON.stringify(cancelled.json)).toBe(200);

    // The user's (now-stale) Approve: the backend envelope REJECTS the
    // resume of a terminal run with the typed 409 — the UI renders the
    // rejection verbatim and never fakes the success.
    await status.getByRole('button', { name: 'Approve' }).click();
    const alert = status.getByRole('alert');
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toContainText("Couldn't continue this run");
    await expect(alert).toContainText('workflow-run-terminal');
    // No fabricated Running on the stale surface.
    await expect(status.getByText('Running')).toHaveCount(0);

    // The re-read record is the honest terminal state.
    await page.reload();
    await expect(status.getByText('Cancelled')).toBeVisible({ timeout: 20_000 });
    const record = await newestRun(token, consumerOrgId, seed.workflowId);
    expect(record.id).toBe(run2.id);
    expect(record.state).toBe('cancelled');
  });
  await shot(page, '08-typed-rejection-honest.png');

  // ============ LEG 12 — the envelope's idempotency (exactly-once) ============
  await step('LEG12 IDEMPOTENCY: the SAME pause envelope re-delivered through the REAL route converges (executed: false, the same run identity) and the timeline records the pause ONCE', async () => {
    // A THIRD run through the real browser Run flow.
    await page.getByRole('button', { name: 'Run' }).first().click();
    const preview = page.getByRole('region', { name: 'Run preview' });
    await expect(preview).toBeVisible();
    await preview.getByRole('button', { name: 'Run' }).click();
    await expect(preview).toHaveCount(0, { timeout: 20_000 });
    const status = page.getByRole('region', { name: 'Run status' });
    await expect(status.getByText('Running')).toBeVisible({ timeout: 20_000 });
    const run3 = await newestRun(token, consumerOrgId, seed.workflowId);
    expect(run3.id).not.toBe(run1Id);
    expect(run3.state).toBe('running');

    // The deterministic envelope — ONE command identity, delivered twice.
    const once = envelope();
    const first = await api(token, 'POST', `/workflow-runs/runs/${run3.id}/pause`, once);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.executed).toBe(true);
    expect(first.json.run.state).toBe('paused');
    const replay = await api(token, 'POST', `/workflow-runs/runs/${run3.id}/pause`, once);
    expect(replay.status, JSON.stringify(replay.json)).toBe(200);
    // The re-delivery CONVERGED: not executed again, the same run identity.
    expect(replay.json.executed).toBe(false);
    expect(replay.json.run.id).toBe(first.json.run.id);
    expect(replay.json.run.state).toBe('paused');

    // The timeline records the pause ONCE (the command log is exactly-once).
    const history = await runHistory(token, run3.id);
    const pauses = history.timeline.filter((e) => e.eventName === 'workflow.run.paused');
    expect(pauses.length).toBe(1);
  });

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
