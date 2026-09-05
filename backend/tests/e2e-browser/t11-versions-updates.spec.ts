import { test, expect } from '@playwright/test';
import { buildIdentityStack } from '../helpers/test-identity-stack.js';
import {
  buildAuthPluginDeps,
  buildIdentityRouteDeps,
  buildOrganizationsRouteDeps,
} from '../helpers/test-identity-server.js';
import { buildServer } from '@api/server.js';
import { InMemoryQueue } from '@platform/index.js';
import { formatUtcTimestamp } from '../../src/workflow-runs/internal/run-clock.js';
import {
  DefaultWorkflowRepositoryService,
} from '../../src/workflow-repository/index.js';
import {
  DefaultWorkflowRunService,
} from '../../src/workflow-runs/index.js';
import {
  DefaultWorkflowDeploymentService,
} from '../../src/workflow-deployments/index.js';
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

/**
 * V2-017 T11 — the versions/updates/improvements journey over the REAL
 * authorities (the dispatch's real browser dogfooding requirement).
 *
 * The real paths: the real SPA (Vite) against a real backend (PGlite, all
 * migrations) with the real V2-002 routes, the real V2-011 optimization
 * authority through its T11 transport routes, and the EXISTING V2-002
 * installation commands for adoption. The journey:
 *
 *   version history (addressable + inspectable) → "An update is
 *   available" (the verbatim installed pin + the no-silent-change
 *   promise) → What changed (the V2-011 comparison) → explicit adoption
 *   (install v2 + retire v1 — the existing commands) → improvements
 *   (the §20 recommendation) → the proposal (what/why/trade-offs) → the
 *   owner approval → materialization as a NEW version (v3, parent v2) →
 *   the v1 baseline stays byte-identical (no mutation, ever).
 */

let server: FastifyInstance;

const JUNO_EMAIL = 'juno-t11@e2e.example.com';
const JUNO_PASSWORD = 'the-t11-password-42';

/** The optimizable workflow: fetch (API) → scan (AGENTIC, one API
 * capability — the detectable api_substitution opportunity) → send (API). */
function authorOptimizableWorkflow(taskText: string): WorkflowIrDocument {
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
    outputs: [{ name: 'tickets', type: { kind: 'json' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const scanStep: WorkflowNode = {
    id: 'scan_step',
    executionClass: 'agentic_computer_use',
    spec: {
      class: 'agentic_computer_use',
      task: taskText,
    },
    capabilityRequirements: ['github.repository.read'],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'tickets',
        type: { kind: 'json' },
        binding: { kind: 'node_output', node: 'fetch_step', output: 'tickets' },
      },
    ],
    outputs: [{ name: 'digest', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
    completionEvidence: 'verification',
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
        binding: { kind: 'node_output', node: 'scan_step', output: 'digest' },
      },
    ],
    outputs: [{ name: 'messageId', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  return createWorkflowIrBuilder()
    .withStart('fetch_step')
    .addNode(fetchStep)
    .addNode(scanStep)
    .addNode(sendStep)
    .addEdge({ from: 'fetch_step', to: 'scan_step', on: 'success' })
    .addEdge({ from: 'scan_step', to: 'send_step', on: 'success' })
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
        scan_step: 'Scan the board for the digest',
        send_step: 'Email the weekly digest',
      },
    })
    .build();
}

test.beforeAll(async () => {
  const stack = await buildIdentityStack();
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
    workflowOptimization: {
      workflowRepositoryService: repository,
      idFactory: () => `opt_${crypto.randomUUID()}`,
      clock: () => Date.now(),
    },
  });
  await server.listen({ port: 3001, host: '127.0.0.1' });
});

test.afterAll(async () => {
  await server.close();
});

test.describe('V2-017 T11 — the versions/updates/improvements experience over the real authorities', () => {
  test('history → update banner → What changed → explicit adoption → improvements → approve → new version → no mutation', async ({ page }) => {
    // Fresh browser → the consumer shell → a real account.
    await page.goto('/');
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill('Juno (T11)');
    await page.locator('#email').fill(JUNO_EMAIL);
    await page.locator('#password').fill(JUNO_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(
      page.getByRole('heading', { name: /What do you want to get done\?/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The org + the workflow through the REAL V2-002 routes.
    const orgRes = await page.request.post('/api/organizations', { data: { name: 'Acme T11' } });
    expect(orgRes.ok()).toBeTruthy();
    const org = (await orgRes.json()) as { organization: { id: string } };
    const orgId = org.organization.id;

    const createRes = await page.request.post(
      `/api/organizations/${orgId}/workflow-repository/workflows`,
      {
        data: {
          slug: 'weekly-ticket-digest-t11',
          name: 'Weekly ticket digest',
          description: 'Collect the open tickets, scan them, and email the digest.',
          visibility: 'private',
          content: JSON.parse(
            serializeWorkflowIrDocument(authorOptimizableWorkflow('Scan the board and summarize the open tickets (v1).')),
          ) as Record<string, unknown>,
          protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
        },
      },
    );
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as {
      workflow: { id: string; headVersionId: string };
      initialVersion: { id: string };
    };
    const workflowId = created.workflow.id;
    const version1Id = created.initialVersion.id;

    // Install v1 (the immutable pin) through the real installation route.
    const installRes = await page.request.post(
      `/api/organizations/${orgId}/workflow-repository/installations`,
      { data: { workflowId, versionId: version1Id } },
    );
    expect(installRes.ok()).toBeTruthy();
    const installation1 = (await installRes.json()) as { installation: { id: string } };

    // v2: a content change (the update material).
    const v2Res = await page.request.post(
      `/api/workflow-repository/workflows/${workflowId}/versions`,
      {
        data: {
          content: JSON.parse(
            serializeWorkflowIrDocument(authorOptimizableWorkflow('Scan the board and summarize the open tickets (v2: faster scan).')),
          ) as Record<string, unknown>,
          protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
          parentVersionId: version1Id,
        },
      },
    );
    expect(v2Res.ok()).toBeTruthy();
    const version2 = (await v2Res.json()) as { version: { id: string } };

    // The v1 baseline (byte-identical re-read at the end).
    const v1Before = await page.request.get(
      `/api/workflow-repository/workflows/${workflowId}/versions/${version1Id}`,
    );
    const v1BodyBefore = v1Before.body;

    // --- the detail page: version history + the update banner -------------
    await page.goto(`/workflows/${workflowId}`);
    await expect(
      page.getByRole('heading', { name: 'Weekly ticket digest' }),
    ).toBeVisible({ timeout: 15_000 });

    // §19: history is addressable — both versions with the badges.
    const history = page.getByRole('region', { name: 'Version history' });
    await expect(history.getByText('Version 1')).toBeVisible({ timeout: 15_000 });
    await expect(history.getByText('Version 2')).toBeVisible();

    // §19: the update banner — the verbatim pin + the no-silent-change promise.
    const update = page.getByRole('region', { name: 'Update available' });
    await expect(update.getByText(/an update is available/i)).toBeVisible();
    await expect(update.getByText(/nothing changes until you approve the update/i)).toBeVisible();
    await expect(update.getByText(/your installed version: version 1/i)).toBeVisible();

    // Review → What changed (the V2-011 comparison, correctness first).
    await update.getByRole('button', { name: /review update/i }).click();
    await expect(update.getByText(/task-for-task equivalent/i)).toBeVisible({ timeout: 15_000 });
    await expect(update.getByText(/estimates, not measurements/i)).toBeVisible();

    // --- §19: explicit adoption (the EXISTING V2-002 commands) ------------
    await update.getByRole('button', { name: /approve update/i }).click();
    // The pin moved to v2: the update surface says so honestly (no
    // fabricated update remains) and the T4 pin section shows the new pin.
    await expect(update.getByText(/you're on the newest version/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/Installed: Version 2 — pinned · Enabled/i)).toBeVisible({
      timeout: 15_000,
    });
    // The old installation was retired (disabled) — the honest lifecycle.
    const inst1After = await page.request.get(
      `/api/organizations/${orgId}/workflow-repository/installations/${installation1.installation.id}`,
    );
    expect(inst1After.ok()).toBeTruthy();
    const inst1Body = (await inst1After.json()) as { installation: { status: string; versionId: string } };
    expect(inst1Body.installation.versionId).toBe(version1Id);
    expect(inst1Body.installation.status).toBe('disabled');

    // --- §20: improvements (the recommendation telemetry) -------------------
    const improvements = page.getByRole('region', { name: 'Improvements' });
    await expect(improvements.getByText(/workflowos found 1 improvement/i)).toBeVisible({
      timeout: 15_000,
    });
    // The consumer label (never the node id).
    await expect(improvements.getByText(/scan the board for the digest/i)).toBeVisible();

    // Review → the proposal card (what changed / why / trade-offs).
    await improvements.getByRole('button', { name: /review/i }).click();
    // The authority's own fixed-template rationale (verbatim evidence).
    await expect(improvements.getByText(/stable github\.repository\.read API/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(improvements.getByText(/task-for-task equivalent/i)).toBeVisible();
    await expect(improvements.getByText(/estimates, not measurements/i)).toBeVisible();

    // The §20 gate: approve → create the new version.
    await improvements.getByRole('button', { name: /approve improvement/i }).click();
    await expect(improvements.getByText(/approved - not created yet/i)).toBeVisible({
      timeout: 15_000,
    });
    await improvements.getByRole('button', { name: /create the new version/i }).click();
    await expect(improvements.getByText(/created as a new version/i)).toBeVisible({
      timeout: 15_000,
    });

    // The materialized candidate is a REAL new version (v3, parent v2).
    const versionsRes = await page.request.get(
      `/api/workflow-repository/workflows/${workflowId}/versions`,
    );
    const versions = (await versionsRes.json()) as {
      versions: Array<{ id: string; versionNumber: number; parentVersionId: string | null }>;
    };
    expect(versions.versions).toHaveLength(3);
    const v3 = versions.versions.find((v) => v.versionNumber === 3);
    expect(v3).toBeDefined();
    expect(v3!.parentVersionId).toBe(version2.version.id);

    // The history shows the new version (the §20 "explicit new WorkflowVersion").
    await expect(history.getByText('Version 3')).toBeVisible({ timeout: 15_000 });

    // --- NO MUTATION: the v1 baseline is byte-identical --------------------
    const v1After = await page.request.get(
      `/api/workflow-repository/workflows/${workflowId}/versions/${version1Id}`,
    );
    expect(v1After.body).toBe(v1BodyBefore);
  });
});
