/**
 * V2-017 T6 — Browser-level E2E: the Run experience over the REAL
 * authorities.
 *
 * Real topology (the work-074/work-050 pattern): the identity stack's real
 * pglite PostgreSQL (all migrations) + the REAL Fastify buildServer wired
 * with the real session auth + identity routes + the organizations routes +
 * the REAL V2-002 workflow-repository routes AND the REAL V2-005
 * workflow-runs routes. The Vite dev server on :5173 serves the actual SPA.
 *
 * The journey proves in a REAL browser:
 *   1. the workflow is authored + created through the real V2-002 route
 *      (a valid WorkflowIR document with presentation labels and an
 *      approval node), then the detail page renders its facts from the
 *      real reads;
 *   2. Run opens the consequential-action preview: the steps from the
 *      V2-003 presentation layer (never internal node IDs), the version,
 *      the Approval-required line (the IR's approval node — consent), the
 *      canonical "Needs access to" capability facts, and the honest
 *      not-set-up where fact (no deployment exists);
 *   3. Run sends the REAL commands — the V2-005 request (command envelope,
 *      manual trigger) then the start command — and the status surface
 *      derives "Running" from the authoritative run record;
 *   4. an executor-side pause AT the approval step (the real pause command
 *      with atStepId) followed by a page reload renders the
 *      history-derived "Waiting for you" state — the approval-boundary
 *      derivation proven end-to-end over the real history read;
 *   5. the run appears in Recent activity (the authoritative runs read).
 *
 * The identity-only topology cannot exercise the run surface (the workflow
 * read itself 404s there — the T4 journey in work-074-auth.spec.ts pins
 * that honest page-level behavior), so this spec is the T6 browser
 * evidence surface.
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

const GINA_EMAIL = 'gina-t6@e2e.example.com';
const GINA_PASSWORD = 'the-t6-password-42';

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
  // The V2-004 node directory (the placement matcher) + the V2-009
  // deployment service — the detail page reads deployments (T4's surface);
  // the run experience renders the placement facts from the same read.
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

/** The authored workflow: fetch → review (approval) → send | log. */
function authorDigestWorkflow(): WorkflowIrDocument {
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
        binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' },
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
        log_rejection: 'Log the rejection',
      },
    })
    .build();
}

test.describe('V2-017 T6 — the Run experience over the real authorities', () => {
  test('preview → real run commands → Running → pause at the approval step → Waiting for you', async ({ page }) => {
    // Fresh browser → the consumer shell.
    await page.goto('/');
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill('Gina (T6)');
    await page.locator('#email').fill(GINA_EMAIL);
    await page.locator('#password').fill(GINA_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(
      page.getByRole('heading', { name: /What do you want to get done\?/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Create the organization through the public route.
    const orgRes = await page.request.post('/api/organizations', { data: { name: 'Acme T6' } });
    expect(orgRes.ok()).toBeTruthy();
    const org = (await orgRes.json()) as { organization: { id: string } };

    // Author + create the workflow through the REAL V2-002 route.
    const document = authorDigestWorkflow();
    const createRes = await page.request.post(
      `/api/organizations/${org.organization.id}/workflow-repository/workflows`,
      {
        data: {
          slug: 'weekly-ticket-digest',
          name: 'Weekly ticket digest',
          description: 'Collect the open tickets and email the digest.',
          visibility: 'private',
          content: JSON.parse(serializeWorkflowIrDocument(document)) as Record<string, unknown>,
          protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
        },
      },
    );
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as {
      workflow: { id: string; headVersionId: string };
    };

    // The detail page renders its facts from the real reads.
    await page.goto(`/workflows/${created.workflow.id}`);
    await expect(
      page.getByRole('heading', { name: 'Weekly ticket digest' }),
    ).toBeVisible({ timeout: 15_000 });

    // Run opens the consequential-action preview.
    await page.getByRole('button', { name: 'Run' }).first().click();
    const preview = page.getByRole('region', { name: 'Run preview' });
    await expect(preview).toBeVisible();
    await expect(preview.getByText('Run Weekly ticket digest?')).toBeVisible();
    // The steps from the presentation layer (never internal node IDs).
    const steps = preview.getByRole('list', { name: 'This will' });
    await expect(steps).toContainText('Collect the open tickets');
    await expect(steps).toContainText('Your approval before sending');
    await expect(steps).toContainText('Email the weekly digest');
    await expect(preview.getByText(/review_gate/i)).toHaveCount(0);
    // The version + the approval (consent) + capability facts.
    await expect(preview.getByText(/Version 1/i)).toBeVisible();
    await expect(preview.getByText(/Approval required/i)).toBeVisible();
    await expect(preview.getByText(/Needs access to/i)).toBeVisible();
    // The honest where fact: no deployment exists.
    await expect(preview.getByText(/Where it runs isn't set up yet/i)).toBeVisible();

    // Run: the REAL V2-005 commands (request → start). The status derives
    // from the authoritative run record.
    await preview.getByRole('button', { name: 'Run' }).click();
    await expect(preview).toHaveCount(0, { timeout: 15_000 });
    const status = page.getByRole('region', { name: 'Run status' });
    await expect(status).toBeVisible({ timeout: 15_000 });
    await expect(status.getByText('Running')).toBeVisible();
    // The run appears in Recent activity (the authoritative runs read).
    await expect(page.getByRole('list', { name: /recent activity/i })).toContainText('running');

    // An executor-side pause AT the approval step (the real pause command),
    // then a reload: the history-derived "Waiting for you" state.
    const runsRes = await page.request.get(
      `/api/organizations/${org.organization.id}/workflow-runs/runs`,
    );
    expect(runsRes.ok()).toBeTruthy();
    const runsBody = (await runsRes.json()) as {
      runs: Array<{ id: string; workflowId: string }>;
    };
    const mine = runsBody.runs.filter((r) => r.workflowId === created.workflow.id);
    expect(mine.length).toBeGreaterThan(0);
    const runId = mine[0]?.id ?? '';
    expect(runId).not.toBe('');
    const pauseRes = await page.request.post(`/api/workflow-runs/runs/${runId}/pause`, {
      data: { commandId: crypto.randomUUID(), correlationId: crypto.randomUUID(), atStepId: 'review_gate' },
    });
    expect(pauseRes.ok()).toBeTruthy();

    await page.reload();
    const statusAfter = page.getByRole('region', { name: 'Run status' });
    await expect(statusAfter.getByText('Waiting for you')).toBeVisible({ timeout: 15_000 });
    // The internal run-state word stays in Advanced details only.
    await expect(statusAfter.getByText(/^paused$/)).toHaveCount(0);
    await statusAfter.getByText('Advanced details').click();
    await expect(statusAfter.getByText(/^paused$/)).toBeVisible();
    await expect(statusAfter.getByText(runId)).toBeVisible();
  });
});
