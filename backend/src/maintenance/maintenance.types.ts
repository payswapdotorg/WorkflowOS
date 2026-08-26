/**
 * WORK-041: Maintenance + Project Health Engine — the application/maintenance-
 * intelligence capability that DETECTS dependency vulnerabilities, CI
 * regressions, runtime changes, security advisories, compatibility issues,
 * performance regressions, architecture drift, technical debt, and operational
 * risks; then CREATES + PRIORITIZES maintenance Work Items THROUGH the
 * EXISTING /work-items authority.
 *
 * This directory is NOT a frozen module (it is not under src/modules/) and is
 * NOT an authority. It is an APPLICATION/MAINTENANCE CAPABILITY (analogous to
 * src/onboarding/, src/repository-intelligence/, src/development-planner/)
 * that COMPOSES the EXISTING domain authorities + the WORK-040 planner to
 * decide "what maintenance should be done?" + convergently create authoritative
 * maintenance Work Items.
 *
 * THE MOST IMPORTANT DISTINCTION (the WORK-041 frozen contract,
 * spec/dependency-graph.md:139): "Both [WORK-040 + WORK-041] feed governed
 * Work Items rather than creating parallel workflow engines." WORK-041 is a
 * TRUSTED INTERNAL PRODUCER that feeds the EXISTING WORK-040 planner. It does
 * NOT create a parallel Work Item pipeline. Its detectors produce
 * PlanningSignal[] (the full vocabulary — kind, provenance, evidenceRefs,
 * relatedWorkItemIds, originator, baselineCommitSha, blocksCount, maintenance)
 * + call DevelopmentPlannerService.evaluate DIRECTLY (programmatically). The
 * planner's prioritizer turns each signal into a PlanningCandidate with a
 * deterministic proposedWorkItemId; the orchestrator dedups via the existing
 * UNIQUE(architecture_version_id, work_item_id) constraint + the 23505 catch →
 * convergent Work Item creation. The created Work Items carry metadata.planner
 * (with the maintenance metadata embedded) — they enter the EXISTING Work Item
 * → Work Order → Execution → Verification → Review lifecycle. WORK-041 does
 * NOT advance them.
 *
 * AUTHORITY BOUNDARY (enforced statically in static-architecture.test.ts):
 *   * /work-items — the AUTHORITATIVE Work Item authority. WORK-041 CREATES
 *                  maintenance Work Items THROUGH the existing planner's
 *                  WorkItemRepository.create (the single creation path). The
 *                  maintenance capability NEVER calls WorkItemRepository.create
 *                  directly + NEVER calls workItemDependencyRepository.add /
 *                  remove (the dependency graph is mutated ONLY through the
 *                  existing /work-items/dependencies route). It READS the
 *                  dependency graph for dependency-aware explanation only.
 *   * /architecture — read-only (ArchitectureDriftDetector compares
 *                  ArchitectureVersion.digestSha256 across versions; it NEVER
 *                  auto-freezes / never creates versions).
 *   * /github    — read-only CiEvidenceIngestionRepository.listForProject (the
 *                  CiRegressionDetector consumes webhook-fed CI evidence). The
 *                  maintenance capability NEVER imports /github internal/ +
 *                  NEVER calls GitHubAdapter methods (no on-demand check-runs;
 *                  the CI detector works ONLY off what webhook ingestion
 *                  already persisted).
 *   * /projects  — read-only ProjectBaselineRepository.listObservations (the
 *                  AdvisoryDetector reads the `package_managers` baseline
 *                  observation's claim to extract dependencies; it NEVER
 *                  mutates baselines).
 *   * AdvisorySource — a PLUGGABLE interface (queryAdvisories). One
 *                  InMemoryAdvisorySource impl for tests. Production advisory
 *                  ingestion (real OSV/GHSA adapter) is declared future work —
 *                  the interface is the contract; a real adapter is a separate
 *                  capability. The maintenance capability NEVER imports a
 *                  security-advisory SDK directly.
 *   * /workflows, /verification, /reviews, /agents, /execution — NEVER
 *                  mutated/invoked.
 *
 * PROVENANCE PRESERVATION. Maintenance signals carry the SAME provenance
 * vocabulary as WORK-040 (observed | inferred | proposed — NEVER confirmed).
 * A maintenance detector's signal is `observed` when it derives from
 * authoritative source facts (CI evidence rows, architecture digests, advisory
 * records) or `inferred` when it derives from derived analysis (drift
 * inference). The maintenance capability NEVER promotes provenance to
 * `confirmed` — confirmation is a separate authorized path. Provenance is
 * recorded in the Work Item's `metadata.planner.provenance` (NOT a new column;
 * NOT an authority mutation).
 *
 * DEDUP / IDEMPOTENCY. The maintenance capability reuses the planner's
 * deterministic dedup. Two maintenance scans that produce the same canonical
 * goal + scope produce the same proposedWorkItemId → the same Work Item (the
 * second scan converges to `already-exists`; NO duplicate). The existing DB
 * UNIQUE constraint is the hard fence. The maintenance capability owns NO
 * tables — its evidence lives in `metadata.planner` (the planner's JSONB) +
 * `metadata.planner.maintenance` (the maintenance-specific passthrough).
 *
 * TRIGGER MODEL. "Continuous" does NOT mean polling. The maintenance capability
 * is triggered EXPLICITLY: POST .../maintenance/evaluate (synchronous mutation,
 * project.write — but this forces kind=maintenance-request/proposed; it does
 * NOT run the detectors — see the authority boundary below) + a durable
 * `maintenance.run` JobHandler (idempotent + redeliveryPolicy) registered with
 * the existing WorkerHost so async maintenance scans can enqueue detector runs
 * — reusing the EXISTING Queue + WorkerHost, NO new scheduler, NO setInterval,
 * NO cron, NO forever-loop.
 *
 * AUTHORITY/PROVENANCE BOUNDARY (mirror of WORK-040 round 4): the PUBLIC
 * maintenance route accepts ONLY the user-request shape { canonicalGoal, scope? }.
 * The server constructs kind=maintenance-request, provenance=proposed,
 * originator=user.id. NO caller-supplied kind/provenance/evidenceRefs/
 * blocksCount/relatedWorkItemIds/originator/baselineCommitSha/maintenance. The
 * DETECTORS are TRUSTED INTERNAL PRODUCERS — they call
 * MaintenanceService.detectAndEvaluate DIRECTLY (programmatically) with the
 * full PlanningSignal vocabulary + the maintenance metadata payload. They do
 * NOT go through the public route.
 */
import type { Logger } from '@platform/index.js';
import type {
  ProjectBaselineRepository,
} from '@modules/projects/index.js';
import type {
  ArchitectureVersionRepository,
  ArchitectureRepository,
} from '@modules/architecture/index.js';
import type {
  WorkItemRepository,
  WorkItemDependencyRepository,
} from '@modules/work-items/index.js';
import type {
  RequirementRepository,
  AcceptanceCriterionRepository,
} from '@modules/requirements/index.js';
import type { CiEvidenceIngestionRepository } from '@modules/github/index.js';
import type {
  DevelopmentPlannerService,
  PlanningSignal,
  PlanningEvaluateResult,
  PlanningRecommendationSummary,
  MaintenanceSignalMetadata,
} from '@development-planner/index.js';

// ---------------------------------------------------------------------------
// Advisory source (pluggable — the vulnerability / security-advisory data).
// ---------------------------------------------------------------------------

/**
 * A security advisory record (CVE / GHSA / OSV). The `advisoryId` is the
 * canonical external id (e.g. "GHSA-1234-abcd-wxyz", "CVE-2024-12345",
 * "OSV-2024-1"). The `vulnerableRange` is a SemVer range string (e.g.
 * "<4.17.21") that the AdvisoryDetector matches against the resolved version.
 * The maintenance capability NEVER imports a security-advisory SDK directly —
 * it queries through the pluggable AdvisorySource interface. One
 * InMemoryAdvisorySource impl exists for tests; production OSV/GHSA adapters
 * are declared future work (the interface is the contract).
 */
export interface AdvisoryRecord {
  readonly advisoryId: string;
  readonly ecosystem: AdvisoryEcosystem;
  readonly packageName: string;
  /** SemVer range string, e.g. "<4.17.21" or ">=2.0.0 <3.0.0". */
  readonly vulnerableRange: string;
  readonly fixedVersion?: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  readonly summary?: string;
}

export type AdvisoryEcosystem =
  | 'npm'
  | 'pypi'
  | 'go'
  | 'cargo'
  | 'gem'
  | 'composer'
  | 'maven';

/**
 * A pluggable advisory data source. The AdvisoryDetector queries this for
 * each dependency in the project's package manifest. The maintenance capability
 * NEVER imports a security-advisory SDK directly — it queries through this
 * interface. Implementations:
 *   * InMemoryAdvisorySource — seeded with a small advisory snapshot for tests.
 *   * (future) OsvAdvisorySource — queries osv.dev (declared future work).
 *   * (future) GhsaAdvisorySource — queries GitHub Security Advisories API
 *     (declared future work — would require a new GitHubAdapter method).
 */
export interface AdvisorySource {
  readonly sourceName: string;
  queryAdvisories(
    ecosystem: AdvisoryEcosystem,
    packageName: string,
    version: string,
  ): Promise<readonly AdvisoryRecord[]>;
}

// ---------------------------------------------------------------------------
// Maintenance detectors (the detection interface).
// ---------------------------------------------------------------------------

/**
 * A maintenance detector. Each detector consumes a REAL authoritative data
 * source (CI evidence rows, architecture digests, advisory records + baseline
 * observations) + produces PlanningSignal[] (the full vocabulary, with the
 * `maintenance` metadata payload). The detectors are TRUSTED INTERNAL
 * PRODUCERS — they NEVER go through the public route. Three real detectors
 * exist in V1:
 *   * CiRegressionDetector — consumes CiEvidenceIngestionRepository; detects
 *     CI regressions (success→failure transitions across headShas per
 *     workflowName).
 *   * ArchitectureDriftDetector — consumes ArchitectureVersionRepository;
 *     detects architecture drift (digestSha256 comparison across versions).
 *   * AdvisoryDetector — consumes AdvisorySource + ProjectBaselineRepository
 *     (the package_managers observation); detects dependency vulnerabilities +
 *     security advisories.
 *
 * The remaining maintenance categories (runtime-change, compatibility,
 * performance-regression, technical-debt-dedicated, operational-risk) are
 * declared detector slots for future work — the frozen contract lists them
 * but V1 does NOT fabricate detection sources that don't exist. The PR
 * description documents which detectors are real vs. declared-future.
 */
export interface MaintenanceDetector {
  readonly name: string;
  detect(
    input: MaintenanceDetectInput,
    ctx: MaintenanceContext,
  ): Promise<readonly PlanningSignal[]>;
}

/**
 * The per-detection input. The projectId + architectureVersionId are the
 * target scope. The baselineId (optional) is the latest baseline for the
 * project (the AdvisoryDetector reads its package_managers observation). The
 * baselineCommitSha (optional) is the revision-bound evidence (carried into
 * each produced signal).
 */
export interface MaintenanceDetectInput {
  readonly projectId: string;
  readonly architectureVersionId: string;
  readonly baselineId?: string;
  readonly baselineCommitSha?: string;
}

// ---------------------------------------------------------------------------
// Maintenance context (read-only authority handles for detectors).
// ---------------------------------------------------------------------------

/**
 * The read-only authority handles a maintenance detector needs. This is a
 * SUBSET of the full authority surface — detectors read CI evidence, architecture
 * versions, + baseline observations. The maintenance capability NEVER holds
 * credentials, NEVER imports /github internal/ (the revision is carried in the
 * signal), NEVER imports /workflows / /verification / /reviews internal/
 * (never mutated). The PlanningContext (for the planner) is built separately
 * by the service from the service deps.
 */
export interface MaintenanceContext {
  readonly organizationId: string;
  readonly projectId: string;
  readonly ciEvidenceRepository: CiEvidenceIngestionRepository;
  readonly architectureVersionRepository: ArchitectureVersionRepository;
  readonly architectureRepository: ArchitectureRepository;
  readonly projectBaselineRepository: ProjectBaselineRepository;
  /** The pluggable advisory source (optional — if absent, AdvisoryDetector produces no signals). */
  readonly advisorySource?: AdvisorySource;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// The orchestrator (the maintenance service).
// ---------------------------------------------------------------------------

/**
 * The maintenance service. detectAndEvaluate runs the configured detectors,
 * collects their PlanningSignals, + delegates to the EXISTING
 * DevelopmentPlannerService.evaluate (the trusted-internal-producer path). The
 * planner's prioritizer turns each signal into a candidate; the planner's
 * orchestrator dedups + creates authoritative Work Items through the existing
 * WorkItemRepository.create. The maintenance capability owns NO Work Item
 * creation path — it goes THROUGH the planner.
 *
 * listMaintenanceSignals is READ-ONLY — it lists maintenance-originated Work
 * Items (those whose metadata.planner.maintenance exists) in the target
 * architecture version. The GET route uses this so a read-authorized caller can
 * NEVER trigger a state mutation.
 */
export interface MaintenanceService {
  /**
   * MUTATION — requires WRITE authority (it triggers the planner, which CREATES
   * authoritative Work Items). Runs the configured detectors, collects their
   * PlanningSignals, + delegates to DevelopmentPlannerService.evaluate. The
   * planner is convergent (the DB constraint fences concurrent runs), so
   * re-scans produce NO duplicate Work Items. The maintenance capability NEVER
   * mutates the dependency graph, NEVER mutates workflow / verification /
   * review state, NEVER starts execution, NEVER selects a provider.
   */
  detectAndEvaluate(input: MaintenanceRunInput): Promise<MaintenanceRunResult>;

  /**
   * READ-ONLY — never creates / mutates. List maintenance-originated Work Items
   * in the architecture version (those whose metadata.planner.maintenance
   * exists). The GET route uses this so a read-authorized caller can NEVER
   * trigger a state mutation. The architectureVersionId is verified to belong
   * to the authorized project by the route BEFORE this is called.
   */
  listMaintenanceSignals(
    architectureVersionId: string,
    ctx: MaintenanceContext,
  ): Promise<readonly MaintenanceSignalSummary[]>;
}

/**
 * The input to a maintenance run. The organizationId is resolved by the caller
 * (the route or the job handler resolves it from ProjectRepository.findById).
 * The architectureVersionId is the TARGET version the created Work Items will
 * belong to. The baselineId (optional) is the latest baseline (for the
 * AdvisoryDetector). The baselineCommitSha (optional) is the revision-bound
 * evidence (carried into each produced signal + recorded in
 * metadata.planner.baselineCommitSha). The idempotencyKey (optional) is for
 * the durable job (the planner is convergent regardless — the DB constraint
 * fences concurrent runs — but the key is carried for traceability).
 */
export interface MaintenanceRunInput {
  readonly projectId: string;
  readonly organizationId: string;
  readonly architectureVersionId: string;
  readonly baselineId?: string;
  readonly baselineCommitSha?: string;
  readonly idempotencyKey?: string;
}

/**
 * The result of a maintenance run. Extends the planner's PlanningEvaluateResult
 * with the count of signals the detectors produced (detectedSignalCount) — so
 * the caller can see "we detected N signals, created M new Work Items, K
 * already existed, F failed".
 */
export interface MaintenanceRunResult extends PlanningEvaluateResult {
  /** How many PlanningSignals the detectors produced (before dedup). */
  readonly detectedSignalCount: number;
}

/**
 * READ-ONLY summary of a maintenance-originated Work Item (one whose
 * metadata.planner.maintenance exists). Returned by listMaintenanceSignals.
 */
export interface MaintenanceSignalSummary extends PlanningRecommendationSummary {
  /** The maintenance metadata (category, severity, advisoryId, etc.). */
  readonly maintenance: MaintenanceSignalMetadata;
}

// ---------------------------------------------------------------------------
// The orchestrator's dependencies (the constructor input).
// ---------------------------------------------------------------------------

/**
 * The maintenance service's dependencies. Carries BOTH:
 *   * The planning authorities (the service builds a PlanningContext for the
 *     planner — workItemRepository, workItemDependencyRepository,
 *     architectureVersionRepository, architectureRepository,
 *     requirementRepository, acceptanceCriterionRepository).
 *   * The maintenance authorities (the service builds a MaintenanceContext for
 *     the detectors — ciEvidenceRepository, projectBaselineRepository,
 *     advisorySource).
 * The service owns NO credentials + NO direct GitHub SDK access. The
 * AdvisorySource is optional (if absent, AdvisoryDetector produces no signals).
 */
export interface MaintenanceServiceDeps {
  readonly detectors: readonly MaintenanceDetector[];
  readonly plannerService: DevelopmentPlannerService;
  // Planning authorities (the service builds PlanningContext for the planner):
  readonly workItemRepository: WorkItemRepository;
  readonly workItemDependencyRepository: WorkItemDependencyRepository;
  readonly architectureVersionRepository: ArchitectureVersionRepository;
  readonly architectureRepository: ArchitectureRepository;
  readonly requirementRepository: RequirementRepository;
  readonly acceptanceCriterionRepository: AcceptanceCriterionRepository;
  // Maintenance authorities (the service builds MaintenanceContext for detectors):
  readonly ciEvidenceRepository: CiEvidenceIngestionRepository;
  readonly projectBaselineRepository: ProjectBaselineRepository;
  readonly advisorySource?: AdvisorySource;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// The durable maintenance.run job (reuses the existing Queue + WorkerHost).
// ---------------------------------------------------------------------------

/**
 * The serializable payload of a `maintenance.run` durable job. The
 * MaintenanceContext + PlanningContext (runtime authority handles) are NOT
 * serializable — the job handler RE-RESOLVES them from the projectId at
 * processing time (the handler is constructed in app.ts with the authority
 * handles). The handler is idempotent (the planner is convergent via the DB
 * constraint), so durable redelivery is safe.
 */
export interface MaintenanceRunJobPayload {
  readonly projectId: string;
  readonly organizationId: string;
  readonly architectureVersionId: string;
  readonly baselineId?: string;
  readonly baselineCommitSha?: string;
  readonly idempotencyKey?: string;
}

/** The durable job type name (registered with the existing WorkerHost). */
export const MAINTENANCE_RUN_JOB_TYPE = 'maintenance.run';

/** The redelivery policy — the maintenance run is idempotent (the planner is convergent), so durable redelivery is safe. */
export const MAINTENANCE_RUN_REDELIVERY_POLICY = {
  maxAttempts: 3,
} as const;

/** The maintenance capability version (recorded in metadata.planner.plannerVersion for traceability — the planner sets this; the maintenance capability records its own version in metadata.planner.maintenance.detectorSource per-signal). */
export const MAINTENANCE_VERSION = 'work-041.v1';
