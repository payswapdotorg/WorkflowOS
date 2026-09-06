/**
 * V2-017 T15 — the REAL product dogfooding run (executable evidence).
 *
 * Frozen requirement (spec/architecture/v2/work-orders/V2-017.md,
 * "Required verification"): "real browser dogfooding" — and the program map
 * (post-w6-product-roadmap.md, "Completion definition"): dogfooding covers
 * "representative creation, review, execution, completion or recovery,
 * teaching, and version/update behavior" through the real product paths.
 *
 * The experiment (ONE persona, ONE continuous real-browser session on the
 * ACTUAL product — the real Vite SPA served by the real dev server, driving
 * the REAL backend topology):
 *
 *   LEG 1  CREATION — the universal Create entry in Tell mode: the typed
 *          goal → the understanding preview (the captured input echoed
 *          VERBATIM + correction fields) → the honest fail-closed durable
 *          boundary (F-T5-001: "Durable creation isn't available yet" —
 *          no fabricated WorkflowIR is ever committed; the missing
 *          authoring authority is surfaced, never invented).
 *   LEG 2  REVIEW — durable authoring through the REAL V2-002 routes
 *          (fetch → approval → send, with presentation labels), install
 *          v1 (the immutable pin), then the product library + the workflow
 *          detail page: purpose, the presentation-layer steps, When/Where,
 *          Recent activity, Version, Access and safety ("Needs access to").
 *   LEG 3  EXECUTION — Run → the consequential-action preview (steps from
 *          presentation, Approval required, Needs access to, the honest
 *          not-set-up where fact) → the REAL V2-005 commands (request →
 *          start) → "Running" → executor pause AT the approval step → the
 *          history-derived "Waiting for you" → executor-side evidence
 *          records + a REAL V2-014 Ed25519 attestation → complete →
 *          "Completed" + the "How do you know?" trust disclosure (concise
 *          evidence first, advanced verification on demand).
 *   LEG 4  TEACHING — Teach Me on a second authored workflow: lesson →
 *          checkpoints → pause/resume → practice → assessment → Lesson
 *          complete; the teaching evidence surface stays VISIBLY DISTINCT
 *          from execution evidence.
 *   LEG 5  VERSION/UPDATE — v2 authored through the REAL V2-002 route →
 *          the update banner ("An update is available", "Nothing changes
 *          until you approve the update.", the verbatim installed pin) →
 *          Review update → What changed (the V2-011 comparison over the
 *          transport route; honest modeled estimates) → Approve update =
 *          the EXISTING V2-002 commands → the new installation pins v2
 *          Enabled, the old pin retired.
 *   LEG 6  ACTIVITY — the universal Activity timeline: the run entries
 *          (Completed / Waiting for you), and the entry → workflow
 *          navigation.
 *
 * Real topology (the union of the t6/t9/t10/t11 spec compositions): the
 * identity stack's real pglite PostgreSQL (ALL migrations) + the REAL
 * Fastify buildServer with the real session auth + identity +
 * organizations + projects routes + the REAL V2-002 workflow-repository
 * routes + the REAL V2-005 workflow-runs routes + the V2-004/V2-009
 * deployment reads + the REAL V2-006/V2-010 teaching services + the V2-011
 * optimization transport route. The Vite dev server on :5199 serves the
 * actual SPA; the browser is a REAL headless Chromium.
 *
 * Run: cd backend && bunx tsx tests/integration/product-ux/run-v2-017-product-dogfooding.ts
 * Exit code 0 = every leg passed. Non-zero = a leg failed (printed).
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import {
  buildIdentityStack,
  type TestIdentityStack,
} from '../../helpers/test-identity-stack.js';
import {
  buildAuthPluginDeps,
  buildIdentityRouteDeps,
  buildOrganizationsRouteDeps,
} from '../../helpers/test-identity-server.js';
import { buildServer } from '@api/server.js';
import { InMemoryQueue } from '@platform/index.js';
import { DefaultWorkflowRepositoryService } from '../../../src/workflow-repository/index.js';
import { DefaultWorkflowRunService } from '../../../src/workflow-runs/index.js';
import { formatUtcTimestamp } from '../../../src/workflow-runs/internal/run-clock.js';
import { DefaultWorkflowDeploymentService } from '../../../src/workflow-deployments/index.js';
import {
  DefaultNodeCapabilityService,
  InMemoryNodeKeyStore,
  InMemoryNodeRecordStore,
  makeSequentialNonceSource,
} from '../../../src/node-capability/index.js';
import {
  createWorkflowIrBuilder,
  serializeWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import type { WorkflowIrDocument, WorkflowNode } from '../../../src/workflow-ir/index.js';
import { DefaultTeachingSessionService, InMemoryTeachingSessionStore } from '../../../src/teaching-sessions/index.js';
import {
  DefaultReverseTeachingSessionService,
  InMemoryReverseTeachingSessionStore,
} from '../../../src/reverse-teaching/index.js';
import {
  generateAttesterKeyPair,
  signExecutionAttestation,
  executionValueCommitment,
  type ExecutionStatement,
} from '../../../src/execution-attestation/index.js';
import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '@platform/index.js';
import type { Page } from '@playwright/test';

expect.configure({ timeout: 15_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const ARTIFACTS_DIR = join(REPO_ROOT, 'spec', 'architecture', 'v2', 'dogfooding-evidence', 'assets', 'v2-017');

const FRONTEND_PORT = 5199;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

const NOVA_NAME = 'Nova (T15)';
const NOVA_EMAIL = 'nova-t15@dogfood.example.com';
const NOVA_PASSWORD = 'the-t15-password-42';

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
    const entry: TranscriptEntry = { at: new Date().toISOString(), label, status: 'PASS', ms: Date.now() - t0 };
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

async function shot(page: Page, name: string): Promise<string> {
  const path = join(ARTIFACTS_DIR, name);
  await page.screenshot({ path });
  const stat = statSync(path);
  const sha = sha256OfFile(path);
  artifacts.push({ file: `spec/architecture/v2/dogfooding-evidence/assets/v2-017/${name}`, sha256: sha, bytes: stat.size });
  console.log(`[SHOT] ${name} (${stat.size} bytes, sha-256 ${sha.slice(0, 16)}…)`);
  return path;
}

/** A deterministic command envelope (fresh ids per call). */
function envelope() {
  return { commandId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
}

/** The digest workflow (fetch → approval gate → send), the t10 shape.
 * The variant string changes the fetch literal so v2 is a REAL content
 * change (a distinct immutable version — identical content converges to
 * the existing version instead of creating v2). */
function authorDigestWorkflow(repository: string, logLabel = 'Log the rejection'): WorkflowIrDocument {
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
      title: 'Weekly ticket digest',
      nodeLabels: {
        fetch_tickets: 'Collect the open tickets',
        review_gate: 'Your approval before sending',
        send_digest: 'Email the weekly digest',
        log_rejection: logLabel,
      },
    })
    .build();
}

/** The practice workflow (fetch → human copy step → send), the t9 shape. */
function authorPracticeWorkflow(): WorkflowIrDocument {
  const fetchStep: WorkflowNode = {
    id: 'fetch_step',
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
    outputs: [{ name: 'report', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const doStep: WorkflowNode = {
    id: 'do_step',
    executionClass: 'agentic_computer_use',
    spec: {
      class: 'agentic_computer_use',
      task: 'Open the issue tracker and copy the open ticket numbers',
    },
    capabilityRequirements: [],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'report',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'fetch_step', output: 'report' },
      },
    ],
    outputs: [{ name: 'tickets', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const sendStep: WorkflowNode = {
    id: 'send_step',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'messaging.send' },
    capabilityRequirements: ['messaging.send'],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'do_step', output: 'tickets' },
      },
    ],
    outputs: [{ name: 'messageId', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart('fetch_step')
    .addNode(fetchStep)
    .addNode(doStep)
    .addNode(sendStep)
    .addEdge({ from: 'fetch_step', to: 'do_step', on: 'success' })
    .addEdge({ from: 'do_step', to: 'send_step', on: 'success' })
    .addWorkflowOutput({
      name: 'messageId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_step', output: 'messageId' },
    })
    .withDefaultPlacement('any_supported_node')
    .withProvenance({ origin: 'authored' })
    .withPresentation({
      title: 'Weekly ticket digest',
      nodeLabels: {
        fetch_step: 'Collect the open tickets',
        do_step: 'Copy the ticket numbers',
        send_step: 'Email the weekly digest',
      },
    })
    .build();
}

async function main(): Promise<number> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  // Clean the artifact dir so each run is fresh (idempotent evidence).
  for (const entry of readdirSync(ARTIFACTS_DIR)) {
    if (entry.endsWith('.png') || entry.endsWith('.json')) {
      rmSync(join(ARTIFACTS_DIR, entry));
    }
  }

  info(`V2-017 T15 product dogfooding run starting at ${startedAt.toISOString()}`);
  info(`artifacts dir: ${ARTIFACTS_DIR}`);

  // ---- The REAL backend topology (the t6/t9/t10/t11 union) --------------------
  const stack: TestIdentityStack = await buildIdentityStack();
  const db: DatabaseClient = stack.db.client;
  const memberships = {
    isMember: async (userId: string, organizationId: string) =>
      (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !==
      null,
  };
  const repository = new DefaultWorkflowRepositoryService({ db, memberships });
  const runService = new DefaultWorkflowRunService({
    db,
    memberships,
    workflowRepository: repository,
    clock: { now: () => formatUtcTimestamp(Date.now()) },
    currentEpoch: 1,
  });
  const nodes = new DefaultNodeCapabilityService({
    clock: () => Date.now(),
    nonceSource: makeSequentialNonceSource(),
    keyStore: new InMemoryNodeKeyStore(),
    nodeStore: new InMemoryNodeRecordStore(),
    heartbeatLeaseTtlMs: 365 * 86_400_000,
  });
  const deploymentService = new DefaultWorkflowDeploymentService({
    db,
    memberships,
    workflowRepository: repository,
    runs: runService,
    nodes,
    clock: { now: () => formatUtcTimestamp(Date.now()) },
  });
  const teachingService = new DefaultTeachingSessionService({
    idFactory: () => `ts_${crypto.randomUUID()}`,
    clock: () => Date.now(),
    store: new InMemoryTeachingSessionStore(),
  });
  const reverseTeachingService = new DefaultReverseTeachingSessionService({
    idFactory: () => `rt_${crypto.randomUUID()}`,
    clock: () => Date.now(),
    store: new InMemoryReverseTeachingSessionStore(),
  });
  const server: FastifyInstance = await buildServer({
    queue: new InMemoryQueue(),
    logger: stack.db.logger,
    auth: buildAuthPluginDeps(stack),
    identity: buildIdentityRouteDeps(stack),
    organizations: buildOrganizationsRouteDeps(stack),
    projects: {
      authorizationService: stack.authorizationService,
      projectRepository: stack.projectRepository,
      repositoryAssociationRepository: stack.repositoryAssociationRepository,
      projectAccessRepository: stack.projectAccessRepository,
      organizationRepository: stack.organizationRepository,
      membershipRepository: stack.membershipRepository,
    },
    workflowRepository: { workflowRepositoryService: repository },
    workflowRuns: { workflowRunService: runService },
    workflowDeployments: { workflowDeploymentService: deploymentService },
    teaching: { teachingSessionService: teachingService, workflowRepositoryService: repository },
    reverseTeaching: {
      reverseTeachingService: reverseTeachingService,
      workflowRepositoryService: repository,
    },
    workflowOptimization: {
      workflowRepositoryService: repository,
      idFactory: () => `opt_${crypto.randomUUID()}`,
      clock: () => Date.now(),
    },
  });
  await server.listen({ port: 3001, host: '127.0.0.1' });
  info('REAL backend topology up: Fastify :3001 (identity + V2-002 repository + V2-005 runs + deployments + teaching + optimization)');

  // ---- The ACTUAL product frontend: the Vite dev server ------------------------
  const vite = spawn('bun', ['run', 'dev', '--', '--port', String(FRONTEND_PORT)], {
    cwd: join(REPO_ROOT, 'frontend'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  vite.stderr.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) console.log(`[vite] ${s}`);
  });
  let viteReady = false;
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${FRONTEND_URL}/`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        viteReady = true;
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!viteReady) throw new Error('the Vite dev server never became ready');
  info(`ACTUAL product frontend up: Vite dev server ${FRONTEND_URL}`);

  // ---- A REAL browser -----------------------------------------------------------
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL: FRONTEND_URL,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  let exitCode = 0;
  try {
    exitCode = await journey(page);
  } catch (err) {
    console.log(`\n[JOURNEY FAILED] ${err instanceof Error ? err.message : String(err)}`);
    try {
      await shot(page, '99-failure.png');
    } catch {
      // best effort
    }
    exitCode = 1;
  } finally {
    const finishedAt = new Date();
    const summary = {
      run: 'V2-017 T15 real product dogfooding',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      exitCode,
      transcript,
      artifacts,
    };
    writeFileSync(join(ARTIFACTS_DIR, 'journey.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`\n[DONE] exitCode=${exitCode} duration=${summary.durationMs}ms legs=${transcript.filter((t) => t.status === 'PASS').length} passed / ${transcript.filter((t) => t.status === 'FAIL').length} failed`);
    await browser.close();
    vite.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    vite.kill('SIGKILL');
    await server.close();
    await stack.teardown();
  }
  return exitCode;
}

async function journey(page: Page): Promise<number> {
  // ================= LEG 1 — CREATION (Tell, honest fail-closed) ================
  await step('LEG1 goto the product', async () => {
    await page.goto(`${FRONTEND_URL}/`);
    await expect(page.getByText('Create one', { exact: true })).toBeVisible();
  });

  await step('LEG1 real signup through the product UI', async () => {
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill(NOVA_NAME);
    await page.locator('#email').fill(NOVA_EMAIL);
    await page.locator('#password').fill(NOVA_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: /What do you want to get done\?/i })).toBeVisible();
  });
  await shot(page, '01-home.png');

  await step('LEG1 the universal Create entry in Tell mode (goal pre-filled)', async () => {
    await page.goto(`${FRONTEND_URL}/create?mode=tell&q=${encodeURIComponent('Send the weekly invoice digest every Friday')}`);
    const modes = page.getByRole('list', { name: 'Creation entry modes' });
    await expect(modes.getByText('Tell', { exact: true }).locator('..')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Continue to preview' })).toBeVisible();
  });

  await step('LEG1 the understanding preview: the captured goal echoed VERBATIM + correction fields', async () => {
    await page.getByRole('button', { name: 'Continue to preview' }).click();
    const preview = page.getByRole('region', { name: 'Understanding preview' });
    await expect(preview).toBeVisible();
    const echo = preview.getByRole('region', { name: 'Captured input' });
    await expect(echo.getByText(/Send the weekly invoice digest every Friday/i)).toBeVisible();
    await expect(preview.getByText(/can't yet turn your description into executable steps/i)).toBeVisible();
    await expect(preview.getByRole('textbox', { name: /workflow name/i })).toBeVisible();
    await expect(preview.getByRole('textbox', { name: /workflow slug/i })).toBeVisible();
    await expect(preview.getByRole('combobox', { name: /visibility/i })).toBeVisible();
  });

  await step('LEG1 F-T5-001 the honest fail-closed durable boundary (NO fabricated WorkflowIR commit)', async () => {
    const unavailable = page.getByRole('status', { name: 'Durable creation unavailable' });
    await expect(unavailable).toBeVisible();
    await expect(unavailable.getByText(/Durable creation isn't available yet/i)).toBeVisible();
    await expect(page.getByText(/Nothing is committed/i)).toBeVisible();
  });
  await shot(page, '02-creation-honest-boundary.png');

  // ================= LEG 2 — REVIEW (durable authoring + the real product) ======
  const org = await step('LEG2 create the organization through the REAL route', async () => {
    const res = await page.request.post('/api/organizations', { data: { name: 'Nova Automation' } });
    expect(res.ok(), `org create failed: ${res.status()}`).toBeTruthy();
    return (await res.json()) as { organization: { id: string } };
  });
  const orgId = org.organization.id;

  const digest = await step('LEG2 author the digest workflow through the REAL V2-002 route (v1 immutable)', async () => {
    const res = await page.request.post(`/api/organizations/${orgId}/workflow-repository/workflows`, {
      data: {
        slug: 'weekly-ticket-digest-t15',
        name: 'Weekly ticket digest',
        description: 'Collect the open tickets, approve, and email the digest.',
        visibility: 'private',
        content: JSON.parse(serializeWorkflowIrDocument(authorDigestWorkflow('payswapdotorg/WorkflowOS'))) as Record<string, unknown>,
        protocol: { irSchemaVersion: 'workflowos-workflow-ir/v1' },
      },
    });
    expect(res.ok(), `workflow create failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as {
      workflow: { id: string; headVersionId: string };
      initialVersion: { id: string };
    };
  });
  const digestWorkflowId = digest.workflow.id;
  const digestV1 = digest.initialVersion.id;

  await step('LEG2 install v1 (the immutable pin) through the REAL V2-002 installation route', async () => {
    const res = await page.request.post(`/api/organizations/${orgId}/workflow-repository/installations`, {
      data: { workflowId: digestWorkflowId, versionId: digestV1 },
    });
    expect(res.ok(), `install failed: ${res.status()}`).toBeTruthy();
  });

  const practice = await step('LEG2 author the practice workflow through the REAL V2-002 route (for the teaching leg)', async () => {
    const res = await page.request.post(`/api/organizations/${orgId}/workflow-repository/workflows`, {
      data: {
        slug: 'ticket-practice-t15',
        name: 'Ticket number practice',
        description: 'Collect, copy, and send — the lesson workflow.',
        visibility: 'private',
        content: JSON.parse(serializeWorkflowIrDocument(authorPracticeWorkflow())) as Record<string, unknown>,
        protocol: { irSchemaVersion: 'workflowos-workflow-ir/v1' },
      },
    });
    expect(res.ok(), `practice create failed: ${res.status()}`).toBeTruthy();
    return (await res.json()) as { workflow: { id: string } };
  });
  const practiceWorkflowId = practice.workflow.id;

  await step('LEG2 the product Workflows library lists both workflows', async () => {
    await page.goto(`${FRONTEND_URL}/workflows`);
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByRole('heading', { name: 'Weekly ticket digest' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Ticket number practice' })).toBeVisible();
  });

  await step('LEG2 the workflow detail page: purpose + presentation-layer steps + version + access/safety + primary actions', async () => {
    await page.goto(`${FRONTEND_URL}/workflows/${digestWorkflowId}`);
    await expect(page.getByRole('heading', { name: 'Weekly ticket digest' })).toBeVisible();
    const does = page.getByRole('region', { name: 'What it does' });
    await expect(does.getByText('Collect the open tickets')).toBeVisible();
    await expect(does.getByText('Your approval before sending')).toBeVisible();
    await expect(does.getByText('Email the weekly digest')).toBeVisible();
    const version = page.getByRole('region', { name: 'Version' });
    await expect(version.getByText('Version 1 — immutable')).toBeVisible();
    const access = page.getByRole('region', { name: 'Access and safety' });
    await expect(access.getByText(/Needs access to/i)).toBeVisible();
    const actions = page.getByRole('region', { name: 'Primary actions' });
    await expect(actions.getByRole('button', { name: 'Run' }).first()).toBeVisible();
    await expect(actions.getByRole('button', { name: 'Teach Me' }).first()).toBeVisible();
  });
  await shot(page, '03-workflow-detail.png');

  // ================= LEG 3 — EXECUTION (run → waiting → completed + trust) ======
  await step('LEG3 Run opens the consequential-action preview (presentation steps, approval, access, honest not-set-up)', async () => {
    await page.getByRole('button', { name: 'Run' }).first().click();
    const preview = page.getByRole('region', { name: 'Run preview' });
    await expect(preview).toBeVisible();
    await expect(preview.getByText('Run Weekly ticket digest?')).toBeVisible();
    const steps = preview.getByRole('list', { name: 'This will' });
    await expect(steps).toContainText('Collect the open tickets');
    await expect(steps).toContainText('Your approval before sending');
    await expect(steps).toContainText('Email the weekly digest');
    await expect(preview.getByText(/Approval required/i)).toBeVisible();
    await expect(preview.getByText(/Needs access to/i)).toBeVisible();
    await expect(preview.getByText(/Where it runs isn't set up yet/i)).toBeVisible();
  });

  await step('LEG3 Run sends the REAL V2-005 commands (request → start) → Running', async () => {
    await page.getByRole('region', { name: 'Run preview' }).getByRole('button', { name: 'Run' }).click();
    const status = page.getByRole('region', { name: 'Run status' });
    await expect(status).toBeVisible();
    await expect(status.getByText('Running')).toBeVisible();
  });

  const runId = await step('LEG3 the executor pauses AT the approval step (the REAL pause command with atStepId)', async () => {
    const runsRes = await page.request.get(`/api/organizations/${orgId}/workflow-runs/runs`);
    expect(runsRes.ok()).toBeTruthy();
    const body = (await runsRes.json()) as { runs: Array<{ id: string; workflowId: string }> };
    const mine = body.runs.filter((r) => r.workflowId === digestWorkflowId);
    expect(mine.length).toBeGreaterThan(0);
    const id = mine[0]!.id;
    const pauseRes = await page.request.post(`/api/workflow-runs/runs/${id}/pause`, {
      data: { ...envelope(), atStepId: 'review_gate' },
    });
    expect(pauseRes.ok(), `pause failed: ${pauseRes.status()}`).toBeTruthy();
    return id;
  });

  await step('LEG3 reload → the history-derived "Waiting for you" (the internal paused state stays in Advanced details)', async () => {
    await page.reload();
    const status = page.getByRole('region', { name: 'Run status' });
    await expect(status.getByText('Waiting for you')).toBeVisible();
    await expect(status.getByText(/^paused$/)).toHaveCount(0);
    await status.getByText('Advanced details').click();
    await expect(status.getByText(/^paused$/)).toBeVisible();
    await expect(status.getByText(runId)).toBeVisible();
  });
  await shot(page, '04-run-waiting-for-you.png');

  await step('LEG3 the executor records REAL evidence + a REAL V2-014 attestation, then completes (the REAL lifecycle commands)', async () => {
    // The approval decision: the executor RESUMES the paused run (the real
    // resume command — the human approved at the gate).
    const resumeRes = await page.request.post(`/api/workflow-runs/runs/${runId}/resume`, {
      data: { ...envelope() },
    });
    expect(resumeRes.ok(), `resume failed: ${resumeRes.status()}`).toBeTruthy();
    const stepRes = await page.request.post(`/api/workflow-runs/runs/${runId}/steps/send_digest/started`, {
      data: { ...envelope() },
    });
    expect(stepRes.ok()).toBeTruthy();
    const evidenceObservation = await page.request.post(`/api/workflow-runs/runs/${runId}/evidence`, {
      data: {
        ...envelope(),
        evidenceClass: 'observation',
        producerKind: 'executor',
        producerId: 'node_test_host_1',
        contentCommitment: executionValueCommitment('t15-evidence-observation'),
        description: 'Observed the message-delivery receipt from the mail service.',
      },
    });
    expect(evidenceObservation.ok()).toBeTruthy();
    const evidenceConfirmation = await page.request.post(`/api/workflow-runs/runs/${runId}/evidence`, {
      data: {
        ...envelope(),
        evidenceClass: 'human_confirmation',
        producerKind: 'user',
        producerId: 'nova-t15',
        contentCommitment: executionValueCommitment('t15-evidence-confirmation'),
        description: 'You approved the digest before it was sent.',
      },
    });
    expect(evidenceConfirmation.ok()).toBeTruthy();

    const runRead = await page.request.get(`/api/workflow-runs/runs/${runId}`);
    expect(runRead.ok()).toBeTruthy();
    const runRecord = (await runRead.json()) as { run: { versionSemanticDigest: string; installationId: string | null } };
    const now = new Date();
    const statement: ExecutionStatement = {
      objectType: 'workflowos/execution-statement/v1',
      statementSchemaVersion: 1,
      workflowId: digestWorkflowId,
      workflowVersionId: digestV1,
      workflowVersionSemanticDigest: runRecord.run.versionSemanticDigest,
      // The binding dimension the verifier expects: the run's ACTUAL
      // installation identity (the UI run carried the installed pin).
      deploymentId: runRecord.run.installationId ?? 'wfin_not_used_here',
      runId,
      attemptId: 1,
      stepId: 'send_digest',
      nodeId: 'node_test_host_1',
      executionClass: 'deterministic_api',
      capability: 'messaging.send',
      action: 'Email the weekly digest',
      inputCommitments: [executionValueCommitment('t15-input')],
      outputCommitments: [executionValueCommitment('t15-output')],
      observationCommitments: [executionValueCommitment('t15-observation')],
      evidenceReferences: [],
      causalParents: [],
      nonce: `challenge-t15-${crypto.randomUUID()}`,
      epoch: 1,
      outcome: 'succeeded',
      executedAt: new Date(now.getTime() - 30_000).toISOString(),
      validUntil: new Date(now.getTime() + 5 * 60_000).toISOString(),
    } as ExecutionStatement;
    const attester = generateAttesterKeyPair();
    const attestation = signExecutionAttestation({
      statement,
      attesterPrivateKey: attester.privateKey,
      attesterPublicKeyDer: attester.publicKeyDer,
      assurance: 'software_signed',
      issuedAt: new Date(now.getTime() - 10_000).toISOString(),
    });
    const attachRes = await page.request.post(`/api/workflow-runs/runs/${runId}/attestations`, {
      data: {
        ...envelope(),
        attemptNumber: 1,
        stepId: 'send_digest',
        attestation: attestation as unknown as Record<string, unknown>,
      },
    });
    expect(attachRes.ok(), `attach failed: ${attachRes.status()} ${await attachRes.text()}`).toBeTruthy();
    const completeRes = await page.request.post(`/api/workflow-runs/runs/${runId}/complete`, {
      data: { ...envelope(), outputCommitments: [executionValueCommitment('t15-output')] },
    });
    expect(completeRes.ok(), `complete failed: ${completeRes.status()}`).toBeTruthy();
  });

  await step('LEG3 reload → Completed + the "How do you know?" trust disclosure (concise evidence first, advanced verification on demand)', async () => {
    await page.reload();
    const status = page.getByRole('region', { name: 'Run status' });
    await expect(status.getByText('Completed')).toBeVisible();
    const trust = status.getByRole('region', { name: 'How do you know?' });
    await expect(trust.getByText(/Observed the message-delivery receipt/i)).toBeVisible();
    await expect(trust.getByText(/Verified by an observation record/i)).toBeVisible();
    await trust.getByText('Advanced verification').click();
    await expect(trust.getByText(/Email the weekly digest/i)).toBeVisible();
    await expect(trust.getByText(/Software-signed/i)).toBeVisible();
    await expect(trust.getByText(/can\u2019t by itself prove what happened in the physical world/i)).toBeVisible();
  });
  await shot(page, '05-run-completed-trust.png');

  // ================= LEG 4 — TEACHING (Teach Me over the real authority) ========
  await step('LEG4 Teach Me: the lesson entry beside Run, bound to the immutable version', async () => {
    await page.goto(`${FRONTEND_URL}/workflows/${practiceWorkflowId}`);
    await expect(page.getByRole('heading', { name: 'Ticket number practice' })).toBeVisible();
    await page.getByRole('button', { name: 'Teach Me' }).first().click();
    const teach = page.getByRole('region', { name: 'Teach Me' });
    await expect(teach.getByText(/You'll learn to do this yourself/i)).toBeVisible();
    await expect(teach.getByText(/Version 1 — the lesson is bound to it/i)).toBeVisible();
  });

  await step('LEG4 the lesson: checkpoints → pause → resume → all steps confirmed', async () => {
    const teach = page.getByRole('region', { name: 'Teach Me' });
    await teach.getByRole('button', { name: 'Start lesson' }).click();
    await expect(teach.getByText(/Step 1 of 3 — Collect the open tickets/)).toBeVisible();
    await teach.getByRole('button', { name: "I've done it" }).click();
    await expect(teach.getByText(/Step 2 of 3 — Copy the ticket numbers/)).toBeVisible();
    await teach.getByRole('button', { name: 'Pause' }).click();
    await expect(teach.getByText(/Paused/i)).toBeVisible();
    await teach.getByRole('button', { name: 'Resume' }).click();
    await expect(teach.getByText(/Step 2 of 3 — Copy the ticket numbers/)).toBeVisible();
    await teach.getByRole('button', { name: "I've done it" }).click();
    await expect(teach.getByText(/Step 3 of 3 — Email the weekly digest/)).toBeVisible();
    await teach.getByRole('button', { name: "I've done it" }).click();
    await expect(teach.getByText(/All steps confirmed/i)).toBeVisible();
  });

  await step("LEG4 practice (the authority's own question) + assessment → Lesson complete (terminal)", async () => {
    const teach = page.getByRole('region', { name: 'Teach Me' });
    const practiceRegion = teach.getByRole('region', { name: 'Practice' }).first();
    await expect(practiceRegion).toBeVisible();
    await practiceRegion.getByRole('radio', { name: 'github.repository.read' }).first().check();
    await practiceRegion.getByRole('button', { name: 'Check' }).click();
    const assessment = teach.getByRole('region', { name: 'Show you know it' });
    await expect(assessment).toBeVisible();
    await assessment.getByLabel('Position of Collect the open tickets').selectOption('1');
    await assessment.getByLabel('Position of Copy the ticket numbers').selectOption('2');
    await assessment.getByLabel('Position of Email the weekly digest').selectOption('3');
    await assessment.getByLabel('What does Collect the open tickets do?').fill('github.repository.read');
    await assessment.getByLabel('What does Copy the ticket numbers do?').fill('Open the issue tracker and copy the open ticket numbers');
    await assessment.getByLabel('What does Email the weekly digest do?').fill('messaging.send');
    await assessment.getByRole('button', { name: 'Submit' }).click();
    await expect(teach.getByText('Lesson complete')).toBeVisible();
  });

  await step('LEG4 the teaching evidence surface stays VISIBLY DISTINCT from execution evidence', async () => {
    const teach = page.getByRole('region', { name: 'Teach Me' });
    const evidence = teach.getByRole('region', { name: 'Teaching evidence' });
    await expect(evidence).toBeVisible();
    await expect(evidence.getByText(/kept separate from run evidence/i)).toBeVisible();
  });
  await shot(page, '06-teach-me-lesson-complete.png');

  // ================= LEG 5 — VERSION/UPDATE (explicit adoption) =================
  await step('LEG5 v2 authored through the REAL V2-002 route (an explicit NEW immutable version)', async () => {
    const res = await page.request.post(`/api/workflow-repository/workflows/${digestWorkflowId}/versions`, {
      data: {
        content: JSON.parse(serializeWorkflowIrDocument(// v2 = a PRESENTATION-layer change (a step relabel): a distinct content
        // digest (a real new immutable version) with an IDENTICAL task surface
        // (the V2-011 comparison proves task-for-task equivalence; a typed-input
        // change would honestly surface the not-equivalent disclosure instead).
        authorDigestWorkflow('payswapdotorg/WorkflowOS', 'Log the declined digest'))) as Record<string, unknown>,
        protocol: { irSchemaVersion: 'workflowos-workflow-ir/v1' },
        parentVersionId: digestV1,
      },
    });
    expect(res.ok(), `v2 create failed: ${res.status()}`).toBeTruthy();
  });

  await step('LEG5 the update banner: an update is available, the verbatim installed pin, "Nothing changes until you approve the update."', async () => {
    await page.goto(`${FRONTEND_URL}/workflows/${digestWorkflowId}`);
    const history = page.getByRole('region', { name: 'Version history' });
    await expect(history.getByText('Version 1')).toBeVisible();
    await expect(history.getByText('Version 2')).toBeVisible();
    const update = page.getByRole('region', { name: 'Update available' });
    await expect(update.getByText(/an update is available/i)).toBeVisible();
    await expect(update.getByText(/your installed version: version 1/i)).toBeVisible();
    await expect(update.getByText(/nothing changes until you approve the update/i)).toBeVisible();
  });

  await step('LEG5 Review update → What changed (the V2-011 comparison over the transport route, honest modeled estimates)', async () => {
    const update = page.getByRole('region', { name: 'Update available' });
    await update.getByRole('button', { name: /review update/i }).click();
    await expect(update.getByText(/task-for-task equivalent/i)).toBeVisible();
    await expect(update.getByText(/estimates, not measurements/i)).toBeVisible();
  });
  await shot(page, '07-update-what-changed.png');

  await step('LEG5 Approve update = the EXISTING V2-002 commands → the new pin (v2, Enabled), the honest newest state', async () => {
    const update = page.getByRole('region', { name: 'Update available' });
    await update.getByRole('button', { name: /approve update/i }).click();
    await expect(update.getByText(/you're on the newest version/i)).toBeVisible();
    await expect(page.getByText(/Installed: Version 2 — pinned · Enabled/i)).toBeVisible();
  });
  await shot(page, '08-update-adopted.png');

  // ================= LEG 6 — ACTIVITY (the universal timeline) ==================
  await step('LEG6 the Activity timeline: the run entries + the workflow links', async () => {
    await page.goto(`${FRONTEND_URL}/activity`);
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({ timeout: 15_000 });
    const timeline = page.getByRole('list', { name: 'Activity timeline' });
    // The newest entry is the adoption-era event (the v2 version/adoption
    // records); the completed run entry is present in the timeline.
    await expect(timeline.getByText('Completed').first()).toBeVisible();
    await expect(timeline.getByText('Weekly ticket digest').first()).toBeVisible();
  });
  await shot(page, '09-activity-timeline.png');

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
