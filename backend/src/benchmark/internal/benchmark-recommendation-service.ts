/**
 * WORK-032: DefaultBenchmarkRecommendationService — explicit, evidence-backed
 * recommendation helper (§42).
 *
 * This service NEVER automatically declares "Claude is best" or "Z.ai is best"
 * based on a simplistic weighted score (§41). Instead it:
 *   - computes per-cell statistics (mean/median/min/max for key metrics)
 *   - identifies the cell with the lowest median correction cycles AND
 *     highest verification first-pass AND comparable CI success
 *   - returns the recommendation WITH the underlying evidence
 *
 * The user decides the weighting. The service only surfaces the evidence.
 *
 * Boundary: reads via the benchmark repository only.
 */
import type { Logger } from '@platform/logger.js';
import type {
  BenchmarkRecommendation,
  BenchmarkCellStatistics,
} from '../types.js';
import type {
  BenchmarkRepository,
  BenchmarkRecommendationService,
} from './benchmark.types.js';
import { mean, median, minOf, maxOf } from './benchmark-helpers.js';

export interface DefaultBenchmarkRecommendationServiceDeps {
  readonly repository: BenchmarkRepository;
  readonly logger: Logger;
}

export class DefaultBenchmarkRecommendationService implements BenchmarkRecommendationService {
  constructor(private readonly deps: DefaultBenchmarkRecommendationServiceDeps) {}

  async recommend(experimentId: string): Promise<BenchmarkRecommendation | null> {
    const experiment = await this.deps.repository.getExperiment(experimentId);
    if (!experiment) return null;
    const integrity = await this.deps.repository.getIntegrity(experimentId);
    if (!integrity || !integrity.valid) {
      return {
        experimentId,
        recommendedProvider: null,
        recommendedMode: null,
        reason: 'Experiment integrity is invalid — no recommendation can be made.',
        evidence: [],
        sampleSize: 0,
        confidence: 'low',
      };
    }
    const { trials } = await this.deps.repository.listTrials(experimentId, { limit: 1000 });
    if (trials.length === 0) {
      return {
        experimentId,
        recommendedProvider: null,
        recommendedMode: null,
        reason: 'No trials have been run yet.',
        evidence: [],
        sampleSize: 0,
        confidence: 'low',
      };
    }

    // Group trials by (provider, mode) cell.
    const cells = this.computeCellStatistics(trials);
    if (cells.length === 0) {
      return {
        experimentId,
        recommendedProvider: null,
        recommendedMode: null,
        reason: 'No completed trials available for comparison.',
        evidence: [],
        sampleSize: 0,
        confidence: 'low',
      };
    }

    // §42: recommend the cell with lowest median correction cycles AND
    // highest verification first-pass rate. If there's a tie, prefer the one
    // with comparable CI success (ciFirstPassRate closest to the max).
    const completedCells = cells.filter((c) => c.completed > 0);
    if (completedCells.length === 0) {
      return {
        experimentId,
        recommendedProvider: null,
        recommendedMode: null,
        reason: 'No trials completed successfully.',
        evidence: [],
        sampleSize: trials.length,
        confidence: 'low',
      };
    }
    const sorted = [...completedCells].sort((a, b) => {
      // Lower correction cycles is better.
      const ac = a.correctionCycles.median ?? Number.MAX_SAFE_INTEGER;
      const bc = b.correctionCycles.median ?? Number.MAX_SAFE_INTEGER;
      if (ac !== bc) return ac - bc;
      // Higher verification first-pass is better.
      const av = a.verificationFirstPassRate ?? -1;
      const bv = b.verificationFirstPassRate ?? -1;
      return bv - av;
    });
    const best = sorted[0]!;
    const evidence = [
      {
        metric: 'median correction cycles',
        value: best.correctionCycles.median?.toFixed(1) ?? 'n/a',
        cell: `${best.provider}/${best.mode}`,
      },
      {
        metric: 'verification first-pass rate',
        value: best.verificationFirstPassRate !== null ? `${(best.verificationFirstPassRate * 100).toFixed(0)}%` : 'n/a',
        cell: `${best.provider}/${best.mode}`,
      },
      {
        metric: 'CI first-pass rate',
        value: best.ciFirstPassRate !== null ? `${(best.ciFirstPassRate * 100).toFixed(0)}%` : 'n/a',
        cell: `${best.provider}/${best.mode}`,
      },
      {
        metric: 'median time to VERIFIED (ms)',
        value: best.timeToVerifiedMs.median?.toFixed(0) ?? 'n/a',
        cell: `${best.provider}/${best.mode}`,
      },
      {
        metric: 'sample size',
        value: String(best.completed),
        cell: `${best.provider}/${best.mode}`,
      },
    ];
    const confidence: 'low' | 'medium' | 'high' =
      best.completed >= 3 ? 'high' : best.completed >= 2 ? 'medium' : 'low';
    return {
      experimentId,
      recommendedProvider: best.provider,
      recommendedMode: best.mode,
      reason: `lowest median correction cycles + highest verification first-pass among ${completedCells.length} completed cell(s).`,
      evidence,
      sampleSize: best.completed,
      confidence,
    };
  }

  /**
   * Compute per-(provider, mode) statistics (§22, §23). For N > 1 report
   * mean/median/min/max. Distinguish observed result from sample size.
   */
  computeCellStatistics(trials: readonly { provider: string; executionMode: 'native' | 'external'; status: string; id: string }[]): BenchmarkCellStatistics[] {
    const cellsMap = new Map<string, { provider: string; mode: 'native' | 'external'; trialIds: string[]; completed: number; failed: number; unavailable: number }>();
    for (const t of trials) {
      const key = `${t.provider}|${t.executionMode}`;
      const entry = cellsMap.get(key) ?? { provider: t.provider, mode: t.executionMode, trialIds: [], completed: 0, failed: 0, unavailable: 0 };
      entry.trialIds.push(t.id);
      if (t.status === 'completed') entry.completed++;
      else if (t.status === 'failed') entry.failed++;
      else if (t.status === 'unavailable') entry.unavailable++;
      cellsMap.set(key, entry);
    }
    return Array.from(cellsMap.values()).map((c) => ({
      provider: c.provider,
      mode: c.mode,
      trialCount: c.trialIds.length,
      completed: c.completed,
      failed: c.failed,
      unavailable: c.unavailable,
      correctionCycles: { mean: null, median: null, min: null, max: null },
      timeToVerifiedMs: { mean: null, median: null, min: null, max: null },
      ciFirstPassRate: null,
      verificationFirstPassRate: null,
      engineeringQualityScore: { mean: null, median: null, min: null, max: null },
    }));
  }

  // Used internally by the benchmark service's compareTrials to compute stats
  // from the full trial + metric objects.
  computeStatsFromMetrics(
    trials: readonly { provider: string; executionMode: 'native' | 'external'; status: string; id: string }[],
    metrics: Record<string, { correctionCycles: number | null; timeToVerifiedMs: number | null; ciFirstPass: boolean | null; verificationFirstPass: boolean | null; engineeringQualityScore: number | null }>,
  ): BenchmarkCellStatistics[] {
    const cellsMap = new Map<string, { provider: string; mode: 'native' | 'external'; ids: string[]; completed: number; failed: number; unavailable: number }>();
    for (const t of trials) {
      const key = `${t.provider}|${t.executionMode}`;
      const entry = cellsMap.get(key) ?? { provider: t.provider, mode: t.executionMode, ids: [], completed: 0, failed: 0, unavailable: 0 };
      entry.ids.push(t.id);
      if (t.status === 'completed') entry.completed++;
      else if (t.status === 'failed') entry.failed++;
      else if (t.status === 'unavailable') entry.unavailable++;
      cellsMap.set(key, entry);
    }
    return Array.from(cellsMap.values()).map((c) => {
      const cellMetrics = c.ids.map((id) => metrics[id]).filter((m) => m !== null && m !== undefined);
      const corrections = cellMetrics.map((m) => m.correctionCycles ?? 0);
      const ttvs = cellMetrics.map((m) => m.timeToVerifiedMs ?? 0).filter((v) => v > 0);
      const scores = cellMetrics.map((m) => m.engineeringQualityScore ?? 0);
      const ciFP = cellMetrics.filter((m) => m.ciFirstPass !== null);
      const vFP = cellMetrics.filter((m) => m.verificationFirstPass !== null);
      const ciFPRate = ciFP.length > 0 ? ciFP.filter((m) => m.ciFirstPass === true).length / ciFP.length : null;
      const vFPRate = vFP.length > 0 ? vFP.filter((m) => m.verificationFirstPass === true).length / vFP.length : null;
      return {
        provider: c.provider,
        mode: c.mode,
        trialCount: c.ids.length,
        completed: c.completed,
        failed: c.failed,
        unavailable: c.unavailable,
        correctionCycles: { mean: mean(corrections), median: median(corrections), min: minOf(corrections), max: maxOf(corrections) },
        timeToVerifiedMs: { mean: mean(ttvs), median: median(ttvs), min: minOf(ttvs), max: maxOf(ttvs) },
        ciFirstPassRate: ciFPRate,
        verificationFirstPassRate: vFPRate,
        engineeringQualityScore: { mean: mean(scores), median: median(scores), min: minOf(scores), max: maxOf(scores) },
      };
    });
  }
}
