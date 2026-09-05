/**
 * V2-017 T7 — Browser-level E2E: the failure / recovery / takeover
 * experience over the REAL run authorities.
 *
 * Real topology (the t6/t8 pattern): the identity stack's real pglite
 * PostgreSQL (all migrations) + the REAL Fastify buildServer wired with
 * the real session auth + identity + organizations routes + the REAL
 * V2-002 workflow-repository routes, the REAL V2-005 workflow-runs
 * routes (request/start/steps/pause/resume/cancel/fail — the full
 * lifecycle), and the REAL V2-009 workflow-deployments routes. The Vite
 * dev server on :5173 serves the actual SPA.
 *
 * The journey proves in a REAL browser (UX §18 end-to-end):
 *   1. the run is started through the real consumer surface (T6's Run);
 *   2. the executor records real step outcomes (one succeeded, one
 *      failed) and fails the run with a reason — all through the REAL
 *      V2-005 routes;
 *   3. the detail page renders the §18 failure surface: the sentence,
 *      the recorded reason, the known ✓/✕ facts labeled from the
 *      V2-003 presentation layer (internal step IDs NEVER surface), and
 *      ONLY the admissible actions (Try again — never Resume/Stop on a
 *      terminal run);
 *   4. "Try again" sends the REAL commands (a fresh manual trigger = a
 *      NEW run; the exact-run re-read discipline; start) and the page
 *      derives Running from the authoritative record;
 *   5. an executor-side pause, then the paused-run controls: Take over
 *      (the honest preserved-run note + the execution-host surface
 *      pointer — no invented command), Resume (the REAL lifecycle
 *      command → Running again), and Stop (the §2.4 explicit choice,
 *      then the REAL cancel → the honest cancelled presentation).
 */
import { test, expect } from '@playwright/test';
import {
  buildIdentityStack,
  type TestIdentityStack,
} from '../helpers/test-identity-stack.js';
import {
  buildAuthPluginDeps,
  buildIdentityRouteDeps,
  buildOrganizationsRouteDeps,
} from '../helpers/test-identity-server.js';
import { buildServer } from '@api/server.js';
import { InMemoryQueue } from '@platform/index.js';
import { DefaultWorkflowRepositoryService } from '../../src/workflow-repository/index.js';
import { DefaultWorkflowRunService } from '../../src/workflow-runs/index.js';
import { formatUtcTimestamp } from '../../src/workflow-runs/internal/run-clock.js';
import { DefaultWorkflowDeploymentService } from '../../src/workflow-deployments/index.js';
import {
  DefaultNodeCapabilityService,
  InMemoryNodeKeyStore,
  InMemoryNodeRecordStore,
  makeSequentialNonceSource,
} from '../../src/node-capability/index.js';
import {
  createWorkflowIrBuilder,
  serializeWorkflowIrDocument,
} from '../../src/workflow-ir/index.js';
import type { WorkflowIrDocument, WorkflowNode } from '../../src/workflow-ir/index.js';
import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '@platform/index.js';

let stack: TestIdentityStack;
let server: FastifyInstance;

const IVY_EMAIL = 'ivy-t7@e2e.example.com';
const IVY_PASSWORD = 'the-t7-password-42';

test.beforeAll(async () => {
  stack = await buildIdentityStack();
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
  server = await buildServer({
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
  });
  await server.listen({ port: 3001, host: '127.0.0.1' });
});

test.afterAll(async () => {
  await server.close();
  await stack.teardown();
});

/** The authored workflow: fetch_step → send_step, with presentation labels. */
function authorReportWorkflow(): WorkflowIrDocument {
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
        binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' },
      },
    ],
    outputs: [{ name: 'report', type: { kind: 'string' } }],
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
        binding: { kind: 'node_output', node: 'fetch_step', output: 'report' },
      },
    ],
    outputs: [{ name: 'messageId', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart('fetch_step')
    .addNode(fetchStep)
    .addNode(sendStep)
    .addEdge({ from: 'fetch_step', to: 'send_step', on: 'success' })
    .addWorkflowOutput({
      name: 'messageId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_step', output: 'messageId' },
    })
    .withDefaultPlacement('any_supported_node')
    .withProvenance({ origin: 'authored' })
    .withPresentation({
      title: 'Website report',
      nodeLabels: {
        fetch_step: 'Open the website report',
        send_step: 'Email the digest',
      },
    })
    .build();
}

test.describe('V2-017 T7 — the failure / recovery / takeover experience over the real authorities', () => {
  test('fail with recorded facts → §18 explanation → real Try again → paused controls (Take over / Resume / Stop)', async ({ page }) => {
    // Fresh browser → the consumer shell → a real account.
    await page.goto('/');
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill('Ivy (T7)');
    await page.locator('#email').fill(IVY_EMAIL);
    await page.locator('#password').fill(IVY_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(
      page.getByRole('heading', { name: /What do you want to get done\?/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Create the organization + the workflow through the real routes.
    const orgRes = await page.request.post('/api/organizations', { data: { name: 'Acme T7' } });
    expect(orgRes.ok()).toBeTruthy();
    const org = (await orgRes.json()) as { organization: { id: string } };
    const createRes = await page.request.post(
      `/api/organizations/${org.organization.id}/workflow-repository/workflows`,
      {
        data: {
          slug: 'website-report-t7',
          name: 'Website report',
          description: 'Open the report and email the digest.',
          visibility: 'private',
          content: JSON.parse(serializeWorkflowIrDocument(authorReportWorkflow())) as Record<
            string,
            unknown
          >,
          protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
        },
      },
    );
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as { workflow: { id: string } };

    // The detail page: run it through the REAL consumer surface (T6).
    await page.goto(`/workflows/${created.workflow.id}`);
    await expect(
      page.getByRole('heading', { name: 'Website report' }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Run' }).first().click();
    const preview = page.getByRole('region', { name: 'Run preview' });
    await expect(preview).toBeVisible();
    await preview.getByRole('button', { name: 'Run' }).click();
    const status = page.getByRole('region', { name: 'Run status' });
    await expect(status).toBeVisible({ timeout: 15_000 });
    await expect(status.getByText('Running')).toBeVisible();

    // The executor records real step outcomes, then fails the run with a
    // reason — all through the REAL V2-005 routes (the page's session).
    const runsRes = await page.request.get(
      `/api/organizations/${org.organization.id}/workflow-runs/runs`,
    );
    expect(runsRes.ok()).toBeTruthy();
    const runsBody = (await runsRes.json()) as {
      runs: Array<{ id: string; workflowId: string }>;
    };
    const runId = runsBody.runs.find((r) => r.workflowId === created.workflow.id)?.id ?? '';
    expect(runId).not.toBe('');

    const envelope = () => ({
      commandId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
    });
    const stepRes1 = await page.request.post(
      `/api/workflow-runs/runs/${runId}/steps/fetch_step/started`,
      { data: { ...envelope(), inputCommitments: [] } },
    );
    expect(stepRes1.ok()).toBeTruthy();
    const stepRes2 = await page.request.post(
      `/api/workflow-runs/runs/${runId}/steps/fetch_step/completed`,
      { data: { ...envelope(), outcome: 'succeeded', outputCommitments: [] } },
    );
    expect(stepRes2.ok()).toBeTruthy();
    const stepRes3 = await page.request.post(
      `/api/workflow-runs/runs/${runId}/steps/send_step/started`,
      { data: { ...envelope(), inputCommitments: [] } },
    );
    expect(stepRes3.ok()).toBeTruthy();
    const stepRes4 = await page.request.post(
      `/api/workflow-runs/runs/${runId}/steps/send_step/completed`,
      { data: { ...envelope(), outcome: 'failed', outputCommitments: [] } },
    );
    expect(stepRes4.ok()).toBeTruthy();
    const failRes = await page.request.post(`/api/workflow-runs/runs/${runId}/fail`, {
      data: { ...envelope(), reason: 'The website had changed.' },
    });
    expect(failRes.ok()).toBeTruthy();

    // Reload: the §18 failure surface over the authoritative history.
    await page.reload();
    const recovery = page.getByRole('region', { name: 'Recovery' });
    await expect(recovery).toBeVisible({ timeout: 15_000 });
    await expect(recovery.getByText('I couldn\u2019t finish this.')).toBeVisible();
    await expect(recovery.getByText('It stopped: The website had changed.')).toBeVisible();
    const known = recovery.getByRole('list', { name: 'What I know' });
    await expect(known).toBeVisible();
    await expect(known).toContainText('\u2713 Open the website report');
    await expect(known).toContainText('\u2717 Email the digest');
    // Internal step IDs NEVER surface (F-T4-001 discipline).
    await expect(recovery.getByText(/fetch_step|send_step/)).toHaveCount(0);
    // Terminal honesty: only Try again (+ Edit) — never Resume/Stop.
    await expect(recovery.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(recovery.getByRole('button', { name: 'Resume' })).toHaveCount(0);
    await expect(recovery.getByRole('button', { name: 'Stop' })).toHaveCount(0);
    // Expert-only facts: the raw state word and run id stay in Advanced.
    await expect(recovery.getByText(/^failed$/)).toHaveCount(0);
    await recovery.getByText('Advanced details').click();
    await expect(recovery.getByText(`Run state: failed`)).toBeVisible();
    await expect(recovery.getByText(`Run id: ${runId}`)).toBeVisible();

    // "Try again": the REAL commands — a NEW run (a fresh manual trigger;
    // the failed run is terminal and can never be restarted), started.
    await recovery.getByRole('button', { name: 'Try again' }).click();
    await expect(recovery).toHaveCount(0, { timeout: 15_000 });
    await expect(status.getByText('Running')).toBeVisible({ timeout: 15_000 });
    const runsRes2 = await page.request.get(
      `/api/organizations/${org.organization.id}/workflow-runs/runs`,
    );
    const runsBody2 = (await runsRes2.json()) as {
      runs: Array<{ id: string; workflowId: string; state: string }>;
    };
    const mine = runsBody2.runs.filter((r) => r.workflowId === created.workflow.id);
    expect(mine.length).toBe(2);
    expect(mine.some((r) => r.id !== runId && r.state === 'running')).toBe(true);

    // An executor-side pause → reload → the paused-run controls.
    const newRunId = mine.find((r) => r.id !== runId)?.id ?? '';
    expect(newRunId).not.toBe('');
    const pauseRes = await page.request.post(`/api/workflow-runs/runs/${newRunId}/pause`, {
      data: { ...envelope() },
    });
    expect(pauseRes.ok()).toBeTruthy();
    await page.reload();
    const recovery2 = page.getByRole('region', { name: 'Recovery' });
    await expect(recovery2).toBeVisible({ timeout: 15_000 });
    await expect(recovery2.getByRole('button', { name: 'Resume' })).toBeVisible();
    await expect(recovery2.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(recovery2.getByRole('button', { name: 'Take over' })).toBeVisible();

    // Take over: the honest preserved-run note + the execution-host
    // surface pointer (no invented command — a presentation, not a call).
    await recovery2.getByRole('button', { name: 'Take over' }).click();
    await expect(
      recovery2.getByText(/Taking over preserves this run and hands control to you\./),
    ).toBeVisible();
    await expect(
      recovery2.getByRole('link', { name: /open the expert workspace/i }),
    ).toHaveAttribute('href', '/expert');
    // The run is still paused (takeover is a pointer, not a command).
    await expect(recovery2.getByRole('button', { name: 'Resume' })).toBeVisible();

    // Resume: the REAL lifecycle command → Running again.
    await recovery2.getByRole('button', { name: 'Resume' }).click();
    await expect(status.getByText('Running')).toBeVisible({ timeout: 15_000 });
    const runStateRes = await page.request.get(
      `/api/organizations/${org.organization.id}/workflow-runs/runs`,
    );
    const runStateBody = (await runStateRes.json()) as {
      runs: Array<{ id: string; state: string }>;
    };
    expect(runStateBody.runs.find((r) => r.id === newRunId)?.state).toBe('running');

    // An executor-side pause again → the Stop journey (the recovery
    // surface renders for paused runs; a running run has nothing to stop
    // through this surface — Run's own flow owns it).
    const pauseRes2 = await page.request.post(`/api/workflow-runs/runs/${newRunId}/pause`, {
      data: { ...envelope() },
    });
    expect(pauseRes2.ok()).toBeTruthy();
    await page.reload();
    const recovery3 = page.getByRole('region', { name: 'Recovery' });
    await expect(recovery3).toBeVisible({ timeout: 15_000 });
    await recovery3.getByRole('button', { name: 'Stop' }).click();
    await expect(
      page.getByText(/This ends the run — it can\u2019t be restarted\./),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Stop it' }).click();
    const recovery4 = page.getByRole('region', { name: 'Recovery' });
    await expect(recovery4.getByText('It was cancelled.')).toBeVisible({ timeout: 15_000 });
    // Terminal honesty again: only Try again remains.
    await expect(recovery4.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(recovery4.getByRole('button', { name: 'Resume' })).toHaveCount(0);
    await expect(recovery4.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  });
});
