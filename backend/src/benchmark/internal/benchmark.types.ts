/**
 * WORK-032: internal contract types for the benchmark domain.
 *
 * Private to src/benchmark/. The public barrel (index.ts) re-exports the
 * service interfaces + repository contract; concrete implementations stay
 * in this folder.
 *
 * Boundary reminder (§34): benchmark code imports @modules/* public barrels
 * and @platform/* only. Never internal/ of any frozen module. Never pg /
 * @octokit / @electric-sql/pglite directly.
 */
import type { DatabaseClient } from '@platform/postgres/database-client.js';
import type { Logger } from '@platform/logger.js';
import type {
  AuditService,
} from '@modules/audit/index.js';
import type {
  ExecutionService,
  ExecutionMode,
  ExecutionSubmitResult,
} from '@modules/agents/index.js';
import type {
  AgentRunRepository,
} from '@modules/agents/index.js';
import type {
  WorkflowEngine,
} from '@modules/workflows/index.js';
import type {
  VerificationService,
} from '@modules/verification/index.js';
import type {
  ReviewService,
} from '@modules/reviews/index.js';
import type {
  WorkItemRepository,
  WorkOrderRepository,
  WorkItemRequirementRepository,
  WorkItemCriterionRepository,
  WorkItemDependencyRepository,
  PullRequestAssociationRepository,
  ImplementationContextRepository,
  ImplementationContextBuilder,
  ExecutionPromptBuilder,
  ExecutionTaskService,
  WorkItemCompletionService,
} from '@modules/work-items/index.js';
import type {
  GitHubAdapter,
  CiEvidenceIngestionRepository,
} from '@modules/github/index.js';
import type {
  AgentProviderRegistry,
} from '@modules/agents/index.js';
import type {
  AuthorizationService,
} from '@modules/auth/index.js';
import type {
  BenchmarkTaskSnapshot,
  BenchmarkExperiment,
  BenchmarkTrial,
  BenchmarkTrialMetrics,
  BenchmarkReviewFinding,
  BenchmarkIntegrityRecord,
  BenchmarkComparison,
  BenchmarkSnapshotPreview,
  CreateBenchmarkSnapshotInput,
  CreateBenchmarkExperimentInput,
  BenchmarkTrialSpec,
  BenchmarkExportFormat,
  BenchmarkRecommendation,
} from '../types.js';

/** Repository contract for all 6 benchmark tables. Owned by src/benchmark/. */
export interface BenchmarkRepository {
  // Snapshots (§4)
  createSnapshot(input: BenchmarkSnapshotInsert): Promise<BenchmarkTaskSnapshot>;
  getSnapshot(id: string): Promise<BenchmarkTaskSnapshot | null>;
  listSnapshots(projectId: string, opts?: { limit?: number; offset?: number }): Promise<{ snapshots: BenchmarkTaskSnapshot[]; total: number }>;

  // Experiments (§5)
  createExperiment(input: BenchmarkExperimentInsert): Promise<BenchmarkExperiment>;
  getExperiment(id: string): Promise<BenchmarkExperiment | null>;
  listExperiments(projectId: string, opts?: { limit?: number; offset?: number }): Promise<{ experiments: BenchmarkExperiment[]; total: number }>;
  updateExperimentStatus(id: string, status: BenchmarkExperiment['status'], opts?: { startedAt?: Date; completedAt?: Date }): Promise<BenchmarkExperiment | null>;

  // Trials (§5, §6)
  createTrial(input: BenchmarkTrialInsert): Promise<BenchmarkTrial>;
  getTrial(id: string): Promise<BenchmarkTrial | null>;
  listTrials(experimentId: string, opts?: { limit?: number; offset?: number }): Promise<{ trials: BenchmarkTrial[]; total: number }>;
  listTrialsByExperiment(experimentId: string): Promise<BenchmarkTrial[]>;
  updateTrial(id: string, patch: BenchmarkTrialPatch): Promise<BenchmarkTrial | null>;
  countByCell(experimentId: string): Promise<{ provider: string; mode: 'native' | 'external'; count: number }[]>;

  // Metrics (§10)
  upsertMetrics(metrics: BenchmarkTrialMetricsInsert): Promise<BenchmarkTrialMetrics>;
  getMetrics(trialId: string): Promise<BenchmarkTrialMetrics | null>;

  // Review findings (§13)
  insertFinding(input: BenchmarkReviewFindingInsert): Promise<BenchmarkReviewFinding>;
  listFindings(trialId: string): Promise<BenchmarkReviewFinding[]>;

  // Integrity (§32)
  upsertIntegrity(input: BenchmarkIntegrityInsert): Promise<BenchmarkIntegrityRecord>;
  getIntegrity(experimentId: string): Promise<BenchmarkIntegrityRecord | null>;
  invalidateIntegrity(experimentId: string, reason: string): Promise<BenchmarkIntegrityRecord | null>;
}

export interface BenchmarkSnapshotInsert {
  readonly organizationId: string;
  readonly projectId: string;
  readonly architectureVersionId: string;
  readonly workItemId: string;
  readonly workOrderId: string;
  readonly implementationContextId: string;
  readonly requirementIds: readonly string[];
  readonly criterionIds: readonly string[];
  readonly repository: string;
  readonly baseCommit: string;
  readonly targetBranchPrefix: string;
  readonly promptDigest: string;
  readonly promptVersion: string;
  readonly verificationRequirements: readonly unknown[];
  readonly snapshotHash: string;
  readonly harnessVersion: string;
  readonly scoringVersion: string;
}

export interface BenchmarkExperimentInsert {
  readonly organizationId: string;
  readonly projectId: string;
  readonly benchmarkTaskSnapshotId: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdBy: string | null;
  readonly status: BenchmarkExperiment['status'];
  readonly randomizationSeed: string | null;
  readonly repetitions: number;
}

export interface BenchmarkTrialInsert {
  readonly experimentId: string;
  readonly benchmarkTaskSnapshotId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly provider: string;
  readonly model: string | null;
  readonly executionMode: 'native' | 'external';
  readonly repetitionIndex: number;
  readonly executionOrder: number;
  readonly randomizationSeed: string | null;
  readonly status: BenchmarkTrial['status'];
  readonly trialBranch: string;
  readonly baselineCommit: string;
  readonly promptDigest: string;
}

export interface BenchmarkTrialPatch {
  readonly status?: BenchmarkTrial['status'];
  readonly workItemId?: string | null;
  readonly executionId?: string | null;
  readonly agentRunId?: string | null;
  readonly pullRequestAssociationId?: string | null;
  readonly workOrderId?: string | null;
  readonly implementationContextId?: string | null;
  readonly failureKind?: string | null;
  readonly failureReason?: string | null;
  readonly humanInterventionCount?: number;
  readonly interventionDurationMs?: number | null;
  readonly companionVersion?: string | null;
  readonly providerAdapterVersion?: string | null;
  readonly browser?: string | null;
  readonly providerSurface?: string | null;
  readonly externalSessionRef?: string | null;
  readonly handoffIssuedAt?: Date | null;
  readonly handoffRedeemedAt?: Date | null;
  readonly adapterVersion?: string | null;
  readonly modelConfigurationVersion?: string | null;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
}

export interface BenchmarkTrialMetricsInsert {
  readonly trialId: string;
  readonly queueTimeMs?: number | null;
  readonly startLatencyMs?: number | null;
  readonly executionDurationMs?: number | null;
  readonly filesChanged?: number | null;
  readonly linesAdded?: number | null;
  readonly linesDeleted?: number | null;
  readonly commits?: number | null;
  readonly pullRequests?: number | null;
  readonly ciRuns?: number | null;
  readonly ciFailures?: number | null;
  readonly ciFirstPass?: boolean | null;
  readonly totalCiDurationMs?: number | null;
  readonly ciFailureCategories?: Record<string, number> | null;
  readonly verificationRuns?: number | null;
  readonly criteriaPassed?: number | null;
  readonly criteriaFailed?: number | null;
  readonly verificationFirstPass?: boolean | null;
  readonly finalPass?: boolean | null;
  readonly totalCriteria?: number | null;
  readonly reviewCount?: number | null;
  readonly requestChangesCount?: number | null;
  readonly approvalCount?: number | null;
  readonly severityCounts?: Record<string, number> | null;
  readonly correctionCycles?: number | null;
  readonly agentRuns?: number | null;
  readonly timeToPrMs?: number | null;
  readonly timeToApprovedMs?: number | null;
  readonly timeToMergedMs?: number | null;
  readonly timeToVerifiedMs?: number | null;
  readonly engineeringQualityScore?: number | null;
  readonly scoreVersion?: string | null;
  readonly executionStartedAt?: Date | null;
  readonly executionCompletedAt?: Date | null;
  readonly prCreatedAt?: Date | null;
  readonly ciStartedAt?: Date | null;
  readonly ciCompletedAt?: Date | null;
  readonly verificationStartedAt?: Date | null;
  readonly verificationCompletedAt?: Date | null;
  readonly reviewStartedAt?: Date | null;
  readonly reviewCompletedAt?: Date | null;
  readonly mergedAt?: Date | null;
  readonly verifiedAt?: Date | null;
}

export interface BenchmarkReviewFindingInsert {
  readonly trialId: string;
  readonly reviewId: string | null;
  readonly severity: 'blocker' | 'major' | 'minor' | 'info';
  readonly category: string | null;
  readonly file: string | null;
  readonly line: number | null;
  readonly description: string;
}

export interface BenchmarkIntegrityInsert {
  readonly experimentId: string;
  readonly snapshotHash: string;
  readonly promptDigest: string;
  readonly baselineCommit: string;
  readonly scoringVersion: string;
  readonly harnessVersion: string;
}

/** Freezes a snapshot from a template work item (§4). */
export interface BenchmarkSnapshotService {
  preview(input: { projectId: string; workItemId: string }): Promise<BenchmarkSnapshotPreview>;
  create(input: CreateBenchmarkSnapshotInput): Promise<BenchmarkTaskSnapshot>;
}

/** Validates experiment integrity (§32). */
export interface BenchmarkIntegrityService {
  record(input: BenchmarkIntegrityInsert): Promise<BenchmarkIntegrityRecord>;
  get(experimentId: string): Promise<BenchmarkIntegrityRecord | null>;
  validate(experimentId: string): Promise<BenchmarkIntegrityRecord>;
  invalidate(experimentId: string, reason: string): Promise<BenchmarkIntegrityRecord>;
}

/** Reads authoritative state and computes the metric row for a trial (§10). */
export interface BenchmarkMetricCollector {
  collect(trial: BenchmarkTrial): Promise<BenchmarkTrialMetricsInsert>;
  collectFindings(trial: BenchmarkTrial): Promise<BenchmarkReviewFindingInsert[]>;
}

/** Orchestrates a single trial: clone work item → branch → ExecutionService (§8). */
export interface BenchmarkTrialOrchestrator {
  /** Run a single trial to completion (or failure). Synchronous for fixtures. */
  runTrial(trial: BenchmarkTrial): Promise<BenchmarkTrial>;
}

/** Exports experiment results as JSON or CSV (§40). */
export interface BenchmarkExportService {
  exportExperiment(experimentId: string, format: BenchmarkExportFormat): Promise<{ contentType: string; body: string; filename: string }>;
}

/** §42: explicit, evidence-backed recommendation helper. */
export interface BenchmarkRecommendationService {
  recommend(experimentId: string): Promise<BenchmarkRecommendation | null>;
}

/** Dependencies for the default benchmark service (DI). */
export interface DefaultBenchmarkServiceDeps {
  readonly db: DatabaseClient;
  readonly logger: Logger;
  readonly repository: BenchmarkRepository;
  readonly snapshotService: BenchmarkSnapshotService;
  readonly integrityService: BenchmarkIntegrityService;
  readonly metricCollector: BenchmarkMetricCollector;
  readonly trialOrchestrator: BenchmarkTrialOrchestrator;
  readonly exportService: BenchmarkExportService;
  readonly recommendationService: BenchmarkRecommendationService;
  readonly auditService: AuditService;
  readonly authorizationService: AuthorizationService;
}

export type {
  BenchmarkComparison,
  BenchmarkSnapshotPreview,
  CreateBenchmarkSnapshotInput,
  CreateBenchmarkExperimentInput,
  BenchmarkTrialSpec,
  BenchmarkExportFormat,
  BenchmarkRecommendation,
  DatabaseClient,
  Logger,
  AuditService,
  ExecutionService,
  ExecutionMode,
  ExecutionSubmitResult,
  AgentRunRepository,
  WorkflowEngine,
  VerificationService,
  ReviewService,
  WorkItemRepository,
  WorkOrderRepository,
  WorkItemRequirementRepository,
  WorkItemCriterionRepository,
  WorkItemDependencyRepository,
  PullRequestAssociationRepository,
  ImplementationContextRepository,
  ImplementationContextBuilder,
  ExecutionPromptBuilder,
  ExecutionTaskService,
  WorkItemCompletionService,
  GitHubAdapter,
  CiEvidenceIngestionRepository,
  AgentProviderRegistry,
  AuthorizationService,
};
