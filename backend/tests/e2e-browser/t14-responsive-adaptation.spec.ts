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
import type { TestIdentityStack } from '../helpers/test-identity-stack.js';

/**
 * V2-017 T14 — the responsive/mobile adaptation journey over the REAL
 * product shell (the dispatch's responsive browser E2E at
 * desktop/tablet/mobile viewports + the real browser dogfooding of
 * navigation, workflow detail, and key primary actions).
 *
 * The real paths: the real SPA (Vite) against a real backend (PGlite,
 * all migrations) with the real V2-002 routes (the workflow + version
 * reads), the real V2-005 runs read, the real workflow-deployments
 * reads, and the real V2-006 teaching authority (the Teach Me primary
 * action). One session walks the SAME product through three viewports:
 *
 *   desktop 1280×800 — the header primary navigation with visible
 *   labels, the header Create entry, the two-column workflow-detail
 *   fact grid, no bottom bar;
 *
 *   tablet 768×1024 — the same header navigation model (the tablet
 *   keeps the product shell), still no bottom bar, the detail grid
 *   still two columns at md;
 *
 *   mobile 375×667 — the platform-appropriate bottom navigation (the
 *   same approved destinations + the Create center action, ≥44px touch
 *   targets, the home-indicator safe area reserved), the header
 *   navigation not rendered, navigation driven THROUGH the bottom bar,
 *   the workflow detail stacked (full-width primary actions, scaled
 *   title), the footer never covered by the fixed bar, and the Teach Me
 *   primary action working at mobile width.
 *
 * No semantics change anywhere: the destinations, hrefs, and
 * aria-current states are identical on both navigation surfaces.
 */

let stack: TestIdentityStack;
let server: FastifyInstance;

const JUNO_EMAIL = 'juno-t14@e2e.example.com';
const JUNO_PASSWORD = 'the-t14-password-42';

/** The two-step workflow (with authoritative presentation labels). */
function authorDigestWorkflow(taskText: string): WorkflowIrDocument {
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
    outputs: [{ name: 'tickets', type: { kind: 'json' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  };
  const sendStep: WorkflowNode = {
    id: 'send_step',
    executionClass: 'agentic_computer_use',
    spec: { class: 'agentic_computer_use', task: taskText },
    capabilityRequirements: ['messaging.send'],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'fetch_step', output: 'tickets' },
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
      title: 'Weekly ticket digest',
      nodeLabels: {
        fetch_step: 'Collect the open tickets',
        send_step: 'Email the weekly digest',
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

const DESKTOP: { width: number; height: number } = { width: 1280, height: 800 };
const TABLET: { width: number; height: number } = { width: 820, height: 1180 };
const MOBILE: { width: number; height: number } = { width: 375, height: 667 };

test.describe('V2-017 T14 — responsive/mobile adaptation over the real shell', () => {
  test('desktop shell → tablet keeps the shell → mobile bottom navigation, stacked detail, uncovered footer, primary actions — same model on every viewport', async ({ page }) => {
    // ── Fresh browser at DESKTOP: the consumer shell + a real account.
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    await page.getByText('Create one', { exact: true }).click();
    await page.locator('#displayName').fill('Juno (T14)');
    await page.locator('#email').fill(JUNO_EMAIL);
    await page.locator('#password').fill(JUNO_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(
      page.getByRole('heading', { name: /What do you want to get done\?/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The safe-area viewport declaration (the home-indicator inset is a
    // first-class platform fact for the mobile bottom navigation).
    const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewportMeta).toContain('viewport-fit=cover');

    // ── DESKTOP: the header carries the approved model; no bottom bar.
    const headerNav = page.getByTestId('header-primary-nav');
    await expect(headerNav).toBeVisible();
    for (const label of ['Home', 'Workflows', 'Explore', 'Activity']) {
      await expect(headerNav.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByTestId('mobile-primary-nav')).toBeHidden();
    await expect(page.getByTestId('header-create-entry')).toBeVisible();

    // ── The org + the workflow through the REAL V2-002 routes.
    const orgRes = await page.request.post('/api/organizations', { data: { name: 'Acme T14' } });
    expect(orgRes.ok()).toBeTruthy();
    const org = (await orgRes.json()) as { organization: { id: string } };
    const createRes = await page.request.post(
      `/api/organizations/${org.organization.id}/workflow-repository/workflows`,
      {
        data: {
          slug: 'weekly-ticket-digest-t14',
          name: 'Weekly ticket digest',
          description: 'Collect the open tickets and email the digest.',
          visibility: 'private',
          content: JSON.parse(
            serializeWorkflowIrDocument(authorDigestWorkflow('Email the weekly digest to the team.')),
          ) as Record<string, unknown>,
          protocol: { irSchemaVersion: 'workflowos-workflow-ir/v1' },
        },
      },
    );
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as { workflow: { id: string } };
    const workflowId = created.workflow.id;

    // ── DESKTOP workflow detail: the two-column fact grid (the 1st and
    //    2nd grid children share a row).
    await page.goto(`/workflows/${workflowId}`);
    await expect(page.getByRole('heading', { name: 'Weekly ticket digest' })).toBeVisible();
    const whatBox = await page.getByRole('region', { name: 'What it does' }).boundingBox();
    const whenBox = await page.getByRole('region', { name: 'When it runs' }).boundingBox();
    expect(whatBox).not.toBeNull();
    expect(whenBox).not.toBeNull();
    // Side by side on the same row (md:grid-cols-2).
    expect(whenBox!.x).toBeGreaterThan(whatBox!.x + 100);
    expect(Math.abs(whenBox!.y - whatBox!.y)).toBeLessThan(8);
    // The desktop title scale (text-3xl = 30px).
    const desktopTitleSize = await page
      .getByRole('heading', { name: 'Weekly ticket digest' })
      .evaluate((el) => window.getComputedStyle(el).fontSize);
    expect(desktopTitleSize).toBe('30px');

    // ── TABLET: the same product shell (header navigation, no bottom
    //    bar), the detail grid still two columns at md.
    await page.setViewportSize(TABLET);
    await expect(headerNav).toBeVisible();
    await expect(page.getByTestId('mobile-primary-nav')).toBeHidden();
    const tabletWhat = await page.getByRole('region', { name: 'What it does' }).boundingBox();
    const tabletWhen = await page.getByRole('region', { name: 'When it runs' }).boundingBox();
    expect(tabletWhen!.x).toBeGreaterThan(tabletWhat!.x + 100);

    // ── MOBILE: the platform-appropriate bottom navigation.
    await page.setViewportSize(MOBILE);
    const bottomNav = page.getByTestId('mobile-primary-nav');
    await expect(bottomNav).toBeVisible();
    // The header surface is NOT rendered at this viewport.
    await expect(headerNav).toBeHidden();
    await expect(page.getByTestId('header-create-entry')).toBeHidden();

    // The SAME approved destinations + the Create center action.
    for (const label of ['Home', 'Workflows', 'Explore', 'Activity', 'Create']) {
      await expect(bottomNav.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    // Platform touch targets: every destination ≥ 44px tall.
    const bottomLinks = bottomNav.getByRole('link');
    const linkCount = await bottomLinks.count();
    expect(linkCount).toBe(5);
    for (let i = 0; i < linkCount; i++) {
      const box = await bottomLinks.nth(i).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    // ── Navigation THROUGH the bottom bar (the primary navigation is
    //    the bottom surface at this viewport).
    await bottomNav.getByRole('link', { name: 'Workflows', exact: true }).click();
    await expect(page).toHaveURL(/\/workflows$/);
    // The active-destination state travels on the bottom surface.
    await expect(
      bottomNav.getByRole('link', { name: 'Workflows', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(
      bottomNav.getByRole('link', { name: 'Home', exact: true }),
    ).not.toHaveAttribute('aria-current', 'page');

    // The center Create action navigates to the universal entry.
    await bottomNav.getByRole('link', { name: 'Create', exact: true }).click();
    await expect(page).toHaveURL(/\/create$/);

    // ── MOBILE workflow detail: stacked facts (the 1st and 2nd grid
    //    children are now in the same column), full-width primary
    //    actions, the scaled title.
    await page.goto(`/workflows/${workflowId}`);
    await expect(page.getByRole('heading', { name: 'Weekly ticket digest' })).toBeVisible();
    const mobileWhat = await page.getByRole('region', { name: 'What it does' }).boundingBox();
    const mobileWhen = await page.getByRole('region', { name: 'When it runs' }).boundingBox();
    expect(mobileWhen!.y).toBeGreaterThan(mobileWhat!.y + mobileWhat!.height);
    expect(Math.abs(mobileWhen!.x - mobileWhat!.x)).toBeLessThan(8);
    const mobileTitleSize = await page
      .getByRole('heading', { name: 'Weekly ticket digest' })
      .evaluate((el) => window.getComputedStyle(el).fontSize);
    expect(mobileTitleSize).toBe('24px');

    // The primary actions stack full-width (platform-appropriate).
    const teachButton = page.getByRole('button', { name: 'Teach Me' });
    const teachBox = await teachButton.boundingBox();
    expect(teachBox).not.toBeNull();
    expect(teachBox!.width).toBeGreaterThan(300);
    const editBox = await page.getByRole('link', { name: 'Edit' }).boundingBox();
    expect(editBox).not.toBeNull();
    expect(editBox!.y).toBeGreaterThan(teachBox!.y + teachBox!.height);

    // ── MOBILE: the footer is never covered by the fixed bottom bar.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const footerBox = await page.getByRole('contentinfo').boundingBox();
    const barBox = await bottomNav.boundingBox();
    expect(footerBox).not.toBeNull();
    expect(barBox).not.toBeNull();
    expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(barBox!.y + 1);
    // The expert-workspace progressive disclosure stays reachable above
    // the bar (semantics unchanged at every viewport).
    await expect(
      page.getByRole('contentinfo').getByRole('link', { name: 'Expert workspace', exact: true }),
    ).toBeVisible();

    // ── MOBILE: the Teach Me primary action works at mobile width (the
    //    real V2-006 authority — the lesson surface opens).
    await page.evaluate(() => window.scrollTo(0, 0));
    await teachButton.click();
    await expect(page.getByRole('button', { name: /close lesson/i })).toBeVisible({
      timeout: 15_000,
    });

    // ── DESKTOP again: the adaptation is stateless — the header model
    //    is intact after the whole viewport journey.
    await page.setViewportSize(DESKTOP);
    await expect(headerNav).toBeVisible();
    await expect(page.getByTestId('mobile-primary-nav')).toBeHidden();
    await expect(page.getByTestId('header-create-entry')).toBeVisible();
    await expect(
      headerNav.getByRole('link', { name: 'Workflows', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
  });
});
