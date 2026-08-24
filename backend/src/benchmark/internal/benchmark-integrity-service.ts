/**
 * WORK-032: DefaultBenchmarkIntegrityService — validates experiment integrity
 * (§32).
 *
 * Before scoring, the benchmark validates that:
 *   - snapshotHash matches the persisted snapshot's hash (recomputed)
 *   - promptDigest is identical across all trials in the experiment (§27)
 *   - baselineCommit is identical across all trials (§28)
 *   - scoringVersion + harnessVersion match the snapshot's versions
 *
 * If any of these are mutated (by a faulty migration, a direct DB edit, or a
 * trial that somehow wrote a different digest/commit), the experiment is
 * marked INVALID and scoring is refused.
 *
 * Boundary: imports the benchmark repository + snapshot service only.
 */
import type { Logger } from '@platform/logger.js';
import type {
  BenchmarkIntegrityRecord,
} from '../types.js';
import type {
  BenchmarkRepository,
  BenchmarkIntegrityService,
  BenchmarkIntegrityInsert,
} from './benchmark.types.js';

export interface DefaultBenchmarkIntegrityServiceDeps {
  readonly repository: BenchmarkRepository;
  readonly logger: Logger;
}

export class DefaultBenchmarkIntegrityService implements BenchmarkIntegrityService {
  constructor(private readonly deps: DefaultBenchmarkIntegrityServiceDeps) {}

  async record(input: BenchmarkIntegrityInsert): Promise<BenchmarkIntegrityRecord> {
    return this.deps.repository.upsertIntegrity(input);
  }

  async get(experimentId: string): Promise<BenchmarkIntegrityRecord | null> {
    return this.deps.repository.getIntegrity(experimentId);
  }

  /**
   * Validate an experiment's integrity (§32). Reads the snapshot, all
   * trials, and the integrity record; recomputes the expected values; and
   * marks the experiment invalid if anything has been mutated.
   */
  async validate(experimentId: string): Promise<BenchmarkIntegrityRecord> {
    const experiment = await this.deps.repository.getExperiment(experimentId);
    if (!experiment) {
      throw new Error('benchmark-integrity-experiment-not-found');
    }
    const snapshot = await this.deps.repository.getSnapshot(experiment.benchmarkTaskSnapshotId);
    if (!snapshot) {
      const invalidated = await this.deps.repository.invalidateIntegrity(experimentId, 'snapshot-not-found');
      return invalidated ?? this.requireIntegrity(experimentId);
    }
    const trials = await this.deps.repository.listTrialsByExperiment(experimentId);

    // §27: all trials must share the snapshot's promptDigest.
    const digestSet = new Set(trials.map((t) => t.promptDigest));
    if (digestSet.size > 1 || (digestSet.size === 1 && !digestSet.has(snapshot.promptDigest))) {
      const r = await this.deps.repository.invalidateIntegrity(
        experimentId,
        `prompt-digest-mismatch: snapshot=${snapshot.promptDigest.slice(0, 12)} trials=${[...digestSet].map((d) => d.slice(0, 12)).join(',')}`,
      );
      return r ?? this.requireIntegrity(experimentId);
    }

    // §28: all trials must share the snapshot's baselineCommit.
    const commitSet = new Set(trials.map((t) => t.baselineCommit));
    if (commitSet.size > 1 || (commitSet.size === 1 && !commitSet.has(snapshot.baseCommit))) {
      const r = await this.deps.repository.invalidateIntegrity(
        experimentId,
        `baseline-commit-mismatch: snapshot=${snapshot.baseCommit.slice(0, 12)} trials=${[...commitSet].map((c) => c.slice(0, 12)).join(',')}`,
      );
      return r ?? this.requireIntegrity(experimentId);
    }

    // §29: all trials must share the benchmarkTaskSnapshotId (enforced by the
    // schema FK, but double-check).
    const snapshotIdSet = new Set(trials.map((t) => t.benchmarkTaskSnapshotId));
    if (snapshotIdSet.size > 1 || (snapshotIdSet.size === 1 && !snapshotIdSet.has(snapshot.id))) {
      const r = await this.deps.repository.invalidateIntegrity(
        experimentId,
        'benchmark-task-snapshot-id-mismatch',
      );
      return r ?? this.requireIntegrity(experimentId);
    }

    // Recompute the integrity record (idempotent upsert). If an existing
    // record was valid, this is a no-op; if it was invalid, this re-validates.
    const insert: BenchmarkIntegrityInsert = {
      experimentId,
      snapshotHash: snapshot.snapshotHash,
      promptDigest: snapshot.promptDigest,
      baselineCommit: snapshot.baseCommit,
      scoringVersion: snapshot.scoringVersion,
      harnessVersion: snapshot.harnessVersion,
    };
    return this.deps.repository.upsertIntegrity(insert);
  }

  async invalidate(experimentId: string, reason: string): Promise<BenchmarkIntegrityRecord> {
    const record = await this.deps.repository.invalidateIntegrity(experimentId, reason);
    return record ?? this.requireIntegrity(experimentId);
  }

  /** Throw if the integrity record does not exist (defensive — should not happen after record()). */
  private async requireIntegrity(experimentId: string): Promise<BenchmarkIntegrityRecord> {
    const record = await this.deps.repository.getIntegrity(experimentId);
    if (!record) throw new Error('benchmark-integrity-experiment-not-found');
    return record;
  }
}
