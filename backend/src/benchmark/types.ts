/**
 * WORK-032: Native vs External Execution Benchmark — public contract types.
 *
 * The benchmark harness measures Native API execution versus External
 * Companion execution using the SAME engineering task. It answers:
 *
 *   Given the same architecture, repository, Work Order, implementation
 *   context, verification requirements, and acceptance criteria, which
 *   execution path produces the highest-quality completed software with the
 *   fewest correction cycles?
 *
 * ARCHITECTURE BOUNDARY (§34 static checks):
 *
 * The benchmark domain lives at `src/benchmark/` — an APPLICATION-LAYER
 * orchestrator OUTSIDE `src/modules/`. It is NOT a 18th frozen module; it is
 * a cross-cutting harness that CONSUMES the 17 frozen domain modules via
 * their public barrels (index.ts). It never reaches into any module's
 * `internal/` directory.
 *
 * The benchmark:
 *   - does NOT create another workflow engine (reads /workflows only)
 *   - does NOT create another verification engine (reads /verification only)
 *   - does NOT create another review engine (reads /reviews only)
 *   - does NOT calculate authoritative workflow state
 *   - does NOT mutate MERGED / VERIFIED (those transitions belong to /workflows)
 *   - DOES use ExecutionService (owned by /agents) for both native + external
 *   - DOES use existing GitHub authority (/github + PullRequestAssociation)
 *   - DOES use existing Verification authority (/verification)
 *   - DOES use existing Review authority (/reviews)
 *   - DOES store promptDigest (§27 equality invariant)
 *   - DOES require baseline commit identity (§28 equality invariant)
 *   - DOES isolate trials (§6 — per-trial branch + cloned work item)
 *   - NEVER stores credentials, callback tokens, handoff tokens, or cookies
 *
 * All file paths below are relative to backend/.
 */

/** A frozen, immutable snapshot of the exact task to benchmark (§4). */
export interface BenchmarkTaskSnapshot {
  readonly id: string;
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
  readonly createdAt: Date;
}

/** Input to freeze a snapshot from a template work item (§4, §44). */
export interface CreateBenchmarkSnapshotInput {
  readonly projectId: string;
  readonly workItemId: string;
  readonly name: string;
  readonly description?: string;
  readonly targetBranchPrefix?: string;
}

/** An experiment: one or more trials against a single snapshot (§5). */
export interface BenchmarkExperiment {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly benchmarkTaskSnapshotId: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdBy: string | null;
  readonly status: BenchmarkExperimentStatus;
  readonly randomizationSeed: string | null;
  readonly repetitions: number;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

export type BenchmarkExperimentStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'invalidated';

/** A trial cell definition (provider × mode × repetition) (§5). */
export interface BenchmarkTrialSpec {
  readonly provider: string;
  /** Model — required for native mode, optional for external. */
  readonly model?: string | null;
  readonly mode: 'native' | 'external';
  readonly repetitions: number;
}

/** Input to create an experiment (§44). */
export interface CreateBenchmarkExperimentInput {
  readonly projectId: string;
  readonly benchmarkTaskSnapshotId: string;
  readonly name: string;
  readonly description?: string;
  readonly createdBy: string;
  readonly trials: readonly BenchmarkTrialSpec[];
  readonly randomizeOrder?: boolean;
  readonly randomizationSeed?: string;
  readonly repetitions?: number;
}

/** A trial: one execution of one (provider, mode, rep) cell (§5, §6). */
export interface BenchmarkTrial {
  readonly id: string;
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
  readonly status: BenchmarkTrialStatus;
  readonly trialBranch: string;
  readonly baselineCommit: string;
  readonly promptDigest: string;
  readonly workItemId: string | null;
  readonly executionId: string | null;
  readonly agentRunId: string | null;
  readonly pullRequestAssociationId: string | null;
  readonly workOrderId: string | null;
  readonly implementationContextId: string | null;
  readonly failureKind: BenchmarkFailureKind | null;
  readonly failureReason: string | null;
  readonly humanInterventionCount: number;
  readonly interventionDurationMs: number | null;
  // §17 external mode metadata
  readonly companionVersion: string | null;
  readonly providerAdapterVersion: string | null;
  readonly browser: string | null;
  readonly providerSurface: string | null;
  readonly externalSessionRef: string | null;
  readonly handoffIssuedAt: Date | null;
  readonly handoffRedeemedAt: Date | null;
  // §18 native mode metadata
  readonly adapterVersion: string | null;
  readonly modelConfigurationVersion: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type BenchmarkTrialStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'unavailable';

export type BenchmarkFailureKind = 'infrastructure' | 'engineering' | 'configuration';

/** The full metric row for a trial (§10). Persisted by the metric collector. */
export interface BenchmarkTrialMetrics {
  readonly trialId: string;
  // §10 Execution
  readonly queueTimeMs: number | null;
  readonly startLatencyMs: number | null;
  readonly executionDurationMs: number | null;
  // §10 Engineering
  readonly filesChanged: number | null;
  readonly linesAdded: number | null;
  readonly linesDeleted: number | null;
  readonly commits: number | null;
  readonly pullRequests: number | null;
  // §15 CI
  readonly ciRuns: number | null;
  readonly ciFailures: number | null;
  readonly ciFirstPass: boolean | null;
  readonly totalCiDurationMs: number | null;
  readonly ciFailureCategories: Record<string, number> | null;
  // §14 Verification
  readonly verificationRuns: number | null;
  readonly criteriaPassed: number | null;
  readonly criteriaFailed: number | null;
  readonly verificationFirstPass: boolean | null;
  readonly finalPass: boolean | null;
  readonly totalCriteria: number | null;
  // §13 Review
  readonly reviewCount: number | null;
  readonly requestChangesCount: number | null;
  readonly approvalCount: number | null;
  readonly severityCounts: Record<string, number> | null;
  // §12 Correction
  readonly correctionCycles: number | null;
  readonly agentRuns: number | null;
  // §10 Completion time
  readonly timeToPrMs: number | null;
  readonly timeToApprovedMs: number | null;
  readonly timeToMergedMs: number | null;
  readonly timeToVerifiedMs: number | null;
  // §11 Derived score (versioned)
  readonly engineeringQualityScore: number | null;
  readonly scoreVersion: string | null;
  // §16 Timestamps
  readonly executionStartedAt: Date | null;
  readonly executionCompletedAt: Date | null;
  readonly prCreatedAt: Date | null;
  readonly ciStartedAt: Date | null;
  readonly ciCompletedAt: Date | null;
  readonly verificationStartedAt: Date | null;
  readonly verificationCompletedAt: Date | null;
  readonly reviewStartedAt: Date | null;
  readonly reviewCompletedAt: Date | null;
  readonly mergedAt: Date | null;
  readonly verifiedAt: Date | null;
  readonly collectedAt: Date;
}

/** A per-trial review finding projection (§13). */
export interface BenchmarkReviewFinding {
  readonly id: string;
  readonly trialId: string;
  readonly reviewId: string | null;
  readonly severity: 'blocker' | 'major' | 'minor' | 'info';
  readonly category: string | null;
  readonly file: string | null;
  readonly line: number | null;
  readonly description: string;
  readonly createdAt: Date;
}

/** The integrity record for an experiment (§32). */
export interface BenchmarkIntegrityRecord {
  readonly id: string;
  readonly experimentId: string;
  readonly snapshotHash: string;
  readonly promptDigest: string;
  readonly baselineCommit: string;
  readonly scoringVersion: string;
  readonly harnessVersion: string;
  readonly valid: boolean;
  readonly validatedAt: Date;
  readonly invalidationReason: string | null;
}

/** Aggregated statistics for a (provider, mode) cell across N repetitions (§22, §23). */
export interface BenchmarkCellStatistics {
  readonly provider: string;
  readonly mode: 'native' | 'external';
  readonly trialCount: number;
  readonly completed: number;
  readonly failed: number;
  readonly unavailable: number;
  readonly correctionCycles: { mean: number | null; median: number | null; min: number | null; max: number | null };
  readonly timeToVerifiedMs: { mean: number | null; median: number | null; min: number | null; max: number | null };
  readonly ciFirstPassRate: number | null;
  readonly verificationFirstPassRate: number | null;
  readonly engineeringQualityScore: { mean: number | null; median: number | null; min: number | null; max: number | null };
}

/** A side-by-side comparison of two or more trials (§26). */
export interface BenchmarkComparison {
  readonly benchmarkTaskSnapshotId: string;
  readonly promptDigest: string;
  readonly baselineCommit: string;
  readonly trials: readonly BenchmarkTrial[];
  readonly metrics: Record<string, BenchmarkTrialMetrics>;
  readonly cells: readonly BenchmarkCellStatistics[];
  readonly integrityValid: boolean;
}

/** Export formats (§40). */
export type BenchmarkExportFormat = 'json' | 'csv';

/** The benchmark service — the application-layer orchestrator (§8). */
export interface BenchmarkService {
  /** §4: Freeze a snapshot from a template work item. */
  createSnapshot(input: CreateBenchmarkSnapshotInput): Promise<BenchmarkTaskSnapshot>;
  /** Preview a snapshot WITHOUT persisting (§44 creation flow). */
  previewSnapshot(input: { projectId: string; workItemId: string }): Promise<BenchmarkSnapshotPreview>;
  /** §5: Create an experiment with one or more trial specs. */
  createExperiment(input: CreateBenchmarkExperimentInput): Promise<BenchmarkExperiment>;
  /** §45: Start an experiment (runs queued trials). */
  startExperiment(experimentId: string): Promise<BenchmarkExperiment>;
  /** §45: Pause a running experiment. */
  pauseExperiment(experimentId: string): Promise<BenchmarkExperiment>;
  /** §45: Cancel an experiment. */
  cancelExperiment(experimentId: string): Promise<BenchmarkExperiment>;
  /** List experiments for a project (paginated, §49). */
  listExperiments(projectId: string, opts?: { limit?: number; offset?: number }): Promise<{ experiments: BenchmarkExperiment[]; total: number }>;
  /** Get an experiment by id. */
  getExperiment(experimentId: string): Promise<BenchmarkExperiment | null>;
  /** List trials for an experiment (paginated, §49). */
  listTrials(experimentId: string, opts?: { limit?: number; offset?: number }): Promise<{ trials: BenchmarkTrial[]; total: number }>;
  /** Get a trial by id (§25 detail view). */
  getTrial(trialId: string): Promise<BenchmarkTrial | null>;
  /** Get trial metrics (§25). */
  getTrialMetrics(trialId: string): Promise<BenchmarkTrialMetrics | null>;
  /** Get trial review findings (§13). */
  listTrialFindings(trialId: string): Promise<BenchmarkReviewFinding[]>;
  /** §26: Side-by-side comparison. */
  compareTrials(trialIds: readonly string[]): Promise<BenchmarkComparison>;
  /** §32: Integrity record for an experiment. */
  getIntegrity(experimentId: string): Promise<BenchmarkIntegrityRecord | null>;
  /** §40: Export experiment results. */
  exportExperiment(experimentId: string, format: BenchmarkExportFormat): Promise<{ contentType: string; body: string; filename: string }>;
  /** §41: Optional recommendation helper — explicit, evidence-backed. */
  recommend(experimentId: string): Promise<BenchmarkRecommendation | null>;
  /** List snapshots for a project. */
  listSnapshots(projectId: string, opts?: { limit?: number; offset?: number }): Promise<{ snapshots: BenchmarkTaskSnapshot[]; total: number }>;
  /** Get a snapshot by id. */
  getSnapshot(snapshotId: string): Promise<BenchmarkTaskSnapshot | null>;
}

/** A snapshot preview (§44) — shows the canonical prompt + digest before freezing. */
export interface BenchmarkSnapshotPreview {
  readonly projectId: string;
  readonly workItemId: string;
  readonly workItemLabel: string;
  readonly architectureVersionId: string;
  readonly requirementIds: readonly string[];
  readonly criterionIds: readonly string[];
  readonly repository: string;
  readonly baseCommit: string;
  readonly implementationContextId: string;
  readonly promptDigest: string;
  readonly promptVersion: string;
  readonly verificationRequirements: readonly unknown[];
  readonly snapshotHash: string;
  readonly harnessVersion: string;
  readonly scoringVersion: string;
  readonly promptExcerpt: string;
}

/** §42: Optional explicit recommendation helper. */
export interface BenchmarkRecommendation {
  readonly experimentId: string;
  readonly recommendedProvider: string | null;
  readonly recommendedMode: 'native' | 'external' | null;
  readonly reason: string;
  readonly evidence: {
    readonly metric: string;
    readonly value: string;
    readonly cell: string;
  }[];
  readonly sampleSize: number;
  readonly confidence: 'low' | 'medium' | 'high';
}
