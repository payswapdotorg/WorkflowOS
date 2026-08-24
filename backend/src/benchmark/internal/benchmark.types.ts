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
import type { Queue } from '@platform/queue/queue.js';
import type {
  AuditService,
} from '@modules/audit/index.js';
import type {
  ExecutionService,
  ExecutionMode,
  ExecutionSubmitResult,
  ExecutionRecordRepository,
  ExecutionState,
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
  /**
   * PR #35 follow-up (idempotency): ATOMIC experiment-completion claim.
   * Compare-and-swap: `UPDATE wfos_benchmark_experiments SET status='completed',
   * completed_at=COALESCE(completed_at, NOW()) WHERE id=$1 AND status='running'
   * RETURNING *`. Only the worker that wins (returns a row) may run integrity
   * validation + write the BENCHMARK_COMPLETED audit event. The loser (null)
   * skips — exactly-once experiment finalization (closes the duplicate
   * BENCHMARK_COMPLETED audit + duplicate integrity-validation race that
   * mirrors the trial-finalization race).
   */
  claimExperimentCompletion(id: string): Promise<BenchmarkExperiment | null>;

  // Trials (§5, §6)
  createTrial(input: BenchmarkTrialInsert): Promise<BenchmarkTrial>;
  getTrial(id: string): Promise<BenchmarkTrial | null>;
  listTrials(experimentId: string, opts?: { limit?: number; offset?: number }): Promise<{ trials: BenchmarkTrial[]; total: number }>;
  listTrialsByExperiment(experimentId: string): Promise<BenchmarkTrial[]>;
  /**
   * PR #35 review fix v2 / Blocker A: find every trial pointing at a given
   * executionId. Used by `advanceTrialsForExecution(executionId)` — the
   * event-driven re-advance path wired off the ExecutionEventIngestion
   * `onExecutionTerminal` hook. Returns ALL matching trials across all
   * experiments (an executionId is globally unique).
   */
  listTrialsByExecutionId(executionId: string): Promise<BenchmarkTrial[]>;
  /**
   * PR #35 review fix v2 / Blocker B: find every trial pointing at a given
   * cloned workItemId. Used by `advanceTrialsForWorkItem(workItemId)` — the
   * event-driven re-advance path wired off the WorkflowEngine `onTransition`
   * hook when the work item reaches `verified` or a terminal failure state.
   */
  listTrialsByWorkItem(workItemId: string): Promise<BenchmarkTrial[]>;
  updateTrial(id: string, patch: BenchmarkTrialPatch): Promise<BenchmarkTrial | null>;
  countByCell(experimentId: string): Promise<{ provider: string; mode: 'native' | 'external'; count: number }[]>;
  /**
   * PR #35 follow-up (idempotency): ATOMIC CLAIM of a queued trial by an
   * orchestrator worker. Performs a compare-and-swap:
   *
   *   UPDATE wfos_benchmark_trials
   *   SET status='running', lifecycle_phase='starting',
   *       started_at = COALESCE(started_at, NOW()), updated_at = NOW()
   *   WHERE id = $1 AND lifecycle_phase = 'queued'
   *   RETURNING *;
   *
   * Returns the claimed row ONLY for the worker that won the race. Returns
   * `null` when another worker already claimed the trial (lifecycle_phase is
   * no longer 'queued') OR the trial does not exist. The LOSER MUST NOT
   * perform any orchestration side effects — the trial is already being
   * advanced by the winner.
   *
   * This closes the `queued → running` claim race identified in the PR #35
   * follow-up review: two deliveries of the same `benchmark.trial` job can
   * no longer both observe `queued` and both proceed to clone / branch /
   * submit.
   */
  claimTrialForSetup(id: string): Promise<BenchmarkTrial | null>;
  /**
   * PR #35 follow-up (idempotency): atomic `starting → execution_wait` OR
   * `starting → delivery_wait` transition, performed by the orchestrator
   * worker that won the `claimTrialForSetup` race. Carries the linkage fields
   * (workItemId, workOrderId, implementationContextId, executionId, etc.)
   * that the orchestrator computed during setup.
   *
   * The `toPhase` is:
   *   - 'execution_wait' — external mode: the orchestrator submitted, the
   *     execution is handoff_ready, awaiting the `onExecutionTerminal`
   *     ingestion hook.
   *   - 'delivery_wait'  — native mode: the orchestrator submitted + the
   *     synchronous execution terminal-completed; awaiting the workflow
   *     `onTransition` hook.
   *
   * Guarded: `WHERE id=$1 AND lifecycle_phase='starting'`. Returns null if
   * the trial is no longer `starting` (e.g. a concurrent terminal failure
   * raced ahead — the orchestrator's linkage update is discarded, which is
   * correct: the trial is already terminal).
   */
  advanceFromStarting(
    id: string,
    toPhase: 'execution_wait' | 'delivery_wait',
    patch: BenchmarkTrialPatch,
  ): Promise<BenchmarkTrial | null>;
  /**
   * PR #35 follow-up (idempotency): atomic `execution_wait → delivery_wait`
   * transition (external mode only). Performed by `runTrialJob` when the
   * authoritative execution record is terminal-completed. Guarded:
   * `WHERE id=$1 AND lifecycle_phase='execution_wait'`. Returns null if the
   * trial is no longer `execution_wait` (already advanced by a concurrent
   * delivery, or already terminal).
   */
  advanceToDeliveryWait(id: string): Promise<BenchmarkTrial | null>;
  /**
   * PR #35 follow-up (idempotency): ATOMIC TERMINAL CLAIM. Performs a
   * compare-and-swap from a non-terminal phase (`execution_wait` or
   * `delivery_wait`) to a terminal phase (`completed` or `failed`).
   *
   * Returns the claimed row ONLY for the worker that won the terminal race.
   * Returns `null` when the trial was already terminal (another worker
   * finalized it) OR the trial is not in the expected `fromPhase`. The LOSER
   * MUST NOT collect metrics / insert findings / write audit — those side
   * effects are exactly-once by construction.
   *
   * This closes the `running → terminal` finalization race identified in the
   * PR #35 follow-up review: two terminal-advancement jobs can no longer
   * both finalize the same trial and both collect metrics + insert findings
   * + write audit events.
   */
  claimTerminal(
    id: string,
    fromPhase: 'execution_wait' | 'delivery_wait',
    outcome:
      | { status: 'completed' }
      | { status: 'failed'; failureKind: string; failureReason: string },
  ): Promise<BenchmarkTrial | null>;
  /**
   * PR #35 follow-up (idempotency): atomic `starting → failed` transition,
   * performed by the orchestrator worker that won the setup claim when setup
   * itself fails (dependency replication failure, branch creation failure,
   * digest mismatch, native submit failure). Guarded:
   * `WHERE id=$1 AND lifecycle_phase='starting'`. Returns null if the trial
   * is no longer `starting` (already terminalized by a concurrent path —
   * the failure update is discarded, which is correct). The optional patch
   * carries whatever linkage / metadata the orchestrator had computed
   * before the failure (workItemId / workOrderId / implementationContextId /
   * executionId / agentRunId / mode metadata) — folded into the same atomic
   * statement so the failed row is self-describing for forensics.
   */
  failFromStarting(
    id: string,
    failureKind: string,
    failureReason: string,
    patch?: BenchmarkTrialPatch,
  ): Promise<BenchmarkTrial | null>;

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
  /**
   * PR #35 follow-up (idempotency): the explicit phase the application layer
   * transitions the trial to. Mutated ONLY through the atomic claim methods
   * (`claimTrialForSetup`, `advanceFromStarting`, `advanceToDeliveryWait`,
   * `claimTerminal`, `failFromStarting`) so that every transition is a
   * compare-and-swap. The generic `updateTrial` does NOT set this field
   * (it is reserved for the atomic paths).
   */
  readonly lifecyclePhase?: BenchmarkTrial['lifecyclePhase'];
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
  /**
   * Run a single trial's setup + submission. Returns the trial in the
   * state the orchestrator reached:
   *   - native mode    → 'running' (execution done, awaiting delivery phase —
   *     the workflow engine drives the cloned work item through
   *     pr_open → verifying → approved → merged → verified). If native
   *     execution itself failed, 'failed' (terminal immediately — no
   *     delivery for a failed execution).
   *   - external mode  → 'running' (handoff_ready — the companion + provider
   *     adapter drive the rest; completion is observed asynchronously via
   *     the ExecutionEventIngestionService `onExecutionTerminal` hook, which
   *     re-enqueues `benchmark.trial` for the trial).
   *   - infrastructure failure → 'failed' (terminal immediately).
   *
   * PR #35 review fix v2 (Blocker A + Blocker B): this method NEVER blocks
   * on external execution + NEVER marks a trial `completed` at submit time.
   * Completion is observed only when the authoritative workflow state for
   * the trial's cloned work item reaches `verified` (terminal success) or a
   * terminal failure state (verification_failed / implementation_blocked).
   * The {@link BenchmarkTrialRunner.runTrialJob} entrypoint drives the full
   * lifecycle: orchestrator (queued → running) → execution phase → delivery
   * phase, each phase event-driven (no bounded poll, no hardcoded timeout).
   */
  runTrial(trial: BenchmarkTrial): Promise<BenchmarkTrial>;
}

/**
 * PR #35 review fix v2 (Blocker A + Blocker B): the benchmark trial
 * lifecycle is FULLY EVENT-DRIVEN + ASYNCHRONOUS. `startExperiment()`
 * enqueues a `benchmark.trial` job per queued trial and returns immediately
 * (experiment 'running'). The WorkerHost picks up each job and calls
 * `runTrialJob(trialId)`, which is a NON-BLOCKING, RE-ENTRANT state machine:
 *
 *   - trial.status == 'queued'   → run the orchestrator (sets trial
 *     'running' + executionId; native submission that returns 'failed'
 *     sets trial 'failed' terminal immediately). Re-check experiment
 *     completion; return.
 *   - trial.status == 'running'  → EXECUTION PHASE: for external mode,
 *     read the authoritative execution record. If the record is not yet
 *     terminal, RETURN (the trial will be re-advanced when the
 *     ExecutionEventIngestionService `onExecutionTerminal` hook fires for
 *     this executionId). If the record is terminal-failed, mark the trial
 *     'failed' (engineering). If the record is terminal-completed, enter
 *     the DELIVERY PHASE. For native mode, the execution outcome is
 *     'completed' (orchestrator already submitted synchronously — if submit
 *     had failed, the trial would be 'failed' terminal, not 'running').
 *   - DELIVERY PHASE: read workflowEngine.getState(workItemId). If
 *     'verified' → trial 'completed' + finalize (metrics+audit). If
 *     'verification_failed' or 'implementation_blocked' → trial 'failed'
 *     (engineering). Otherwise → RETURN (the trial will be re-advanced
 *     when the WorkflowEngine `onTransition` hook fires for this workItemId
 *     on a terminal transition).
 *
 * NO bounded poll. NO hardcoded timeout. NO `externalTimeoutMs`. An
 * experiment is NEVER marked 'completed' while ANY trial is still
 * 'running'/'queued' (delivery-complete is the authority, NOT
 * execution-complete).
 */
export interface BenchmarkTrialRunner {
  /** Advance a single trial through the next phase; finalize when terminal. */
  runTrialJob(trialId: string): Promise<void>;
  /**
   * PR #35 review fix v2 / Blocker A: re-advance every trial pointing at
   * the given executionId. Called by the
   * `ExecutionEventIngestionService.onExecutionTerminal` composition hook
   * (wired in app.ts) when an external execution reaches a terminal state
   * (completed / failed). Each matching trial is re-enqueued onto the
   * `benchmark.trial` queue; the worker then re-enters `runTrialJob` and
   * advances the trial through the delivery phase.
   */
  advanceTrialsForExecution(executionId: string): Promise<void>;
  /**
   * PR #35 review fix v2 / Blocker B: re-advance every trial pointing at
   * the given cloned workItemId. Called by the
   * `WorkflowEngine.onTransition` composition hook (wired in app.ts) when
   * the work item reaches `verified` or a terminal failure state
   * (`verification_failed` / `implementation_blocked`). Each matching
   * trial is re-enqueued onto the `benchmark.trial` queue; the worker then
   * re-enters `runTrialJob` and finalizes the trial.
   */
  advanceTrialsForWorkItem(workItemId: string): Promise<void>;
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
  /** PR #35 review fix #4: background queue for async `benchmark.trial` jobs. */
  readonly queue: Queue;
  /**
   * PR #35 review fix v2 / Blocker A: authoritative execution record lookup
   * — used by `runTrialJob`'s EXECUTION PHASE to read whether an external
   * execution has reached a terminal state. NO bounded poll: if the record
   * is non-terminal, the trial stays 'running' + the
   * `onExecutionTerminal` composition hook (wired in app.ts) re-advances
   * the trial when the ingestion service observes the terminal event.
   */
  readonly executionRecordRepository: ExecutionRecordRepository;
  /**
   * PR #35 review fix v2 / Blocker B: authoritative workflow state lookup —
   * used by `runTrialJob`'s DELIVERY PHASE to read whether the trial's
   * cloned work item has reached `verified` (terminal success) or a
   * terminal failure state. NO bounded poll: if the work item is still
   * delivering, the trial stays 'running' + the `onTransition` composition
   * hook (wired in app.ts) re-advances the trial when the workflow engine
   * observes the terminal transition.
   */
  readonly workflowEngine: WorkflowEngine;
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
  Queue,
  AuditService,
  ExecutionService,
  ExecutionMode,
  ExecutionSubmitResult,
  ExecutionRecordRepository,
  ExecutionState,
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
