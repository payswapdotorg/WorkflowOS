/**
 * WORK-032: DefaultBenchmarkService — the application-layer orchestrator that
 * ties together snapshot, experiment, trial, metrics, integrity, export, and
 * recommendation (§8).
 *
 * This service:
 *   - freezes snapshots (via the snapshot service)
 *   - creates experiments + trials (§5)
 *   - starts/pauses/cancels experiments (§45)
 *   - runs trials (via the trial orchestrator) — delegates to ExecutionService
 *   - collects metrics after trial completion (via the metric collector)
 *   - records integrity (§32)
 *   - exports results (§40)
 *   - recommends (§42)
 *
 * It does NOT create another workflow/verification/review/CI engine (§34).
 * It reads authoritative state through the existing public contracts.
 *
 * Boundary: imports the benchmark internal services + @modules/* barrels.
 */
import type {
  BenchmarkTaskSnapshot,
  BenchmarkExperiment,
  BenchmarkTrial,
  BenchmarkTrialMetrics,
  BenchmarkReviewFinding,
  BenchmarkIntegrityRecord,
  BenchmarkComparison,
  BenchmarkSnapshotPreview,
  BenchmarkExportFormat,
  BenchmarkRecommendation,
  BenchmarkCellStatistics,
  CreateBenchmarkSnapshotInput,
  CreateBenchmarkExperimentInput,
  BenchmarkTrialSpec,
  BenchmarkService,
} from '../types.js';
import type {
  DefaultBenchmarkServiceDeps,
} from './benchmark.types.js';
import {
  BENCHMARK_HARNESS_VERSION,
  BENCHMARK_SCORING_VERSION,
  buildTrialBranchName,
} from './benchmark-helpers.js';

export class DefaultBenchmarkService implements BenchmarkService {
  constructor(private readonly deps: DefaultBenchmarkServiceDeps) {}

  // --- Snapshots (§4) ---

  async previewSnapshot(input: { projectId: string; workItemId: string }): Promise<BenchmarkSnapshotPreview> {
    return this.deps.snapshotService.preview(input);
  }

  async createSnapshot(input: CreateBenchmarkSnapshotInput): Promise<BenchmarkTaskSnapshot> {
    const snapshot = await this.deps.snapshotService.create(input);
    await this.deps.auditService.write({
      projectId: snapshot.projectId,
      eventType: 'BENCHMARK_SNAPSHOT_CREATED',
      actor: input.name,
      source: 'benchmark-service',
      resourceType: 'benchmark_snapshot',
      resourceId: snapshot.id,
      metadata: { name: input.name, promptDigest: snapshot.promptDigest, baseCommit: snapshot.baseCommit },
    });
    return snapshot;
  }

  async listSnapshots(projectId: string, opts: { limit?: number; offset?: number } = {}): Promise<{ snapshots: BenchmarkTaskSnapshot[]; total: number }> {
    return this.deps.repository.listSnapshots(projectId, opts);
  }

  async getSnapshot(snapshotId: string): Promise<BenchmarkTaskSnapshot | null> {
    return this.deps.repository.getSnapshot(snapshotId);
  }

  // --- Experiments (§5) ---

  async createExperiment(input: CreateBenchmarkExperimentInput): Promise<BenchmarkExperiment> {
    const snapshot = await this.deps.repository.getSnapshot(input.benchmarkTaskSnapshotId);
    if (!snapshot) {
      throw new Error('benchmark-experiment-snapshot-not-found');
    }
    if (snapshot.projectId !== input.projectId) {
      throw new Error('benchmark-experiment-project-mismatch');
    }

    // Validate trial specs (§2 provider matrix, §19 model configuration).
    const seenCells = new Set<string>();
    for (const spec of input.trials) {
      const key = `${spec.provider}|${spec.model ?? ''}|${spec.mode}`;
      if (seenCells.has(key)) {
        throw new Error(`benchmark-experiment-duplicate-trial-spec: ${key}`);
      }
      seenCells.add(key);
    }

    // §21: optional trial ordering randomization.
    const randomizationSeed = input.randomizeOrder
      ? (input.randomizationSeed ?? crypto.randomUUID())
      : null;
    const repetitions = input.repetitions ?? 1;

    const experiment = await this.deps.repository.createExperiment({
      organizationId: snapshot.organizationId,
      projectId: snapshot.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name: input.name,
      description: input.description ?? null,
      createdBy: input.createdBy,
      status: 'created',
      randomizationSeed,
      repetitions,
    });

    // §32: record the integrity record at creation time.
    await this.deps.integrityService.record({
      experimentId: experiment.id,
      snapshotHash: snapshot.snapshotHash,
      promptDigest: snapshot.promptDigest,
      baselineCommit: snapshot.baseCommit,
      scoringVersion: snapshot.scoringVersion,
      harnessVersion: snapshot.harnessVersion,
    });

    // Create the trial rows (queued) — one per (provider, mode, repetition).
    // The execution order is assigned now (randomized if requested).
    const expandedSpecs = this.expandTrialSpecs(input.trials, repetitions);
    const orderedSpecs = randomizationSeed
      ? this.shuffle(expandedSpecs, randomizationSeed)
      : expandedSpecs;

    for (let i = 0; i < orderedSpecs.length; i++) {
      const spec = orderedSpecs[i]!;
      const trialBranch = buildTrialBranchName({
        targetBranchPrefix: snapshot.targetBranchPrefix,
        provider: spec.provider,
        mode: spec.mode,
        repetition: spec.repetition,
      });
      await this.deps.repository.createTrial({
        experimentId: experiment.id,
        benchmarkTaskSnapshotId: snapshot.id,
        organizationId: snapshot.organizationId,
        projectId: snapshot.projectId,
        provider: spec.provider,
        model: spec.model ?? null,
        executionMode: spec.mode,
        repetitionIndex: spec.repetition,
        executionOrder: i,
        randomizationSeed,
        status: 'queued',
        trialBranch,
        baselineCommit: snapshot.baseCommit,
        promptDigest: snapshot.promptDigest,
      });
    }

    await this.deps.auditService.write({
      projectId: snapshot.projectId,
      eventType: 'BENCHMARK_CREATED',
      actor: input.createdBy,
      source: 'benchmark-service',
      resourceType: 'benchmark_experiment',
      resourceId: experiment.id,
      metadata: { name: input.name, trialCount: orderedSpecs.length, repetitions },
    });

    return experiment;
  }

  async startExperiment(experimentId: string): Promise<BenchmarkExperiment> {
    const experiment = await this.deps.repository.getExperiment(experimentId);
    if (!experiment) throw new Error('benchmark-experiment-not-found');
    if (experiment.status !== 'created' && experiment.status !== 'paused') {
      throw new Error(`benchmark-experiment-invalid-state: ${experiment.status}`);
    }
    await this.deps.repository.updateExperimentStatus(experimentId, 'running', { startedAt: experiment.startedAt ?? new Date() });
    await this.deps.auditService.write({
      projectId: experiment.projectId,
      eventType: 'BENCHMARK_STARTED',
      actor: 'system',
      source: 'benchmark-service',
      resourceType: 'benchmark_experiment',
      resourceId: experimentId,
      metadata: {},
    });
    // Run all queued trials sequentially. In production this would be a
    // background job; for the MVP it runs inline.
    const { trials } = await this.deps.repository.listTrials(experimentId, { limit: 1000 });
    for (const trial of trials) {
      if (trial.status !== 'queued') continue;
      try {
        const completed = await this.deps.trialOrchestrator.runTrial(trial);
        // Collect metrics after the trial completes (or fails).
        const metrics = await this.deps.metricCollector.collect(completed);
        await this.deps.repository.upsertMetrics(metrics);
        const findings = await this.deps.metricCollector.collectFindings(completed);
        for (const f of findings) {
          await this.deps.repository.insertFinding(f);
        }
        await this.deps.auditService.write({
          projectId: trial.projectId,
          eventType: completed.status === 'completed' ? 'TRIAL_COMPLETED' : completed.status === 'failed' ? 'TRIAL_FAILED' : 'TRIAL_RUNNING',
          actor: 'benchmark-orchestrator',
          source: 'benchmark-service',
          resourceType: 'benchmark_trial',
          resourceId: trial.id,
          metadata: { status: completed.status, provider: trial.provider, mode: trial.executionMode },
        });
      } catch (err) {
        await this.deps.repository.updateTrial(trial.id, {
          status: 'failed',
          failureKind: 'infrastructure',
          failureReason: (err as Error).message,
          completedAt: new Date(),
        });
        await this.deps.auditService.write({
          projectId: trial.projectId,
          eventType: 'TRIAL_FAILED',
          actor: 'benchmark-orchestrator',
          source: 'benchmark-service',
          resourceType: 'benchmark_trial',
          resourceId: trial.id,
          metadata: { error: (err as Error).message },
        });
      }
    }
    // Re-validate integrity after all trials.
    await this.deps.integrityService.validate(experimentId);
    const finalExperiment = await this.deps.repository.updateExperimentStatus(experimentId, 'completed', { completedAt: new Date() });
    await this.deps.auditService.write({
      projectId: experiment.projectId,
      eventType: 'BENCHMARK_COMPLETED',
      actor: 'system',
      source: 'benchmark-service',
      resourceType: 'benchmark_experiment',
      resourceId: experimentId,
      metadata: {},
    });
    return finalExperiment ?? experiment;
  }

  async pauseExperiment(experimentId: string): Promise<BenchmarkExperiment> {
    const updated = await this.deps.repository.updateExperimentStatus(experimentId, 'paused');
    if (!updated) throw new Error('benchmark-experiment-not-found');
    await this.deps.auditService.write({
      projectId: updated.projectId,
      eventType: 'BENCHMARK_PAUSED',
      actor: 'system',
      source: 'benchmark-service',
      resourceType: 'benchmark_experiment',
      resourceId: experimentId,
      metadata: {},
    });
    return updated;
  }

  async cancelExperiment(experimentId: string): Promise<BenchmarkExperiment> {
    const updated = await this.deps.repository.updateExperimentStatus(experimentId, 'cancelled', { completedAt: new Date() });
    if (!updated) throw new Error('benchmark-experiment-not-found');
    await this.deps.auditService.write({
      projectId: updated.projectId,
      eventType: 'BENCHMARK_CANCELLED',
      actor: 'system',
      source: 'benchmark-service',
      resourceType: 'benchmark_experiment',
      resourceId: experimentId,
      metadata: {},
    });
    return updated;
  }

  async listExperiments(projectId: string, opts: { limit?: number; offset?: number } = {}): Promise<{ experiments: BenchmarkExperiment[]; total: number }> {
    return this.deps.repository.listExperiments(projectId, opts);
  }

  async getExperiment(experimentId: string): Promise<BenchmarkExperiment | null> {
    return this.deps.repository.getExperiment(experimentId);
  }

  async listTrials(experimentId: string, opts: { limit?: number; offset?: number } = {}): Promise<{ trials: BenchmarkTrial[]; total: number }> {
    return this.deps.repository.listTrials(experimentId, opts);
  }

  async getTrial(trialId: string): Promise<BenchmarkTrial | null> {
    return this.deps.repository.getTrial(trialId);
  }

  async getTrialMetrics(trialId: string): Promise<BenchmarkTrialMetrics | null> {
    return this.deps.repository.getMetrics(trialId);
  }

  async listTrialFindings(trialId: string): Promise<BenchmarkReviewFinding[]> {
    return this.deps.repository.listFindings(trialId);
  }

  async compareTrials(trialIds: readonly string[]): Promise<BenchmarkComparison> {
    if (trialIds.length < 2) {
      throw new Error('benchmark-comparison-requires-at-least-two-trials');
    }
    const trials: BenchmarkTrial[] = [];
    const metrics: Record<string, BenchmarkTrialMetrics> = {};
    for (const id of trialIds) {
      const trial = await this.deps.repository.getTrial(id);
      if (!trial) throw new Error(`benchmark-trial-not-found: ${id}`);
      trials.push(trial);
      const m = await this.deps.repository.getMetrics(id);
      if (m) metrics[id] = m;
    }
    // §27: prompt digest equality.
    const digestSet = new Set(trials.map((t) => t.promptDigest));
    // §28: baseline commit equality.
    const commitSet = new Set(trials.map((t) => t.baselineCommit));
    // §29: snapshot equality.
    const snapshotSet = new Set(trials.map((t) => t.benchmarkTaskSnapshotId));
    const integrityValid = digestSet.size === 1 && commitSet.size === 1 && snapshotSet.size === 1;

    // Compute per-cell statistics (§22, §23).
    const recService = this.deps.recommendationService as unknown as { computeStatsFromMetrics(trials: { provider: string; executionMode: 'native' | 'external'; status: string; id: string }[], metrics: Record<string, { correctionCycles: number | null; timeToVerifiedMs: number | null; ciFirstPass: boolean | null; verificationFirstPass: boolean | null; engineeringQualityScore: number | null }>): BenchmarkCellStatistics[] };
    const cells = recService.computeStatsFromMetrics(
      trials.map((t) => ({ provider: t.provider, executionMode: t.executionMode, status: t.status, id: t.id })),
      Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, {
        correctionCycles: v.correctionCycles,
        timeToVerifiedMs: v.timeToVerifiedMs,
        ciFirstPass: v.ciFirstPass,
        verificationFirstPass: v.verificationFirstPass,
        engineeringQualityScore: v.engineeringQualityScore,
      }])),
    );

    return {
      benchmarkTaskSnapshotId: trials[0]!.benchmarkTaskSnapshotId,
      promptDigest: trials[0]!.promptDigest,
      baselineCommit: trials[0]!.baselineCommit,
      trials,
      metrics,
      cells,
      integrityValid,
    };
  }

  async getIntegrity(experimentId: string): Promise<BenchmarkIntegrityRecord | null> {
    return this.deps.integrityService.get(experimentId);
  }

  async exportExperiment(experimentId: string, format: BenchmarkExportFormat): Promise<{ contentType: string; body: string; filename: string }> {
    return this.deps.exportService.exportExperiment(experimentId, format);
  }

  async recommend(experimentId: string): Promise<BenchmarkRecommendation | null> {
    return this.deps.recommendationService.recommend(experimentId);
  }

  // --- Helpers ---

  private expandTrialSpecs(specs: readonly BenchmarkTrialSpec[], repetitions: number): Array<BenchmarkTrialSpec & { repetition: number }> {
    const out: Array<BenchmarkTrialSpec & { repetition: number }> = [];
    for (const spec of specs) {
      const reps = spec.repetitions > 0 ? spec.repetitions : repetitions;
      for (let i = 0; i < reps; i++) {
        out.push({ ...spec, repetition: i });
      }
    }
    return out;
  }

  /**
   * Deterministic Fisher–Yates shuffle seeded by a string seed (§21). The
   * same seed always produces the same order — reproducibility (§20).
   */
  private shuffle<T>(arr: readonly T[], seed: string): T[] {
    const out = [...arr];
    let s = 0;
    for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    // xorshift32 for deterministic pseudo-randomness
    const rand = () => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 0xFFFFFFFF;
    };
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

/** Re-exported for the barrel + tests. */
export { BENCHMARK_HARNESS_VERSION, BENCHMARK_SCORING_VERSION };
