/**
 * WORK-049 — Browser-level E2E test: the Project Health & Maintenance UX
 * (the Workbench Health tab).
 *
 * Real topology (Fastify API on 127.0.0.1:3001 + the Vite dev server on
 * :5173 via the Playwright webServer + pglite PostgreSQL + InMemoryQueue +
 * WorkerHost). The browser loads the actual SPA, authenticates, and drives
 * the Health tab through the REAL rendered DOM — asserting on visible
 * content, never on API responses.
 *
 * The topology: the MAINTENANCE route group IS wired (the real WORK-041
 * authority serving real maintenance-originated Work Items through
 * GET /maintenance/health), while the RUNTIME route group is deliberately
 * UNWIRED — so the Health tab renders real findings AND proves the
 * read-state discipline against real 404/401 failures.
 *
 * Flows proven:
 *   1. the Health tab renders FINDINGS from authoritative facts — the
 *      maintenance authority's open critical signal (what / why / the
 *      authority's own severity / the evidence line), the verification
 *      authority's failed run, and the dependency authority's blocked item;
 *   2. failed health reads are DISTINCT from genuine empty health — the
 *      UNWIRED runtime authority withholds the all-healthy conclusion
 *      ("Health assessment incomplete — … deployments, runtime"), never a
 *      fabricated "No health findings";
 *   3. open maintenance findings remain distinguishable from actual
 *      COMPLETED Work Items (the completed maintenance signal renders in the
 *      "Completed maintenance work" section — done, not open — and NEVER as
 *      a finding);
 *   4. what should happen next: the maintenance authority's open Work Item
 *      as the governed path (recommendations never become decisions — the
 *      health view renders no scan/evaluate mutation trigger at all);
 *   5. browser-level tenant isolation: user A opening user B's project
 *      Health tab sees ONLY the degraded states — zero project B data
 *      (including project B's SECRET maintenance signal), and the failures
 *      render as ERRORS, provably never as fabricated empty states.
 */
import { test, expect, type Page } from '@playwright/test';
import { buildAuthStack, type TestAuthStack } from '../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { InMemoryQueue, buildHandlerRegistry, WorkerHost, createLogger } from '@platform/index.js';
import { DefaultWorkflowEngine } from '../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultAuditService } from '../../src/modules/audit/internal/audit-service.js';
import { DefaultWorkItemDependencyService } from '../../src/modules/work-items/internal/work-item-dependency-service.js';
import { DefaultVerificationService } from '../../src/modules/verification/internal/verification-service.js';
import { DefaultReviewService } from '../../src/modules/reviews/internal/review-service.js';
import { PgExecutionRecordRepository } from '../../src/modules/agents/internal/pg-execution-repository.js';
import { PgCiEvidenceIngestionRepository } from '../../src/modules/github/internal/pg-ci-evidence-repository.js';
import { PgGitHubInstallationRepository } from '../../src/modules/github/internal/pg-github-repository.js';
import { DefaultCiEvidenceIngestionService } from '../../src/modules/github/internal/ci-evidence-ingestion-service.js';
import { DefaultDevelopmentPlannerService } from '../../src/development-planner/internal/default-development-planner-service.js';
import { DeterministicPlanningPrioritizer } from '../../src/development-planner/internal/deterministic-planning-prioritizer.js';
import { DefaultMaintenanceService } from '../../src/maintenance/internal/default-maintenance-service.js';
import { CiRegressionDetector } from '../../src/maintenance/internal/detectors/ci-regression-detector.js';
import { ArchitectureDriftDetector } from '../../src/maintenance/internal/detectors/architecture-drift-detector.js';
import { AdvisoryDetector } from '../../src/maintenance/internal/detectors/advisory-detector.js';
import type { FastifyInstance } from 'fastify';

let stack: TestAuthStack;
let server: FastifyInstance;
let worker: WorkerHost;
let queue: InMemoryQueue;

let projectAId: string;
let projectBId: string;
let wi2Id: string; // WB-E2E-002 (the item whose verification run FAILS)

const API_KEY = 'raw-key-health-e2e';

test.beforeAll(async () => {
  stack = await buildAuthStack({ WFOS_TEST_HEALTH_KEY: API_KEY });

  const logger = createLogger({ level: 'warn', destination: process.stdout });
  const db = stack.db.client;

  // --- Project A (user A / org A): the health project ------------------------
  const orgA = await stack.organizationRepository.create({ name: 'Health E2E Org A' });
  const userA = await stack.userRepository.upsertByExternalId({ externalId: 'health-e2e-user-a', displayName: 'User A' });
  await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
  const projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Health E2E Project A' });
  await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
  projectAId = projectA.id;
  await stack.apiKeyProvisioner.provision({
    keyId: 'health-key', secretRef: 'WFOS_TEST_HEALTH_KEY', externalId: 'health-e2e-user-a', label: 'A', rawKey: API_KEY,
  });

  const archA = await stack.architectureRepository.create({ projectId: projectAId, name: 'Health Arch A' });
  const versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: '# Health E2E A' });
  await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);

  // The blocker + the item blocked on it (the dependency authority's facts).
  const wi1 = await stack.workItemRepository.create({
    architectureVersionId: versionA.id, workItemId: 'WB-E2E-001',
    title: 'First item (the blocker)', objective: 'Lay the foundation.', scope: 'src/foundation.ts',
    metadata: { baseCommit: 'health-e2e-baseline-00000000000000000001' },
  });
  await stack.workItemRepository.create({
    architectureVersionId: versionA.id, workItemId: 'WB-E2E-003',
    title: 'Blocked item', objective: 'Waits on the first item.', scope: 'src/blocked.ts',
    metadata: { baseCommit: 'health-e2e-baseline-00000000000000000003' },
  });
  await stack.workItemDependencyRepository.add(
    (await stack.workItemRepository.findByArchitectureVersion(versionA.id)).find((w) => w.workItemId === 'WB-E2E-003')!.id,
    wi1.id,
  );

  // The active item whose verification run FAILS (the verification
  // authority's own failed record — the finding's evidence).
  const wi2 = await stack.workItemRepository.create({
    architectureVersionId: versionA.id, workItemId: 'WB-E2E-002',
    title: 'Second item (active)', objective: 'Build on the foundation.', scope: 'src/active.ts',
    metadata: { baseCommit: 'health-e2e-baseline-00000000000000000002' },
  });
  wi2Id = wi2.id;

  // The maintenance authority's OWN signals: two maintenance-originated Work
  // Items (one OPEN + critical, one COMPLETED) seeded through the owning
  // work-item repository with the planner's maintenance metadata — exactly
  // the records GET /maintenance/health serves (the authority's read model).
  await stack.workItemRepository.create({
    architectureVersionId: versionA.id, workItemId: 'WI-MAINT-OPEN',
    title: 'CI is regressing on main', objective: 'Restore the main branch CI.',
    scope: '.github/workflows',
    metadata: {
      baseCommit: 'health-e2e-baseline-00000000000000000004',
      planner: {
        source: 'maintenance-ci-regression', provenance: 'observed', priority: 'high',
        rationale: 'Three consecutive CI failures on the frozen version.',
        whyNow: 'main is red — every merge is now unverifiable.',
        expectedImpact: 'Restores the verification path for all in-flight work.',
        maintenance: { category: 'ci-regression', severity: 'critical', affectedCount: 3, detectorSource: 'ci-regression-detector' },
      },
    },
  });
  const maintDone = await stack.workItemRepository.create({
    architectureVersionId: versionA.id, workItemId: 'WI-MAINT-DONE',
    title: 'Stale dependency was upgraded', objective: 'Upgrade lodash.',
    scope: 'package.json',
    metadata: {
      baseCommit: 'health-e2e-baseline-00000000000000000005',
      planner: {
        source: 'maintenance-advisory', provenance: 'observed', priority: 'medium',
        rationale: 'The advisory detector flagged lodash.',
        whyNow: 'A known vulnerability affected the dependency.',
        expectedImpact: 'Closes the vulnerability window.',
        maintenance: { category: 'vulnerability', severity: 'high', advisoryId: 'GHSA-TEST-0000-0000', detectorSource: 'advisory-detector' },
      },
    },
  });
  await stack.workItemRepository.markCompleted(maintDone.id, true);

  // The workflow authority: WB-E2E-002 reaches 'ready' (a live, unblocked item).
  const auditService = new DefaultAuditService(db, stack.db.logger);
  const depService = new DefaultWorkItemDependencyService(db);
  queue = new InMemoryQueue();
  const workflowEngine = new DefaultWorkflowEngine(
    db, logger,
    (wiId: string) => depService.canBeginImplementation(wiId),
    auditService,
  );
  await workflowEngine.transition({ workItemId: wi2.id, toState: 'ready', actor: 'health-e2e' });

  // The verification authority's FAILED run for WB-E2E-002 (created through
  // the real service, finalized through the real terminal transition).
  const verificationService = new DefaultVerificationService(
    db, stack.requirementRepository, stack.acceptanceCriterionRepository,
    stack.architectureVersionRepository, stack.workItemRepository,
    stack.workItemRequirementRepository, stack.workItemCriterionRepository,
    stack.ciEvidenceRepository, stack.objectStore, stack.db.logger,
  );
  const failedRun = await verificationService.createRun({
    projectId: projectAId, workItemId: wi2.id, architectureVersionId: versionA.id,
    source: 'manual', sourceRef: 'health-e2e', executionId: 'exec-health-e2e-1',
  });
  await verificationService.finalizeOrchestrationRun({
    verificationRunId: failedRun.id, status: 'failed',
    summary: { criteriaFail: 2, criteriaPass: 0 },
  });

  // --- Project B (user B / org B — the tenant-isolation partner) ------------
  const orgB = await stack.organizationRepository.create({ name: 'Health E2E Org B' });
  const userB = await stack.userRepository.upsertByExternalId({ externalId: 'health-e2e-user-b', displayName: 'User B' });
  await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
  const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Health E2E Project B' });
  await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
  projectBId = projectB.id;
  const archB = await stack.architectureRepository.create({ projectId: projectBId, name: 'Health Arch B' });
  const versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: '# Health E2E B' });
  await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);
  // Project B's SECRET maintenance signal — must NEVER be visible to user A.
  await stack.workItemRepository.create({
    architectureVersionId: versionB.id, workItemId: 'WI-B-SECRET-MAINT',
    title: 'SECRET project B maintenance signal', objective: 'Must never be visible to user A.',
    metadata: {
      baseCommit: 'health-e2e-b-baseline-00000000000000000001',
      planner: {
        source: 'maintenance-ci-regression', provenance: 'observed', priority: 'high',
        rationale: 'secret', whyNow: 'secret', expectedImpact: 'secret',
        maintenance: { category: 'ci-regression', severity: 'critical' },
      },
    },
  });

  // --- The server: the WORK-049 topology (the maintenance route group WIRED
  //     over the real WORK-041 authority; the runtime/planning route groups
  //     deliberately UNWIRED so their failures render as explicit
  //     "unavailable" states — never invented health). ------------------------
  const handlers = buildHandlerRegistry([]);
  worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 50 });

  const plannerService = new DefaultDevelopmentPlannerService({
    prioritizer: new DeterministicPlanningPrioritizer(),
    logger,
  });
  const maintenanceService = new DefaultMaintenanceService({
    detectors: [new CiRegressionDetector(), new ArchitectureDriftDetector(), new AdvisoryDetector()],
    plannerService,
    workItemRepository: stack.workItemRepository,
    workItemDependencyRepository: stack.workItemDependencyRepository,
    architectureVersionRepository: stack.architectureVersionRepository,
    architectureRepository: stack.architectureRepository,
    requirementRepository: stack.requirementRepository,
    acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
    ciEvidenceRepository: stack.ciEvidenceRepository,
    projectBaselineRepository: stack.projectBaselineRepository,
    logger,
  });

  // The execution + review authorities (wired with REAL repositories over
  // the owning stores — genuinely empty for this topology; the rollup reads
  // succeed, and only the deliberately-UNWIRED runtime/planning groups fail).
  const executionRepo = new PgExecutionRecordRepository(db);
  const reviewService = new DefaultReviewService(db, stack.workItemRepository, stack.db.logger);

  server = await buildServer({
    queue,
    logger: stack.db.logger,
    auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
    projects: {
      authorizationService: stack.authorizationService,
      projectRepository: stack.projectRepository,
      repositoryAssociationRepository: stack.repositoryAssociationRepository,
    },
    architecture: {
      authorizationService: stack.authorizationService,
      projectRepository: stack.projectRepository,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureDecisionRepository: stack.architectureDecisionRepository,
      architectureChangeRequestRepository: stack.architectureChangeRequestRepository,
      architectureAssertionRepository: stack.architectureAssertionRepository,
      architectureService: stack.architectureService,
    },
    workItems: {
      authorizationService: stack.authorizationService,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      workItemRepository: stack.workItemRepository,
      workItemRequirementRepository: stack.workItemRequirementRepository,
      workItemCriterionRepository: stack.workItemCriterionRepository,
      workItemDependencyRepository: stack.workItemDependencyRepository,
      pullRequestAssociationRepository: stack.pullRequestAssociationRepository,
      workOrderRepository: stack.workOrderRepository,
    },
    workflow: {
      authorizationService: stack.authorizationService,
      projectRepository: stack.projectRepository,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      workItemRepository: stack.workItemRepository,
      workflowEngine,
    },
    verification: {
      authorizationService: stack.authorizationService,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      workItemRepository: stack.workItemRepository,
      requirementRepository: stack.requirementRepository,
      acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
      verificationService,
      ciEvidenceIngestionService: new DefaultCiEvidenceIngestionService(
        new PgCiEvidenceIngestionRepository(db),
        new PgGitHubInstallationRepository(db),
        logger,
      ),
    },
    workbench: {
      authorizationService: stack.authorizationService,
      workItemRepository: stack.workItemRepository,
      workItemDependencyRepository: stack.workItemDependencyRepository,
      dependencyService: depService,
      workflowEngine,
      executionRecordRepository: executionRepo,
      pullRequestAssociationRepository: stack.pullRequestAssociationRepository,
      verificationService,
      reviewService,
    },
    // WORK-049: the maintenance route group IS wired — the Health tab's
    // maintenance facts come from the REAL WORK-041 authority.
    maintenance: {
      authorizationService: stack.authorizationService,
      projectRepository: stack.projectRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      requirementRepository: stack.requirementRepository,
      acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
      workItemRepository: stack.workItemRepository,
      workItemDependencyRepository: stack.workItemDependencyRepository,
      ciEvidenceRepository: stack.ciEvidenceRepository,
      projectBaselineRepository: stack.projectBaselineRepository,
      plannerService,
      maintenanceService,
      logger: stack.db.logger,
    },
  });
  await server.listen({ port: 3001, host: '127.0.0.1' });
  await worker.start();
});

test.afterAll(async () => {
  await worker.stop();
  await server.close();
  await stack.teardown();
});

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate((key: string) => {
    localStorage.setItem('wfos_api_key', key);
  }, API_KEY);
}

test('the Health tab renders FINDINGS from authoritative facts (maintenance signal, failed verification, blocked work) with the authorities\' own severity and evidence', async ({ page }) => {
  await login(page);
  await page.goto(`/projects/${projectAId}/workbench?tab=health`);

  // The maintenance finding — WHAT/WHY/SEVERITY/EVIDENCE, all the
  // authority's own values (severity critical is the maintenance
  // authority's assessment, rendered verbatim — never computed).
  await expect(page.getByText('Maintenance: CI is regressing on main')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/main is red — every merge is now unverifiable\./).first()).toBeVisible();
  await expect(page.getByText(/Evidence: WI-MAINT-OPEN \(ci-regression\) · 3 affected · detector: ci-regression-detector/i)).toBeVisible();
  await expect(page.getByText('Critical', { exact: true }).first()).toBeVisible();

  // The failed-verification finding (the verification authority's own
  // record: the run's failed status + its criteria counts).
  await expect(page.getByText(`Verification failed for ${wi2Id.slice(0, 8)}`)).toBeVisible();
  await expect(page.getByText(/failed 2 acceptance criteria/i)).toBeVisible();

  // The blocked-work finding (the dependency authority's own blocker list).
  await expect(page.getByText('WB-E2E-003 is blocked')).toBeVisible();
  await expect(page.getByText(/waiting on WB-E2E-001/i)).toBeVisible();
});

test('failed health reads are DISTINCT from genuine empty health — the UNWIRED runtime authority withholds the all-healthy conclusion, never fabricates "No health findings"', async ({ page }) => {
  await login(page);
  await page.goto(`/projects/${projectAId}/workbench?tab=health`);

  // The runtime + deployments reads FAIL (unwired): the health assessment is
  // INCOMPLETE — the gap is named, and "No health findings" is provably NOT
  // rendered (a failed read can never become an all-clear).
  await expect(page.getByText(/Health assessment incomplete/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/could not be assessed: deployments, runtime\./i)).toBeVisible();
  await expect(page.getByText(/No health findings/i)).toHaveCount(0);

  // The maintenance read SUCCEEDED — the maintenance work renders (the
  // read-state discipline: one failing surface never degrades another).
  await expect(page.getByText('Maintenance work', { exact: true })).toBeVisible();
});

test('open maintenance findings remain distinguishable from actual COMPLETED Work Items — the completed signal is done work, never a finding', async ({ page }) => {
  await login(page);
  await page.goto(`/projects/${projectAId}/workbench?tab=health`);

  // The OPEN signal is the finding; the COMPLETED signal never becomes one.
  await expect(page.getByText('Maintenance: CI is regressing on main')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Maintenance: Stale dependency was upgraded')).toHaveCount(0);

  // The completed record renders in its own VISIBLY DISTINCT section.
  await expect(page.getByText(/Completed maintenance work \(1\) — done, not open/i)).toBeVisible();
  await expect(page.getByText('WI-MAINT-DONE — Stale dependency was upgraded')).toBeVisible();
  await expect(page.getByText(/was high/i)).toBeVisible();
});

test('what should happen next: the maintenance authority\'s open Work Item is the governed path — and the health view renders NO mutation trigger (recommendations cannot mutate state)', async ({ page }) => {
  await login(page);
  await page.goto(`/projects/${projectAId}/workbench?tab=health`);

  // The governed path: the open maintenance Work Item, linked.
  await expect(page.getByText('What should happen next')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/WI-MAINT-OPEN — CI is regressing on main/).first()).toBeVisible();
  await expect(page.getByText(/The maintenance authority's Work Item — the governed path/i)).toBeVisible();

  // READ-ONLY: the health view surfaces NO scan/evaluate trigger anywhere —
  // health recommendations cannot mutate state (there is no mutation UI at
  // all; the scan routes exist only behind explicit project.write actions
  // elsewhere).
  await expect(page.getByRole('button', { name: /scan/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /run maintenance/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /evaluate/i })).toHaveCount(0);
});

test('BROWSER-LEVEL TENANT ISOLATION: user A opening user B\'s project Health tab sees ONLY degraded states — zero project B data (including the SECRET maintenance signal)', async ({ page }) => {
  await login(page);
  // User A has NO access to project B: every backend call 403s (server-side
  // authorization) and the Health tab renders ONLY the degraded states.
  await page.goto(`/projects/${projectBId}/workbench?tab=health`);
  await expect(page.getByText(/Health assessment incomplete/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/could not be assessed: work graph, executions, verification, deployments, runtime, maintenance\./i)).toBeVisible();
  // The maintenance authority read FAILED (403) — an explicit error, never
  // "No maintenance signals" and never project B's data.
  await expect(page.getByText(/Maintenance health unavailable/i)).toBeVisible();
  await expect(page.getByText('No maintenance signals', { exact: true })).toHaveCount(0);
  // No project B data ever renders (the SECRET maintenance signal must
  // never appear — not as a finding, not as maintenance work).
  await expect(page.getByText('SECRET project B maintenance signal')).toHaveCount(0);
  await expect(page.getByText('WI-B-SECRET-MAINT')).toHaveCount(0);
  await expect(page.getByText(/No health findings/i)).toHaveCount(0);
});
