/**
 * WORK-041: Maintenance + Project Health Engine — integration coverage of the
 * 12 frozen WORK-041 regression requirements.
 *
 * The test wires the REAL maintenance orchestrator
 * (DefaultMaintenanceService) + the REAL WORK-040 planner
 * (DefaultDevelopmentPlannerService + DeterministicPlanningPrioritizer) on top
 * of a real PostgreSQL test database (pglite locally / real pg in CI). The
 * CI evidence rows are ingested through the REAL /github
 * CiEvidenceIngestionRepository (the same repository the production webhook
 * ingestion path writes to). The architecture versions are produced by the
 * REAL /architecture authority. The maintenance service CREATES Work Items
 * THROUGH the EXISTING WORK-040 planner (the trusted-internal-producer entry
 * point) — no fake creation path.
 *
 * The 12 regressions:
 *  1. CI regression detector — 2 CI evidence rows (success→failure) → 1
 *     maintenance-ci-regression Work Item with category=ci-regression.
 *  2. Architecture drift detector — 2 architecture versions with different
 *     digestSha256 → 1 architecture-observation Work Item with
 *     category=architecture-drift.
 *  3. Advisory detector — InMemoryAdvisorySource + stub ProjectBaselineRepo
 *     with a package_managers observation → 1 dependency-observation Work
 *     Item with category=vulnerability + advisoryId.
 *  4. Dedup/convergence — same scan twice → first createdCount=1, second
 *     createdCount=0 + alreadyExistsCount=1 (NO duplicate).
 *  5. Public evaluate route rejects `maintenance` field in a request item.
 *  6. Public evaluate route rejects top-level `maintenance`.
 *  7. Public evaluate route rejects caller-supplied `provenance: 'observed'`.
 *  8. Public evaluate route produces a maintenance-request/proposed Work
 *     Item with originator = authenticated user + NO maintenance metadata.
 *  9. Public scan route rejects signal-authority fields (signals, kind,
 *     provenance, evidenceRefs, baselineCommitSha, maintenance).
 * 10. Public scan route runs the detectors (CI regression evidence → Work
 *     Items created).
 * 11. GET /signals does NOT mutate (Work Item count unchanged before/after).
 * 12. Cross-tenant isolation — CI evidence in Project B is NEVER traversed
 *     when scanning Project A (the detector calls listForProject(projectA.id)
 *     only).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import { DefaultDevelopmentPlannerService } from '../../../src/development-planner/internal/default-development-planner-service.js';
import { DeterministicPlanningPrioritizer, computeProposedWorkItemId } from '../../../src/development-planner/internal/deterministic-planning-prioritizer.js';
import { DefaultMaintenanceService } from '../../../src/maintenance/internal/default-maintenance-service.js';
import { CiRegressionDetector } from '../../../src/maintenance/internal/detectors/ci-regression-detector.js';
import { ArchitectureDriftDetector } from '../../../src/maintenance/internal/detectors/architecture-drift-detector.js';
import { AdvisoryDetector } from '../../../src/maintenance/internal/detectors/advisory-detector.js';
import { InMemoryAdvisorySource } from '../../../src/maintenance/internal/advisory-source.js';
import type {
  MaintenanceRunInput,
  MaintenanceRunResult,
  AdvisoryRecord,
} from '@maintenance/index.js';
import type {
  ProjectBaseline,
  ProjectBaselineRepository,
  BaselineObservation,
} from '@modules/projects/index.js';
import type {
  BaselineEvidence,
  BaselineState,
  BaselineAnalysisMode,
  EnsureBaselineInput,
  NewBaselineEvidence,
  NewBaselineObservation,
  PersistBaselineInput,
  PersistBaselineResult,
} from '@modules/projects/index.js';
import type { CiEvidenceIngestionRepository, CiRunEvidence, IngestCiEvidenceInput } from '@modules/github/index.js';
import type { WorkItem } from '@modules/work-items/index.js';
import { createLogger } from '@platform/logger.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import { InMemoryQueue } from '@platform/index.js';

/**
 * A STUB ProjectBaselineRepository for the advisory detector test (#3). It
 * returns a CANNED package_managers observation (the parsed package.json with
 * lodash@^4.17.20) so the AdvisoryDetector can match against the
 * InMemoryAdvisorySource's lodash advisory. The maintenance service accepts
 * the repository via deps, so a stub is fine for testing the detector logic
 * in isolation (mirrors the WORK-040 InterceptableWorkItemRepository pattern).
 *
 * Only the methods the AdvisoryDetector calls (listForProject +
 * listObservations) return canned data; the rest throw (the advisory detector
 * never calls them — the test would fail loudly if it did).
 */
class StubProjectBaselineRepository implements ProjectBaselineRepository {
  constructor(
    private readonly baseline: ProjectBaseline,
    private readonly observations: BaselineObservation[],
  ) {}

  async listForProject(_projectId: string): Promise<ProjectBaseline[]> {
    return [this.baseline];
  }
  async listObservations(_baselineId: string): Promise<BaselineObservation[]> {
    return this.observations;
  }
  // The advisory detector never calls these — throw to surface an unexpected
  // call loudly (defense-in-depth; the test would fail rather than silently
  // mask a missing-method bug).
  async ensureBaseline(_input: EnsureBaselineInput): Promise<ProjectBaseline> {
    throw new Error('stub-baseline-not-implemented: ensureBaseline');
  }
  async findById(_id: string): Promise<ProjectBaseline | null> {
    throw new Error('stub-baseline-not-implemented: findById');
  }
  async findByRevision(
    _projectId: string,
    _projectGithubRepositoryId: string,
    _baselineCommitSha: string,
  ): Promise<ProjectBaseline | null> {
    throw new Error('stub-baseline-not-implemented: findByRevision');
  }
  async appendEvidence(
    _baselineId: string,
    _evidence: readonly NewBaselineEvidence[],
  ): Promise<BaselineEvidence[]> {
    throw new Error('stub-baseline-not-implemented: appendEvidence');
  }
  async upsertObservations(
    _baselineId: string,
    _observations: readonly NewBaselineObservation[],
  ): Promise<BaselineObservation[]> {
    throw new Error('stub-baseline-not-implemented: upsertObservations');
  }
  async listEvidence(_baselineId: string): Promise<BaselineEvidence[]> {
    throw new Error('stub-baseline-not-implemented: listEvidence');
  }
  async markComplete(
    _baselineId: string,
    _contentDigest: string,
    _expectedVersion: number,
  ): Promise<ProjectBaseline | null> {
    throw new Error('stub-baseline-not-implemented: markComplete');
  }
  async markFailed(
    _baselineId: string,
    _failureStage: string,
    _expectedVersion: number,
  ): Promise<ProjectBaseline | null> {
    throw new Error('stub-baseline-not-implemented: markFailed');
  }
  async confirmObservation(
    _baselineId: string,
    _observationId: string,
    _confirmedBy: string,
  ): Promise<BaselineObservation> {
    throw new Error('stub-baseline-not-implemented: confirmObservation');
  }
  async persistBaselineWithPolicyFence(
    _input: PersistBaselineInput,
  ): Promise<PersistBaselineResult> {
    throw new Error('stub-baseline-not-implemented: persistBaselineWithPolicyFence');
  }
}

/**
 * A RECORDING wrapper around CiEvidenceIngestionRepository for the
 * cross-tenant regression (#12). Records every listForProject call so the
 * test can PROVE the CiRegressionDetector queried ONLY projectA.id (Project
 * B's CI evidence is NEVER traversed). Mirrors the WORK-040
 * RecordingWorkItemDependencyRepository pattern.
 */
class RecordingCiEvidenceRepository implements CiEvidenceIngestionRepository {
  readonly listForProjectCalls: string[] = [];
  constructor(private readonly real: CiEvidenceIngestionRepository) {}
  async upsert(input: IngestCiEvidenceInput): Promise<CiRunEvidence> {
    return this.real.upsert(input);
  }
  async findById(id: string): Promise<CiRunEvidence | null> {
    return this.real.findById(id);
  }
  async findByExternalRunId(provider: string, externalRunId: string): Promise<CiRunEvidence | null> {
    return this.real.findByExternalRunId(provider, externalRunId);
  }
  async listForProject(projectId: string, opts?: { headSha?: string }): Promise<CiRunEvidence[]> {
    this.listForProjectCalls.push(projectId);
    return this.real.listForProject(projectId, opts);
  }
}

describe('WORK-041 — Maintenance + Project Health Engine (12 frozen regressions)', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let userA: User;
  let projectA: { id: string };
  let projectB: { id: string };
  let projectD: { id: string };
  let versionA: { id: string };
  let versionB: { id: string };
  let versionD: { id: string };
  let orgA: { id: string };
  let orgB: { id: string };
  let planner: DefaultDevelopmentPlannerService;
  let maintenanceService: DefaultMaintenanceService;
  const capture = new CaptureStream();

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_MAINT: 'raw-key-maint-a',
    });
    orgA = await stack.organizationRepository.create({ name: 'MAINT Org A' });
    orgB = await stack.organizationRepository.create({ name: 'MAINT Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'maint-user-a', displayName: 'User A' });
    const userB = await stack.userRepository.upsertByExternalId({ externalId: 'maint-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'MAINT Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'MAINT Project B' });
    projectD = await stack.projectRepository.create({ organizationId: orgA.id, name: 'MAINT Project D (dedup)' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectD.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'maint-key-a', secretRef: 'WFOS_TEST_KEY_MAINT', externalId: 'maint-user-a', label: 'User A', rawKey: 'raw-key-maint-a',
    });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'MAINT Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'v1', digestSha256: 'aaa-111' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);

    const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'MAINT Arch B' });
    versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: 'v1', digestSha256: 'bbb-111' });
    await stack.architectureVersionRepository.transitionState(versionB.id, 'frozen', userB.id);

    const archD = await stack.architectureRepository.create({ projectId: projectD.id, name: 'MAINT Arch D (dedup)' });
    versionD = await stack.architectureVersionRepository.create({ architectureId: archD.id, contentInline: 'v1', digestSha256: 'ddd-111' });
    await stack.architectureVersionRepository.transitionState(versionD.id, 'frozen', userA.id);

    const logger = createLogger({ level: 'info', destination: capture });
    planner = new DefaultDevelopmentPlannerService({
      prioritizer: new DeterministicPlanningPrioritizer(),
      logger,
    });
    maintenanceService = new DefaultMaintenanceService({
      detectors: [
        new CiRegressionDetector(),
        new ArchitectureDriftDetector(),
        new AdvisoryDetector(),
      ],
      plannerService: planner,
      workItemRepository: stack.workItemRepository,
      workItemDependencyRepository: stack.workItemDependencyRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      requirementRepository: stack.requirementRepository,
      acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
      ciEvidenceRepository: stack.ciEvidenceRepository,
      projectBaselineRepository: stack.projectBaselineRepository,
      // No advisory source in the main service (the AdvisoryDetector produces
      // no signals when absent — honest; does NOT fabricate advisories).
      logger,
    });

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      architecture: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        architectureDecisionRepository: stack.architectureDecisionRepository,
        architectureChangeRequestRepository: stack.architectureChangeRequestRepository,
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
      developmentPlanner: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        architectureRepository: stack.architectureRepository,
        requirementRepository: stack.requirementRepository,
        acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
        workItemRepository: stack.workItemRepository,
        workItemDependencyRepository: stack.workItemDependencyRepository,
        plannerService: planner,
        logger: stack.db.logger,
        queue: new InMemoryQueue(),
      },
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
        plannerService: planner,
        maintenanceService,
        logger: stack.db.logger,
        queue: new InMemoryQueue(),
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  /** Ingest a CI evidence row for the project. */
  const ingestCi = async (input: {
    projectId: string;
    externalRunId: string;
    workflowName: string;
    headSha: string;
    conclusion: 'success' | 'failure' | 'neutral';
    runStartedAt: Date;
    runCompletedAt: Date;
  }): Promise<CiRunEvidence> => {
    return stack.ciEvidenceRepository.upsert({
      projectId: input.projectId,
      externalRunId: input.externalRunId,
      workflowName: input.workflowName,
      headSha: input.headSha,
      status: 'completed',
      conclusion: input.conclusion,
      runStartedAt: input.runStartedAt,
      runCompletedAt: input.runCompletedAt,
    });
  };

  /** Run the maintenance scan for a project + version. */
  const runMaintenance = async (
    projectId: string,
    organizationId: string,
    architectureVersionId: string,
  ): Promise<MaintenanceRunResult> => {
    const input: MaintenanceRunInput = {
      projectId,
      organizationId,
      architectureVersionId,
    };
    return maintenanceService.detectAndEvaluate(input);
  };

  /** Read metadata.planner off a Work Item as a typed shape. */
  const readPlannerMeta = (wi: WorkItem): {
    source: string;
    provenance: string;
    maintenance?: {
      category: string;
      severity?: string;
      advisoryId?: string;
      affectedCount?: number;
      detectorSource?: string;
    };
    canonicalGoal?: string;
  } => {
    return (wi.metadata as {
      planner?: {
        source: string;
        provenance: string;
        maintenance?: {
          category: string;
          severity?: string;
          advisoryId?: string;
          affectedCount?: number;
          detectorSource?: string;
        };
        canonicalGoal?: string;
      };
    }).planner!;
  };

  // -------------------------------------------------------------------------
  // 1. CI regression detector
  // -------------------------------------------------------------------------
  it('1. CI regression detector — 2 CI evidence rows (success→failure) → 1 maintenance-ci-regression Work Item with category=ci-regression + 2 ci-evidence refs', async () => {
    // Insert a passing run, then a failing run, ordered by runStartedAt.
    const t0 = new Date('2024-01-01T10:00:00Z');
    const t1 = new Date('2024-01-01T11:00:00Z');
    const passing = await ingestCi({
      projectId: projectA.id,
      externalRunId: 'ci-run-passing-1',
      workflowName: 'CI',
      headSha: 'sha-passing-1',
      conclusion: 'success',
      runStartedAt: t0,
      runCompletedAt: new Date('2024-01-01T10:05:00Z'),
    });
    const failing = await ingestCi({
      projectId: projectA.id,
      externalRunId: 'ci-run-failing-1',
      workflowName: 'CI',
      headSha: 'sha-failing-1',
      conclusion: 'failure',
      runStartedAt: t1,
      runCompletedAt: new Date('2024-01-01T11:05:00Z'),
    });
    const result = await runMaintenance(projectA.id, orgA.id, versionA.id);
    expect(result.detectedSignalCount).toBeGreaterThanOrEqual(1);
    expect(result.createdCount).toBeGreaterThanOrEqual(1);
    // Find the maintenance-ci-regression recommendation (created status).
    const rec = result.recommendations.find(
      (r) => r.candidate.signal.kind === 'maintenance-ci-regression' && r.status === 'created',
    );
    expect(rec, 'a maintenance-ci-regression Work Item should have been created').toBeDefined();
    // The candidate carries the FORCED vocabulary.
    expect(rec!.candidate.signal.provenance).toBe('observed');
    expect(rec!.candidate.signal.evidenceRefs?.length).toBe(2);
    expect(rec!.candidate.signal.evidenceRefs?.every((e) => e.kind === 'ci-evidence')).toBe(true);
    expect(rec!.candidate.signal.evidenceRefs?.map((e) => e.ref)).toStrictEqual(
      expect.arrayContaining([passing.id, failing.id]),
    );
    // The persisted Work Item carries the maintenance metadata.
    const wi = await stack.workItemRepository.findById(rec!.workItemId!);
    expect(wi).not.toBeNull();
    const meta = readPlannerMeta(wi!);
    expect(meta.source).toBe('maintenance-ci-regression');
    expect(meta.provenance).toBe('observed');
    expect(meta.maintenance).toBeDefined();
    expect(meta.maintenance!.category).toBe('ci-regression');
    expect(meta.maintenance!.severity).toBe('high');
    expect(meta.maintenance!.detectorSource).toBe('ci-regression-detector');
  });

  // -------------------------------------------------------------------------
  // 2. Architecture drift detector
  // -------------------------------------------------------------------------
  it('2. Architecture drift detector — 2 architecture versions with different digestSha256 → 1 architecture-observation Work Item with category=architecture-drift', async () => {
    // Add a SECOND version to archB with a DIFFERENT digestSha256. The drift
    // detector scans projectB's architectures (archB has 2 versions now).
    const archB = (await stack.architectureRepository.findByProject(projectB.id))[0]!;
    const versionB2 = await stack.architectureVersionRepository.create({
      architectureId: archB.id,
      contentInline: 'v2',
      digestSha256: 'bbb-222', // different from versionB's 'bbb-111' → drift
    });
    await stack.architectureVersionRepository.transitionState(versionB2.id, 'frozen', userA.id);
    const result = await runMaintenance(projectB.id, orgB.id, versionB.id);
    // Drift detected → 1 architecture-observation Work Item.
    const rec = result.recommendations.find(
      (r) => r.candidate.signal.kind === 'architecture-observation' && r.status === 'created',
    );
    expect(rec, 'an architecture-observation Work Item should have been created').toBeDefined();
    expect(rec!.candidate.signal.provenance).toBe('inferred');
    expect(rec!.candidate.signal.evidenceRefs?.every((e) => e.kind === 'architecture-observation')).toBe(true);
    const wi = await stack.workItemRepository.findById(rec!.workItemId!);
    expect(wi).not.toBeNull();
    const meta = readPlannerMeta(wi!);
    expect(meta.source).toBe('architecture-observation');
    expect(meta.provenance).toBe('inferred');
    expect(meta.maintenance).toBeDefined();
    expect(meta.maintenance!.category).toBe('architecture-drift');
    expect(meta.maintenance!.detectorSource).toBe('architecture-drift-detector');
  });

  // -------------------------------------------------------------------------
  // 3. Advisory detector (stub ProjectBaselineRepository + InMemoryAdvisorySource)
  // -------------------------------------------------------------------------
  it('3. Advisory detector — InMemoryAdvisorySource seeded with lodash advisory + stub baseline repo with package_managers observation → 1 dependency-observation Work Item with category=vulnerability + advisoryId', async () => {
    const advisoryId = 'GHSA-TEST-LODASH-001';
    const lodashAdvisory: AdvisoryRecord = {
      advisoryId,
      ecosystem: 'npm',
      packageName: 'lodash',
      vulnerableRange: '<4.17.21',
      fixedVersion: '4.17.21',
      severity: 'high',
      summary: 'Prototype pollution in lodash',
    };
    const advisorySource = new InMemoryAdvisorySource([lodashAdvisory]);
    // Build a STUB ProjectBaselineRepository that returns a package_managers
    // observation with claim = { dependencies: { lodash: '^4.17.20' } }.
    // The resolved version ('4.17.20') satisfies the vulnerable range
    // ('<4.17.21') → the advisory detector produces a signal.
    const baselineId = 'stub-baseline-id';
    const baselineCommitSha = 'stub-baseline-sha';
    const baseline: ProjectBaseline = {
      id: baselineId,
      projectId: projectA.id,
      organizationId: orgA.id,
      projectGithubRepositoryId: 'stub-repo-id',
      repositoryOwner: 'stub-owner',
      repositoryName: 'stub-repo',
      baselineCommitSha,
      revisionRef: 'main',
      state: 'complete' as BaselineState,
      version: 1,
      analysisMode: 'governed' as BaselineAnalysisMode,
      contentDigest: 'stub-content-digest',
      failureStage: null,
      analysisRunId: null,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z'),
      finalizedAt: new Date('2024-01-01T00:00:00Z'),
      terminalAt: new Date('2024-01-01T00:00:00Z'),
    };
    const observations: BaselineObservation[] = [
      {
        id: 'stub-observation-id',
        baselineId,
        kind: 'package_managers',
        provenance: 'observed',
        claim: { dependencies: { lodash: '^4.17.20' } },
        claimDigest: 'stub-claim-digest',
        evidenceRef: [],
        confirmedBy: null,
        confirmedAt: null,
        createdAt: new Date('2024-01-01T00:00:00Z'),
      },
    ];
    const stubBaselineRepo = new StubProjectBaselineRepository(baseline, observations);
    // Construct a SEPARATE maintenance service with ONLY the AdvisoryDetector
    // (isolate from CI/drift detectors — those would also produce signals on
    // projectA + versionA, polluting the advisory assertion).
    const logger = createLogger({ level: 'info', destination: capture });
    const advisoryOnlyService = new DefaultMaintenanceService({
      detectors: [new AdvisoryDetector()],
      plannerService: planner,
      workItemRepository: stack.workItemRepository,
      workItemDependencyRepository: stack.workItemDependencyRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      requirementRepository: stack.requirementRepository,
      acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
      ciEvidenceRepository: stack.ciEvidenceRepository,
      projectBaselineRepository: stubBaselineRepo,
      advisorySource,
      logger,
    });
    const result = await advisoryOnlyService.detectAndEvaluate({
      projectId: projectA.id,
      organizationId: orgA.id,
      architectureVersionId: versionA.id,
      baselineId,
      baselineCommitSha,
    });
    expect(result.detectedSignalCount).toBe(1);
    expect(result.createdCount).toBe(1);
    const rec = result.recommendations[0]!;
    expect(rec.status).toBe('created');
    expect(rec.candidate.signal.kind).toBe('dependency-observation');
    expect(rec.candidate.signal.provenance).toBe('observed');
    expect(rec.candidate.signal.evidenceRefs?.length).toBe(1);
    expect(rec.candidate.signal.evidenceRefs?.[0]?.kind).toBe('advisory-evidence');
    expect(rec.candidate.signal.evidenceRefs?.[0]?.ref).toBe(advisoryId);
    const wi = await stack.workItemRepository.findById(rec.workItemId!);
    expect(wi).not.toBeNull();
    const meta = readPlannerMeta(wi!);
    expect(meta.source).toBe('dependency-observation');
    expect(meta.provenance).toBe('observed');
    expect(meta.maintenance).toBeDefined();
    expect(meta.maintenance!.category).toBe('vulnerability');
    expect(meta.maintenance!.advisoryId).toBe(advisoryId);
    expect(meta.maintenance!.severity).toBe('high');
    expect(meta.maintenance!.detectorSource).toBe('advisory-detector');
  });

  // -------------------------------------------------------------------------
  // 4. Dedup/convergence (isolated projectD — no prior CI evidence)
  // -------------------------------------------------------------------------
  it('4. Dedup/convergence — the same scan twice: first createdCount=1, second createdCount=0 + alreadyExistsCount=1 (NO duplicate)', async () => {
    // projectD is fresh — no prior CI evidence + only one architecture with
    // one version → no drift signal. This isolates the dedup behavior.
    const t0 = new Date('2024-02-01T10:00:00Z');
    const t1 = new Date('2024-02-01T11:00:00Z');
    await ingestCi({
      projectId: projectD.id,
      externalRunId: 'dedup-passing',
      workflowName: 'Build',
      headSha: 'dedup-sha-passing',
      conclusion: 'success',
      runStartedAt: t0,
      runCompletedAt: new Date('2024-02-01T10:05:00Z'),
    });
    await ingestCi({
      projectId: projectD.id,
      externalRunId: 'dedup-failing',
      workflowName: 'Build',
      headSha: 'dedup-sha-failing',
      conclusion: 'failure',
      runStartedAt: t1,
      runCompletedAt: new Date('2024-02-01T11:05:00Z'),
    });
    // First scan → creates the 'Build' regression Work Item.
    const r1 = await runMaintenance(projectD.id, orgA.id, versionD.id);
    expect(r1.createdCount).toBe(1);
    expect(r1.alreadyExistsCount).toBe(0);
    const before = await stack.workItemRepository.findByArchitectureVersion(versionD.id);
    // Second scan (SAME evidence, SAME canonicalGoal) → converges.
    const r2 = await runMaintenance(projectD.id, orgA.id, versionD.id);
    expect(r2.createdCount).toBe(0);
    expect(r2.alreadyExistsCount).toBe(1);
    const after = await stack.workItemRepository.findByArchitectureVersion(versionD.id);
    // NO new row was created by the re-scan (convergence — the DB UNIQUE
    // constraint + the deterministic proposedWorkItemId fence the race).
    expect(after.length).toBe(before.length);
    // The same proposedWorkItemId (verifying the dedup key is deterministic).
    const goal = `Fix CI regression on workflow "Build" (started failing at dedup-sha-failing)`;
    const expectedId = computeProposedWorkItemId(goal);
    const matches = after.filter((w) => w.workItemId === expectedId);
    expect(matches.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 5. Public evaluate route rejects the `maintenance` field in a request item
  // -------------------------------------------------------------------------
  it('5. Public evaluate route rejects the `maintenance` field in a request item — a public caller CANNOT manufacture maintenance metadata', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/maintenance/evaluate`,
      headers: { authorization: 'Bearer raw-key-maint-a' },
      payload: {
        architectureVersionId: versionA.id,
        requests: [{ canonicalGoal: 'x', maintenance: { category: 'vulnerability' } }],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('invalid-user-request');
  });

  // -------------------------------------------------------------------------
  // 6. Public evaluate route rejects top-level `maintenance`
  // -------------------------------------------------------------------------
  it('6. Public evaluate route rejects top-level `maintenance` — the route accepts ONLY the user-request shape', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/maintenance/evaluate`,
      headers: { authorization: 'Bearer raw-key-maint-a' },
      payload: {
        architectureVersionId: versionA.id,
        maintenance: {},
        requests: [{ canonicalGoal: 'x' }],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string; reason: string };
    expect(body.error).toBe('forbidden-field');
  });

  // -------------------------------------------------------------------------
  // 7. Public evaluate route rejects caller-supplied `provenance: 'observed'`
  // -------------------------------------------------------------------------
  it('7. Public evaluate route rejects caller-supplied `provenance: "observed"` — the public route must NOT turn unverified client assertions into observed evidence', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/maintenance/evaluate`,
      headers: { authorization: 'Bearer raw-key-maint-a' },
      payload: {
        architectureVersionId: versionA.id,
        requests: [{ canonicalGoal: 'x', provenance: 'observed' }],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('invalid-user-request');
  });

  // -------------------------------------------------------------------------
  // 8. Public evaluate route produces a maintenance-request Work Item
  // -------------------------------------------------------------------------
  it('8. Public evaluate route produces a maintenance-request/proposed Work Item with originator = the authenticated user + NO maintenance metadata', async () => {
    const goal = 'Public-route maintenance-request Work Item — constrained user request';
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/maintenance/evaluate`,
      headers: { authorization: 'Bearer raw-key-maint-a' },
      payload: {
        architectureVersionId: versionA.id,
        requests: [{ canonicalGoal: goal, scope: 'the public maintenance route boundary' }],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      createdCount: number;
      recommendations: Array<{
        candidate: { signal: { originator?: string; kind: string; provenance: string } };
        workItemId: string;
      }>;
    };
    expect(body.createdCount).toBe(1);
    const rec = body.recommendations[0]!;
    // The persisted Work Item carries the FORCED planning evidence.
    const wi = await stack.workItemRepository.findById(rec.workItemId);
    expect(wi).not.toBeNull();
    const meta = readPlannerMeta(wi!);
    expect(meta.source).toBe('maintenance-request');
    expect(meta.provenance).toBe('proposed');
    // The public route does NOT supply maintenance metadata → the field is
    // ABSENT on the persisted Work Item (the planner records
    // candidate.signal.maintenance verbatim, which is undefined here).
    expect(meta.maintenance).toBeUndefined();
    // The candidate's signal carries the FORCED vocabulary: originator =
    // the authenticated user (userA.id), kind=maintenance-request,
    // provenance=proposed. NO caller-supplied authority fields survived.
    expect(rec.candidate.signal.originator).toBe(userA.id);
    expect(rec.candidate.signal.kind).toBe('maintenance-request');
    expect(rec.candidate.signal.provenance).toBe('proposed');
  });

  // -------------------------------------------------------------------------
  // 9. Public scan route rejects signal-authority fields
  // -------------------------------------------------------------------------
  it('9. Public scan route rejects signal-authority fields — POST /scan with `{ signals: [...] }` returns 400 forbidden-field', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/maintenance/scan`,
      headers: { authorization: 'Bearer raw-key-maint-a' },
      payload: {
        architectureVersionId: versionA.id,
        signals: [{ kind: 'maintenance-ci-regression', canonicalGoal: 'x', provenance: 'observed' }],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string; reason: string };
    expect(body.error).toBe('forbidden-field');
    expect(body.reason).toBe('scan-route-accepts-only-detector-trigger-shape');
  });

  // -------------------------------------------------------------------------
  // 10. Public scan route runs the detectors
  // -------------------------------------------------------------------------
  it('10. Public scan route runs the detectors — POST /scan with `{ architectureVersionId }` produces Work Items from the CI evidence', async () => {
    // Insert NEW CI evidence with a DIFFERENT workflowName so the scan
    // produces a NEW work item (not already-exists from test #1).
    const t0 = new Date('2024-03-01T10:00:00Z');
    const t1 = new Date('2024-03-01T11:00:00Z');
    await ingestCi({
      projectId: projectA.id,
      externalRunId: 'scan-route-passing',
      workflowName: 'Lint',
      headSha: 'scan-route-sha-passing',
      conclusion: 'success',
      runStartedAt: t0,
      runCompletedAt: new Date('2024-03-01T10:05:00Z'),
    });
    await ingestCi({
      projectId: projectA.id,
      externalRunId: 'scan-route-failing',
      workflowName: 'Lint',
      headSha: 'scan-route-sha-failing',
      conclusion: 'failure',
      runStartedAt: t1,
      runCompletedAt: new Date('2024-03-01T11:05:00Z'),
    });
    const before = await stack.workItemRepository.findByArchitectureVersion(versionA.id);
    const res = await server.inject({
      method: 'POST',
      url: `/projects/${projectA.id}/maintenance/scan`,
      headers: { authorization: 'Bearer raw-key-maint-a' },
      payload: {
        architectureVersionId: versionA.id,
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(200);
    expect(res.statusCode).toBeLessThanOrEqual(201);
    const body = JSON.parse(res.body) as {
      detectedSignalCount: number;
      createdCount: number;
      alreadyExistsCount: number;
    };
    expect(body.detectedSignalCount).toBeGreaterThan(0);
    const after = await stack.workItemRepository.findByArchitectureVersion(versionA.id);
    // The scan created at least one NEW work item (the 'Lint' regression).
    expect(after.length).toBeGreaterThan(before.length);
  });

  // -------------------------------------------------------------------------
  // 11. GET signals does NOT mutate
  // -------------------------------------------------------------------------
  it('11. GET /signals does NOT mutate — a GET call creates NO new Work Items', async () => {
    const before = await stack.workItemRepository.findByArchitectureVersion(versionA.id);
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectA.id}/maintenance/signals?architectureVersionId=${versionA.id}`,
      headers: { authorization: 'Bearer raw-key-maint-a' },
    });
    expect(res.statusCode).toBe(200);
    const after = await stack.workItemRepository.findByArchitectureVersion(versionA.id);
    // NO new rows created by the read.
    expect(after.length).toBe(before.length);
  });

  // -------------------------------------------------------------------------
  // 12. Cross-tenant isolation — Project B's CI evidence is NEVER traversed
  // -------------------------------------------------------------------------
  it('12. Cross-tenant isolation — scanning Project A NEVER traverses Project B CI evidence (the detector calls listForProject(projectA.id) only)', async () => {
    // Set up CI evidence in Project B (a success→failure regression).
    const t0 = new Date('2024-04-01T10:00:00Z');
    const t1 = new Date('2024-04-01T11:00:00Z');
    await ingestCi({
      projectId: projectB.id,
      externalRunId: 'cross-tenant-passing',
      workflowName: 'CrossTenant',
      headSha: 'cross-tenant-sha-passing',
      conclusion: 'success',
      runStartedAt: t0,
      runCompletedAt: new Date('2024-04-01T10:05:00Z'),
    });
    await ingestCi({
      projectId: projectB.id,
      externalRunId: 'cross-tenant-failing',
      workflowName: 'CrossTenant',
      headSha: 'cross-tenant-sha-failing',
      conclusion: 'failure',
      runStartedAt: t1,
      runCompletedAt: new Date('2024-04-01T11:05:00Z'),
    });
    // Wrap the CI evidence repository in a RECORDING wrapper that records
    // every listForProject call. The maintenance service accepts the
    // repository via deps, so a recording wrapper is fine for proving the
    // detector never queried Project B.
    const recordingCiRepo = new RecordingCiEvidenceRepository(stack.ciEvidenceRepository);
    const logger = createLogger({ level: 'info', destination: capture });
    const recordingMaintenanceService = new DefaultMaintenanceService({
      detectors: [new CiRegressionDetector()],
      plannerService: planner,
      workItemRepository: stack.workItemRepository,
      workItemDependencyRepository: stack.workItemDependencyRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      requirementRepository: stack.requirementRepository,
      acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
      ciEvidenceRepository: recordingCiRepo,
      projectBaselineRepository: stack.projectBaselineRepository,
      logger,
    });
    const before = await stack.workItemRepository.findByArchitectureVersion(versionA.id);
    // Scan Project A (NOT Project B).
    await recordingMaintenanceService.detectAndEvaluate({
      projectId: projectA.id,
      organizationId: orgA.id,
      architectureVersionId: versionA.id,
    });
    const after = await stack.workItemRepository.findByArchitectureVersion(versionA.id);
    // PROOF: listForProject was called ONLY with projectA.id — NEVER with
    // projectB.id. The CiRegressionDetector scoped its read to Project A's
    // CI evidence; Project B's evidence was NEVER traversed.
    expect(recordingCiRepo.listForProjectCalls.length).toBeGreaterThan(0);
    expect(recordingCiRepo.listForProjectCalls.every((id) => id === projectA.id)).toBe(true);
    expect(recordingCiRepo.listForProjectCalls).not.toContain(projectB.id);
    // No Project B work item was created in Project A's version (the
    // cross-tenant CI evidence never reached the planner).
    const newItems = after.filter((w) => !before.some((b) => b.id === w.id));
    // The new items in versionA are all from Project A's CI evidence
    // (workflowNames 'CI', 'Build', 'Lint') — NONE from 'CrossTenant'.
    for (const wi of newItems) {
      const meta = readPlannerMeta(wi);
      // The maintenance category (if present) is ci-regression; the canonical
      // goal does NOT reference the CrossTenant workflow from Project B.
      const canonicalGoal = meta.canonicalGoal ?? '';
      expect(canonicalGoal).not.toContain('CrossTenant');
    }
  });
});
