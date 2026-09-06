/**
 * REALITY-REPAIR-009 — the real-topology browser smoke (deterministic proof
 * over the REAL deployment entry + the REAL product SPA + a REAL browser).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-009.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-010 ACCEPT;
 * GitHub dispatch Issue #30).
 *
 * Required evidence (the Work Order's own words): "Render the existing
 * V2-011 comparison payload as a human-readable node/field summary rather
 * than raw internal JSON. Preserve the authoritative comparison result and
 * explicit non-equivalence statement." — proven in the real browser on the
 * real topology, with the payload-vs-DOM contrast captured by the browser's
 * own network read (the raw envelope travels the wire; the DOM never shows
 * it), and the equivalence path proven UNCHANGED in the same journey.
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
 *     login → org → public workflow → listing → publish) and then ships TWO
 *     real updates through the REAL owner-only createVersion route: v2 (an
 *     agentic task-text change — task-surface EQUIVALENT, the regression
 *     leg) and v3 (a step input literal change — task-surface
 *     NON-equivalent, exactly the audit VER-2/F-010 divergence shape).
 *   - the CONSUMER does EVERYTHING through the real browser UI — signup
 *     included — installs version 1 from the marketplace, and reviews BOTH
 *     updates on the workflow detail's "What changed" surface.
 *
 * LEG 1  SIGNUP   — the real LoginPage's register surface lands the
 *                   consumer on Home.
 * LEG 2  ORG      — the RR-002 first-run onboarding creates the consumer's
 *                   organization through the real browser UI.
 * LEG 3  MARKET   — Explore → the listing → the entitled free decision →
 *                   the EXISTING V2-002 Install pins version 1 into the
 *                   CONSUMER org.
 * LEG 4  V2       — the publisher creates version 2 through the REAL
 *                   owner-only createVersion route (the task-text change:
 *                   digest-different, task-surface equivalent).
 * LEG 5  BANNER   — the consumer opens the detail: "An update is
 *                   available" (Version 2) + the verbatim §19 pin language.
 * LEG 6  EQUIV    — Review update → What changed: "Task-for-task
 *                   equivalent - verified" — EQUIVALENCE STAYS EQUIVALENCE
 *                   (the authority's result unchanged; no divergence
 *                   block, no raw JSON).
 * LEG 7  V3       — the publisher creates version 3 through the REAL
 *                   owner-only createVersion route (the step-input literal
 *                   change: `node fetch_tickets inputs: [...] != [...]`).
 * LEG 8  THE REPAIR — the consumer re-opens the detail → Review update →
 *                   What changed renders the HUMAN-READABLE diff (F-010):
 *                   the honest "Not equivalent" verdict, the step NAME
 *                   (the presentation label "Collect the open tickets" —
 *                   never the raw node id), the field ("its inputs"), the
 *                   two readable values, and NO raw internal JSON envelope.
 * LEG 9  WIRE/DOM — the browser's own network capture: the compare POST
 *                   hit the REAL V2-011 authority route and its RESPONSE
 *                   payload carries the raw internal envelope
 *                   (`node fetch_tickets inputs: [...] != [...]`,
 *                   equivalent: false) while the rendered DOM never shows
 *                   it — the derivation-over-payload proof.
 *
 * Every leg persists a screenshot + a sha-256 digest; the transcript lands
 * in spec/architecture/v2/dogfooding-evidence/assets/reality-repair-009/
 * (journey.json + the screenshots the evidence document references).
 *
 * Run: cd backend && bunx tsx tests/integration/deployment/run-reality-repair-009-browser-smoke.ts
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
import { chromium, expect, type Page, type Response } from '@playwright/test';
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
  'reality-repair-009',
);

const BACKEND_PORT = 3001; // the Vite dev proxy's fixed target — the REAL entry must own it.
const FRONTEND_PORT = 5188;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

const PUBLISHER_NAME = 'Petra (RR-009 publisher)';
const PUBLISHER_EMAIL = 'reality-repair-009-publisher@deployment.test';
const PUBLISHER_PASSWORD = 'the-reality-repair-009-publisher-42';
const PUBLISHER_ORG_NAME = 'RR-009 Publisher Org';

const CONSUMER_NAME = 'Ilex (RR-009 consumer)';
const CONSUMER_EMAIL = 'reality-repair-009-consumer@deployment.test';
const CONSUMER_PASSWORD = 'the-reality-repair-009-consumer-42';
const CONSUMER_ORG_NAME = 'Ilex RR-009 Consumer Org';

const WORKFLOW_NAME = 'Reality repair version digest';
const LISTING_NAME = 'RR-009 version-diff listing';

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
    file: `spec/architecture/v2/dogfooding-evidence/assets/reality-repair-009/${name}`,
    sha256: sha,
    bytes: stat.size,
  });
  console.log(`[SHOT] ${name} (${stat.size} bytes, sha-256 ${sha.slice(0, 16)}…)`);
}

/**
 * The digest workflow with presentation labels (the consumer detail
 * surface): fetch (API, the input literal that changes in v3) → scan
 * (AGENTIC, the task text that changes in v2 — task-surface EQUIVALENT)
 * → send (API).
 */
function authorSmokeWorkflow(scanTask: string, repository: string): WorkflowIrDocument {
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
        binding: { kind: 'literal', value: repository },
      },
    ],
    outputs: [{ name: 'tickets', type: { kind: 'json' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const scanBoard: WorkflowNode = {
    id: 'scan_board',
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: scanTask },
    capabilityRequirements: ['github.repository.read'],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'tickets',
        type: { kind: 'json' },
        binding: { kind: 'node_output', node: 'fetch_tickets', output: 'tickets' },
      },
    ],
    outputs: [{ name: 'digest', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
    completionEvidence: 'verification',
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
        binding: { kind: 'node_output', node: 'scan_board', output: 'digest' },
      },
    ],
    outputs: [{ name: 'messageId', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart('fetch_tickets')
    .addNode(fetchTickets)
    .addNode(scanBoard)
    .addNode(sendDigest)
    .addEdge({ from: 'fetch_tickets', to: 'scan_board', on: 'success' })
    .addEdge({ from: 'scan_board', to: 'send_digest', on: 'success' })
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
        scan_board: 'Scan the board for the digest',
        send_digest: 'Email the weekly digest',
      },
    })
    .build();
}

interface SeedFacts {
  listingId: string;
  workflowId: string;
  version1Id: string;
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

  info(`REALITY-REPAIR-009 real-deployment browser smoke starting at ${startedAt.toISOString()}`);
  info(`artifacts dir: ${ARTIFACTS_DIR}`);

  // ---- 1. The REAL deployment entry as a process (docker-compose CMD) --------
  const dataDir = mkdtempSync(join(tmpdir(), 'reality-repair-009-smoke-pglite-'));
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
    const seed = await step('seed: publisher register → login → org → public workflow (v1) → listing → publish (REAL routes; the consumer gets NOTHING pre-seeded)', async () => {
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
        slug: 'reality-repair-009-digest',
        name: WORKFLOW_NAME,
        description: 'Collect the open tickets, scan them, and email the digest.',
        visibility: 'public', // public: the marketplace publish precondition
        content: versionContentOf(
          authorSmokeWorkflow(
            'Scan the board and summarize the open tickets (v1).',
            'payswapdotorg/WorkflowOS',
          ),
        ),
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      });
      expect(wf.status, JSON.stringify(wf.json)).toBe(201);
      const workflowId = wf.json.workflow.id as string;
      const version1Id = wf.json.initialVersion.id as string;

      // The listing carries a FREE offer: the consumer's purchase path is the
      // offer acceptance (a real marketplace command), not a payment provider
      // (none is configured on this topology — honestly so).
      const listing = await api(cookie, 'POST', '/marketplace/listings', {
        organizationId: orgId,
        workflowId,
        versionId: version1Id,
        name: LISTING_NAME,
        description: 'The REALITY-REPAIR-009 representative published listing.',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      });
      expect(listing.status, JSON.stringify(listing.json)).toBe(201);
      const listingId = listing.json.listing.id as string;

      const publish = await api(cookie, 'POST', `/marketplace/listings/${listingId}/publish`);
      expect(publish.status, JSON.stringify(publish.json)).toBe(200);

      return { listingId, workflowId, version1Id, publisherCookie: cookie } satisfies SeedFacts;
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
      run: 'REALITY-REPAIR-009 real-deployment browser smoke',
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

  // ============ LEG 3 — MARKETPLACE: entitled → install (pins v1) =============
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

  // ============ LEG 4 — V2: the publisher ships the EQUIVALENT update =========
  // The task-text change (t11's own v2 pattern): digest-different (a new
  // immutable version is created), task-surface EQUIVALENT (the execution
  // mechanism is out of the comparison surface by design).
  const version2Id = await step('LEG4 the publisher creates version 2 through the REAL owner-only createVersion route (the task-text change — task-surface EQUIVALENT)', async () => {
    const v2 = await api(seed.publisherCookie, 'POST', `/workflow-repository/workflows/${seed.workflowId}/versions`, {
      content: versionContentOf(
        authorSmokeWorkflow(
          'Scan the board and summarize the open tickets (v2: a faster, focused scan).',
          'payswapdotorg/WorkflowOS',
        ),
      ),
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      parentVersionId: seed.version1Id,
    });
    expect(v2.status, JSON.stringify(v2.json)).toBe(201);
    // the REAL workflow read confirms the head moved to version 2
    const wf = await api(seed.publisherCookie, 'GET', `/workflow-repository/workflows/${seed.workflowId}`);
    expect(wf.status).toBe(200);
    expect(wf.json.workflow.headVersionId).toBe(v2.json.version.id);
    expect(wf.json.workflow.headVersionId).not.toBe(seed.version1Id);
    return v2.json.version.id as string;
  });

  // ============ LEG 5 — the §19 update banner =================================
  await step('LEG5 the consumer opens the workflow detail: "An update is available" (Version 2) + the verbatim installed pin + the no-silent-change promise', async () => {
    await page.goto(`${FRONTEND_URL}/workflows/${seed.workflowId}`);
    await expect(
      page.getByRole('heading', { name: WORKFLOW_NAME }),
    ).toBeVisible({ timeout: 20_000 });
    const update = page.getByRole('region', { name: 'Update available' });
    await expect(update.getByText(/an update is available/i)).toBeVisible({ timeout: 20_000 });
    await expect(update.getByText(/version 2/i)).toBeVisible();
    await expect(update.getByText(/your installed version: version 1/i)).toBeVisible();
    await expect(
      update.getByText(/nothing changes until you approve the update/i),
    ).toBeVisible();
  });

  // ============ LEG 6 — EQUIVALENCE STAYS EQUIVALENCE (the regression) ========
  await step('LEG6 Review update → What changed: "Task-for-task equivalent - verified" (the authority\'s equivalent result, UNCHANGED by this repair — no divergence block, no raw JSON)', async () => {
    const update = page.getByRole('region', { name: 'Update available' });
    await update.getByRole('button', { name: /review update/i }).click();
    await expect(
      update.getByText(/task-for-task equivalent - verified/i),
    ).toBeVisible({ timeout: 20_000 });
    await expect(update.getByText(/where the versions differ/i)).toHaveCount(0);
    await expect(update.getByText(/not equivalent/i)).toHaveCount(0);
    // the honest estimates still render (correctness first, then estimates)
    await expect(update.getByText(/estimates, not measurements/i)).toBeVisible();
    // no raw envelope on the equivalence path either
    await expect(update).not.toContainText('!=');
    await shot(page, '03-equivalent-what-changed.png');
  });

  // ============ LEG 7 — V3: the publisher ships the NON-EQUIVALENT update =====
  // The step-input literal change: exactly the audit VER-2/F-010 divergence
  // shape — the comparison authority reports
  // `node fetch_tickets inputs: [...] != [...]`.
  await step('LEG7 the publisher creates version 3 through the REAL owner-only createVersion route (the step-input literal change — task-surface NON-equivalent)', async () => {
    const v3 = await api(seed.publisherCookie, 'POST', `/workflow-repository/workflows/${seed.workflowId}/versions`, {
      content: versionContentOf(
        authorSmokeWorkflow(
          'Scan the board and summarize the open tickets (v2: a faster, focused scan).',
          'pectoraux/WorkflowOS',
        ),
      ),
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      parentVersionId: version2Id,
    });
    expect(v3.status, JSON.stringify(v3.json)).toBe(201);
    const wf = await api(seed.publisherCookie, 'GET', `/workflow-repository/workflows/${seed.workflowId}`);
    expect(wf.status).toBe(200);
    expect(wf.json.workflow.headVersionId).toBe(v3.json.version.id);
  });

  // ============ LEG 8 — THE F-010 REPAIR (the human-readable diff) ============
  // Arm the browser's own network capture BEFORE the navigation: every
  // workflow-optimization/compare response is kept for the LEG 9 proof.
  const compareResponses: Response[] = [];
  page.on('response', (res) => {
    if (res.url().includes('/api/workflow-optimization/compare')) {
      compareResponses.push(res);
    }
  });

  await step('LEG8 the consumer re-opens the detail → Review update → What changed renders the HUMAN-READABLE diff (F-010): the verdict, the step NAME, the field, the readable values — NO raw internal JSON envelope', async () => {
    await page.goto(`${FRONTEND_URL}/workflows/${seed.workflowId}`);
    const update = page.getByRole('region', { name: 'Update available' });
    await expect(update.getByText(/an update is available/i)).toBeVisible({ timeout: 20_000 });
    await expect(update.getByText(/version 3/i)).toBeVisible();
    await update.getByRole('button', { name: /review update/i }).click();

    // The honest verdict first — the authority's own non-equivalence,
    // stated explicitly (never buried, never softened).
    await expect(update.getByText('Not equivalent', { exact: true })).toBeVisible({ timeout: 20_000 });

    // The node/field NAMES: the presentation label (never the raw node id)
    // + the divergent field as consumer words.
    await expect(
      update.getByText(/where the versions differ: the step "collect the open tickets" — its inputs/i),
    ).toBeVisible();

    // The two values, readable (names and values — not JSON blobs).
    await expect(
      update.getByText(/^installed version:/i),
    ).toContainText('value: payswapdotorg/WorkflowOS');
    await expect(update.getByText(/^installed version:/i)).toContainText('name: repository');
    await expect(
      update.getByText(/^new version:/i),
    ).toContainText('value: pectoraux/WorkflowOS');

    // NO raw internal JSON envelope anywhere in the rendered surface: no
    // `!=` blob, no JSON.stringify'd payload, no raw node-id transport head.
    await expect(update).not.toContainText('!=');
    await expect(update).not.toContainText('node fetch_tickets inputs:');
    await expect(update).not.toContainText('"kind"');
    await expect(update).not.toContainText('"literal"');
    await expect(update).not.toContainText('fetch_tickets');

    // Correctness first, then the estimates — and the explicit adoption
    // gate still hangs off the comparison (no semantics change).
    await expect(update.getByText(/estimates, not measurements/i)).toBeVisible();
    await expect(update.getByRole('button', { name: /approve update/i })).toBeVisible();
    await shot(page, '04-human-readable-what-changed.png');
  });

  // ============ LEG 9 — WIRE vs DOM (the derivation-over-payload proof) ======
  await step('LEG9 the browser network capture: the REAL V2-011 compare route answered (the payload itself carries the raw internal envelope + equivalent:false) while the rendered DOM never shows it', async () => {
    // the compare POSTs were issued against the REAL authority route
    expect(compareResponses.length).toBeGreaterThan(0);
    const domText = await page.getByRole('region', { name: 'Update available' }).innerText();
    for (const res of compareResponses) {
      expect(res.request().method()).toBe('POST');
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        comparison: { correctness: { equivalent: boolean; firstDivergence: string | null } };
      };
      // the PAYLOAD is the authority's own raw shape — non-equivalent, with
      // the internal envelope the transport carries …
      expect(body.comparison.correctness.equivalent).toBe(false);
      const divergence = body.comparison.correctness.firstDivergence;
      expect(typeof divergence).toBe('string');
      expect(divergence).toMatch(/^node fetch_tickets inputs: /);
      expect(divergence).toContain(' != ');
      expect(divergence).toContain('"kind"');
      // … while the rendered DOM (LEG 8) never shows any of it.
      expect(domText).not.toContain(divergence);
      expect(domText).not.toContain('!=');
      expect(domText).not.toContain('"kind"');
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
