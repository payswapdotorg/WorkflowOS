/**
 * WORK-032: PgBenchmarkRepository — persistence for all 6 benchmark tables.
 *
 * Hand-written parameterized SQL (the WorkflowOS convention — no ORM). All
 * queries go through DatabaseClient (raw pg / pglite). Tenant scoping is
 * enforced by organization_id / project_id on every row.
 *
 * SECURITY: this file NEVER writes credentials, callback tokens, handoff
 * tokens, or cookies. The external_session_ref column stores an opaque
 * provider-side reference only.
 *
 * Boundary: imports @platform/postgres only. Never @modules/internal.
 */
import type { DatabaseClient } from '@platform/postgres/database-client.js';
import type {
  BenchmarkTaskSnapshot,
  BenchmarkExperiment,
  BenchmarkTrial,
  BenchmarkTrialMetrics,
  BenchmarkReviewFinding,
  BenchmarkIntegrityRecord,
  BenchmarkExperimentStatus,
  BenchmarkTrialStatus,
} from '../types.js';
import type {
  BenchmarkRepository,
  BenchmarkSnapshotInsert,
  BenchmarkExperimentInsert,
  BenchmarkTrialInsert,
  BenchmarkTrialPatch,
  BenchmarkTrialMetricsInsert,
  BenchmarkReviewFindingInsert,
  BenchmarkIntegrityInsert,
} from './benchmark.types.js';

interface Row {
  [key: string]: unknown;
}

function toSnapshot(r: Row): BenchmarkTaskSnapshot {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    projectId: String(r.project_id),
    architectureVersionId: String(r.architecture_version_id),
    workItemId: String(r.work_item_id),
    workOrderId: String(r.work_order_id),
    implementationContextId: String(r.implementation_context_id),
    requirementIds: Array.isArray(r.requirement_ids) ? (r.requirement_ids as string[]) : [],
    criterionIds: Array.isArray(r.criterion_ids) ? (r.criterion_ids as string[]) : [],
    repository: String(r.repository),
    baseCommit: String(r.base_commit),
    targetBranchPrefix: String(r.target_branch_prefix),
    promptDigest: String(r.prompt_digest),
    promptVersion: String(r.prompt_version),
    verificationRequirements: Array.isArray(r.verification_requirements) ? (r.verification_requirements as unknown[]) : [],
    snapshotHash: String(r.snapshot_hash),
    harnessVersion: String(r.harness_version),
    scoringVersion: String(r.scoring_version),
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
  };
}

function toExperiment(r: Row): BenchmarkExperiment {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    projectId: String(r.project_id),
    benchmarkTaskSnapshotId: String(r.benchmark_task_snapshot_id),
    name: String(r.name),
    description: r.description === null ? null : String(r.description),
    createdBy: r.created_by === null ? null : String(r.created_by),
    status: String(r.status) as BenchmarkExperimentStatus,
    randomizationSeed: r.randomization_seed === null ? null : String(r.randomization_seed),
    repetitions: Number(r.repetitions),
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
    startedAt: r.started_at === null || r.started_at === undefined ? null : (r.started_at instanceof Date ? r.started_at : new Date(String(r.started_at))),
    completedAt: r.completed_at === null || r.completed_at === undefined ? null : (r.completed_at instanceof Date ? r.completed_at : new Date(String(r.completed_at))),
  };
}

function toTrial(r: Row): BenchmarkTrial {
  return {
    id: String(r.id),
    experimentId: String(r.experiment_id),
    benchmarkTaskSnapshotId: String(r.benchmark_task_snapshot_id),
    organizationId: String(r.organization_id),
    projectId: String(r.project_id),
    provider: String(r.provider),
    model: r.model === null || r.model === undefined ? null : String(r.model),
    executionMode: String(r.execution_mode) as 'native' | 'external',
    repetitionIndex: Number(r.repetition_index),
    executionOrder: Number(r.execution_order),
    randomizationSeed: r.randomization_seed === null || r.randomization_seed === undefined ? null : String(r.randomization_seed),
    status: String(r.status) as BenchmarkTrialStatus,
    trialBranch: String(r.trial_branch),
    baselineCommit: String(r.baseline_commit),
    promptDigest: String(r.prompt_digest),
    workItemId: r.work_item_id === null || r.work_item_id === undefined ? null : String(r.work_item_id),
    executionId: r.execution_id === null || r.execution_id === undefined ? null : String(r.execution_id),
    agentRunId: r.agent_run_id === null || r.agent_run_id === undefined ? null : String(r.agent_run_id),
    pullRequestAssociationId: r.pull_request_association_id === null || r.pull_request_association_id === undefined ? null : String(r.pull_request_association_id),
    workOrderId: r.work_order_id === null || r.work_order_id === undefined ? null : String(r.work_order_id),
    implementationContextId: r.implementation_context_id === null || r.implementation_context_id === undefined ? null : String(r.implementation_context_id),
    failureKind: r.failure_kind === null || r.failure_kind === undefined ? null : (String(r.failure_kind) as BenchmarkTrial['failureKind']),
    failureReason: r.failure_reason === null || r.failure_reason === undefined ? null : String(r.failure_reason),
    humanInterventionCount: Number(r.human_intervention_count ?? 0),
    interventionDurationMs: r.intervention_duration_ms === null || r.intervention_duration_ms === undefined ? null : Number(r.intervention_duration_ms),
    companionVersion: r.companion_version === null || r.companion_version === undefined ? null : String(r.companion_version),
    providerAdapterVersion: r.provider_adapter_version === null || r.provider_adapter_version === undefined ? null : String(r.provider_adapter_version),
    browser: r.browser === null || r.browser === undefined ? null : String(r.browser),
    providerSurface: r.provider_surface === null || r.provider_surface === undefined ? null : String(r.provider_surface),
    externalSessionRef: r.external_session_ref === null || r.external_session_ref === undefined ? null : String(r.external_session_ref),
    handoffIssuedAt: r.handoff_issued_at === null || r.handoff_issued_at === undefined ? null : (r.handoff_issued_at instanceof Date ? r.handoff_issued_at : new Date(String(r.handoff_issued_at))),
    handoffRedeemedAt: r.handoff_redeemed_at === null || r.handoff_redeemed_at === undefined ? null : (r.handoff_redeemed_at instanceof Date ? r.handoff_redeemed_at : new Date(String(r.handoff_redeemed_at))),
    adapterVersion: r.adapter_version === null || r.adapter_version === undefined ? null : String(r.adapter_version),
    modelConfigurationVersion: r.model_configuration_version === null || r.model_configuration_version === undefined ? null : String(r.model_configuration_version),
    startedAt: r.started_at === null || r.started_at === undefined ? null : (r.started_at instanceof Date ? r.started_at : new Date(String(r.started_at))),
    completedAt: r.completed_at === null || r.completed_at === undefined ? null : (r.completed_at instanceof Date ? r.completed_at : new Date(String(r.completed_at))),
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
    updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(String(r.updated_at)),
  };
}

function toMetrics(r: Row): BenchmarkTrialMetrics {
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const b = (v: unknown): boolean | null => (v === null || v === undefined ? null : Boolean(v));
  const d = (v: unknown): Date | null => (v === null || v === undefined ? null : (v instanceof Date ? v : new Date(String(v))));
  return {
    trialId: String(r.trial_id),
    queueTimeMs: n(r.queue_time_ms),
    startLatencyMs: n(r.start_latency_ms),
    executionDurationMs: n(r.execution_duration_ms),
    filesChanged: n(r.files_changed),
    linesAdded: n(r.lines_added),
    linesDeleted: n(r.lines_deleted),
    commits: n(r.commits),
    pullRequests: n(r.pull_requests),
    ciRuns: n(r.ci_runs),
    ciFailures: n(r.ci_failures),
    ciFirstPass: b(r.ci_first_pass),
    totalCiDurationMs: n(r.total_ci_duration_ms),
    ciFailureCategories: (r.ci_failure_categories ?? null) as Record<string, number> | null,
    verificationRuns: n(r.verification_runs),
    criteriaPassed: n(r.criteria_passed),
    criteriaFailed: n(r.criteria_failed),
    verificationFirstPass: b(r.verification_first_pass),
    finalPass: b(r.final_pass),
    totalCriteria: n(r.total_criteria),
    reviewCount: n(r.review_count),
    requestChangesCount: n(r.request_changes_count),
    approvalCount: n(r.approval_count),
    severityCounts: (r.severity_counts ?? null) as Record<string, number> | null,
    correctionCycles: n(r.correction_cycles),
    agentRuns: n(r.agent_runs),
    timeToPrMs: n(r.time_to_pr_ms),
    timeToApprovedMs: n(r.time_to_approved_ms),
    timeToMergedMs: n(r.time_to_merged_ms),
    timeToVerifiedMs: n(r.time_to_verified_ms),
    engineeringQualityScore: n(r.engineering_quality_score),
    scoreVersion: r.score_version === null || r.score_version === undefined ? null : String(r.score_version),
    executionStartedAt: d(r.execution_started_at),
    executionCompletedAt: d(r.execution_completed_at),
    prCreatedAt: d(r.pr_created_at),
    ciStartedAt: d(r.ci_started_at),
    ciCompletedAt: d(r.ci_completed_at),
    verificationStartedAt: d(r.verification_started_at),
    verificationCompletedAt: d(r.verification_completed_at),
    reviewStartedAt: d(r.review_started_at),
    reviewCompletedAt: d(r.review_completed_at),
    mergedAt: d(r.merged_at),
    verifiedAt: d(r.verified_at),
    collectedAt: r.collected_at instanceof Date ? r.collected_at : new Date(String(r.collected_at)),
  };
}

function toFinding(r: Row): BenchmarkReviewFinding {
  return {
    id: String(r.id),
    trialId: String(r.trial_id),
    reviewId: r.review_id === null || r.review_id === undefined ? null : String(r.review_id),
    severity: String(r.severity) as BenchmarkReviewFinding['severity'],
    category: r.category === null || r.category === undefined ? null : String(r.category),
    file: r.file === null || r.file === undefined ? null : String(r.file),
    line: r.line === null || r.line === undefined ? null : Number(r.line),
    description: String(r.description),
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
  };
}

function toIntegrity(r: Row): BenchmarkIntegrityRecord {
  return {
    id: String(r.id),
    experimentId: String(r.experiment_id),
    snapshotHash: String(r.snapshot_hash),
    promptDigest: String(r.prompt_digest),
    baselineCommit: String(r.baseline_commit),
    scoringVersion: String(r.scoring_version),
    harnessVersion: String(r.harness_version),
    valid: Boolean(r.valid),
    validatedAt: r.validated_at instanceof Date ? r.validated_at : new Date(String(r.validated_at)),
    invalidationReason: r.invalidation_reason === null || r.invalidation_reason === undefined ? null : String(r.invalidation_reason),
  };
}

export class PgBenchmarkRepository implements BenchmarkRepository {
  constructor(
    private readonly db: DatabaseClient,
  ) {}

  // --- Snapshots (§4) ---

  async createSnapshot(input: BenchmarkSnapshotInsert): Promise<BenchmarkTaskSnapshot> {
    const { rows } = await this.db.query<Row>(
      `INSERT INTO wfos_benchmark_task_snapshots
         (organization_id, project_id, architecture_version_id, work_item_id,
          work_order_id, implementation_context_id, requirement_ids, criterion_ids,
          repository, base_commit, target_branch_prefix, prompt_digest,
          prompt_version, verification_requirements, snapshot_hash,
          harness_version, scoring_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        input.organizationId,
        input.projectId,
        input.architectureVersionId,
        input.workItemId,
        input.workOrderId,
        input.implementationContextId,
        input.requirementIds,
        input.criterionIds,
        input.repository,
        input.baseCommit,
        input.targetBranchPrefix,
        input.promptDigest,
        input.promptVersion,
        JSON.stringify(input.verificationRequirements),
        input.snapshotHash,
        input.harnessVersion,
        input.scoringVersion,
      ],
    );
    return toSnapshot(rows[0]!);
  }

  async getSnapshot(id: string): Promise<BenchmarkTaskSnapshot | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM wfos_benchmark_task_snapshots WHERE id = $1`,
      [id],
    );
    return rows[0] ? toSnapshot(rows[0]) : null;
  }

  async listSnapshots(projectId: string, opts: { limit?: number; offset?: number } = {}): Promise<{ snapshots: BenchmarkTaskSnapshot[]; total: number }> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM wfos_benchmark_task_snapshots WHERE project_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [projectId, limit, offset],
    );
    const countRes = await this.db.query<Row>(
      `SELECT COUNT(*)::int AS c FROM wfos_benchmark_task_snapshots WHERE project_id = $1`,
      [projectId],
    );
    return { snapshots: rows.map(toSnapshot), total: Number(countRes.rows[0]?.c ?? 0) };
  }

  // --- Experiments (§5) ---

  async createExperiment(input: BenchmarkExperimentInsert): Promise<BenchmarkExperiment> {
    const { rows } = await this.db.query<Row>(
      `INSERT INTO wfos_benchmark_experiments
         (organization_id, project_id, benchmark_task_snapshot_id, name,
          description, created_by, status, randomization_seed, repetitions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        input.organizationId,
        input.projectId,
        input.benchmarkTaskSnapshotId,
        input.name,
        input.description,
        input.createdBy,
        input.status,
        input.randomizationSeed,
        input.repetitions,
      ],
    );
    return toExperiment(rows[0]!);
  }

  async getExperiment(id: string): Promise<BenchmarkExperiment | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM wfos_benchmark_experiments WHERE id = $1`,
      [id],
    );
    return rows[0] ? toExperiment(rows[0]) : null;
  }

  async listExperiments(projectId: string, opts: { limit?: number; offset?: number } = {}): Promise<{ experiments: BenchmarkExperiment[]; total: number }> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM wfos_benchmark_experiments WHERE project_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [projectId, limit, offset],
    );
    const countRes = await this.db.query<Row>(
      `SELECT COUNT(*)::int AS c FROM wfos_benchmark_experiments WHERE project_id = $1`,
      [projectId],
    );
    return { experiments: rows.map(toExperiment), total: Number(countRes.rows[0]?.c ?? 0) };
  }

  async updateExperimentStatus(id: string, status: BenchmarkExperimentStatus, opts: { startedAt?: Date; completedAt?: Date } = {}): Promise<BenchmarkExperiment | null> {
    const sets: string[] = ['status = $2'];
    const params: unknown[] = [id, status];
    let i = 3;
    if (opts.startedAt !== undefined) { sets.push(`started_at = $${i++}`); params.push(opts.startedAt); }
    if (opts.completedAt !== undefined) { sets.push(`completed_at = $${i++}`); params.push(opts.completedAt); }
    const { rows } = await this.db.query<Row>(
      `UPDATE wfos_benchmark_experiments SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    return rows[0] ? toExperiment(rows[0]) : null;
  }

  // --- Trials (§5, §6) ---

  async createTrial(input: BenchmarkTrialInsert): Promise<BenchmarkTrial> {
    const { rows } = await this.db.query<Row>(
      `INSERT INTO wfos_benchmark_trials
         (experiment_id, benchmark_task_snapshot_id, organization_id, project_id,
          provider, model, execution_mode, repetition_index, execution_order,
          randomization_seed, status, trial_branch, baseline_commit, prompt_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        input.experimentId,
        input.benchmarkTaskSnapshotId,
        input.organizationId,
        input.projectId,
        input.provider,
        input.model,
        input.executionMode,
        input.repetitionIndex,
        input.executionOrder,
        input.randomizationSeed,
        input.status,
        input.trialBranch,
        input.baselineCommit,
        input.promptDigest,
      ],
    );
    return toTrial(rows[0]!);
  }

  async getTrial(id: string): Promise<BenchmarkTrial | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM wfos_benchmark_trials WHERE id = $1`,
      [id],
    );
    return rows[0] ? toTrial(rows[0]) : null;
  }

  async listTrials(experimentId: string, opts: { limit?: number; offset?: number } = {}): Promise<{ trials: BenchmarkTrial[]; total: number }> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM wfos_benchmark_trials WHERE experiment_id = $1
       ORDER BY execution_order ASC LIMIT $2 OFFSET $3`,
      [experimentId, limit, offset],
    );
    const countRes = await this.db.query<Row>(
      `SELECT COUNT(*)::int AS c FROM wfos_benchmark_trials WHERE experiment_id = $1`,
      [experimentId],
    );
    return { trials: rows.map(toTrial), total: Number(countRes.rows[0]?.c ?? 0) };
  }

  async listTrialsByExperiment(experimentId: string): Promise<BenchmarkTrial[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM wfos_benchmark_trials WHERE experiment_id = $1
       ORDER BY execution_order ASC`,
      [experimentId],
    );
    return rows.map(toTrial);
  }

  /**
   * PR #35 review fix v2 / Blocker A: find every trial pointing at a given
   * external executionId (called by `advanceTrialsForExecution` off the
   * `onExecutionTerminal` composition hook). executionId is globally
   * unique → at most a handful of trials match (typically one).
   */
  async listTrialsByExecutionId(executionId: string): Promise<BenchmarkTrial[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM wfos_benchmark_trials WHERE execution_id = $1`,
      [executionId],
    );
    return rows.map(toTrial);
  }

  /**
   * PR #35 review fix v2 / Blocker B: find every trial pointing at a given
   * cloned workItemId (called by `advanceTrialsForWorkItem` off the
   * `onTransition` composition hook). workItemId is the trial's CLONE — a
   * fresh work item per trial → at most one trial matches.
   */
  async listTrialsByWorkItem(workItemId: string): Promise<BenchmarkTrial[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM wfos_benchmark_trials WHERE work_item_id = $1`,
      [workItemId],
    );
    return rows.map(toTrial);
  }

  async updateTrial(id: string, patch: BenchmarkTrialPatch): Promise<BenchmarkTrial | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    let i = 2;
    const map: [string, unknown | undefined][] = [
      ['status', patch.status],
      ['work_item_id', patch.workItemId],
      ['execution_id', patch.executionId],
      ['agent_run_id', patch.agentRunId],
      ['pull_request_association_id', patch.pullRequestAssociationId],
      ['work_order_id', patch.workOrderId],
      ['implementation_context_id', patch.implementationContextId],
      ['failure_kind', patch.failureKind],
      ['failure_reason', patch.failureReason],
      ['human_intervention_count', patch.humanInterventionCount],
      ['intervention_duration_ms', patch.interventionDurationMs],
      ['companion_version', patch.companionVersion],
      ['provider_adapter_version', patch.providerAdapterVersion],
      ['browser', patch.browser],
      ['provider_surface', patch.providerSurface],
      ['external_session_ref', patch.externalSessionRef],
      ['handoff_issued_at', patch.handoffIssuedAt],
      ['handoff_redeemed_at', patch.handoffRedeemedAt],
      ['adapter_version', patch.adapterVersion],
      ['model_configuration_version', patch.modelConfigurationVersion],
      ['started_at', patch.startedAt],
      ['completed_at', patch.completedAt],
    ];
    for (const [col, val] of map) {
      if (val !== undefined) {
        sets.push(`${col} = $${i++}`);
        params.push(val);
      }
    }
    if (sets.length === 0) {
      const { rows } = await this.db.query<Row>(`SELECT * FROM wfos_benchmark_trials WHERE id = $1`, [id]);
      return rows[0] ? toTrial(rows[0]) : null;
    }
    const { rows } = await this.db.query<Row>(
      `UPDATE wfos_benchmark_trials SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    return rows[0] ? toTrial(rows[0]) : null;
  }

  async countByCell(experimentId: string): Promise<{ provider: string; mode: 'native' | 'external'; count: number }[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT provider, execution_mode AS mode, COUNT(*)::int AS count
       FROM wfos_benchmark_trials WHERE experiment_id = $1
       GROUP BY provider, execution_mode`,
      [experimentId],
    );
    return rows.map((r) => ({
      provider: String(r.provider),
      mode: String(r.mode) as 'native' | 'external',
      count: Number(r.count),
    }));
  }

  // --- Metrics (§10) ---

  async upsertMetrics(metrics: BenchmarkTrialMetricsInsert): Promise<BenchmarkTrialMetrics> {
    const cols: string[] = ['trial_id'];
    const vals: unknown[] = [metrics.trialId];
    const ph: string[] = ['$1'];
    let i = 2;
    const m = (col: string, val: unknown | undefined) => {
      if (val !== undefined) {
        cols.push(col);
        vals.push(val);
        ph.push(`$${i++}`);
      }
    };
    m('queue_time_ms', metrics.queueTimeMs);
    m('start_latency_ms', metrics.startLatencyMs);
    m('execution_duration_ms', metrics.executionDurationMs);
    m('files_changed', metrics.filesChanged);
    m('lines_added', metrics.linesAdded);
    m('lines_deleted', metrics.linesDeleted);
    m('commits', metrics.commits);
    m('pull_requests', metrics.pullRequests);
    m('ci_runs', metrics.ciRuns);
    m('ci_failures', metrics.ciFailures);
    m('ci_first_pass', metrics.ciFirstPass);
    m('total_ci_duration_ms', metrics.totalCiDurationMs);
    m('ci_failure_categories', metrics.ciFailureCategories ? JSON.stringify(metrics.ciFailureCategories) : undefined);
    m('verification_runs', metrics.verificationRuns);
    m('criteria_passed', metrics.criteriaPassed);
    m('criteria_failed', metrics.criteriaFailed);
    m('verification_first_pass', metrics.verificationFirstPass);
    m('final_pass', metrics.finalPass);
    m('total_criteria', metrics.totalCriteria);
    m('review_count', metrics.reviewCount);
    m('request_changes_count', metrics.requestChangesCount);
    m('approval_count', metrics.approvalCount);
    m('severity_counts', metrics.severityCounts ? JSON.stringify(metrics.severityCounts) : undefined);
    m('correction_cycles', metrics.correctionCycles);
    m('agent_runs', metrics.agentRuns);
    m('time_to_pr_ms', metrics.timeToPrMs);
    m('time_to_approved_ms', metrics.timeToApprovedMs);
    m('time_to_merged_ms', metrics.timeToMergedMs);
    m('time_to_verified_ms', metrics.timeToVerifiedMs);
    m('engineering_quality_score', metrics.engineeringQualityScore);
    m('score_version', metrics.scoreVersion);
    m('execution_started_at', metrics.executionStartedAt);
    m('execution_completed_at', metrics.executionCompletedAt);
    m('pr_created_at', metrics.prCreatedAt);
    m('ci_started_at', metrics.ciStartedAt);
    m('ci_completed_at', metrics.ciCompletedAt);
    m('verification_started_at', metrics.verificationStartedAt);
    m('verification_completed_at', metrics.verificationCompletedAt);
    m('review_started_at', metrics.reviewStartedAt);
    m('review_completed_at', metrics.reviewCompletedAt);
    m('merged_at', metrics.mergedAt);
    m('verified_at', metrics.verifiedAt);

    // Build ON CONFLICT (trial_id) DO UPDATE for all non-key columns.
    const updateCols = cols.slice(1); // exclude trial_id
    const updateSet = updateCols.length > 0
      ? ', ' + updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')
      : '';
    const { rows } = await this.db.query<Row>(
      `INSERT INTO wfos_benchmark_trial_metrics (${cols.join(', ')})
       VALUES (${ph.join(', ')})
       ON CONFLICT (trial_id) DO UPDATE SET collected_at = NOW()${updateSet}
       RETURNING *`,
      vals,
    );
    return toMetrics(rows[0]!);
  }

  async getMetrics(trialId: string): Promise<BenchmarkTrialMetrics | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM wfos_benchmark_trial_metrics WHERE trial_id = $1`,
      [trialId],
    );
    return rows[0] ? toMetrics(rows[0]) : null;
  }

  // --- Review findings (§13) ---

  async insertFinding(input: BenchmarkReviewFindingInsert): Promise<BenchmarkReviewFinding> {
    const { rows } = await this.db.query<Row>(
      `INSERT INTO wfos_benchmark_review_findings
         (trial_id, review_id, severity, category, file, line, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.trialId, input.reviewId, input.severity, input.category, input.file, input.line, input.description],
    );
    return toFinding(rows[0]!);
  }

  async listFindings(trialId: string): Promise<BenchmarkReviewFinding[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM wfos_benchmark_review_findings WHERE trial_id = $1
       ORDER BY created_at ASC`,
      [trialId],
    );
    return rows.map(toFinding);
  }

  // --- Integrity (§32) ---

  async upsertIntegrity(input: BenchmarkIntegrityInsert): Promise<BenchmarkIntegrityRecord> {
    const { rows } = await this.db.query<Row>(
      `INSERT INTO wfos_benchmark_integrity
         (experiment_id, snapshot_hash, prompt_digest, baseline_commit,
          scoring_version, harness_version, valid, validated_at)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,NOW())
       ON CONFLICT (experiment_id) DO UPDATE SET
         snapshot_hash = EXCLUDED.snapshot_hash,
         prompt_digest = EXCLUDED.prompt_digest,
         baseline_commit = EXCLUDED.baseline_commit,
         scoring_version = EXCLUDED.scoring_version,
         harness_version = EXCLUDED.harness_version,
         valid = TRUE,
         validated_at = NOW(),
         invalidation_reason = NULL
       RETURNING *`,
      [input.experimentId, input.snapshotHash, input.promptDigest, input.baselineCommit, input.scoringVersion, input.harnessVersion],
    );
    return toIntegrity(rows[0]!);
  }

  async getIntegrity(experimentId: string): Promise<BenchmarkIntegrityRecord | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM wfos_benchmark_integrity WHERE experiment_id = $1`,
      [experimentId],
    );
    return rows[0] ? toIntegrity(rows[0]) : null;
  }

  async invalidateIntegrity(experimentId: string, reason: string): Promise<BenchmarkIntegrityRecord | null> {
    const { rows } = await this.db.query<Row>(
      `UPDATE wfos_benchmark_integrity SET valid = FALSE, invalidation_reason = $2, validated_at = NOW()
       WHERE experiment_id = $1 RETURNING *`,
      [experimentId, reason],
    );
    return rows[0] ? toIntegrity(rows[0]) : null;
  }
}
