/**
 * V2-017 T10 — Browser-level E2E: the universal Activity timeline and the
 * "How do you know?" trust presentation over the REAL authorities.
 *
 * Real topology (the t6 pattern): the identity stack's real pglite
 * PostgreSQL (all migrations) + the REAL Fastify buildServer wired with
 * the real session auth + identity routes + the organizations routes + the
 * REAL V2-002 workflow-repository routes AND the REAL V2-005 workflow-runs
 * routes (commands + the reconstructed-history read that carries the
 * evidence records and the V2-014 attestation bindings). The Vite dev
 * server on :5173 serves the actual SPA.
 *
 * The journey proves in a REAL browser:
 *   1. the derivable empty state BEFORE anything exists (a successful read
 *      with no records — never an error), plus the honest teaching
 *      disclosure (no fabricated teaching events: V2-006/V2-010 expose no
 *      list read);
 *   2. three real runs driven through the REAL V2-005 commands — one
 *      paused AT the approval step (the history-derived "Waiting for
 *      you"), one failed (the recovery event), one completed WITH real
 *      evidence records and a REAL V2-014 Ed25519 attestation attached at
 *      the Run boundary — plus the V1 "New version" event from the V2-002
 *      version record;
 *   3. the timeline renders every event with the §15 human state
 *      vocabulary, newest first, each entry linking to the related
 *      workflow (§16);
 *   4. the filters are presentation-only over the record states;
 *   5. the per-event "How do you know?" loads the history on demand:
 *      concise evidence first (the records' own descriptions + the honest
 *      "Verified by" wording), then advanced verification on demand (the
 *      attestation's statement action, the assurance level) with the
 *      frozen no-physical-proof boundary;
 *   6. a FAILED history read stays visibly Unavailable with Try again
 *      (injected as a real HTTP 500 the browser actually receives), and
 *      the retry recovers the honest record — never a successful empty
 *      trust surface;
 *   7. the run-status surface (the workflow detail page) carries the same
 *      trust presentation composed from the same history read.
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
import {
  generateAttesterKeyPair,
  signExecutionAttestation,
  executionValueCommitment,
  type ExecutionStatement,
} from '../../src/execution-attestation/index.js';
import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '@platform/index.js';

let stack: TestIdentityStack;
let server: FastifyInstance;

const GINA_EMAIL = 'gina-t10@e2e.example.com';
const GINA_PASSWORD = 'the-t10-password-42';

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
  // deployment service — the workflow detail page reads deployments (T4's
  // surface); the Activity timeline itself reads runs/versions only.
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

/** A deterministic command envelope (fresh ids per call). */
function envelope() {
  return { commandId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
}

test.describe('V2-017 T10 — the universal Activity + trust over the real authorities', () => {
  test('empty state → three real runs (paused-at-approval / failed / completed+evidence+attestation) → timeline → filters → How do you know? → unavailable-read recovery → run-status trust', async ({ page }) => {
    // Fresh browser → the consumer shell → Activity.
    await page.goto('/');
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill('Gina (T10)');
    await page.locator('#email').fill(GINA_EMAIL);
    await page.locator('#password').fill(GINA_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(
      page.getByRole('heading', { name: /What do you want to get done\?/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Create the organization through the public route.
    const orgRes = await page.request.post('/api/organizations', { data: { name: 'Acme T10' } });
    expect(orgRes.ok()).toBeTruthy();
    const org = (await orgRes.json()) as { organization: { id: string } };

    // FIRST VISIT: the derivable empty state (a real successful read with
    // no records yet — never an error), plus the honest teaching
    // disclosure (no fabricated teaching events).
    await page.goto('/activity');
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/No activity yet/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Teaching activity isn\u2019t shown here yet/i)).toBeVisible();

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
    if (!createRes.ok()) {
      const fs = await import('node:fs');
      fs.writeFileSync('/tmp/t10-create-debug.txt', `status=${createRes.status()}\nbody=${await createRes.text()}\n`);
    } else {
      const fs = await import('node:fs');
      fs.writeFileSync('/tmp/t10-create-debug.txt', await createRes.text());
    }
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as {
      workflow: { id: string; headVersionId: string };
    };
    const workflowId = created.workflow.id;
    const versionId = created.workflow.headVersionId;

    /** Drive one real run: request → start. */
    async function startRun(): Promise<string> {
      const requestRes = await page.request.post(
        `/api/organizations/${org.organization.id}/workflow-runs/runs`,
        {
          data: {
            ...envelope(),
            workflowId,
            versionId,
            installationId: null,
            trigger: { type: 'manual', id: crypto.randomUUID() },
            inputCommitments: [],
          },
        },
      );
      expect(requestRes.ok()).toBeTruthy();
      const requested = (await requestRes.json()) as { run: { id: string } };
      const startRes = await page.request.post(
        `/api/workflow-runs/runs/${requested.run.id}/start`,
        { data: { ...envelope() } },
      );
      expect(startRes.ok()).toBeTruthy();
      return requested.run.id;
    }

    // Run A (the needs-you event): pause AT the approval step (the real
    // pause command carrying atStepId — the t6 executor-side pattern).
    const runA = await startRun();
    const pauseRes = await page.request.post(`/api/workflow-runs/runs/${runA}/pause`, {
      data: { ...envelope(), atStepId: 'review_gate' },
    });
    expect(pauseRes.ok()).toBeTruthy();

    // Run B (the failure/recovery event): the real fail command.
    const runB = await startRun();
    const failRes = await page.request.post(`/api/workflow-runs/runs/${runB}/fail`, {
      data: { ...envelope(), reason: 'The mail service rejected the message.' },
    });
    expect(failRes.ok()).toBeTruthy();

    // Run D (F01): pause at a NON-approval step — a paused run the user
    // is NOT needed for must never be upgraded into the Needs-me bucket.
    const runD = await startRun();
    const pauseDRes = await page.request.post(`/api/workflow-runs/runs/${runD}/pause`, {
      data: { ...envelope(), atStepId: 'send_digest' },
    });
    expect(pauseDRes.ok()).toBeTruthy();

    // Run C (the completed event WITH trust): step started → REAL evidence
    // records → a REAL V2-014 Ed25519 attestation attached at the Run
    // boundary → complete.
    const runC = await startRun();
    const stepRes = await page.request.post(
      `/api/workflow-runs/runs/${runC}/steps/send_digest/started`,
      { data: { ...envelope() } },
    );
    expect(stepRes.ok()).toBeTruthy();

    const evidenceObservation = await page.request.post(
      `/api/workflow-runs/runs/${runC}/evidence`,
      {
        data: {
          ...envelope(),
          evidenceClass: 'observation',
          producerKind: 'executor',
          producerId: 'node_test_host_1',
          contentCommitment: executionValueCommitment('t10-evidence-observation'),
          description: 'Observed the message-delivery receipt from the mail service.',
        },
      },
    );
    expect(evidenceObservation.ok()).toBeTruthy();
    const evidenceConfirmation = await page.request.post(
      `/api/workflow-runs/runs/${runC}/evidence`,
      {
        data: {
          ...envelope(),
          evidenceClass: 'human_confirmation',
          producerKind: 'user',
          producerId: 'gina-t10',
          contentCommitment: executionValueCommitment('t10-evidence-confirmation'),
          description: 'You approved the digest before it was sent.',
        },
      },
    );
    expect(evidenceConfirmation.ok()).toBeTruthy();

    // The run's semantic-digest pin (the GET run read — the statement must
    // bind the run's EXACT version semantic digest).
    const runRead = await page.request.get(`/api/workflow-runs/runs/${runC}`);
    expect(runRead.ok()).toBeTruthy();
    const runCRecord = (await runRead.json()) as {
      run: { id: string; versionSemanticDigest: string };
    };
    const now = new Date();
    const executedAt = new Date(now.getTime() - 30_000).toISOString();
    const issuedAt = new Date(now.getTime() - 10_000).toISOString();
    const validUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
    const statement: ExecutionStatement = {
      objectType: 'workflowos/execution-statement/v1',
      statementSchemaVersion: 1,
      workflowId,
      workflowVersionId: versionId,
      workflowVersionSemanticDigest: runCRecord.run.versionSemanticDigest,
      deploymentId: 'wfin_not_used_here',
      runId: runC,
      attemptId: 1,
      stepId: 'send_digest',
      nodeId: 'node_test_host_1',
      executionClass: 'deterministic_api',
      capability: 'messaging.send',
      action: 'Email the weekly digest',
      inputCommitments: [executionValueCommitment('t10-input')],
      outputCommitments: [executionValueCommitment('t10-output')],
      observationCommitments: [executionValueCommitment('t10-observation')],
      evidenceReferences: [],
      causalParents: [],
      nonce: `challenge-t10-${crypto.randomUUID()}`,
      epoch: 1,
      outcome: 'succeeded',
      executedAt,
      validUntil,
    } as ExecutionStatement;
    const attester = generateAttesterKeyPair();
    const attestation = signExecutionAttestation({
      statement,
      attesterPrivateKey: attester.privateKey,
      attesterPublicKeyDer: attester.publicKeyDer,
      assurance: 'software_signed',
      issuedAt,
    });
    const attachRes = await page.request.post(`/api/workflow-runs/runs/${runC}/attestations`, {
      data: {
        ...envelope(),
        attemptNumber: 1,
        stepId: 'send_digest',
        attestation: attestation as unknown as Record<string, unknown>,
      },
    });
    expect(attachRes.ok()).toBeTruthy();

    // Complete run C (the REAL lifecycle command) — last, so it is the
    // workflow's newest run (the run-status data source on the detail page).
    const completeRes = await page.request.post(`/api/workflow-runs/runs/${runC}/complete`, {
      data: { ...envelope(), outputCommitments: [executionValueCommitment('t10-output')] },
    });
    expect(completeRes.ok()).toBeTruthy();

    // THE TIMELINE: every event renders with the §15 human vocabulary,
    // newest first, each entry linking to the workflow (§16).
    await page.goto('/activity');
    const timeline = page.getByRole('list', { name: 'Activity timeline' });
    await expect(timeline.getByText('Waiting for you')).toBeVisible({ timeout: 15_000 });
    await expect(timeline.getByText('Completed')).toBeVisible();
    await expect(timeline.getByText('Couldn\u2019t complete')).toBeVisible();
    await expect(timeline.getByText('New version')).toBeVisible();
    // 5 events: 4 runs (paused-at-approval / failed / paused-not-approval
    // / completed) + the V1 version record.
    expect(await timeline.getByRole('listitem').count()).toBe(5);
    // Newest first: the completed run (driven last) is the first entry.
    await expect(timeline.getByRole('listitem').first()).toContainText('Completed');
    // The non-approval paused run (Run D) honestly shows "Paused".
    await expect(timeline.getByText('Paused')).toBeVisible();
    // Internal state words never render on the primary timeline.
    await expect(timeline.getByText(/^paused$/)).toHaveCount(0);
    await expect(timeline.getByText(/^failed$/)).toHaveCount(0);

    // The filters are presentation-only over the record states.
    const filters = page.getByRole('group', { name: 'Activity filters' });
    await filters.getByRole('button', { name: 'Needs me' }).click();
    // F01: ONLY the approval-derived waiting run — the paused run the
    // user is NOT needed for (Run D) never enters the Needs-me bucket.
    await expect(timeline.getByRole('listitem')).toHaveCount(1);
    await expect(timeline.getByText('Waiting for you')).toBeVisible();
    await expect(timeline.getByText('Paused')).toHaveCount(0);
    await filters.getByRole('button', { name: 'Completed' }).click();
    await expect(timeline.getByRole('listitem')).toHaveCount(1);
    await filters.getByRole('button', { name: 'Failed' }).click();
    await expect(timeline.getByRole('listitem')).toHaveCount(1);
    await filters.getByRole('button', { name: 'All' }).click();
    await expect(timeline.getByRole('listitem')).toHaveCount(5);

    // A FAILED history read stays visibly Unavailable with Try again —
    // injected as a REAL HTTP 500 the browser actually receives; the
    // retry recovers the honest record (never a successful empty trust).
    await page.route('**/api/workflow-runs/runs/*/history', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 't10-injected-read-failure' }),
      });
    });
    const failedItem = timeline.getByRole('listitem').filter({ hasText: 'Couldn\u2019t complete' });
    await failedItem.getByRole('button', { name: 'How do you know?' }).click();
    const failedTrust = failedItem.getByRole('region', { name: 'How do you know?' });
    await expect(failedTrust.getByRole('status', { name: 'Unavailable' })).toBeVisible();
    await expect(failedTrust.getByRole('button', { name: /try again/i })).toBeVisible();
    await expect(failedTrust.getByText(/No evidence records yet/i)).toHaveCount(0);
    await page.unroute('**/api/workflow-runs/runs/*/history');
    await failedTrust.getByRole('button', { name: /try again/i }).click();
    await expect(failedTrust.getByText(/No evidence records yet/i)).toBeVisible();

    // THE TRUST EXPLANATION (the completed run): concise evidence first —
    // the records' OWN descriptions + the honest "Verified by" wording.
    const completedItem = timeline.getByRole('listitem').filter({ hasText: 'Completed' });
    await completedItem.getByRole('button', { name: 'How do you know?' }).click();
    const trust = completedItem.getByRole('region', { name: 'How do you know?' });
    await expect(trust.getByText(/Observed the message-delivery receipt/i)).toBeVisible();
    await expect(trust.getByText(/You approved the digest/i)).toBeVisible();
    await expect(trust.getByText(/Verified by an observation record/i)).toBeVisible();
    await expect(trust.getByText(/Verified by human confirmation/i)).toBeVisible();
    // Advanced verification on demand: the V2-014 facts (the statement's
    // action, the assurance level) with the frozen trust boundary.
    await trust.getByText('Advanced verification').click();
    await expect(trust.getByText(/Email the weekly digest/i)).toBeVisible();
    await expect(trust.getByText(/Software-signed/i)).toBeVisible();
    await expect(
      trust.getByText(/can\u2019t by itself prove what happened in the physical world/i),
    ).toBeVisible();

    // §16 direct links (F02): the run entry reaches the SPECIFIC run —
    // "Open the run" navigates to the workflow's run-status surface with
    // that run selected (?run=). Here: the earlier paused-at-approval
    // run, whose status is presented — never the newest run's status.
    const waitingItem = timeline.getByRole('listitem').filter({ hasText: 'Waiting for you' });
    await waitingItem.getByRole('link', { name: 'Open the run' }).click();
    const selectedStatus = page.getByRole('region', { name: 'Run status' });
    await expect(selectedStatus.getByText('Waiting for you')).toBeVisible({
      timeout: 15_000,
    });
    await expect(selectedStatus.getByText(/^Completed$/)).toHaveCount(0);
    // The honest earlier-run note — an earlier run is never mistaken for
    // the current status.
    await expect(selectedStatus.getByText(/An earlier run/i)).toBeVisible();

    // Back to Activity for the workflow-name link (the same surface's
    // newest-run default, without the ?run= param).
    await page.goto('/activity');
    await expect(timeline.getByText('Completed')).toBeVisible({ timeout: 15_000 });

    // §16: the entry reaches the related Workflow (and its Run surface).
    await completedItem.getByRole('link', { name: 'Weekly ticket digest' }).click();
    await expect(
      page.getByRole('heading', { name: 'Weekly ticket digest' }),
    ).toBeVisible({ timeout: 15_000 });

    // The run-status surface carries the SAME trust presentation,
    // composed from the same history read (no second evidence authority).
    const status = page.getByRole('region', { name: 'Run status' });
    await expect(status.getByText('Completed')).toBeVisible({ timeout: 15_000 });
    const statusTrust = status.getByRole('region', { name: 'How do you know?' });
    await expect(statusTrust.getByText(/Observed the message-delivery receipt/i)).toBeVisible();
    await expect(statusTrust.getByText(/Verified by an observation record/i)).toBeVisible();
  });
});
