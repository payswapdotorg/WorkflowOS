/**
 * REALITY-REPAIR-004 — the real-topology browser smoke (deterministic proof
 * over the REAL deployment entry + the REAL product SPA + a REAL browser).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-004.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-004a ACCEPT +
 * F-004b composition-only expert authoring; GitHub dispatch Issue #25).
 *
 * Required evidence (the Work Order's own words): "Browser proof of truthful
 * creation boundary and successful manual expert authoring/version creation
 * against real V2 routes; deterministic validation; regression of existing
 * creation/install/fork flows; exact-head review."
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
 * Persona: ONE EXPERT USER does EVERYTHING through the real browser UI —
 * signup included. Nothing is pre-seeded: no publisher, no workflow, no
 * listing (this slice's journeys do not need the marketplace; the existing
 * creation/install/fork regression is carried by the deterministic suites
 * and the e2e-browser battery).
 *
 *   LEG 1  SIGNUP   — the real LoginPage's register surface lands the
 *                     expert on Home.
 *   LEG 2  ORG      — the RR-002 first-run onboarding creates the expert's
 *                     organization through the real browser UI (the
 *                     composed precondition of the org-scoped create).
 *   LEG 3  BOUNDARY — /create (Tell): capture → Continue to preview → the
 *                     TRUTHFUL creation boundary renders (F-004a): the
 *                     corrected copy ("Natural-language capture isn't
 *                     converted into executable WorkflowIR", "Durable
 *                     creation isn't available for captured input",
 *                     "Nothing is committed"), NO false promise, and the
 *                     browser's own network capture proves ZERO create
 *                     POSTs ever left the captured-input flow.
 *   LEG 4  EXPERT   — the boundary's expert entry navigates to /expert:
 *                     the bounded authoring surface renders (the org
 *                     selection auto-resolved, the EMPTY WorkflowIR editor,
 *                     the honest "generates nothing" copy).
 *   LEG 5  CREATE   — the expert authors the WorkflowIR document DIRECTLY
 *                     (the textarea) + the metadata → Create workflow →
 *                     the REAL V2-002 createWorkflow route creates the
 *                     workflow with immutable Version 1; the created
 *                     facts render FROM THE RESPONSE, and the REAL routes
 *                     resolve the SAME facts (workflow read + versions
 *                     read, digest-verified).
 *   LEG 6  VERSION  — the second EXISTING command: the version surface
 *                     (workflow id carried forward) + a second authored
 *                     WorkflowIR document → Create version → the REAL
 *                     V2-002 createVersion route creates Version 2; the
 *                     API reads confirm 2 versions and the workflow's
 *                     headVersionId moved to the new version.
 *   LEG 7  LIBRARY  — the existing library/detail journey for the CREATED
 *                     workflow: /workflows lists it (My Workflows), Open
 *                     loads the detail (heading, description, Private
 *                     line, the presentation-label steps of the head
 *                     version, Version 2 — immutable, the honest no-install
 *                     state, the 2-entry version history — no error state).
 *
 * Every leg persists a screenshot + a sha-256 digest; the transcript lands
 * in spec/architecture/v2/dogfooding-evidence/assets/reality-repair-004/
 * (journey.json + the screenshots the evidence document references).
 *
 * Run: cd backend && bunx tsx tests/integration/deployment/run-reality-repair-004-browser-smoke.ts
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
  serializeWorkflowIrDocument,
  type WorkflowIrDocument,
  type WorkflowNode,
} from '../../../src/workflow-ir/index.js';

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
  'reality-repair-004',
);

const BACKEND_PORT = 3001; // the Vite dev proxy's fixed target — the REAL entry must own it.
const FRONTEND_PORT = 5188;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

const EXPERT_NAME = 'Mat (RR-004 expert author)';
const EXPERT_EMAIL = 'reality-repair-004-expert@deployment.test';
const EXPERT_PASSWORD = 'the-reality-repair-expert-42';
const EXPERT_ORG_NAME = 'RR-004 Expert Org';

const WORKFLOW_NAME = 'Expert-authored reality digest';
const WORKFLOW_SLUG = 'rr004-expert-authored-digest';
const WORKFLOW_DESCRIPTION = 'The workflow this smoke authors as an expert, directly as WorkflowIR.';

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
    file: `spec/architecture/v2/dogfooding-evidence/assets/reality-repair-004/${name}`,
    sha256: sha,
    bytes: stat.size,
  });
  console.log(`[SHOT] ${name} (${stat.size} bytes, sha-256 ${sha.slice(0, 16)}…)`);
}

/**
 * The WorkflowIR document the EXPERT authors by hand — built here only so
 * the smoke can TYPE the exact JSON into the editor (the browser journey
 * itself never imports any authoring authority: the textarea receives the
 * text exactly as a human would paste it).
 *
 * Variant 1 → Version 1; variant 2 changes the presentation labels (a
 * different content digest, so the version command creates a NEW immutable
 * version instead of converging).
 */
function authorIrDocument(variant: 1 | 2): WorkflowIrDocument {
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
      nodeLabels:
        variant === 1
          ? {
              fetch_tickets: 'Collect the open tickets',
              send_digest: 'Email the digest',
            }
          : {
              fetch_tickets: 'Collect the fresh tickets',
              send_digest: 'Email the digest, sorted',
            },
    })
    .build();
}

/** A JSON call against the REAL entry (the verification channel — same session cookie). */
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

  info(`REALITY-REPAIR-004 real-deployment browser smoke starting at ${startedAt.toISOString()}`);
  info(`artifacts dir: ${ARTIFACTS_DIR}`);

  // ---- 1. The REAL deployment entry as a process (docker-compose CMD) --------
  const dataDir = mkdtempSync(join(tmpdir(), 'reality-repair-004-smoke-pglite-'));
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

    // ---- 3. A REAL browser against the REAL topology -------------------------
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      baseURL: FRONTEND_URL,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    exitCode = await journey(page, context);
  } catch (err) {
    console.log(`\n[JOURNEY FAILED] ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    const finishedAt = new Date();
    const summary = {
      run: 'REALITY-REPAIR-004 real-deployment browser smoke',
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

async function journey(page: Page, context: BrowserContext): Promise<number> {
  // ============ LEG 1 — SIGNUP (the real register surface) ====================
  await step('LEG1 the expert signs up through the real register UI (Create one → Create account) and lands on Home', async () => {
    await page.goto(`${FRONTEND_URL}/`);
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill(EXPERT_NAME);
    await page.locator('#email').fill(EXPERT_EMAIL);
    await page.locator('#password').fill(EXPERT_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible();
  });

  // ============ LEG 2 — ORG: the composed RR-002 onboarding ===================
  await step('LEG2 the expert creates their organization through the real Home onboarding (the RR-002 composed precondition)', async () => {
    await page.locator('#organization-name').fill(EXPERT_ORG_NAME);
    await page.getByRole('button', { name: 'Create organization' }).click();
    await expect(
      page.getByRole('region', { name: 'Organization onboarding' }),
    ).toHaveCount(0);
  });
  await shot(page, '01-expert-org-created.png');

  // ============ LEG 3 — the TRUTHFUL creation boundary (F-004a) ==============
  // The network capture is armed BEFORE the navigation: the proof is that
  // the captured-input flow NEVER sends a create POST (F-T5-001 preserved).
  const boundaryRequests: string[] = [];
  const onBoundaryRequest = (req: import('@playwright/test').Request) => {
    boundaryRequests.push(`${req.method()} ${req.url()}`);
  };
  page.on('request', onBoundaryRequest);

  await step('LEG3 /create (Tell): capture → preview → the TRUTHFUL boundary renders (corrected copy, the expert entry) and ZERO create POSTs leave the captured-input flow', async () => {
    await page.goto(`${FRONTEND_URL}/create?mode=tell`);
    const box = page.getByRole('textbox', { name: /describe what you want done/i });
    await box.fill('Every morning, collect the open tickets and email me the digest.');
    await page.getByRole('button', { name: 'Continue to preview' }).click();
    await expect(
      page.getByRole('heading', { name: /here's what i understood/i }),
    ).toBeVisible();
    // The truthful limitation (F-004a): natural-language capture is NOT
    // converted into executable WorkflowIR.
    await expect(
      page.getByText(/natural-language capture isn't converted into executable workflowir/i),
    ).toBeVisible();
    await expect(page.getByText(/no generation authority exists/i)).toBeVisible();
    await expect(page.getByText(/nothing is created from this page/i)).toBeVisible();
    // The false promise is GONE (the defect's own sentence).
    await expect(
      page.getByText(/executable authoring happens later/i),
    ).toHaveCount(0);
    await expect(page.getByText(/durable workflow is created with immutable version 1/i)).toHaveCount(0);
    // The boundary card: fail-closed for captured input + the REAL expert
    // entry (Slice B).
    await expect(
      page.getByText(/durable creation isn't available for captured input/i),
    ).toBeVisible();
    await expect(page.getByText(/nothing is committed/i)).toBeVisible();
    const expertEntry = page.getByRole('link', {
      name: /author a workflow in the expert workspace/i,
    });
    await expect(expertEntry).toBeVisible();
    await expect(expertEntry).toHaveAttribute('href', '/expert');
  });
  await shot(page, '02-create-boundary-truthful.png');

  await step('LEG3b the browser network capture: ZERO workflow-repository commands during the whole captured-input journey', async () => {
    const commands = boundaryRequests.filter(
      (u) => u.startsWith('POST') && u.includes('/api/workflow-repository/'),
    );
    expect(
      commands,
      `workflow-repository commands issued during the captured-input journey: ${commands.join(', ')}`,
    ).toEqual([]);
    page.off('request', onBoundaryRequest);
  });

  // ============ LEG 4 — EXPERT: the bounded authoring surface =================
  await step('LEG4 the boundary entry navigates to /expert: the bounded authoring surface renders (org auto-resolved, the EMPTY WorkflowIR editor, the honest no-generation copy)', async () => {
    await page.getByRole('link', { name: /author a workflow in the expert workspace/i }).click();
    const surface = page.getByRole('region', { name: 'Expert workflow authoring' });
    await expect(surface).toBeVisible();
    // The honest bounded-authoring copy.
    await expect(surface.getByText(/generates nothing/i)).toBeVisible();
    await expect(surface.getByText(/author the workflowir document/i)).toBeVisible();
    // The org selection (the product-shell selection, auto-resolved to the
    // onboarding org).
    const orgSelect = surface.getByLabel('For organization');
    await expect(orgSelect).toHaveValue(
      await (async () => {
        const token = await sessionToken(context);
        const orgs = await api(token, 'GET', '/organizations');
        expect(orgs.status).toBe(200);
        return (orgs.json.organizations as Array<{ id: string; name: string }>)[0]?.id ?? '';
      })(),
    );
    // The EMPTY WorkflowIR editor (the expert authors it directly).
    await expect(surface.getByLabel(/workflowir document \(json\)/i)).toHaveValue('');
    // The protocol declaration defaults to the current descriptor.
    await expect(surface.getByLabel(/protocol irschemaversion/i)).toHaveValue(
      'workflowos-workflow-ir-v1',
    );
    // The second command's surface exists.
    await expect(page.getByRole('region', { name: 'Create a new version' })).toBeVisible();
  });

  // ============ LEG 5 — CREATE: the REAL V2-002 createWorkflow route ==========
  let createdWorkflowId = '';
  let createdVersion1Digest = '';
  await step('LEG5 the expert authors the WorkflowIR directly + the metadata → Create workflow → the REAL route creates it with immutable Version 1 and the created facts render FROM THE RESPONSE', async () => {
    const surface = page.getByRole('region', { name: 'Expert workflow authoring' });
    await page.locator('#expert-name').fill(WORKFLOW_NAME);
    await page.locator('#expert-slug').fill(WORKFLOW_SLUG);
    await page.locator('#expert-description').fill(WORKFLOW_DESCRIPTION);
    // The IR document, typed into the editor exactly as a human would
    // paste it (the browser journey owns no authoring authority).
    const irText = serializeWorkflowIrDocument(authorIrDocument(1));
    await page.locator('#expert-ir').fill(irText);
    await surface.getByRole('button', { name: 'Create workflow' }).click();

    // The authoritative created facts, rendered FROM THE 201 RESPONSE.
    const done = page.getByRole('status', { name: 'Workflow created' });
    await expect(done).toBeVisible({ timeout: 20_000 });
    await expect(done.getByText(/born with immutable version 1/i)).toBeVisible();
    await expect(done.getByText(WORKFLOW_NAME)).toBeVisible();
    await expect(done.getByText(WORKFLOW_SLUG)).toBeVisible();
    // The durable library links.
    await expect(done.getByRole('link', { name: /open in your workflows library/i })).toHaveAttribute(
      'href',
      /^\/workflows\/wf-/,
    );

    createdWorkflowId =
      (await done.getByRole('link', { name: /open in your workflows library/i }).getAttribute('href'))
        ?.replace('/workflows/', '') ?? '';
    expect(createdWorkflowId).toMatch(/^wf-/);

    // The version surface carries the created workflow forward.
    const versionSurface = page.getByRole('region', { name: 'Create a new version' });
    await expect(versionSurface.getByLabel('Workflow id')).toHaveValue(createdWorkflowId);
  });
  await shot(page, '03-expert-create-done.png');

  await step('LEG5b the REAL routes resolve the SAME created facts (workflow read + versions read, digest-verified)', async () => {
    const token = await sessionToken(context);
    const wf = await api(token, 'GET', `/workflow-repository/workflows/${createdWorkflowId}`);
    expect(wf.status, JSON.stringify(wf.json)).toBe(200);
    expect(wf.json.workflow.id).toBe(createdWorkflowId);
    expect(wf.json.workflow.slug).toBe(WORKFLOW_SLUG);
    expect(wf.json.workflow.name).toBe(WORKFLOW_NAME);
    expect(wf.json.workflow.description).toBe(WORKFLOW_DESCRIPTION);
    expect(wf.json.workflow.visibility).toBe('private');
    expect(wf.json.workflow.headVersionId).toBeTruthy();

    const versions = await api(
      token,
      'GET',
      `/workflow-repository/workflows/${createdWorkflowId}/versions`,
    );
    expect(versions.status, JSON.stringify(versions.json)).toBe(200);
    const list = versions.json.versions as Array<{
      versionNumber: number;
      contentDigest: string;
    }>;
    expect(list.map((v) => v.versionNumber)).toEqual([1]);
    createdVersion1Digest = list[0]?.contentDigest ?? '';
    expect(createdVersion1Digest).not.toBe('');

    // The created workflow is visible in the org's repository read (the
    // library's own authority).
    const orgId = wf.json.workflow.organizationId as string;
    const orgWorkflows = await api(
      token,
      'GET',
      `/organizations/${orgId}/workflow-repository/workflows`,
    );
    expect(orgWorkflows.status).toBe(200);
    expect(
      (orgWorkflows.json.workflows as Array<{ id: string }>).some(
        (w) => w.id === createdWorkflowId,
      ),
    ).toBe(true);
  });

  // ============ LEG 6 — VERSION: the REAL V2-002 createVersion route ==========
  await step('LEG6 the version surface (the created workflow carried forward) + the second authored WorkflowIR document → Create version → the REAL route creates Version 2 and its facts render', async () => {
    const versionSurface = page.getByRole('region', { name: 'Create a new version' });
    const irText = serializeWorkflowIrDocument(authorIrDocument(2));
    await page.locator('#expert-version-ir').fill(irText);
    await versionSurface.getByRole('button', { name: 'Create version' }).click();

    const done = page.getByRole('status', { name: 'Version created' });
    await expect(done).toBeVisible({ timeout: 20_000 });
    await expect(done.getByText(/version 2 created — immutable/i)).toBeVisible();
    // The durable link back to the created workflow.
    await expect(done.getByRole('link', { name: /open the workflow/i })).toHaveAttribute(
      'href',
      `/workflows/${createdWorkflowId}`,
    );
  });
  await shot(page, '04-expert-version-done.png');

  await step('LEG6b the REAL routes confirm Version 2 (2 versions; the workflow head moved to the new version)', async () => {
    const token = await sessionToken(context);
    const versions = await api(
      token,
      'GET',
      `/workflow-repository/workflows/${createdWorkflowId}/versions`,
    );
    expect(versions.status).toBe(200);
    const list = versions.json.versions as Array<{
      id: string;
      versionNumber: number;
      contentDigest: string;
    }>;
    expect(list.map((v) => v.versionNumber)).toEqual([1, 2]);
    expect(list[1]?.contentDigest).not.toBe(createdVersion1Digest);
    const createdVersion2Id = list[1]?.id ?? '';

    const wf = await api(token, 'GET', `/workflow-repository/workflows/${createdWorkflowId}`);
    expect(wf.status).toBe(200);
    expect(wf.json.workflow.headVersionId).toBe(createdVersion2Id);
    // The exact immutable version read resolves the new version.
    const exact = await api(
      token,
      'GET',
      `/workflow-repository/workflows/${createdWorkflowId}/versions/${createdVersion2Id}`,
    );
    expect(exact.status).toBe(200);
    expect(exact.json.version.versionNumber).toBe(2);
  });

  // ============ LEG 7 — LIBRARY/DETAIL: the existing journey ==================
  await step('LEG7 the existing library journey: /workflows lists the created workflow (My Workflows) and the detail loads with the created facts', async () => {
    await page.goto(`${FRONTEND_URL}/workflows`);
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByRole('heading', { name: WORKFLOW_NAME })).toBeVisible({
      timeout: 20_000,
    });
    await panel.getByRole('link', { name: 'Open' }).first().click();

    // THE detail loads (the F-003 repair keeps this journey honest; the
    // F-004b workflow exists with real versions behind it).
    await expect(
      page.getByRole('heading', { name: WORKFLOW_NAME }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(WORKFLOW_DESCRIPTION)).toBeVisible();
    await expect(page.getByText(/Private — only you/i)).toBeVisible();
    // The head version's presentation-label steps (authored in the IR).
    const steps = page.getByRole('list', { name: /what it does/i });
    await expect(steps.getByRole('listitem')).toHaveCount(2);
    await expect(steps.getByText('Collect the fresh tickets')).toBeVisible();
    await expect(steps.getByText('Email the digest, sorted')).toBeVisible();
    // The version facts: Version 2 is the immutable head.
    await expect(page.getByText(/version 2 — immutable/i)).toBeVisible();
    // The honest own-org no-install state.
    await expect(page.getByText(/No installs — run it from the library/i)).toBeVisible();
    // The version history lists both immutable versions.
    const history = page.getByRole('region', { name: /version history/i });
    await expect(history.getByText('Version 1')).toBeVisible();
    await expect(history.getByText('Version 2')).toBeVisible();
    // NO honest-error state — the detail is NOT the error surface.
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
  await shot(page, '05-created-workflow-detail.png');

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
