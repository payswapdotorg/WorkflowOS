/**
 * WORK-032: shared benchmark helpers — versions, CI failure classification,
 * quality scoring, branch naming.
 *
 * Pure functions, no I/O. Deterministic. Used by the snapshot service, metric
 * collector, trial orchestrator, and integrity service.
 */
import { createHash } from 'node:crypto';

/**
 * The benchmark harness version. Bumped when the orchestration logic changes
 * in a way that affects reproducibility (§20). Persisted on every snapshot +
 * integrity record so an experiment can be inspected for which harness
 * version produced it.
 */
export const BENCHMARK_HARNESS_VERSION = 'work-032-v1';

/**
 * The quality scoring formula version (§11). Bumped when the scoring
 * function changes. NEVER tuned after seeing results in the same experiment.
 */
export const BENCHMARK_SCORING_VERSION = 'v1';

/**
 * Classify a CI run's failure into a category (§15). GitHub Actions workflow
 * names / check names are free-text, so classification is heuristic:
 *   - matches /typecheck|tsc|type-check/i → 'typecheck'
 *   - matches /lint|eslint/i → 'lint'
 *   - matches /unit/ → 'unit'
 *   - matches /integration/ → 'integration'
 *   - matches /\be2e\b|browser/ → 'E2E'
 *   - matches /build|vite|webpack|rollup/ → 'build'
 *   - matches /deploy|vercel|railway/ → 'deployment'
 *   - otherwise → 'other'
 *
 * This classification is a BENCHMARK CONCERN only — it never feeds the
 * authoritative /verification evidence pipeline. /verification reads the raw
 * CiRunEvidence.conclusion (GitHub-native) for authority.
 */
export function classifyCiFailureCategory(workflowName: string | null, checkName: string | null): string {
  const text = `${workflowName ?? ''} ${checkName ?? ''}`.toLowerCase();
  if (/typecheck|tsc|type-check/.test(text)) return 'typecheck';
  if (/lint|eslint/.test(text)) return 'lint';
  if (/unit/.test(text)) return 'unit';
  if (/integration/.test(text)) return 'integration';
  if (/\be2e\b|browser/.test(text)) return 'E2E';
  if (/build|vite|webpack|rollup/.test(text)) return 'build';
  if (/deploy|vercel|railway/.test(text)) return 'deployment';
  return 'other';
}

/**
 * The v1 engineering quality score (§11). A derived number in [0, 100] that
 * summarizes engineering outcome quality from AUTHORITATIVE signals only.
 *
 * v1 formula (frozen — do not tune after seeing results):
 *   base = 40
 *   + verificationFirstPass ? 25 : (finalPass ? 10 : 0)
 *   + ciFirstPass ? 15 : 0
 *   - correctionCycles * 8  (capped at -20)
 *   - blockerFindings * 5   (capped at -15)
 *
 * Rationale (documented, not tuned):
 *   - Verification first-pass is the strongest signal of correct work (+25).
 *   - Final pass (after corrections) is still positive but weaker (+10).
 *   - CI first-pass is a real engineering-quality signal (+15).
 *   - Each correction cycle is a meaningful cost (-8, capped).
 *   - Blocker findings are the most severe review outcome (-5, capped).
 *
 * The score NEVER replaces the underlying measurements — the dashboard always
 * shows CI first-pass rate, verification first-pass rate, correction count,
 * review findings, and time-to-VERIFIED alongside the score (§11, §41).
 */
export function computeEngineeringQualityScore(input: {
  verificationFirstPass: boolean | null;
  finalPass: boolean | null;
  ciFirstPass: boolean | null;
  correctionCycles: number | null;
  blockerFindings: number | null;
}): number {
  let score = 40;
  if (input.verificationFirstPass === true) score += 25;
  else if (input.finalPass === true) score += 10;
  if (input.ciFirstPass === true) score += 15;
  const correctionPenalty = Math.min(20, (input.correctionCycles ?? 0) * 8);
  score -= correctionPenalty;
  const blockerPenalty = Math.min(15, (input.blockerFindings ?? 0) * 5);
  score -= blockerPenalty;
  return Math.max(0, Math.min(100, score));
}

/**
 * Build the isolated trial branch name (§6). Format:
 *   <targetBranchPrefix>/<provider>-<mode>/<repetition>
 * Example:
 *   benchmark/work-001/zai-native/0
 *   benchmark/work-001/claude-external/2
 */
export function buildTrialBranchName(input: {
  targetBranchPrefix: string;
  provider: string;
  mode: 'native' | 'external';
  repetition: number;
}): string {
  const prefix = input.targetBranchPrefix.replace(/\/+$/, '');
  return `${prefix}/${input.provider}-${input.mode}/${input.repetition}`;
}

/** Compute the SHA-256 hex of a string (used for snapshot hashes). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Median of a non-empty numeric array; null if empty (§23). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/** Mean of a non-empty numeric array; null if empty (§23). */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Min of a non-empty numeric array; null if empty. */
export function minOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.min(...values);
}

/** Max of a non-empty numeric array; null if empty. */
export function maxOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(...values);
}
