/**
 * WORK-044 — the pure, deterministic ranking function (internal).
 *
 * Ranks ALREADY-ELIGIBLE candidates (W044-AC01: the input model carries the
 * authoritative WORK-043 verdict; an ineligible verdict is REJECTED here —
 * fail-closed, typed error — as defense in depth behind the public routing
 * path, which constructs ranking inputs ONLY from the consumed
 * recommendation's eligibleCandidates).
 *
 * THE DOCUMENTED RANKING METHODOLOGY (W044-AC04 — no hidden rule, no
 * provider-specific preference, no intrinsic mode bias):
 *
 *   DIMENSIONS (all normalized to [0,1]; "higher is better"):
 *     1. quality            — raw benchmark observedQuality / 100
 *                              (the DOMINANT axis, §13: NEVER reduced to
 *                              equalize providers — capability ceiling
 *                              preserved; §14: insufficient sample → the
 *                              neutral 0.5 prior, never fabricated)
 *     2. reliability        — mean of the present first-pass rates
 *                              (ciFirstPassRate, verificationFirstPassRate)
 *     3. cost               — policy-cap-anchored: clamp01(1 − cents/cap);
 *                              1.0 when no cap is active; neutral 0.5 when
 *                              the cost is unknown (§24)
 *     4. latency            — clamp01(1 − estimatedMs / 1h); neutral 0.5
 *                              when unknown (§25)
 *     5. human intervention — clamp01(1 − interventions/trials); neutral
 *                              0.5 when the evidence is absent
 *
 *   WEIGHTS (derived from the user's ADVISORY preference profile — §12;
 *   the privacy weight is deliberately NOT a routing weight: privacy is a
 *   HARD WORK-043 eligibility constraint and never re-enters as a ranking
 *   dimension):
 *     wQ = max(0.5, q/(q+c+l))       — the §13 quality floor: benchmark
 *                                      evidence dominates (≥ 0.5)
 *     rem = 1 − wQ, partitioned:
 *       reliability 0.35 · rem       — fixed documented share (no user
 *                                      weight exists for it yet)
 *       cost         0.50 · rem · c/(c+l)
 *       latency      0.50 · rem · l/(c+l)
 *       human        0.15 · rem      — fixed documented share
 *     When q+c+l ≤ 0 the documented defaults (0.6/0.2/0.2) apply.
 *
 *   PREFERENCE BOOSTS (applied AFTER evidence scoring; bounded + advisory —
 *   NEVER a filter, NEVER able to override quality dominance materially):
 *     +0.05 for each matching explicit mode signal
 *     (preferredMode === candidate mode, externalPreferred, nativePreferred)
 *
 *   TIE-BREAK CHAIN (W044-AC03/AC14 — a TOTAL order; independent of input
 *   order, object/hash iteration order, and database ordering):
 *     total score DESC → quality DESC → reliability DESC → cost DESC →
 *     latency DESC → human intervention DESC →
 *     (provider, model, executionMode) lexicographic ASC
 *
 *   FAIL-CLOSED INPUT VALIDATION (W044-AC10 — deterministic, documented):
 *     ineligible verdict → execution-routing-ineligible-candidate
 *     duplicate identity → execution-routing-duplicate-candidate
 *     invalid signal value → execution-routing-invalid-signal
 *     (The router NEVER falls back to an ineligible candidate.)
 *
 *   INSUFFICIENT EVIDENCE (W044-AC10 — the documented deterministic
 *   policy): a dimension without observed evidence takes the neutral 0.5
 *   prior and is reported with status 'insufficient'. No value is ever
 *   fabricated. Zero eligible candidates → the documented empty result
 *     (selected=null; never a fallback).
 */
import type { ExecutionMode } from '@modules/agents';
import type {
  ExecutionPreferenceProfile,
} from '../../execution-policy/index.js';
import type {
  RankingComponent,
  RoutingCandidate,
  RoutingExplanation,
  RoutingExcludedCandidate,
  RoutingRankInput,
  RoutingRankOutput,
  RoutingRankedCandidate,
  RoutingScoreComponents,
} from '../types.js';
import { ExecutionRoutingError } from '../types.js';

const NEUTRAL = 0.5;                 // the documented neutral prior
const MAX_LATENCY_MS = 1000 * 60 * 60; // 1h cap for latency normalization
const PREFERENCE_BOOST = 0.05;       // small; NEVER overrides capability (§13)
const QUALITY_FLOOR = 0.5;           // §13 — benchmark evidence dominates

// The documented non-quality partition of the routing weights.
const RELIABILITY_SHARE = 0.35;
const COST_LATENCY_SHARE = 0.50;
const HUMAN_INTERVENTION_SHARE = 0.15;

// Documented default preference weights when the profile carries none.
const DEFAULT_QUALITY_WEIGHT = 0.6;
const DEFAULT_COST_WEIGHT = 0.2;
const DEFAULT_LATENCY_WEIGHT = 0.2;

/**
 * The documented methodology text surfaced on EVERY routing explanation
 * (W044-AC04/AC09: the dimensions, weights, and tie-break chain are
 * explicit and inspectable — no hidden rule).
 */
export const ROUTING_METHODOLOGY: string = [
  'Adaptive Execution Router methodology (WORK-044, §33.3/§33.4):',
  '1. Eligibility is the authoritative WORK-043 HARD gate — only already-eligible candidates are ranked; benchmark evidence never overrides it.',
  '2. Ranking dimensions (normalized [0,1]): quality (raw benchmark observed quality — the dominant axis, never equalized), reliability (mean of CI/verification first-pass rates), cost (policy-cap anchored; neutral when unknown), latency (1h-cap normalized; neutral when unknown), human intervention (interventions per trial).',
  `3. Weights derive from the user preference profile with the §13 quality floor (quality weight ≥ ${QUALITY_FLOOR}); the privacy weight is NOT a routing weight (privacy is a hard WORK-043 constraint). Non-quality partition: reliability ${RELIABILITY_SHARE}, cost+latency ${COST_LATENCY_SHARE} (split by the user cost:latency ratio), human intervention ${HUMAN_INTERVENTION_SHARE} of the remainder.`,
  `4. A bounded advisory preference boost (+${PREFERENCE_BOOST} per matching explicit mode signal) is applied AFTER evidence scoring; preferences never filter candidates and never bypass hard constraints.`,
  '5. Deterministic tie-break chain: total score DESC, then quality DESC, reliability DESC, cost DESC, latency DESC, human intervention DESC, then the lexicographic candidate identity (provider, model, executionMode) ASC — a total order independent of input, hash, or database ordering.',
  '6. Fail-closed: an ineligible verdict, a duplicate identity, or an invalid signal is a typed deterministic error — the router never falls back to an ineligible candidate; a dimension without observed evidence takes the neutral 0.5 prior with status "insufficient" (never fabricated).',
].join('\n');

/**
 * Pure deterministic ranking over ALREADY-ELIGIBLE candidates. No I/O.
 */
export function rankEligibleCandidates(input: RoutingRankInput): RoutingRankOutput {
  const { candidates, preferences, policy, taskProfile } = input;

  // --- W044-AC01/AC10: fail-closed input validation -------------------------
  validateCandidates(candidates);

  const weights = deriveRoutingWeights(preferences);

  const scored = candidates.map((c) => {
    const quality = qualityComponent(c.quality);
    const reliability = reliabilityComponent(c.reliability);
    const cost = costComponent(c.cost, policy.maxCostCents);
    const latency = latencyComponent(c.latency);
    const human = humanInterventionComponent(c.humanIntervention);
    const preferenceBoost = preferenceBoostFor(c.identity.executionMode, preferences);
    const score = clamp01(
      quality.value * weights.quality +
      reliability.value * weights.reliability +
      cost.value * weights.cost +
      latency.value * weights.latency +
      human.value * weights.humanIntervention +
      preferenceBoost,
    );
    const components: RoutingScoreComponents = {
      quality,
      reliability,
      cost,
      latency,
      humanIntervention: human,
      preferenceBoost,
    };
    return { candidate: c, score, components };
  });

  // --- W044-AC03/AC14: the documented total-order sort ----------------------
  scored.sort(compareRanked);

  const ranked: RoutingRankedCandidate[] = scored.map((s) => ({
    identity: s.candidate.identity,
    score: s.score,
    components: s.components,
    eligibility: s.candidate.eligibility,
  }));

  const selected = ranked[0] ?? null;
  const tieBreakDecided =
    selected != null && ranked.length > 1 && ranked[1] != null && ranked[1].score === selected.score;

  const explanation = buildExplanation(selected, ranked, taskProfile, tieBreakDecided);

  return { ranked, selected, explanation };
}

// ============================================================================
// VALIDATION — fail-closed (W044-AC01/AC10)
// ============================================================================

function validateCandidates(candidates: readonly RoutingCandidate[]): void {
  const seen = new Set<string>();
  for (const c of candidates) {
    // W044-AC01 (defense in depth): the ranking seam itself refuses an
    // ineligible verdict. The public routing path cannot produce this
    // (it maps ONLY the consumed recommendation's eligibleCandidates) —
    // this guard makes the boundary STRUCTURAL, not conventional.
    if (!c.eligibility || !c.eligibility.eligible || c.eligibility.status !== 'eligible') {
      throw new ExecutionRoutingError(
        'execution-routing-ineligible-candidate',
        `execution-routing-ineligible-candidate: the candidate ${identityKey(c.identity)} carried a non-eligible WORK-043 verdict (${c.eligibility?.status ?? 'absent'}) — an ineligible candidate can never be ranked (fail-closed; the router never falls back)`,
      );
    }
    const key = identityKey(c.identity);
    if (seen.has(key)) {
      throw new ExecutionRoutingError(
        'execution-routing-duplicate-candidate',
        `execution-routing-duplicate-candidate: two candidates share the identity ${key} — inconsistent routing input (fail-closed)`,
      );
    }
    seen.add(key);
    validateSignals(c);
  }
}

function validateSignals(c: RoutingCandidate): void {
  const label = identityKey(c.identity);
  const fail = (detail: string): never => {
    throw new ExecutionRoutingError(
      'execution-routing-invalid-signal',
      `execution-routing-invalid-signal: ${detail} (${label}) — invalid ranking evidence is a typed deterministic failure, never a silent neutral (fail-closed)`,
    );
  };
  const { quality, reliability, latency, humanIntervention } = c;
  if (!Number.isFinite(quality.sampleSize) || quality.sampleSize < 0) fail('quality.sampleSize is negative or non-finite');
  if (quality.observedQuality != null && (!Number.isFinite(quality.observedQuality) || quality.observedQuality < 0 || quality.observedQuality > 100)) fail('quality.observedQuality is outside [0,100]');
  if (!Number.isFinite(reliability.sampleSize) || reliability.sampleSize < 0) fail('reliability.sampleSize is negative or non-finite');
  for (const [name, rate] of [['reliability.ciFirstPassRate', reliability.ciFirstPassRate], ['reliability.verificationFirstPassRate', reliability.verificationFirstPassRate]] as const) {
    if (rate != null && (!Number.isFinite(rate) || rate < 0 || rate > 1)) fail(`${name} is outside [0,1]`);
  }
  if (c.cost.cents != null && (!Number.isFinite(c.cost.cents) || c.cost.cents < 0)) fail('cost.cents is negative or non-finite');
  if (latency.estimatedMs != null && (!Number.isFinite(latency.estimatedMs) || latency.estimatedMs < 0)) fail('latency.estimatedMs is negative or non-finite');
  if (!Number.isFinite(humanIntervention.sampleSize) || humanIntervention.sampleSize < 0) fail('humanIntervention.sampleSize is negative or non-finite');
  if (humanIntervention.count != null && (!Number.isFinite(humanIntervention.count) || humanIntervention.count < 0)) fail('humanIntervention.count is negative or non-finite');
}

// ============================================================================
// COMPONENTS — one per documented dimension (W044-AC04)
// ============================================================================

/**
 * Dimension 1 — quality. Raw observed quality scaled to [0,1]; NEVER
 * reduced to equalize (§13). Insufficient sample → the neutral prior
 * (§14: a single trial is never definitive; nothing is fabricated).
 */
function qualityComponent(signal: RoutingCandidate['quality']): RankingComponent {
  if (!signal.sufficient || signal.observedQuality == null) {
    return { value: NEUTRAL, status: 'insufficient' };
  }
  return { value: clamp01(signal.observedQuality / 100), status: 'observed' };
}

/**
 * Dimension 2 — reliability: the mean of the PRESENT first-pass rates
 * (each already [0,1]). Insufficient sample or no rates → neutral.
 */
function reliabilityComponent(signal: RoutingCandidate['reliability']): RankingComponent {
  if (!signal.sufficient) return { value: NEUTRAL, status: 'insufficient' };
  const rates: number[] = [];
  if (signal.ciFirstPassRate != null) rates.push(signal.ciFirstPassRate);
  if (signal.verificationFirstPassRate != null) rates.push(signal.verificationFirstPassRate);
  if (rates.length === 0) return { value: NEUTRAL, status: 'insufficient' };
  const mean = rates.reduce((n, x) => n + x, 0) / rates.length;
  return { value: clamp01(mean), status: 'observed' };
}

/**
 * Dimension 3 — cost, policy-cap anchored (the WORK-033 §13 precedent):
 * lower cost = higher component; over cap = 0; no active cap = 1 for a
 * known cost; unknown cost = the neutral prior (§24 — never fabricated).
 */
function costComponent(signal: RoutingCandidate['cost'], maxCostCents: number | null): RankingComponent {
  const cents = signal.cents;
  if (cents == null) return { value: NEUTRAL, status: 'insufficient' };
  const cap = maxCostCents;
  if (cap == null || cap <= 0) return { value: 1, status: 'observed' };
  return { value: clamp01(1 - cents / cap), status: 'observed' };
}

/** Dimension 4 — latency, normalized against the 1h cap; unknown = neutral. */
function latencyComponent(signal: RoutingCandidate['latency']): RankingComponent {
  const ms = signal.estimatedMs;
  if (ms == null) return { value: NEUTRAL, status: 'insufficient' };
  return { value: clamp01(1 - ms / MAX_LATENCY_MS), status: 'observed' };
}

/**
 * Dimension 5 — human intervention: the intervention RATE over the
 * completed trials (lower is better). Absent evidence → neutral.
 */
function humanInterventionComponent(signal: RoutingCandidate['humanIntervention']): RankingComponent {
  const { count, sampleSize } = signal;
  if (count == null || sampleSize <= 0) return { value: NEUTRAL, status: 'insufficient' };
  return { value: clamp01(1 - count / sampleSize), status: 'observed' };
}

/**
 * The bounded advisory preference boost (§12): explicit mode signals only,
 * applied AFTER evidence scoring. W044-AC05: this is the ONLY place the
 * candidate's execution mode influences the score — through the caller's
 * EXPLICIT preferences, never an intrinsic router bias. Either mode may
 * win when eligible and the evidence supports it.
 */
function preferenceBoostFor(mode: ExecutionMode, p: ExecutionPreferenceProfile): number {
  let v = 0;
  if (p.preferredMode === mode) v += PREFERENCE_BOOST;
  if (p.externalPreferred && mode === 'external') v += PREFERENCE_BOOST;
  if (p.nativePreferred && mode === 'native') v += PREFERENCE_BOOST;
  return v;
}

// ============================================================================
// WEIGHTS — documented derivation from the advisory preference profile
// ============================================================================

export interface RoutingWeights {
  readonly quality: number;
  readonly reliability: number;
  readonly cost: number;
  readonly latency: number;
  readonly humanIntervention: number;
}

/**
 * Derive the routing weights from the user's preference profile:
 *   wQ = max(0.5, q/(q+c+l)) — the §13 quality floor (benchmark evidence
 *   dominates); the non-quality remainder is partitioned reliability 0.35 /
 *   (cost+latency 0.50, split by the user's cost:latency ratio) / human
 *   intervention 0.15. The PRIVACY weight is deliberately ignored — privacy
 *   is a HARD WORK-043 eligibility constraint, never a ranking dimension.
 */
export function deriveRoutingWeights(p: ExecutionPreferenceProfile): RoutingWeights {
  let q = p.quality;
  let c = p.cost;
  let l = p.latency;
  const sum = q + c + l;
  if (!Number.isFinite(sum) || sum <= 0) {
    q = DEFAULT_QUALITY_WEIGHT;
    c = DEFAULT_COST_WEIGHT;
    l = DEFAULT_LATENCY_WEIGHT;
  }
  const total = q + c + l;
  const wQ = Math.max(QUALITY_FLOOR, q / total);
  const rem = 1 - wQ;
  const cl = c + l;
  const costShare = cl > 0 ? c / cl : 0.5;
  return {
    quality: wQ,
    reliability: rem * RELIABILITY_SHARE,
    cost: rem * COST_LATENCY_SHARE * costShare,
    latency: rem * COST_LATENCY_SHARE * (1 - costShare),
    humanIntervention: rem * HUMAN_INTERVENTION_SHARE,
  };
}

// ============================================================================
// ORDER — the documented total-order tie-break chain (W044-AC03/AC14)
// ============================================================================

/**
 * The total order over scored candidates. The FINAL lexicographic
 * identity step guarantees determinism even for fully-identical evidence:
 * the order is independent of the input order, object/hash iteration
 * order, and nondeterministic database ordering.
 */
function compareRanked(
  a: { candidate: RoutingCandidate; score: number; components: RoutingScoreComponents },
  b: { candidate: RoutingCandidate; score: number; components: RoutingScoreComponents },
): number {
  if (a.score !== b.score) return b.score - a.score;
  const ca = a.components;
  const cb = b.components;
  if (ca.quality.value !== cb.quality.value) return cb.quality.value - ca.quality.value;
  if (ca.reliability.value !== cb.reliability.value) return cb.reliability.value - ca.reliability.value;
  if (ca.cost.value !== cb.cost.value) return cb.cost.value - ca.cost.value;
  if (ca.latency.value !== cb.latency.value) return cb.latency.value - ca.latency.value;
  if (ca.humanIntervention.value !== cb.humanIntervention.value) return cb.humanIntervention.value - ca.humanIntervention.value;
  return compareIdentity(a.candidate.identity, b.candidate.identity);
}

/** The lexicographic total order over candidate identities (W044-AC14). */
function compareIdentity(a: RoutingCandidate['identity'], b: RoutingCandidate['identity']): number {
  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
  if (a.model !== b.model) return a.model < b.model ? -1 : 1;
  if (a.executionMode !== b.executionMode) return a.executionMode < b.executionMode ? -1 : 1;
  return 0;
}

function identityKey(identity: RoutingCandidate['identity']): string {
  return `${identity.provider}/${identity.model}/${identity.executionMode}`;
}

// ============================================================================
// EXPLANATION — inspectable (W044-AC09)
// ============================================================================

function buildExplanation(
  selected: RoutingRankedCandidate | null,
  ranked: readonly RoutingRankedCandidate[],
  _taskProfile: RoutingRankInput['taskProfile'],
  tieBreakDecided: boolean,
): RoutingExplanation {
  const runnerUp = ranked[1] ?? null;
  let selectionReason: string;
  if (selected == null) {
    selectionReason =
      'No eligible execution candidate exists: every candidate failed at least one WORK-043 hard constraint. The router never falls back to an ineligible candidate.';
  } else if (runnerUp == null) {
    selectionReason =
      `${describeIdentity(selected)} won as the ONLY eligible candidate (passed every WORK-043 hard constraint).`;
  } else if (tieBreakDecided) {
    selectionReason =
      `${describeIdentity(selected)} won over ${describeIdentity(runnerUp)} on the documented tie-break chain (identical total score ${selected.score.toFixed(4)}; quality, reliability, cost, latency, human-intervention components equal → lexicographic identity order).`;
  } else {
    const topDims = strongestDimensions(selected);
    selectionReason =
      `${describeIdentity(selected)} won over ${describeIdentity(runnerUp)} on total score ${selected.score.toFixed(4)} vs ${runnerUp.score.toFixed(4)} (strongest signals: ${topDims}).`;
  }
  return {
    selectionReason,
    methodology: ROUTING_METHODOLOGY,
    eligibleCount: ranked.length,
    excluded: [],
    tieBreakDecided,
  };
}

/** The strongest observed dimensions of the winner (for the explanation). */
function strongestDimensions(c: RoutingRankedCandidate): string {
  const dims: { name: string; value: number }[] = [
    { name: `quality ${c.components.quality.value.toFixed(2)}${c.components.quality.status === 'insufficient' ? ' (insufficient evidence, neutral)' : ''}`, value: c.components.quality.value },
    { name: `reliability ${c.components.reliability.value.toFixed(2)}${c.components.reliability.status === 'insufficient' ? ' (insufficient evidence, neutral)' : ''}`, value: c.components.reliability.value },
    { name: `cost ${c.components.cost.value.toFixed(2)}${c.components.cost.status === 'insufficient' ? ' (unknown, neutral)' : ''}`, value: c.components.cost.value },
    { name: `latency ${c.components.latency.value.toFixed(2)}${c.components.latency.status === 'insufficient' ? ' (unknown, neutral)' : ''}`, value: c.components.latency.value },
    { name: `human-intervention ${c.components.humanIntervention.value.toFixed(2)}${c.components.humanIntervention.status === 'insufficient' ? ' (insufficient evidence, neutral)' : ''}`, value: c.components.humanIntervention.value },
  ];
  dims.sort((a, b) => b.value - a.value);
  return dims.slice(0, 2).map((d) => d.name).join(', ');
}

function describeIdentity(c: RoutingRankedCandidate): string {
  return `${c.identity.provider}/${c.identity.model} (${c.identity.executionMode})`;
}

/** The excluded-candidate view used by the router service (transparency). */
export function excludedViewOf(
  identity: RoutingCandidate['identity'],
  eligibility: RoutingCandidate['eligibility'],
): RoutingExcludedCandidate {
  return { identity, eligibility };
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
