/**
 * V2-017 T8 — Browser-level E2E: the "When" experience over the REAL
 * scheduling/event authorities.
 *
 * Real topology (the t6/work-074 pattern): the identity stack's real
 * pglite PostgreSQL (all migrations) + the REAL Fastify buildServer wired
 * with the real session auth + identity routes + the organizations routes
 * + the REAL V2-002 workflow-repository routes, the REAL V2-005
 * workflow-runs routes, AND the REAL V2-009 workflow-deployments routes
 * (deployment create-or-converge, subscription create-or-converge,
 * enable/disable). The Vite dev server on :5173 serves the actual SPA.
 *
 * The journey proves in a REAL browser:
 *   1. the manual When fact renders before any trigger exists, with the
 *      honest not-deployed where fact, and the contextual [Schedule]
 *      action opens the §11 editor;
 *   2. "On a schedule" creates the REAL deployment (any-supported
 *      placement, the pinned head version) + the REAL daily subscription
 *      through the public routes, and the page re-renders the human When
 *      language ("Runs every day · 9:00 AM UTC") + the where fact
 *      ("Any supported node") from the authoritative reads;
 *   3. "After another workflow" creates the REAL workflow-completion
 *      trigger (workflow.run.completed + the typed workflowId match) and
 *      resolves the followed workflow's NAME from the org read; the
 *      canonical event name stays expert-only (Advanced details);
 *   4. Pause travels the REAL enable/disable route and the configured
 *      trigger is presented as Paused (never silently dropped);
 *   5. "When something happens" creates the REAL event subscription with
 *      the canonical registry event type.
 *
 * No occurrence math is ever asserted: the page presents CONFIGURED
 * facts only (the schedule derivation is the backend's pure function of
 * the injected clock).
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

const HANA_EMAIL = 'hana-t8@e2e.example.com';
const HANA_PASSWORD = 'the-t8-password-42';

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
  // deployment service — the When experience's mutations travel these
  // REAL routes (create-or-converge + enable/disable).
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

/** A simple authored workflow: collect → send, with presentation labels. */
function authorSimpleWorkflow(
  title: string,
  labels: { collect: string; send: string },
): WorkflowIrDocument {
  const collect: WorkflowNode = {
    id: 'collect',
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
    outputs: [{ name: 'collected', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const send: WorkflowNode = {
    id: 'send',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'messaging.send' },
    capabilityRequirements: ['messaging.send'],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'collect', output: 'collected' },
      },
    ],
    outputs: [{ name: 'messageId', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart('collect')
    .addNode(collect)
    .addNode(send)
    .addEdge({ from: 'collect', to: 'send', on: 'success' })
    .addWorkflowOutput({
      name: 'messageId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send', output: 'messageId' },
    })
    .withDefaultPlacement('any_supported_node')
    .withProvenance({ origin: 'authored' })
    .withPresentation({
      title,
      nodeLabels: { collect: labels.collect, send: labels.send },
    })
    .build();
}

async function createWorkflowThroughRoute(
  page: import('@playwright/test').Page,
  orgId: string,
  slug: string,
  name: string,
  document: WorkflowIrDocument,
): Promise<{ id: string; headVersionId: string }> {
  const res = await page.request.post(
    `/api/organizations/${orgId}/workflow-repository/workflows`,
    {
      data: {
        slug,
        name,
        description: `${name} — the T8 journey workflow.`,
        visibility: 'private',
        content: JSON.parse(serializeWorkflowIrDocument(document)) as Record<string, unknown>,
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      },
    },
  );
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { workflow: { id: string; headVersionId: string } };
  return body.workflow;
}

test.describe('V2-017 T8 — the When experience over the real authorities', () => {
  test('manual → schedule (deployment + subscription create-or-converge) → after another workflow → pause → event', async ({ page }) => {
    // Fresh browser → the consumer shell → a real account.
    await page.goto('/');
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill('Hana (T8)');
    await page.locator('#email').fill(HANA_EMAIL);
    await page.locator('#password').fill(HANA_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(
      page.getByRole('heading', { name: /What do you want to get done\?/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Create the organization through the public route.
    const orgRes = await page.request.post('/api/organizations', { data: { name: 'Acme T8' } });
    expect(orgRes.ok()).toBeTruthy();
    const org = (await orgRes.json()) as { organization: { id: string } };

    // Author + create the scheduled workflow through the REAL V2-002 route.
    const digest = await createWorkflowThroughRoute(
      page,
      org.organization.id,
      'weekly-invoice-digest-t8',
      'Weekly invoice digest',
      authorSimpleWorkflow('Weekly invoice digest', {
        collect: 'Collect the open invoices',
        send: 'Email the weekly digest',
      }),
    );
    // The followed workflow (the "After another workflow" target).
    const sweep = await createWorkflowThroughRoute(
      page,
      org.organization.id,
      'expense-sweep-t8',
      'Expense sweep',
      authorSimpleWorkflow('Expense sweep', {
        collect: 'Collect the expenses',
        send: 'File the expense report',
      }),
    );

    // The detail page: the manual When fact + the honest no-where fact.
    await page.goto(`/workflows/${digest.id}`);
    await expect(
      page.getByRole('heading', { name: 'Weekly invoice digest' }),
    ).toBeVisible({ timeout: 15_000 });
    const when = page.getByRole('region', { name: 'When it runs' });
    await expect(when).toBeVisible();
    await expect(when.getByText('Runs when you start it')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Where it runs' })).toHaveText(
      /Not deployed yet/i,
    );

    // ---- Journey 1: "On a schedule" (the REAL create-or-converge) ----
    await when.getByRole('button', { name: 'Schedule' }).click();
    const editor = page.getByRole('region', { name: 'When editor' });
    await expect(editor).toBeVisible();
    // The five §11 choices in plain language.
    for (const choice of ['Run now', 'At a time', 'On a schedule', 'When something happens', 'After another workflow']) {
      await expect(editor.getByRole('radio', { name: choice })).toBeVisible();
    }
    // Simple scheduling first: the advanced controls stay hidden.
    await expect(editor.getByLabel('Timezone')).toHaveCount(0);
    await editor.getByRole('radio', { name: 'On a schedule' }).check();
    await editor.getByLabel('How often?').selectOption('daily');
    await editor.getByLabel('Time', { exact: true }).fill('09:00');
    await editor.getByRole('button', { name: 'Save' }).click();

    // The REAL deployment + subscription were created; the page re-renders
    // the human When language from the authoritative reads.
    await expect(
      when.getByText('Runs every day · 9:00 AM UTC', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('region', { name: 'Where it runs' })).toHaveText(
      /Any supported node/i,
    );
    // No occurrence math is presented (only configured facts).
    await expect(when.getByText(/next run/i)).toHaveCount(0);

    // ---- Journey 2: "After another workflow" (workflow-completion) ----
    await when.getByRole('button', { name: 'Schedule' }).click();
    await editor.getByRole('radio', { name: 'After another workflow' }).check();
    await editor.getByLabel('Which workflow?').selectOption({ label: 'Expense sweep' });
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(
      when.getByText('Runs after Expense sweep finishes', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // The canonical event name stays expert-only (Advanced details).
    await expect(when.getByText('workflow.run.completed')).toHaveCount(0);
    // The workflow-completion trigger is the second configured trigger —
    // its Advanced details is the LAST one in the ordered list.
    await when.getByText('Advanced details').last().click();
    await expect(when.getByText('Event type: workflow.run.completed')).toBeVisible();
    await expect(when.getByText(/Missed window: skip/)).toBeVisible();

    // ---- Journey 3: Pause (the REAL enable/disable route) ----
    await when.getByRole('button', { name: 'Pause' }).last().click();
    await expect(when.getByText(/ · Paused$/)).toBeVisible({ timeout: 15_000 });
    // The daily trigger is still presented (never silently dropped).
    await expect(when.getByText('Runs every day · 9:00 AM UTC', { exact: true })).toBeVisible();
    // Resume restores it.
    await when.getByRole('button', { name: 'Resume' }).last().click();
    await expect(when.getByText(/ · Paused$/)).toHaveCount(0, { timeout: 15_000 });

    // ---- Journey 4: "When something happens" (a registry event) ----
    await when.getByRole('button', { name: 'Schedule' }).click();
    await editor.getByRole('radio', { name: 'When something happens' }).check();
    await editor.getByLabel('What event?').selectOption('file.changed');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(
      when.getByText('Runs when a file changes', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Every configured trigger renders (all three, plus the manual mode).
    await expect(when.getByText('Runs when you start it')).toBeVisible();
    await expect(when.getByText('Runs every day · 9:00 AM UTC', { exact: true })).toBeVisible();
    await expect(when.getByText('Runs after Expense sweep finishes', { exact: true })).toBeVisible();
    await expect(when.getByText('Runs when a file changes', { exact: true })).toBeVisible();

    // The followed workflow is untouched (no trigger was created on it).
    await page.goto(`/workflows/${sweep.id}`);
    const sweepWhen = page.getByRole('region', { name: 'When it runs' });
    await expect(sweepWhen.getByText('Runs when you start it')).toBeVisible({ timeout: 15_000 });
    await expect(sweepWhen.getByText(/Runs every day/i)).toHaveCount(0);
  });
});
