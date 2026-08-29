/**
 * WORK-047 — the PURE intelligence ranking over the routing result's
 * ALREADY-ELIGIBLE candidates (no I/O; fully deterministic).
 *
 * THE AUTHORITY MODEL (spec/work-orders/WORK-047.md — W047-AC01/AC02):
 *
 *   - The input is the WORK-044 routing result: the ranked ELIGIBLE set (the
 *     ranking seam REJECTS any candidate whose carried WORK-043 verdict is
 *     not eligible — an ineligible candidate can never be scored; defense in
 *     depth mirroring the W044-AC01/W044-AC11 seam) plus the excluded
 *     candidates with the AUTHORITY's blocking reasons (carried verbatim).
 *   - The routing score is CONSUMED as a component — never recomputed,
 *     never weakened; the routing authority's order stays visible on every
 *     ranked row (`routingRank`).
 *   - The ONLY new signal is the observed execution history (terminal
 *     outcomes per (provider, model, mode) from the EXISTING wfos_executions
 *     store) — a signal WORK-044 does not consume.
 *
 * THE SCORING (documented, deterministic):
 *
 *   intelligenceScore = ROUTING_WEIGHT × routingScore
 *                     + HISTORY_WEIGHT × historicalSuccessComponent
 *
 *   with ROUTING_WEIGHT = 0.6, HISTORY_WEIGHT = 0.4. The historical
 *   component is the observed cell success rate when the sample is
 *   sufficient, the NEUTRAL PRIOR (0.5) when there is no observed evidence,
 *   and the OBSERVED rate (with an `insufficient` status + explicit
 *   uncertainty in the provenance) when 0 < sample < INSUFFICIENT_SAMPLE —
 *   the rate is never fabricated, and insufficient evidence is never
 *   presented as definitive (§14 precedent).
 *
 * THE TIE-BREAK CHAIN (a total order — W044-AC14 pattern):
 *   1. intelligenceScore desc
 *   2. routingScore desc (the routing authority dominates ties)
 *   3. lexicographic (provider, model, executionMode) asc
 *
 * Stale evidence is surfaced (the observation window rides every signal and
   every evidence contribution); the scoring is recency-independent, so the
 * same evidence always produces the same score.
 */

import type { ExecutionEligibilityResult } from '../../execution-policy/index.js';
import type {
  RoutingCandidateIdentity,
  RoutingRankedCandidate,
} from '../../execution-routing/index.js';
import type {
  EvidenceContribution,
  ExecutionHistoryCell,
  HistoricalSuccessSignal,
  IntelligenceComponent,
  IntelligenceRankedCandidate,
  IntelligenceRejectedAlternative,
  IntelligenceScoreComponents,
} from '../types.js';
import { AgentIntelligenceError } from '../types.js';

// ============================================================================
// The documented constants (deterministic; pinned by static invariants)
// ============================================================================

/** The weight of the consumed WORK-044 routing score in the composite. */
export const ROUTING_WEIGHT = 0.6;
/** The weight of the observed execution-history success component. */
export const HISTORY_WEIGHT = 0.4;
/** The neutral prior applied when NO evidence exists for a cell (never fabricated). */
export const NEUTRAL_PRIOR = 0.5;
/** §14 precedent: a sample below this is never definitive. */
export const INSUFFICIENT_SAMPLE = 3;

// ============================================================================
// Evidence-cell lookup (pure; null-safe model matching)
// ============================================================================

/**
 * The execution-history cell key: `provider/model/mode` (model `_null_`
 * when absent — external executions legitimately carry no model).
 */
export function executionCellKey(provider: string, model: string | null, mode: 'native' | 'external'): string {
  return `${provider}/${model ?? '_null_'}/${mode}`;
}

/** Find the observed execution-history cell for a candidate identity (null when unobserved). */
export function findExecutionCell(
  cells: readonly ExecutionHistoryCell[],
  identity: RoutingCandidateIdentity,
): ExecutionHistoryCell | null {
  return cells.find(
    (c) =>
      c.provider === identity.provider &&
      c.mode === identity.executionMode &&
      c.model === (identity.model || null),
  ) ?? null;
}

/** Derive the observed historical-success signal from a cell (null cell → insufficient). */
export function deriveHistoricalSignal(cell: ExecutionHistoryCell | null): HistoricalSuccessSignal {
  if (!cell || cell.attempts <= 0) {
    return { successRate: null, sampleSize: cell?.attempts ?? 0, sufficient: false, lastObservedAt: cell?.lastObservedAt ?? null };
  }
  return {
    successRate: cell.successRate,
    sampleSize: cell.attempts,
    sufficient: cell.attempts >= INSUFFICIENT_SAMPLE,
    lastObservedAt: cell.lastObservedAt,
  };
}

// ============================================================================
// Signal validation (fail-closed — W047-AC03 + the invalid-signal seam)
// ============================================================================

/** Validate an evidence cell (fail-closed on NaN / negative / out-of-range values). */
export function validateExecutionCell(cell: ExecutionHistoryCell): void {
  if (!Number.isFinite(cell.attempts) || cell.attempts < 0) {
    throw new AgentIntelligenceError(
      'agent-intelligence-invalid-signal',
      `execution-history cell ${executionCellKey(cell.provider, cell.model, cell.mode)} carries an invalid attempts value (${cell.attempts})`,
    );
  }
  if (cell.succeeded < 0 || cell.failed < 0 || cell.succeeded + cell.failed !== cell.attempts) {
    throw new AgentIntelligenceError(
      'agent-intelligence-invalid-signal',
      `execution-history cell ${executionCellKey(cell.provider, cell.model, cell.mode)} is inconsistent (attempts ${cell.attempts} ≠ succeeded ${cell.succeeded} + failed ${cell.failed})`,
    );
  }
  if (cell.successRate !== null && (!Number.isFinite(cell.successRate) || cell.successRate < 0 || cell.successRate > 1)) {
    throw new AgentIntelligenceError(
      'agent-intelligence-invalid-signal',
      `execution-history cell ${executionCellKey(cell.provider, cell.model, cell.mode)} carries an out-of-range success rate (${cell.successRate})`,
    );
  }
}

// ============================================================================
// THE ELIGIBILITY SEAM (W047-AC02 — defense in depth)
// ============================================================================

/**
 * The fail-closed eligibility seam: every candidate entering the
 * intelligence ranking MUST carry an ELIGIBLE WORK-043 verdict. An
 * ineligible candidate is REJECTED with a typed error — it can never be
 * scored, ranked, or recommended (structurally unreachable on the public
 * path, where the input is the router's eligible ranked set; the seam
 * exists so the guarantee does not depend on the caller's discipline).
 */
export function assertEligibleAtSeam(candidate: { eligibility: ExecutionEligibilityResult; identity: RoutingCandidateIdentity }): void {
  if (!candidate.eligibility.eligible || candidate.eligibility.status !== 'eligible') {
    throw new AgentIntelligenceError(
      'agent-intelligence-ineligible-candidate',
      `candidate ${candidate.identity.provider}/${candidate.identity.model}/${candidate.identity.executionMode} carries a non-eligible WORK-043 verdict (${candidate.eligibility.status}) — an ineligible candidate can never be scored by the intelligence layer`,
    );
  }
}

// ============================================================================
// THE COMPOSITE (pure)
// ============================================================================

/** Compute the historical component from an observed signal (never fabricates). */
export function historicalComponent(signal: HistoricalSuccessSignal): IntelligenceComponent {
  if (signal.successRate === null) {
    // No observed evidence: the documented NEUTRAL PRIOR (explicitly insufficient).
    return { value: NEUTRAL_PRIOR, status: 'insufficient' };
  }
  if (signal.sampleSize < INSUFFICIENT_SAMPLE) {
    // Observed but thin: the OBSERVED rate is used honestly with an explicit
    // insufficient status (never presented as definitive; §14 precedent).
    return { value: signal.successRate, status: 'insufficient' };
  }
  return { value: signal.successRate, status: 'observed' };
}

/** The composite intelligence score (both components in [0,1] → score in [0,1]). */
export function compositeScore(components: IntelligenceScoreComponents): number {
  return ROUTING_WEIGHT * components.routing.value + HISTORY_WEIGHT * components.historicalSuccess.value;
}

// ============================================================================
// THE RANKING (pure; total order)
// ============================================================================

/** The deterministic candidate comparison (the documented tie-break chain). */
export function compareIntelligenceRanked(
  a: IntelligenceRankedCandidate,
  b: IntelligenceRankedCandidate,
): number {
  if (a.score !== b.score) return b.score - a.score;                 // 1. intelligence score desc
  if (a.components.routing.value !== b.components.routing.value) {
    return b.components.routing.value - a.components.routing.value;   // 2. routing authority desc
  }
  const ka = `${a.identity.provider}\u0000${a.identity.model}\u0000${a.identity.executionMode}`; // 3. lexicographic
  const kb = `${b.identity.provider}\u0000${b.identity.model}\u0000${b.identity.executionMode}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** The identity key used by the lexicographic tie-break (exported for tests/pins). */
export function identityLexicographicKey(identity: RoutingCandidateIdentity): string {
  return `${identity.provider}\u0000${identity.model}\u0000${identity.executionMode}`;
}

export interface IntelligenceRankInput {
  /** The router's ranked ELIGIBLE candidates (the authority input). */
  readonly ranked: readonly RoutingRankedCandidate[];
  /** The project-scoped observed execution history. */
  readonly executionCells: readonly ExecutionHistoryCell[];
}

export interface IntelligenceRankOutput {
  readonly ranked: readonly IntelligenceRankedCandidate[];
  readonly selected: IntelligenceRankedCandidate | null;
}

/**
 * Rank the router's already-eligible candidates with the intelligence
 * composite. Pure and deterministic: identical inputs → identical output;
 * equal evidence → the documented tie-break chain.
 */
export function rankWithIntelligence(input: IntelligenceRankInput): IntelligenceRankOutput {
  const cellByKey = new Map<string, ExecutionHistoryCell>();
  for (const cell of input.executionCells) {
    validateExecutionCell(cell);
    cellByKey.set(executionCellKey(cell.provider, cell.model, cell.mode), cell);
  }
  const rows: IntelligenceRankedCandidate[] = [];
  for (let i = 0; i < input.ranked.length; i += 1) {
    const candidate = input.ranked[i]!;
    // THE SEAM (fail-closed): an ineligible candidate can never be scored.
    assertEligibleAtSeam({ eligibility: candidate.eligibility, identity: candidate.identity });
    if (!Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 1) {
      throw new AgentIntelligenceError(
        'agent-intelligence-invalid-signal',
        `candidate ${candidate.identity.provider}/${candidate.identity.model}/${candidate.identity.executionMode} carries an invalid routing score (${candidate.score})`,
      );
    }
    const cell = cellByKey.get(executionCellKey(candidate.identity.provider, candidate.identity.model || null, candidate.identity.executionMode)) ?? null;
    const signal = deriveHistoricalSignal(cell);
    const components: IntelligenceScoreComponents = {
      routing: { value: candidate.score, status: 'observed' },
      historicalSuccess: historicalComponent(signal),
    };
    rows.push({
      identity: candidate.identity,
      score: compositeScore(components),
      components,
      historicalSignal: signal,
      eligibility: candidate.eligibility,
      routingRank: i + 1,
    });
  }
  rows.sort(compareIntelligenceRanked);
  return { ranked: rows, selected: rows[0] ?? null };
}

// ============================================================================
// The excluded picture (carried verbatim from the authority — W047-AC02)
// ============================================================================

/** Classify which authority excluded a candidate (descriptive, from the verdict). */
export function classifyExclusion(eligibility: ExecutionEligibilityResult): IntelligenceRejectedAlternative['excludedThrough'] {
  switch (eligibility.status) {
    case 'policy_blocked':
    case 'project_policy_blocked':
    case 'subscription_blocked':
    case 'privacy_blocked':
    case 'agent_policy_blocked':
    case 'quota_exhausted':
    case 'rate_limited':
    case 'security_blocked':
      return 'policy';
    case 'capability_blocked':
      return 'capability';
    default:
      return 'routing';
  }
}

/** Build the rejected-alternatives picture from the routing result's excluded set (reasons verbatim). */
export function buildRejectedAlternatives(
  excluded: readonly { identity: RoutingCandidateIdentity; eligibility: ExecutionEligibilityResult }[],
): IntelligenceRejectedAlternative[] {
  return excluded.map((e) => ({
    identity: e.identity,
    eligibility: e.eligibility,
    excludedThrough: classifyExclusion(e.eligibility),
  }));
}

// ============================================================================
// The evidence-contribution + confidence helpers (pure)
// ============================================================================

/** The evidence contribution of one execution-history cell. */
export function executionContribution(cell: ExecutionHistoryCell): EvidenceContribution {
  return {
    cell: executionCellKey(cell.provider, cell.model, cell.mode),
    kind: 'execution-history',
    attempts: cell.attempts,
    succeeded: cell.succeeded,
    successRate: cell.successRate,
    firstObservedAt: cell.firstObservedAt,
    lastObservedAt: cell.lastObservedAt,
  };
}

/**
 * The deterministic confidence of a recommendation:
 *   'high'   — the recommended candidate rests on SUFFICIENT observed history
 *   'medium' — some observed history exists (the recommended cell is thin)
 *   'low'    — no observed evidence backs the ranking at all
 */
export function confidenceOf(
  recommended: IntelligenceRankedCandidate | null,
  totalObservedAttempts: number,
): 'low' | 'medium' | 'high' {
  if (!recommended) return 'low';
  if (recommended.historicalSignal.sufficient && recommended.historicalSignal.successRate !== null) {
    return 'high';
  }
  return totalObservedAttempts > 0 ? 'medium' : 'low';
}
