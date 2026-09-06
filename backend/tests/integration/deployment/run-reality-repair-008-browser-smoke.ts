/**
 * REALITY-REPAIR-008 — the real-topology teaching-feedback browser smoke
 * (deterministic proof over the REAL deployment entry + the REAL product
 * SPA + a REAL browser). COMMITTED, NEVER RUN by this worker — the
 * orchestrator owns the run (port discipline: :3001/:5188).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-008.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-009 ACCEPT;
 * GitHub dispatch Issue #29).
 *
 * Required evidence (the Work Order's own words): "the known
 * `collect_posts` feedback case names `collect_posts`, not
 * `send_report`, while all lesson/assessment evidence remains
 * unchanged."
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
 *   - the PUBLISHER is seeded through the REAL HTTP routes only
 *     (register → login → org → public workflow → free listing →
 *     publish) with the audit's TEACH-2 topology: the two-step workflow
 *     `collect_posts` → `send_report`. The learner's journey never
 *     depends on any other fixture.
 *   - the LEARNER does EVERYTHING through the real browser UI — signup
 *     included — reaching the practice-feedback moment through the real
 *     teaching flow:
 *
 *   LEG 1  SIGNUP   — the real LoginPage's register surface lands the
 *                     learner on Home.
 *   LEG 2  ORG      — the RR-002 first-run onboarding creates the
 *                     learner's organization through the real browser UI
 *                     (the composed precondition of the marketplace
 *                     journey).
 *   LEG 3  MARKET   — Explore → the listing → the entitled free decision
 *                     → the EXISTING V2-002 Install pins version 1 into
 *                     the LEARNER's org.
 *   LEG 4  TEACH    — the library's Installed tab → Open: the cross-org
 *                     detail loads → Teach Me opens beside Run; the
 *                     session create-or-converges bound to the pinned
 *                     version.
 *   LEG 5  LESSON   — Start lesson → the REAL derived lesson (Step 1 of
 *                     2 — the presentation label) → "I've done it" × 2
 *                     → All steps confirmed (the §12 checkpoint flow
 *                     unchanged).
 *   LEG 6  THE PRACTICE MOMENT (F-009's exact scenario) — the authority's
 *                     own practice questions render (the collect_posts
 *                     question + the send_report question). The learner
 *                     attempts the send_report question FIRST with a
 *                     wrong answer: the REAL authority answers with its
 *                     verbatim feedback for the ATTEMPTED step — and in
 *                     the real rendered DOM the collect_posts question's
 *                     section carries NO feedback naming send_report (at
 *                     base the one question-unscoped feedback state
 *                     rendered inside EVERY practice section — the
 *                     audited defect).
 *   LEG 7  THE KNOWN CASE (the Work Order's required regression) — the
 *                     learner answers the collect_posts question itself:
 *                     the feedback under the collect_posts question names
 *                     `collect_posts` (the authority's own string for
 *                     THAT attempt) and NOT send_report; the send_report
 *                     question keeps its OWN feedback; the real wire
 *                     carries nodeId collect_posts.
 *   LEG 8  EVIDENCE UNCHANGED — the assessment surface ("Show you know
 *                     it") renders as before; the learner submits the
 *                     real assessment (order + declared semantics) →
 *                     "Lesson complete" (terminal) → the teaching
 *                     evidence surface renders with its §12 separation
 *                     vocabulary — all lesson/assessment evidence
 *                     unchanged by the repair.
 *
 * Every leg persists a screenshot + a sha-256 digest; the transcript lands
 * in spec/architecture/v2/dogfooding-evidence/assets/reality-repair-008/
 * (journey.json + the screenshots the evidence document references).
 *
 * Run: cd backend && bunx tsx tests/integration/deployment/run-reality-repair-008-browser-smoke.ts
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
import { chromium, expect, type Page } from '@playwright/test';
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
  'reality-repair-008',
);

const BACKEND_PORT = 3001; // the Vite dev proxy's fixed target — the REAL entry must own it.
const FRONTEND_PORT = 5188;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

const PUBLISHER_NAME = 'Perrin (RR-008 publisher)';
const PUBLISHER_EMAIL = 'reality-repair-008-publisher@deployment.test';
const PUBLISHER_PASSWORD = 'the-reality-repair-publisher-42';
const PUBLISHER_ORG_NAME = 'RR-008 Publisher Org';

const LEARNER_NAME = 'Ilex (RR-008 learner)';
const LEARNER_EMAIL = 'reality-repair-008-learner@deployment.test';
const LEARNER_PASSWORD = 'the-reality-repair-learner-42';
const LEARNER_ORG_NAME = 'Ilex Learner Org';

const WORKFLOW_NAME = 'Weekly social media report';
const LISTING_NAME = 'RR-008 teaching listing';

/** The audit's TEACH-2 topology: collect_posts → send_report. */
const COLLECT_NODE_ID = 'collect_posts';
const SEND_NODE_ID = 'send_report';
const COLLECT_LABEL = 'Collect the open posts';
const SEND_LABEL = 'Email the weekly report';
const COLLECT_SEMANTICS = 'github.repository.read';
const SEND_SEMANTICS = 'messaging.send';

/** The authority's own fixed practice-feedback templates (V2-006). */
const collectCorrectFeedback = `Correct: the workflow declares exactly this semantics for step "${COLLECT_NODE_ID}".`;
const sendIncorrectFeedback = `Not the workflow declaration for step "${SEND_NODE_ID}". The workflow declares: "${SEND_SEMANTICS}". (The correction quotes the workflow own declared semantics.)`;

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
    file: `spec/architecture/v2/dogfooding-evidence/assets/reality-repair-008/${name}`,
    sha256: sha,
    bytes: stat.size,
  });
  console.log(`[SHOT] ${name} (${stat.size} bytes, sha-256 ${sha.slice(0, 16)}…)`);
}

/** The TEACH-2 digest fixture with presentation labels (the lesson surface). */
function authorSmokeWorkflow(): WorkflowIrDocument {
  const collectPosts: WorkflowNode = {
    id: COLLECT_NODE_ID,
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: COLLECT_SEMANTICS },
    capabilityRequirements: [COLLECT_SEMANTICS],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'query',
        type: { kind: 'string' },
        binding: { kind: 'literal', value: 'reality-repair-008' },
      },
    ],
    outputs: [{ name: 'posts', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const sendReport: WorkflowNode = {
    id: SEND_NODE_ID,
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: SEND_SEMANTICS },
    capabilityRequirements: [SEND_SEMANTICS],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: COLLECT_NODE_ID, output: 'posts' },
      },
    ],
    outputs: [{ name: 'messageId', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart(COLLECT_NODE_ID)
    .addNode(collectPosts)
    .addNode(sendReport)
    .addEdge({ from: COLLECT_NODE_ID, to: SEND_NODE_ID, on: 'success' })
    .addWorkflowOutput({
      name: 'messageId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: SEND_NODE_ID, output: 'messageId' },
    })
    .withDefaultPlacement('any_supported_node')
    .withProvenance({ origin: 'authored' })
    .withPresentation({
      title: WORKFLOW_NAME,
      nodeLabels: {
        [COLLECT_NODE_ID]: COLLECT_LABEL,
        [SEND_NODE_ID]: SEND_LABEL,
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

  info(`REALITY-REPAIR-008 real-deployment teaching-feedback smoke starting at ${startedAt.toISOString()}`);
  info(`artifacts dir: ${ARTIFACTS_DIR}`);

  // ---- 1. The REAL deployment entry as a process (docker-compose CMD) --------
  const dataDir = mkdtempSync(join(tmpdir(), 'reality-repair-008-smoke-pglite-'));
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
    //         The LEARNER is NOT seeded: their entire journey happens through
    //         the real browser UI. -----------------------------------------------
    const seed = await step('seed: publisher register → login → org → public workflow (collect_posts → send_report) → free listing → publish (REAL routes; the learner gets NOTHING pre-seeded)', async () => {
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
        slug: 'reality-repair-008-social-report',
        name: WORKFLOW_NAME,
        description: 'Collect the open posts and email the weekly report.',
        visibility: 'public', // public: the marketplace publish precondition
        content: versionContentOf(authorSmokeWorkflow()),
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      });
      expect(wf.status, JSON.stringify(wf.json)).toBe(201);
      const workflowId = wf.json.workflow.id as string;
      const versionId = wf.json.initialVersion.id as string;

      // The listing carries a FREE offer: the learner's acquisition path is
      // the offer acceptance (a real marketplace command), not a payment
      // provider (none is configured on this topology — honestly so).
      const listing = await api(cookie, 'POST', '/marketplace/listings', {
        organizationId: orgId,
        workflowId,
        versionId,
        name: LISTING_NAME,
        description: 'The REALITY-REPAIR-008 representative published listing (the teaching topology).',
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
    exitCode = await journey(page, seed);
  } catch (err) {
    console.log(`\n[JOURNEY FAILED] ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    const finishedAt = new Date();
    const summary = {
      run: 'REALITY-REPAIR-008 real-deployment teaching-feedback smoke',
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

/** The practice-question section whose prompt names `nodeId` (the authority's own prompt). */
function practiceSection(page: Page, nodeId: string) {
  return page
    .getByRole('region', { name: 'Practice' })
    .filter({ hasText: `assign to step "${nodeId}"` });
}

async function journey(page: Page, seed: SeedFacts): Promise<number> {
  // ============ LEG 1 — SIGNUP (the real register surface) ====================
  await step('LEG1 the learner signs up through the real register UI (Create one → Create account) and lands on Home', async () => {
    await page.goto(`${FRONTEND_URL}/`);
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill(LEARNER_NAME);
    await page.locator('#email').fill(LEARNER_EMAIL);
    await page.locator('#password').fill(LEARNER_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible();
  });

  // ============ LEG 2 — ORG: the composed RR-002 onboarding ===================
  await step('LEG2 the learner creates their organization through the real Home onboarding (the RR-002 composed precondition)', async () => {
    await page.locator('#organization-name').fill(LEARNER_ORG_NAME);
    await page.getByRole('button', { name: 'Create organization' }).click();
    await expect(
      page.getByRole('region', { name: 'Organization onboarding' }),
    ).toHaveCount(0);
  });

  // ============ LEG 3 — MARKETPLACE: entitled → install =======================
  await step('LEG3 Explore → the listing → the entitled free decision → Install pins version 1 into the LEARNER organization', async () => {
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
  await shot(page, '01-learner-installed.png');

  // ============ LEG 4 — TEACH: open the real lesson surface ===================
  // Arm the network capture for the whole teaching journey (the wire proof
  // of LEG7: the practice POST carries the step actually being assessed).
  const practiceCalls: Array<{ nodeId: string; answer: string }> = [];
  const onRequest = (req: import('@playwright/test').Request) => {
    if (
      req.method() === 'POST' &&
      req.url().includes('/api/teaching-sessions/sessions/') &&
      req.url().endsWith('/practice')
    ) {
      const data = req.postDataJSON() as { nodeId?: unknown; answer?: unknown } | null;
      practiceCalls.push({
        nodeId: String(data?.nodeId ?? ''),
        answer: String(data?.answer ?? ''),
      });
    }
  };
  page.on('request', onRequest);

  await step('LEG4 the library Installed tab → Open: the cross-org detail loads → Teach Me opens; the session create-or-converges bound to the pinned version', async () => {
    await page.goto(`${FRONTEND_URL}/workflows`);
    await page.getByRole('tab', { name: 'Installed' }).click();
    const panel = page.getByRole('tabpanel');
    await expect(
      panel.getByRole('heading', { name: 'Installed workflow' }),
    ).toBeVisible({ timeout: 20_000 });
    await panel.getByRole('link', { name: 'Open' }).click();
    // The cross-org public workflow detail LOADS (the RR-003 repair — the
    // composed precondition of the teaching surface).
    await expect(
      page.getByRole('heading', { name: WORKFLOW_NAME }),
    ).toBeVisible({ timeout: 20_000 });
    // Teach Me opens beside Run (§12 first-class).
    await page.getByRole('button', { name: 'Teach Me' }).click();
    const teach = page.getByRole('region', { name: 'Teach Me' });
    await expect(teach).toBeVisible();
    await expect(teach.getByText(/You'll learn to do this yourself/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(teach.getByText(/Version 1 — the lesson is bound to it/i)).toBeVisible();
  });

  // ============ LEG 5 — LESSON: the real checkpoint flow (unchanged) ==========
  await step('LEG5 Start lesson → the REAL derived lesson (Step 1 of 2 — the presentation label) → "I\'ve done it" × 2 → All steps confirmed', async () => {
    const teach = page.getByRole('region', { name: 'Teach Me' });
    await teach.getByRole('button', { name: 'Start lesson' }).click();
    await expect(teach.getByText(`Step 1 of 2 — ${COLLECT_LABEL}`)).toBeVisible({
      timeout: 20_000,
    });
    await teach.getByRole('button', { name: "I've done it" }).click();
    await expect(teach.getByText(`Step 2 of 2 — ${SEND_LABEL}`)).toBeVisible({
      timeout: 20_000,
    });
    await teach.getByRole('button', { name: "I've done it" }).click();
    await expect(teach.getByText(/All steps confirmed/i)).toBeVisible({ timeout: 20_000 });
  });

  // ============ LEG 6 — THE PRACTICE MOMENT (F-009's exact scenario) ==========
  // The learner attempts the send_report question FIRST (wrong answer): the
  // REAL authority answers with its verbatim feedback for the ATTEMPTED step
  // — and the collect_posts question's section must carry NO feedback naming
  // send_report. At base the single question-unscoped feedback state rendered
  // inside EVERY practice section: the audited defect.
  await step('LEG6 the practice moment: after the send_report attempt, the collect_posts question carries NO send_report feedback in the real DOM (the send_report question shows its own verbatim feedback)', async () => {
    // The authority's own questions render (one per lesson step).
    const collectQuestion = practiceSection(page, COLLECT_NODE_ID);
    const sendQuestion = practiceSection(page, SEND_NODE_ID);
    await expect(collectQuestion).toBeVisible({ timeout: 20_000 });
    await expect(sendQuestion).toBeVisible();

    // No feedback anywhere before any attempt.
    await expect(collectQuestion.getByText(/for step "/)).toHaveCount(0);
    await expect(sendQuestion.getByText(/for step "/)).toHaveCount(0);

    // The send_report question is answered WRONG (the collect semantics).
    await sendQuestion
      .getByRole('radio', { name: COLLECT_SEMANTICS })
      .check();
    await sendQuestion.getByRole('button', { name: 'Check' }).click();

    // The REAL authority feedback for the ATTEMPTED step — verbatim, under
    // its own question.
    await expect(sendQuestion.getByText(sendIncorrectFeedback)).toBeVisible({
      timeout: 20_000,
    });

    // THE F-009 PROOF: the collect_posts question's section carries NO
    // feedback naming send_report (at base the shared feedback rendered
    // here — the audited wrong step reference).
    await expect(collectQuestion.getByText(/for step "send_report"/)).toHaveCount(0);
    // And no feedback at all — the question was never attempted.
    await expect(collectQuestion.getByText(/for step "/)).toHaveCount(0);
    // The wire: the send attempt carried the step actually being assessed.
    expect(practiceCalls, `practice calls: ${JSON.stringify(practiceCalls)}`).toContainEqual({
      nodeId: SEND_NODE_ID,
      answer: COLLECT_SEMANTICS,
    });
  });
  await shot(page, '02-practice-scoped-feedback.png');

  // ============ LEG 7 — THE KNOWN CASE (the required regression) =============
  // The learner answers the collect_posts question itself: the feedback under
  // the collect_posts question names collect_posts — NOT send_report.
  await step('LEG7 the known case: the collect_posts answer feedback names collect_posts (the authority own string for THAT attempt); the send_report question keeps its OWN feedback; the wire carries nodeId collect_posts', async () => {
    const collectQuestion = practiceSection(page, COLLECT_NODE_ID);
    const sendQuestion = practiceSection(page, SEND_NODE_ID);

    // The correct declared semantics for the collect_posts question.
    await collectQuestion
      .getByRole('radio', { name: COLLECT_SEMANTICS })
      .check();
    await collectQuestion.getByRole('button', { name: 'Check' }).click();

    // THE REQUIRED REGRESSION, in the real rendered DOM: the feedback under
    // the collect_posts question names collect_posts — the authority's own
    // string for THAT attempt, verbatim.
    await expect(collectQuestion.getByText(collectCorrectFeedback)).toBeVisible({
      timeout: 20_000,
    });
    expect(collectCorrectFeedback).toContain(`for step "${COLLECT_NODE_ID}"`);

    // …and NOT send_report (the audit's exact wrong reference).
    await expect(collectQuestion.getByText(/for step "send_report"/)).toHaveCount(0);

    // The derivation rule, in the real DOM: the send_report question KEEPS
    // its own feedback after the collect_posts attempt (each question's
    // section shows the feedback of the step actually being assessed).
    await expect(sendQuestion.getByText(sendIncorrectFeedback)).toBeVisible();
    await expect(sendQuestion.getByText(/for step "collect_posts"/)).toHaveCount(0);

    // The wire: the collect attempt carried the step actually being
    // assessed (the template's step reference is the authority's own
    // nodeId, never another question's).
    expect(practiceCalls, `practice calls: ${JSON.stringify(practiceCalls)}`).toContainEqual({
      nodeId: COLLECT_NODE_ID,
      answer: COLLECT_SEMANTICS,
    });
  });
  await shot(page, '03-collect-feedback-names-collect.png');

  // ============ LEG 8 — LESSON/ASSESSMENT EVIDENCE UNCHANGED ==================
  // The §12 assessment + completion + evidence surfaces behave exactly as
  // before the repair (the Work Order: "all lesson/assessment evidence
  // remains unchanged").
  await step('LEG8 the assessment → Lesson complete (terminal) → the teaching evidence separation vocabulary — all lesson/assessment evidence unchanged', async () => {
    const teach = page.getByRole('region', { name: 'Teach Me' });

    // The assessment surface renders as before.
    const assessment = teach.getByRole('region', { name: 'Show you know it' });
    await expect(assessment).toBeVisible({ timeout: 20_000 });

    // Order the steps + recall each step's declared semantics (the exact
    // tokens practice taught — the authority's exact-token grading).
    await assessment.getByLabel(`Position of ${COLLECT_LABEL}`).selectOption('1');
    await assessment.getByLabel(`Position of ${SEND_LABEL}`).selectOption('2');
    await assessment.getByLabel(`What does ${COLLECT_LABEL} do?`).fill(COLLECT_SEMANTICS);
    await assessment.getByLabel(`What does ${SEND_LABEL} do?`).fill(SEND_SEMANTICS);
    await assessment.getByRole('button', { name: 'Submit' }).click();

    // Terminal: Lesson complete — no lifecycle commands remain.
    await expect(teach.getByText('Lesson complete')).toBeVisible({ timeout: 20_000 });
    await expect(teach.getByRole('button', { name: 'Pause' })).toHaveCount(0);
    await expect(teach.getByRole('button', { name: "I've done it" })).toHaveCount(0);

    // Teaching evidence: the DISTINCT surface (never execution vocabulary).
    const evidence = teach.getByRole('region', { name: 'Teaching evidence' });
    await expect(evidence).toBeVisible();
    await expect(evidence.getByText(/kept separate from run evidence/i)).toBeVisible();

    // Learning never executed the workflow (the §12/§13 structural
    // guarantee, asserted against the authoritative read).
    const token = (await contextCookies(page)).find((c) => c.name === 'wfos_session')?.value ?? '';
    expect(token).not.toBe('');
    const orgs = await api(token, 'GET', '/organizations');
    expect(orgs.status).toBe(200);
    const learnerOrgId = (orgs.json.organizations as Array<{ id: string }>)[0]?.id ?? '';
    expect(learnerOrgId).not.toBe('');
    const runs = await api(
      token,
      'GET',
      `/organizations/${learnerOrgId}/workflow-runs/runs`,
    );
    expect(runs.status).toBe(200);
    const mine = ((runs.json.runs as Array<{ workflowId: string }>) ?? []).filter(
      (r) => r.workflowId === seed.workflowId,
    );
    expect(mine).toHaveLength(0);
  });
  await shot(page, '04-lesson-complete.png');

  page.off('request', onRequest);
  return 0;
}

/** The session cookies of the page's browser context (the REAL session). */
async function contextCookies(page: Page) {
  return await page.context().cookies(FRONTEND_URL);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
