/**
 * WORK-032: DefaultBenchmarkExportService — exports experiment results as
 * JSON or CSV (§40).
 *
 * The exported data ALWAYS excludes (§33, §40):
 *   - credentials
 *   - callback tokens
 *   - handoff tokens
 *   - cookies
 *
 * It includes enough metadata to reproduce/inspect the experiment:
 *   - snapshot (promptDigest, baselineCommit, snapshotHash, versions)
 *   - integrity record
 *   - every trial (provider, model, mode, status, timestamps)
 *   - every trial's metrics (all metric groups)
 *   - every trial's review findings
 *
 * Boundary: reads via the benchmark repository only.
 */
import type { Logger } from '@platform/logger.js';
import type { BenchmarkExportFormat } from '../types.js';
import type {
  BenchmarkRepository,
  BenchmarkExportService,
} from './benchmark.types.js';

export interface DefaultBenchmarkExportServiceDeps {
  readonly repository: BenchmarkRepository;
  readonly logger: Logger;
}

export class DefaultBenchmarkExportService implements BenchmarkExportService {
  constructor(private readonly deps: DefaultBenchmarkExportServiceDeps) {}

  async exportExperiment(experimentId: string, format: BenchmarkExportFormat): Promise<{ contentType: string; body: string; filename: string }> {
    const experiment = await this.deps.repository.getExperiment(experimentId);
    if (!experiment) {
      throw new Error('benchmark-export-experiment-not-found');
    }
    const snapshot = await this.deps.repository.getSnapshot(experiment.benchmarkTaskSnapshotId);
    if (!snapshot) {
      throw new Error('benchmark-export-snapshot-not-found');
    }
    const integrity = await this.deps.repository.getIntegrity(experimentId);
    const { trials } = await this.deps.repository.listTrials(experimentId, { limit: 1000 });
    const trialMetrics: Record<string, unknown> = {};
    const trialFindings: Record<string, unknown> = {};
    for (const trial of trials) {
      const metrics = await this.deps.repository.getMetrics(trial.id);
      // Strip any field that could conceivably carry a credential. The
      // external_session_ref is an opaque provider-side reference (not a
      // credential) — it is safe to export because the user's own browser
      // session already holds it.
      trialMetrics[trial.id] = metrics ? this.sanitizeMetrics(metrics as unknown as Record<string, unknown>) : null;
      const findings = await this.deps.repository.listFindings(trial.id);
      trialFindings[trial.id] = findings.map((f) => ({
        severity: f.severity,
        category: f.category,
        file: f.file,
        line: f.line,
        description: f.description,
      }));
    }

    // The export payload. NEVER includes credentials/tokens/cookies.
    const payload = {
      experiment: {
        id: experiment.id,
        name: experiment.name,
        description: experiment.description,
        status: experiment.status,
        repetitions: experiment.repetitions,
        randomizationSeed: experiment.randomizationSeed,
        createdAt: experiment.createdAt.toISOString(),
        startedAt: experiment.startedAt?.toISOString() ?? null,
        completedAt: experiment.completedAt?.toISOString() ?? null,
      },
      snapshot: {
        id: snapshot.id,
        architectureVersionId: snapshot.architectureVersionId,
        workItemId: snapshot.workItemId,
        workOrderId: snapshot.workOrderId,
        repository: snapshot.repository,
        baseCommit: snapshot.baseCommit,
        promptDigest: snapshot.promptDigest,
        promptVersion: snapshot.promptVersion,
        snapshotHash: snapshot.snapshotHash,
        harnessVersion: snapshot.harnessVersion,
        scoringVersion: snapshot.scoringVersion,
        verificationRequirements: snapshot.verificationRequirements,
        createdAt: snapshot.createdAt.toISOString(),
      },
      integrity: integrity
        ? {
            valid: integrity.valid,
            validatedAt: integrity.validatedAt.toISOString(),
            invalidationReason: integrity.invalidationReason,
          }
        : null,
      trials: trials.map((t) => ({
        id: t.id,
        provider: t.provider,
        model: t.model,
        executionMode: t.executionMode,
        repetitionIndex: t.repetitionIndex,
        executionOrder: t.executionOrder,
        status: t.status,
        trialBranch: t.trialBranch,
        baselineCommit: t.baselineCommit,
        promptDigest: t.promptDigest,
        failureKind: t.failureKind,
        failureReason: t.failureReason,
        humanInterventionCount: t.humanInterventionCount,
        interventionDurationMs: t.interventionDurationMs,
        startedAt: t.startedAt?.toISOString() ?? null,
        completedAt: t.completedAt?.toISOString() ?? null,
      })),
      metrics: trialMetrics,
      findings: trialFindings,
    };

    if (format === 'json') {
      return {
        contentType: 'application/json',
        body: JSON.stringify(payload, null, 2),
        filename: `benchmark-${experiment.name.replace(/[^a-z0-9-]+/gi, '-')}-${experiment.id.slice(0, 8)}.json`,
      };
    }
    // CSV — a flat trials-only view (metrics + findings are nested; JSON is
    // the authoritative export for those).
    const header = [
      'trialId', 'provider', 'model', 'executionMode', 'repetitionIndex',
      'executionOrder', 'status', 'trialBranch', 'baselineCommit',
      'promptDigest', 'failureKind', 'humanInterventionCount',
      'correctionCycles', 'ciFirstPass', 'verificationFirstPass',
      'engineeringQualityScore', 'timeToVerifiedMs',
    ];
    const rows = [header.join(',')];
    for (const t of trials) {
      const m = (payload.metrics as Record<string, { correctionCycles?: number; ciFirstPass?: boolean; verificationFirstPass?: boolean; engineeringQualityScore?: number; timeToVerifiedMs?: number } | null>)[t.id];
      const esc = (v: unknown): string => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      rows.push([
        t.id, t.provider, t.model ?? '', t.executionMode,
        t.repetitionIndex, t.executionOrder, t.status, t.trialBranch,
        t.baselineCommit, t.promptDigest, t.failureKind ?? '',
        t.humanInterventionCount,
        m?.correctionCycles ?? '',
        m?.ciFirstPass ?? '',
        m?.verificationFirstPass ?? '',
        m?.engineeringQualityScore ?? '',
        m?.timeToVerifiedMs ?? '',
      ].map(esc).join(','));
    }
    return {
      contentType: 'text/csv',
      body: rows.join('\n'),
      filename: `benchmark-${experiment.name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}-${experiment.id.slice(0, 8)}.csv`,
    };
  }

  /**
   * Sanitize a metrics object for export. The metric row never contains
   * credentials (it's all authoritative signals), but this is a defense-in-
   * depth checkpoint that strips any field whose name matches a credential
   * pattern (§33).
   */
  private sanitizeMetrics(metrics: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(metrics)) {
      if (/(?:secret|password|token|api_?key|credential|private_?key|cookie)/i.test(k)) continue;
      out[k] = v;
    }
    return out;
  }
}
