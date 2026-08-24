/**
 * WORK-032: Native vs External Execution Benchmark — public barrel.
 *
 * The benchmark domain is an APPLICATION-LAYER orchestrator that lives at
 * `src/benchmark/` — OUTSIDE `src/modules/`. It is NOT a frozen module; it
 * is a cross-cutting harness that CONSUMES the 17 frozen domain modules via
 * their public barrels (index.ts).
 *
 * Boundary contract (§34 static checks enforce):
 *   - imports from @modules/* (public barrels only — never internal/)
 *   - imports from @platform/* (cross-cutting infrastructure)
 *   - NEVER imports pg / @octokit / @electric-sql/pglite directly
 *   - NEVER stores credentials, callback tokens, handoff tokens, or cookies
 *
 * Authority model (§9):
 *   - reads workflow state via /workflows (workflowEngine.getState/getHistory)
 *   - reads verification via /verification (verificationService.listRunsForWorkItem)
 *   - reads reviews via /reviews (reviewService.listReviewsForWorkItem)
 *   - reads PR/merge via /work-items (pullRequestAssociationRepository)
 *   - reads CI via /github (ciEvidenceIngestionRepository.listForProject)
 *   - reads agent runs via /agents (agentRunRepository.findByWorkItem)
 *   - delegates execution to /agents (ExecutionService.submit) — native + external
 *   - emits audit via /audit (auditService.write) — BENCHMARK_x / TRIAL_x event types
 *
 * The benchmark NEVER:
 *   - mutates MERGED / VERIFIED (those transitions belong to /workflows)
 *   - creates another workflow/verification/review/CI engine
 *   - trusts provider claims ("all tests passed") without authoritative confirmation
 */
export type {
  BenchmarkTaskSnapshot,
  CreateBenchmarkSnapshotInput,
  BenchmarkExperiment,
  BenchmarkExperimentStatus,
  BenchmarkTrialSpec,
  CreateBenchmarkExperimentInput,
  BenchmarkTrial,
  BenchmarkTrialStatus,
  BenchmarkFailureKind,
  BenchmarkTrialMetrics,
  BenchmarkReviewFinding,
  BenchmarkIntegrityRecord,
  BenchmarkCellStatistics,
  BenchmarkComparison,
  BenchmarkExportFormat,
  BenchmarkService,
  BenchmarkSnapshotPreview,
  BenchmarkRecommendation,
} from './types.js';

export {
  BENCHMARK_HARNESS_VERSION,
  BENCHMARK_SCORING_VERSION,
  classifyCiFailureCategory,
  computeEngineeringQualityScore,
  buildTrialBranchName,
} from './internal/benchmark-helpers.js';

export type {
  BenchmarkRepository,
  BenchmarkSnapshotService,
  BenchmarkIntegrityService,
  BenchmarkMetricCollector,
  BenchmarkTrialOrchestrator,
  BenchmarkExportService,
  BenchmarkRecommendationService,
  DefaultBenchmarkServiceDeps,
} from './internal/benchmark.types.js';

export {
  DefaultBenchmarkSnapshotService,
} from './internal/benchmark-snapshot-service.js';

export {
  DefaultBenchmarkIntegrityService,
} from './internal/benchmark-integrity-service.js';

export {
  DefaultBenchmarkMetricCollector,
} from './internal/benchmark-metric-collector.js';

export {
  DefaultBenchmarkTrialOrchestrator,
} from './internal/benchmark-trial-orchestrator.js';

export {
  DefaultBenchmarkExportService,
} from './internal/benchmark-export-service.js';

export {
  DefaultBenchmarkRecommendationService,
} from './internal/benchmark-recommendation-service.js';

export {
  DefaultBenchmarkService,
} from './internal/benchmark-service.js';

export {
  PgBenchmarkRepository,
} from './internal/pg-benchmark-repository.js';

// §37/§38: deterministic providers for CI parity. These implement the
// ExecutionProvider boundary (owned by /agents) and produce known variants
// so the benchmark machinery can be tested without real provider accounts.
export {
  DeterministicNativeBenchmarkProvider,
  type DeterministicNativeVariant,
} from './internal/deterministic-native-benchmark-provider.js';

export {
  DeterministicExternalBenchmarkProvider,
  type DeterministicExternalVariant,
} from './internal/deterministic-external-benchmark-provider.js';
