/**
 * WORK-033 §14 — Historical performance evidence provider.
 *
 * Consumes WORK-032 benchmark evidence via the existing `BenchmarkRepository`
 * public interface (exported from @root/benchmark). Aggregates per
 * (provider, mode) cell across all experiments in a project. NEVER treats a
 * single run as definitive (§14: < INSUFFICIENT_SAMPLE = insufficient).
 *
 * Boundary: depends on the benchmark public TYPE only; the composition root
 * (app.ts) injects the concrete `PgBenchmarkRepository` instance.
 */
import type { BenchmarkRepository, BenchmarkTrial, BenchmarkTrialMetrics, BenchmarkCellStatistics } from '../../benchmark/index.js';
import type {
  HistoricalPerformance,
} from '../types.js';

const INSUFFICIENT_SAMPLE = 3;

export interface BenchmarkEvidenceProviderDeps {
  readonly benchmarkRepository: Pick<BenchmarkRepository, 'listExperiments' | 'listTrialsByExperiment' | 'getMetrics'>;
}

export class DefaultBenchmarkEvidenceProvider {
  constructor(private readonly deps: BenchmarkEvidenceProviderDeps) {}

  async historicalPerformanceForCell(
    projectId: string,
    provider: string,
    mode: 'native' | 'external',
  ): Promise<HistoricalPerformance> {
    const cells = await this.collectCells(projectId);
    const matching = cells.filter((c) => c.provider === provider && c.mode === mode);
    return aggregate(matching);
  }

  async aggregateForProject(projectId: string): Promise<HistoricalPerformance> {
    const cells = await this.collectCells(projectId);
    return aggregate(cells);
  }

  private async collectCells(projectId: string): Promise<BenchmarkCellStatistics[]> {
    const { experiments } = await this.deps.benchmarkRepository.listExperiments(projectId, { limit: 200 });
    const cellMap = new Map<string, AggCell>();
    for (const exp of experiments) {
      if (exp.status !== 'completed' && exp.status !== 'cancelled') continue;
      const trials = await this.deps.benchmarkRepository.listTrialsByExperiment(exp.id);
      for (const t of trials) {
        if (t.status !== 'completed') continue;
        const key = `${t.provider}|${t.executionMode}`;
        const cell = cellMap.get(key) ?? newAggCell(t.provider, t.executionMode);
        cell.trialCount += 1;
        const m = await this.deps.benchmarkRepository.getMetrics(t.id);
        if (m) accumulate(cell, t, m);
        cellMap.set(key, cell);
      }
    }
    return Array.from(cellMap.values()).map(finalize);
  }
}

interface AggCell {
  provider: string;
  mode: 'native' | 'external';
  trialCount: number;
  qualityScores: number[];
  ciFirstPass: boolean[];
  verifFirstPass: boolean[];
  correctionCycles: number[];
  timeToVerifiedMs: number[];
  humanIntervention: number[];
}

function newAggCell(provider: string, mode: 'native' | 'external'): AggCell {
  return { provider, mode, trialCount: 0, qualityScores: [], ciFirstPass: [], verifFirstPass: [], correctionCycles: [], timeToVerifiedMs: [], humanIntervention: [] };
}

function accumulate(cell: AggCell, _t: BenchmarkTrial, m: BenchmarkTrialMetrics): void {
  if (m.engineeringQualityScore != null) cell.qualityScores.push(m.engineeringQualityScore);
  if (m.ciFirstPass != null) cell.ciFirstPass.push(m.ciFirstPass);
  if (m.verificationFirstPass != null) cell.verifFirstPass.push(m.verificationFirstPass);
  if (m.correctionCycles != null) cell.correctionCycles.push(m.correctionCycles);
  if (m.timeToVerifiedMs != null) cell.timeToVerifiedMs.push(m.timeToVerifiedMs);
  cell.humanIntervention.push(_t.humanInterventionCount ?? 0);
}

function finalize(cell: AggCell): BenchmarkCellStatistics {
  return {
    provider: cell.provider,
    mode: cell.mode,
    trialCount: cell.trialCount,
    completed: cell.trialCount,
    failed: 0,
    unavailable: 0,
    correctionCycles: stats(cell.correctionCycles),
    timeToVerifiedMs: stats(cell.timeToVerifiedMs),
    ciFirstPassRate: rate(cell.ciFirstPass),
    verificationFirstPassRate: rate(cell.verifFirstPass),
    engineeringQualityScore: stats(cell.qualityScores),
  };
}

function stats(arr: number[]): { mean: number | null; median: number | null; min: number | null; max: number | null } {
  if (arr.length === 0) return { mean: null, median: null, min: null, max: null };
  const sorted = [...arr].sort((a, b) => a - b);
  const mean = sorted.reduce((n, x) => n + x, 0) / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)] ?? null;
  return { mean, median, min: sorted[0] ?? null, max: sorted[sorted.length - 1] ?? null };
}

function rate(arr: boolean[]): number | null {
  if (arr.length === 0) return null;
  return arr.filter(Boolean).length / arr.length;
}

function aggregate(cells: BenchmarkCellStatistics[]): HistoricalPerformance {
  if (cells.length === 0) {
    return { sampleSize: 0, sufficient: false, observedQuality: null, ciFirstPassRate: null, verificationFirstPassRate: null, medianCorrectionCycles: null, medianTimeToVerifiedMs: null, humanInterventionCount: null, evidenceCells: [] };
  }
  const sampleSize = cells.reduce((n, c) => n + c.trialCount, 0);
  const qualities: number[] = [];
  const ciRates: number[] = [];
  const verifRates: number[] = [];
  const corrections: number[] = [];
  const ttvs: number[] = [];
  const interventions: number[] = [];
  for (const c of cells) {
    if (c.engineeringQualityScore.mean != null) qualities.push(c.engineeringQualityScore.mean);
    if (c.ciFirstPassRate != null) ciRates.push(c.ciFirstPassRate);
    if (c.verificationFirstPassRate != null) verifRates.push(c.verificationFirstPassRate);
    if (c.correctionCycles.median != null) corrections.push(c.correctionCycles.median);
    if (c.timeToVerifiedMs.median != null) ttvs.push(c.timeToVerifiedMs.median);
  }
  const mean = (xs: number[]) => xs.length === 0 ? null : xs.reduce((n, x) => n + x, 0) / xs.length;
  const median = (xs: number[]) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? null;
  };
  return {
    sampleSize,
    sufficient: sampleSize >= INSUFFICIENT_SAMPLE,
    observedQuality: mean(qualities),
    ciFirstPassRate: mean(ciRates),
    verificationFirstPassRate: mean(verifRates),
    medianCorrectionCycles: median(corrections),
    medianTimeToVerifiedMs: median(ttvs),
    humanInterventionCount: interventions.length === 0 ? null : interventions.reduce((n, x) => n + x, 0),
    evidenceCells: cells,
  };
}
