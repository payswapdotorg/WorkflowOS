import { test, expect, type Page } from '@playwright/test';
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
import { createSequentialIdFactory, createSteppingClock } from '../../src/marketplace/index.js';
import type { WorkflowIrDocument, WorkflowNode } from '../../src/workflow-ir/index.js';
import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '@platform/index.js';

/**
 * V2-017 T12 — Browser-level E2E: the Share / Make my own / Explore /
 * install journey over the REAL authorities (the dispatch's real-browser
 * dogfooding requirement).
 *
 * Real topology (the t10 pattern): the identity stack's real pglite
 * PostgreSQL (all migrations) + the REAL Fastify buildServer wired with
 * the real session auth + identity + organizations routes + the REAL
 * V2-002 workflow-repository routes (workflows, versions, forks,
 * installations — the EXISTING commands) + the REAL V2-005 run routes +
 * the V2-004/V2-009 deployment reads (the workflow detail surfaces) + the
 * T12 marketplace transport routes over the REAL V2-012 authority. The
 * Vite dev server on :5173 serves the actual SPA.
 *
 * The two-persona journey proves in a REAL browser:
 *
 *   1. ADA (the publisher): authors a real WorkflowIR workflow through the
 *      real V2-002 routes (private), opens Share on the workflow detail,
 *      sees the honest publish precondition, makes the workflow public
 *      through the EXISTING V2-002 visibility command, publishes the
 *      listing ($19 one-time) through the V2-012 transport routes, and
 *      reaches the published state with the Explore link;
 *   2. BAY (the customer, a fresh browser session + own organization):
 *      browses Explore, opens the listing, reads the §22 disclosure
 *      (needs access, sensitive capability, works-with, version, digests)
 *      and the boundary sentences, sees the honest no-free-offering
 *      denial, purchases (the real in-memory adapter charge → the real
 *      entitlement), sees the §23 entitled state, INSTALLS the exact
 *      pinned version through the EXISTING V2-002 command, and finally
 *      makes their own copy (the EXISTING V2-002 fork) with the §21
 *      disclosure — attribution kept, no private data, no secrets.
 *
 * The entitlement-vs-execution boundary language is asserted at every
 * step where commerce meets authority.
 */

let stack: TestIdentityStack;
let server: FastifyInstance;

const ADA_EMAIL = 'ada-t12@e2e.example.com';
const ADA_PASSWORD = 'the-t12-password-42';
const BAY_EMAIL = 'bay-t12@e2e.example.com';
const BAY_PASSWORD = 'the-t12-bay-password-42';

/** The shared marketplace workflow: collect (ordinary) → send (SENSITIVE). */
function authorSocialReportWorkflow(taskSeed: string): WorkflowIrDocument {
  const collect: WorkflowNode = {
    id: 'collect_posts',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'github.repository.read' },
    capabilityRequirements: ['github.repository.read'],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'query',
        type: { kind: 'string' },
        binding: { kind: 'literal', value: taskSeed },
      },
    ],
    outputs: [{ name: 'posts', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const send: WorkflowNode = {
    id: 'send_report',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'messaging.send' },
    capabilityRequirements: ['messaging.send'],
    placement: 'cloud_preferred',
    inputs: [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'collect_posts', output: 'posts' },
      },
    ],
    outputs: [{ name: 'messageId', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'verification',
  };
  return createWorkflowIrBuilder()
    .withStart('collect_posts')
    .addWorkflowOutput({
      name: 'reportId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_report', output: 'messageId' },
    })
    .addNode(collect)
    .addNode(send)
    .addEdge({ from: 'collect_posts', to: 'send_report', on: 'success' })
    .withDefaultPlacement('any_supported_node')
    .withProvenance({ origin: 'authored' })
    .withPresentation({
      title: 'Weekly social media report',
      nodeLabels: {
        collect_posts: 'Collect the week’s posts',
        send_report: 'Email the weekly report',
      },
    })
    .build();
}

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
    // T12: the marketplace transport routes over the frozen V2-012
    // authority, composed over the REAL V2-002 repository (the
    // version-reader port) + the identity membership facts. The payment
    // adapter is the module's deterministic in-memory reference (the
    // composition the transport route owns).
    marketplace: {
      workflowRepositoryService: repository,
      memberships,
      idFactory: createSequentialIdFactory('t12e2e'),
      clock: createSteppingClock(1789510000000, 1000),
    },
  });
  await server.listen({ port: 3001, host: '127.0.0.1' });
});

test.afterAll(async () => {
  await server.close();
  await stack.teardown();
});

/** The real signup journey (the t11 pattern). */
async function signUp(page: Page, displayName: string, email: string, password: string) {
  await page.goto('/');
  await page.getByText('Create one', { exact: true }).click();
  await page.locator('#displayName').fill(displayName);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
}

test.describe('V2-017 T12 — Share / Explore / purchase / install / Make my own over the real authorities', () => {
  test('ADA: Share → make public → publish the listing → the Explore link', async ({ page }) => {
    // A real account + organization.
    await signUp(page, 'Ada (T12)', ADA_EMAIL, ADA_PASSWORD);
    await expect(
      page.getByRole('heading', { name: /What do you want to get done\?/i }),
    ).toBeVisible({ timeout: 15_000 });

    const orgRes = await page.request.post('/api/organizations', { data: { name: 'Ada Automation' } });
    expect(orgRes.ok()).toBeTruthy();
    const org = (await orgRes.json()) as { organization: { id: string } };
    const orgId = org.organization.id;

    // Author the workflow PRIVATE through the real V2-002 routes.
    const createRes = await page.request.post(
      `/api/organizations/${orgId}/workflow-repository/workflows`,
      {
        data: {
          slug: 'weekly-social-report-t12',
          name: 'Weekly social media report',
          description: 'Automatically creates and sends your weekly social report.',
          visibility: 'private',
          content: JSON.parse(
            serializeWorkflowIrDocument(authorSocialReportWorkflow('t12-ada-seed')),
          ) as Record<string, unknown>,
          protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
        },
      },
    );
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as { workflow: { id: string } };
    const workflowId = created.workflow.id;

    // The workflow detail → Share.
    await page.goto(`/workflows/${workflowId}`);
    await expect(
      page.getByRole('heading', { name: 'Weekly social media report' }),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Share' }).click();
    const share = page.getByRole('region', { name: 'Share' });
    await expect(share).toBeVisible();

    // §21: the honest visibility + the publish precondition + the fork
    // disclosure.
    await expect(share.getByText('Private — only you')).toBeVisible();
    await expect(
      share.getByText('Publishing to Explore requires this workflow to be public.'),
    ).toBeVisible();
    await expect(share.getByText('Have its own versions')).toBeVisible();
    await expect(share.getByText('Not receive the publisher’s secrets')).toBeVisible();

    // No listing form while private.
    await expect(share.getByRole('button', { name: /publish to explore/i })).toHaveCount(0);

    // Make it public through the EXISTING V2-002 command.
    await share.getByRole('button', { name: /make it public/i }).click();
    await expect(share.getByText('Public — any signed-in user')).toBeVisible({
      timeout: 15_000,
    });

    // Publish: the one-time price.
    await expect(share.getByRole('button', { name: /publish to explore/i })).toBeVisible();
    await share.locator('#share-one-time-price').fill('19');
    await share.getByRole('button', { name: /publish to explore/i }).click();

    await expect(share.getByText(/published to explore/i)).toBeVisible({ timeout: 15_000 });
    const viewLink = share.getByRole('link', { name: /view on explore/i });
    await expect(viewLink).toHaveAttribute('href', /^\/explore\//);

    // The frozen boundary sentence renders with the published state.
    await expect(
      share.getByText(
        'Getting this workflow gives your organization access to its content — it is not permission to run. Execution stays subject to your access and approvals.',
      ),
    ).toBeVisible();

    // The publisher can browse their own listing from Explore.
    await viewLink.click();
    await expect(
      page.getByRole('heading', { name: 'Weekly social media report' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Listed by your organization Ada Automation')).toBeVisible();
    await expect(page.getByText('$19.00')).toBeVisible();
  });

  test('BAY: Explore → the listing disclosure → purchase → Install the exact pin → Make my own', async ({ page }) => {
    // A fresh session + own organization (the customer tenant).
    await signUp(page, 'Bay (T12)', BAY_EMAIL, BAY_PASSWORD);
    await expect(
      page.getByRole('heading', { name: /What do you want to get done\?/i }),
    ).toBeVisible({ timeout: 15_000 });

    const orgRes = await page.request.post('/api/organizations', { data: { name: 'Bay Logistics' } });
    expect(orgRes.ok()).toBeTruthy();
    const org = (await orgRes.json()) as { organization: { id: string } };
    const orgId = org.organization.id;

    // Explore: the listing card.
    await page.goto('/explore');
    const card = page.getByRole('link', { name: /weekly social media report/i });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('$19.00')).toBeVisible();
    await expect(
      page.getByText('Publication is not verification, authorization, or proof of safety.'),
    ).toBeVisible();
    await card.click();

    // The listing detail: the §22 disclosure.
    await expect(
      page.getByRole('heading', { name: 'Weekly social media report' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Listed by another organization')).toBeVisible();

    const needsAccess = page.getByRole('region', { name: /needs access to/i });
    await expect(needsAccess.getByText('github.repository.read')).toBeVisible();
    await expect(needsAccess.getByText('messaging.send', { exact: true })).toBeVisible();
    await expect(
      needsAccess.getByText(/messaging\.send is sensitive/i),
    ).toBeVisible();

    const worksWith = page.getByRole('region', { name: /works with/i });
    await expect(worksWith.getByText('cloud_allowed')).toBeVisible();
    await expect(worksWith.getByText('cloud_preferred')).toBeVisible();

    await expect(page.getByText('Version 1')).toBeVisible();
    await expect(
      page.getByText(
        'Getting this workflow gives your organization access to its content — it is not permission to run. Execution stays subject to your access and approvals.',
      ),
    ).toBeVisible();

    // The honest pre-purchase denial (no free offer on this listing).
    await expect(page.getByText('This listing has no free offer.')).toBeVisible({
      timeout: 15_000,
    });

    // Purchase: the one-time offer through the real adapter + entitlement.
    await page.getByRole('button', { name: /get workflow/i }).click();
    await expect(page.getByText("You're entitled to this workflow.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Access through your one-time purchase.')).toBeVisible();
    await expect(page.getByText('Next: Install version 1')).toBeVisible();

    // Install: the EXISTING V2-002 command with the EXACT pin.
    await page.getByRole('button', { name: /^install$/i }).click();
    await expect(page.getByText('Installed — pinned to version 1')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText(
        /running it stays a separate decision/i,
      ),
    ).toBeVisible();

    // The installation is real: the tenant's installations carry the pin.
    const installsRes = await page.request.get(
      `/api/organizations/${orgId}/workflow-repository/installations`,
    );
    expect(installsRes.ok()).toBeTruthy();
    const installs = (await installsRes.json()) as {
      installations: { installation: { versionId: string }; pinnedVersion: { versionNumber: number } }[];
    };
    expect(installs.installations.length).toBe(1);
    expect(installs.installations[0]!.pinnedVersion.versionNumber).toBe(1);

    // Make my own: the §21 disclosure + the EXISTING V2-002 fork command.
    await page.getByRole('button', { name: /make (this|it) my own/i }).click();
    const forkRegion = page.getByRole('region', { name: /make my own/i });
    await expect(forkRegion.getByText('Have its own versions')).toBeVisible();
    await expect(forkRegion.getByText('Keep the original attribution')).toBeVisible();
    await expect(
      forkRegion.getByText('Not receive the publisher’s private data'),
    ).toBeVisible();
    await expect(forkRegion.getByText('Not receive the publisher’s secrets')).toBeVisible();

    await forkRegion.locator('#fork-copy-name').fill('My social report');
    await forkRegion.getByRole('button', { name: /create copy/i }).click();

    const copyLink = forkRegion.getByRole('link', { name: /open your copy/i });
    await expect(copyLink).toBeVisible({ timeout: 15_000 });
    await copyLink.click();

    // The copy's own detail page: a real workflow of Bay's own.
    await expect(
      page.getByRole('heading', { name: 'My social report' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Private — only you')).toBeVisible();
    // The fork kept the attribution facts (the V2-002 record).
    const copyUrl = new URL(page.url());
    const copyId = copyUrl.pathname.split('/').pop() ?? '';
    const copyRes = await page.request.get(
      `/api/workflow-repository/workflows/${copyId}`,
    );
    expect(copyRes.ok()).toBeTruthy();
    const copyWorkflow = (await copyRes.json()) as {
      workflow: { forkedFromWorkflowId: string | null; forkedFromVersionId: string | null };
    };
    expect(copyWorkflow.workflow.forkedFromWorkflowId).not.toBeNull();
    expect(copyWorkflow.workflow.forkedFromVersionId).not.toBeNull();
  });
});
