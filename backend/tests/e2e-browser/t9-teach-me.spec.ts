/**
 * V2-017 T9 — Browser-level E2E: the Teach Me / reverse-teaching
 * experience over the REAL teaching authorities.
 *
 * Real topology (the t6/t7/t8 pattern): the identity stack's real pglite
 * PostgreSQL (all migrations) + the REAL Fastify buildServer wired with
 * the real session auth + identity + organizations routes + the REAL
 * V2-002 workflow-repository routes (workflow create + version content
 * + installations) + the REAL V2-005 run routes + the REAL V2-009
 * deployment routes + the T9 TRANSPORT routes over the REAL V2-006
 * teaching-session service and the REAL V2-010 reverse-teaching service
 * (their own in-memory stores — the modules' reference composition).
 *
 * The journey proves in a REAL browser (UX §12/§13 end-to-end):
 *   1. Teach Me opens beside Run; the session create-or-converges bound
 *      to the pinned head version;
 *   2. Start lesson → the REAL derived lesson renders (labels from the
 *      V2-003 presentation layer — internal node IDs never surface);
 *   3. the checkpoint flow through the REAL commands (confirm step 1,
 *      pause, reload, resume to the EXACT pending step, confirm step 2);
 *   4. practice (the authority's own questions) + the assessment (order
 *      + declared-semantics recall) → the terminal Lesson complete;
 *   5. teaching evidence renders under the visibly DISTINCT surface;
 *   6. install the workflow through the REAL route → the §13 entry
 *      appears → the reverse-teaching journey: the manual steps
 *      performed through the REAL commands → completion — and ZERO
 *      runs ever exist (learning is never execution).
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
import { DefaultTeachingSessionService, InMemoryTeachingSessionStore } from '../../src/teaching-sessions/index.js';
import {
  DefaultReverseTeachingSessionService,
  InMemoryReverseTeachingSessionStore,
} from '../../src/reverse-teaching/index.js';
import {
  createWorkflowIrBuilder,
  serializeWorkflowIrDocument,
} from '../../src/workflow-ir/index.js';
import type { WorkflowIrDocument, WorkflowNode } from '../../src/workflow-ir/index.js';
import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '@platform/index.js';

let stack: TestIdentityStack;
let server: FastifyInstance;

const JUNO_EMAIL = 'juno-t9@e2e.example.com';
const JUNO_PASSWORD = 'the-t9-password-42';

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
  // The REAL teaching authorities (V2-006 / V2-010), each with its own
  // in-memory store — the modules' reference composition.
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
    teaching: { teachingSessionService: teachingService, workflowRepositoryService: repository },
    reverseTeaching: {
      reverseTeachingService: reverseTeachingService,
      workflowRepositoryService: repository,
    },
  });
  await server.listen({ port: 3001, host: '127.0.0.1' });
});

test.afterAll(async () => {
  await server.close();
  await stack.teardown();
});

/** The authored workflow: fetch (system) → do (agentic, PERFORMED by the
 * learner in reverse teaching) → send (system). */
function authorDigestWorkflow(): WorkflowIrDocument {
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

test.describe('V2-017 T9 — the Teach Me / reverse-teaching experience over the real authorities', () => {
  test('lesson → checkpoints → pause/resume → practice → assessment → complete; then install → reverse teaching → zero runs', async ({ page }) => {
    // Fresh browser → the consumer shell → a real account.
    await page.goto('/');
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill('Juno (T9)');
    await page.locator('#email').fill(JUNO_EMAIL);
    await page.locator('#password').fill(JUNO_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(
      page.getByRole('heading', { name: /What do you want to get done\?/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Create the organization + the workflow through the REAL routes.
    const orgRes = await page.request.post('/api/organizations', { data: { name: 'Acme T9' } });
    expect(orgRes.ok()).toBeTruthy();
    const org = (await orgRes.json()) as { organization: { id: string } };
    const createRes = await page.request.post(
      `/api/organizations/${org.organization.id}/workflow-repository/workflows`,
      {
        data: {
          slug: 'weekly-ticket-digest-t9',
          name: 'Weekly ticket digest',
          description: 'Collect the open tickets and email the digest.',
          visibility: 'private',
          content: JSON.parse(serializeWorkflowIrDocument(authorDigestWorkflow())) as Record<
            string,
            unknown
          >,
          protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
        },
      },
    );
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as {
      workflow: { id: string; headVersionId: string };
    };

    // The detail page: Teach Me opens beside Run (§12 first-class).
    await page.goto(`/workflows/${created.workflow.id}`);
    await expect(
      page.getByRole('heading', { name: 'Weekly ticket digest' }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Teach Me' }).click();
    const teach = page.getByRole('region', { name: 'Teach Me' });
    await expect(teach).toBeVisible();
    // The session create-or-converge happened (bound to Version 1).
    await expect(teach.getByText(/You'll learn to do this yourself/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(teach.getByText(/Version 1 — the lesson is bound to it/i)).toBeVisible();

    // Start lesson → the REAL derived lesson: Step 1 with the
    // presentation label in the consumer title line (the authority's
    // own explanation text renders verbatim below it).
    await teach.getByRole('button', { name: 'Start lesson' }).click();
    await expect(teach.getByText(/Step 1 of 3 — Collect the open tickets/)).toBeVisible({
      timeout: 15_000,
    });

    // Confirm step 1, then PAUSE through the real command.
    await teach.getByRole('button', { name: "I've done it" }).click();
    await expect(teach.getByText(/Step 2 of 3 — Copy the ticket numbers/)).toBeVisible({
      timeout: 15_000,
    });
    await teach.getByRole('button', { name: 'Pause' }).click();
    await expect(teach.getByText(/Paused/i)).toBeVisible({ timeout: 15_000 });

    // Reload: the session converges (create-or-converge) in the paused
    // state; resume returns to the EXACT pending step.
    await page.reload();
    await page.getByRole('button', { name: 'Teach Me' }).click();
    const teach2 = page.getByRole('region', { name: 'Teach Me' });
    await expect(teach2.getByText(/Paused/i)).toBeVisible({ timeout: 15_000 });
    await teach2.getByRole('button', { name: 'Resume' }).click();
    await expect(teach2.getByText(/Step 2 of 3 — Copy the ticket numbers/)).toBeVisible({
      timeout: 15_000,
    });

    // Confirm step 2, then step 3 → the assessment appears (all checkpoints confirmed).
    await teach2.getByRole('button', { name: "I've done it" }).click();
    await expect(teach2.getByText(/Step 3 of 3 — Email the weekly digest/)).toBeVisible({
      timeout: 15_000,
    });
    await teach2.getByRole('button', { name: "I've done it" }).click();
    await expect(teach2.getByText(/All steps confirmed/i)).toBeVisible({ timeout: 15_000 });

    // Practice: the authority's own question (the step semantics
    // options) — answer correctly through the real command.
    const practice = teach2.getByRole('region', { name: 'Practice' }).first();
    await expect(practice).toBeVisible({ timeout: 15_000 });
    await practice.getByRole('radio', { name: 'github.repository.read' }).first().check();
    await practice.getByRole('button', { name: 'Check' }).click();

    // The assessment: order the steps + recall each step's declared
    // semantics (the capabilities — what practice taught).
    const assessment = teach2.getByRole('region', { name: 'Show you know it' });
    await expect(assessment).toBeVisible({ timeout: 15_000 });
    await assessment
      .getByLabel('Position of Collect the open tickets')
      .selectOption('1');
    await assessment.getByLabel('Position of Copy the ticket numbers').selectOption('2');
    await assessment.getByLabel('Position of Email the weekly digest').selectOption('3');
    await assessment.getByLabel('What does Collect the open tickets do?').fill('github.repository.read');
    await assessment.getByLabel('What does Copy the ticket numbers do?').fill('Open the issue tracker and copy the open ticket numbers');
    await assessment.getByLabel('What does Email the weekly digest do?').fill('messaging.send');
    await assessment.getByRole('button', { name: 'Submit' }).click();

    // Terminal: Lesson complete — no lifecycle commands remain.
    await expect(teach2.getByText('Lesson complete')).toBeVisible({ timeout: 15_000 });
    await expect(teach2.getByRole('button', { name: 'Pause' })).toHaveCount(0);
    await expect(teach2.getByRole('button', { name: "I've done it" })).toHaveCount(0);

    // Teaching evidence: the DISTINCT surface (never execution vocabulary).
    const evidence = teach2.getByRole('region', { name: 'Teaching evidence' });
    await expect(evidence).toBeVisible();
    await expect(evidence.getByText(/kept separate from run evidence/i)).toBeVisible();

    // ---- Part 2 (§13): install → reverse teaching → zero runs ----
    // Install the workflow through the REAL V2-002 route.
    const installRes = await page.request.post(
      `/api/organizations/${org.organization.id}/workflow-repository/installations`,
      { data: { workflowId: created.workflow.id, versionId: created.workflow.headVersionId } },
    );
    expect(installRes.ok()).toBeTruthy();

    // Reload: the detail page now knows the installation; the §13 entry
    // appears inside the lesson surface.
    await page.reload();
    await page.getByRole('button', { name: 'Teach Me' }).click();
    const teach3 = page.getByRole('region', { name: 'Teach Me' });
    await expect(teach3.getByText(/Lesson complete/)).toBeVisible({ timeout: 15_000 });
    await expect(teach3.getByRole('button', { name: /do it myself/i })).toBeVisible({
      timeout: 15_000,
    });

    // The reverse journey: the session + lesson through the REAL
    // V2-010 routes; the zero-runs distinction is explicit.
    await teach3.getByRole('button', { name: /do it myself/i }).click();
    const reverse = page.getByRole('region', { name: 'Do it yourself' });
    await expect(reverse).toBeVisible({ timeout: 15_000 });
    // The zero-runs distinction is explicit (the §13 entry note + the
    // do-it-yourself surface).
    await expect(reverse.getByText(/no run is created/i)).toBeVisible();
    await expect(teach3.getByText(/no run is created/i)).toBeVisible();

    // Perform the manual steps through the REAL commands. Step 1 is
    // system-performed (acknowledge); step 2 is the agentic task the
    // LEARNER performs; step 3 is system-performed (acknowledge).
    await expect(reverse.getByText(/Step 1 of 3 — Collect the open tickets/)).toBeVisible();
    await reverse.getByRole('button', { name: 'I understand' }).click();
    await expect(reverse.getByText(/Step 2 of 3 — Copy the ticket numbers/)).toBeVisible({
      timeout: 15_000,
    });
    await reverse.getByLabel('What did you do?').fill('Opened the tracker and copied the numbers myself');
    await reverse.getByRole('button', { name: 'I did this step' }).click();
    await expect(reverse.getByText(/Step 3 of 3 — Email the weekly digest/)).toBeVisible({
      timeout: 15_000,
    });
    await reverse.getByRole('button', { name: 'I understand' }).click();
    await expect(reverse.getByText(/You did the whole thing yourself/i)).toBeVisible({
      timeout: 15_000,
    });

    // ZERO runs: learning never executed the workflow (the §13
    // structural guarantee, asserted against the authoritative read).
    const runsRes = await page.request.get(
      `/api/organizations/${org.organization.id}/workflow-runs/runs`,
    );
    expect(runsRes.ok()).toBeTruthy();
    const runsBody = (await runsRes.json()) as { runs: unknown[] };
    expect(runsBody.runs).toHaveLength(0);
    // The page agrees: Not run yet.
    await page.reload();
    await expect(page.getByText(/Not run yet/i)).toBeVisible({ timeout: 15_000 });
  });
});
