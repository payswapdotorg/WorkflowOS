/**
 * WORK-033 §13/§16/§19 — ExecutionRecommendationService.
 *
 * ORDER (§13, per the PR #37 review's required revision):
 *
 *   hard constraints → ELIGIBILITY (§3, upstream hard filter)
 *     → eligible candidates
 *       → benchmark evidence (the DOMINANT axis)
 *       → cost / latency
 *       → user preferences (advisory tie-breaker — NEVER a hard filter)
 *         → RECOMMENDATION
 *
 * Only ELIGIBLE candidates reach this service. §12 preferences
 * (preferredMode / externalPreferred / nativePreferred / weights) are
 * RANKING inputs ONLY (preferenceComponent + normalizeWeights) — they
 * never exclude a candidate (the PR #37 review fix removed the
 * preference→allowedModes leak from the hard constraint set).
 *
 * CAPABILITY CEILING INVARIANT (§13, §21):
 *   The recommendation engine MUST preserve the capability ceiling. Claude's
 *   observedQuality is NOT lowered to "normalize" against Qwen. Each provider
 *   operates at its full appropriate capability. Equalization is forbidden
 *   outside CONTROLLED_COMPARISON mode (which the policy layer enforces
 *   separately via BenchmarkPolicy.toolPolicy).
 *
 *   Concretely: the quality component uses the RAW observed quality (scaled
 *   to [0,1]); it is never mathematically reduced to equalize outcomes. The
 *   cost/latency/preference components add bounded adjustments; quality
 *   remains the dominant axis (weight ≥ 0.5 after normalization).
 *
 * FAIL-CLOSED INTERPLAY: an unknown cost under an active cost cap (or an
 * unknown/over-cap latency under an active latency cap) makes a candidate
 * INELIGIBLE upstream (§3) — so the neutral 0.5 components below are only
 * reachable when NO cap is active (neutral is honest exactly then).
 */
import type {
  ExecutionCandidateInput,
  ExecutionPreferenceProfile,
  ExecutionRecommendationService,
  HistoricalPerformance,
  RankInput,
  RankResult,
  RecommendationReason,
  RecommendationWhy,
  BenchmarkPolicy,
  ExecutionTaskProfile,
} from '../types.js';

const NEUTRAL_QUALITY = 50;   // §14: insufficient sample → neutral prior (no fabrication)
const MAX_LATENCY_MS = 1000 * 60 * 60; // 1h cap for normalization
const PREFERENCE_BOOST = 0.05;          // small; NEVER overrides capability

export class DefaultExecutionRecommendationService implements ExecutionRecommendationService {
  rank(input: RankInput): RankResult {
    const { eligibleCandidates, preferences, policy, taskProfile } = input;
    if (eligibleCandidates.length === 0) {
      return {
        ranked: [],
        recommended: null,
        why: {
          recommendedCandidateId: null,
          headline: 'No eligible execution strategy.',
          reasons: [{ dimension: 'hard_eligibility', satisfied: false, detail: 'Every candidate failed at least one hard constraint.' }],
          alternatives: [],
        },
      };
    }

    // §12 normalize preference weights (default to quality-dominant).
    const w = normalizeWeights(preferences);

    const scored = eligibleCandidates.map((c) => {
      const q = qualityComponent(c.historicalPerformance);
      const cost = costComponent(c, policy);
      const latency = latencyComponent(c, policy);
      const pref = preferenceComponent(c, preferences);
      const score = q * w.quality + cost * w.cost + latency * w.latency + pref * w.privacy;
      return { candidate: c, score: clamp01(score), components: { q, cost, latency, pref } };
    });

    // §13 preserve capability ceiling: sort by score DESC; ties broken by
    // raw quality (never reduced). The recommended candidate is the top.
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return rawQuality(b.candidate.historicalPerformance) - rawQuality(a.candidate.historicalPerformance);
    });

    const recommended = scored[0]?.candidate ?? null;
    const why = buildWhy(recommended, scored, preferences, policy, taskProfile);

    return {
      ranked: scored.map((s) => ({ candidate: s.candidate, score: s.score })),
      recommended,
      why,
    };
  }
}

function qualityComponent(h: HistoricalPerformance): number {
  // §13/§14: use raw observed quality. NEVER reduced to equalize. Neutral
  // prior (0.5) when sample insufficient — NO fabrication.
  if (!h.sufficient || h.observedQuality == null) return NEUTRAL_QUALITY / 100;
  return clamp01(h.observedQuality / 100);
}

function rawQuality(h: HistoricalPerformance): number {
  if (!h.sufficient || h.observedQuality == null) return NEUTRAL_QUALITY;
  return h.observedQuality;
}

function costComponent(c: ExecutionCandidateInput, policy: BenchmarkPolicy): number {
  // Lower cost = higher component. Over budget → 0.
  const cost = c.estimatedCost.cents;
  const cap = policy.maxCostCents;
  if (cost == null) return 0.5;       // unknown → neutral (§24)
  if (cap == null || cap <= 0) return 1; // no budget constraint
  if (cost > cap) return 0;
  return clamp01(1 - cost / cap);
}

function latencyComponent(c: ExecutionCandidateInput, policy: BenchmarkPolicy): number {
  const lat = c.estimatedLatency.estimatedMs;
  const cap = policy.maxDurationMs;
  if (lat == null) return 0.5;
  if (cap != null && lat > cap) return 0;
  return clamp01(1 - lat / MAX_LATENCY_MS);
}

function preferenceComponent(c: ExecutionCandidateInput, p: ExecutionPreferenceProfile): number {
  let v = 0;
  if (p.preferredMode && c.executionMode === p.preferredMode) v += PREFERENCE_BOOST;
  if (p.externalPreferred && c.executionMode === 'external') v += PREFERENCE_BOOST;
  if (p.nativePreferred && c.executionMode === 'native') v += PREFERENCE_BOOST;
  return clamp01(v);
}

function normalizeWeights(p: ExecutionPreferenceProfile): {
  quality: number; cost: number; latency: number; privacy: number;
} {
  const sum = p.quality + p.cost + p.latency + p.privacy;
  if (sum <= 0) return { quality: 0.6, cost: 0.2, latency: 0.1, privacy: 0.1 };
  // §13: quality weight is floored at 0.5 to preserve the capability ceiling
  // (cost/latency/preferences must NOT dominate quality).
  const q = Math.max(0.5, p.quality / sum);
  const remainder = 1 - q;
  const othersSum = p.cost + p.latency + p.privacy;
  if (othersSum <= 0) return { quality: q, cost: 0, latency: 0, privacy: 0 };
  return {
    quality: q,
    cost: (p.cost / othersSum) * remainder,
    latency: (p.latency / othersSum) * remainder,
    privacy: (p.privacy / othersSum) * remainder,
  };
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function buildWhy(
  recommended: ExecutionCandidateInput | null,
  scored: readonly { candidate: ExecutionCandidateInput; score: number; components: { q: number; cost: number; latency: number; pref: number } }[],
  _preferences: ExecutionPreferenceProfile,
  policy: BenchmarkPolicy,
  taskProfile: ExecutionTaskProfile,
): RecommendationWhy {
  if (!recommended) {
    return {
      recommendedCandidateId: null,
      headline: 'No eligible execution strategy.',
      reasons: [{ dimension: 'hard_eligibility', satisfied: false, detail: 'Every candidate failed at least one hard constraint.' }],
      alternatives: [],
    };
  }
  const top = scored[0];
  const reasons: RecommendationReason[] = [
    { dimension: 'hard_eligibility', satisfied: true, detail: 'Passed all hard constraints (capability, subscription, policy, privacy).' },
    { dimension: 'user_project_org_policy', satisfied: true, detail: `Benchmark mode: ${policy.benchmarkMode}; policy v${policy.policyVersion}.` },
    { dimension: 'required_capability', satisfied: true, detail: taskProfile.requiredCapabilities.length === 0 ? 'No special capability required.' : `Provides required capabilities: ${taskProfile.requiredCapabilities.join(', ')}.` },
    {
      dimension: 'benchmark_evidence',
      satisfied: recommended.historicalPerformance.sufficient,
      detail: recommended.historicalPerformance.sufficient
        ? `Observed quality ${recommended.historicalPerformance.observedQuality?.toFixed(1) ?? '—'} over ${recommended.historicalPerformance.sampleSize} trial(s).`
        : 'Insufficient benchmark sample (neutral prior; no fabrication).',
    },
    { dimension: 'cost', satisfied: recommended.estimatedCost.confidence !== 'unknown', detail: costDetail(recommended.estimatedCost.cents, recommended.estimatedCost.confidence) },
    { dimension: 'latency', satisfied: recommended.estimatedLatency.source !== 'unknown', detail: latencyDetail(recommended.estimatedLatency.estimatedMs, recommended.estimatedLatency.source) },
    { dimension: 'user_preferences', satisfied: true, detail: `Recommendation score ${(top?.score ?? 0).toFixed(3)} (quality-weighted; capability ceiling preserved).` },
  ];
  const alternatives = scored.slice(1).map((s) => s.candidate.provider);
  return {
    recommendedCandidateId: recommended.provider,
    headline: `Recommended: ${recommended.name} (${recommended.executionMode})`,
    reasons,
    alternatives,
  };
}

function costDetail(cents: number | null, confidence: string): string {
  if (cents == null) return 'Cost unknown.';
  const dollars = (cents / 100).toFixed(2);
  return `Estimated cost $${dollars} (${confidence}).`;
}
function latencyDetail(ms: number | null, source: string): string {
  if (ms == null) return 'Latency unknown.';
  return `Estimated latency ${Math.round(ms / 1000)}s (${source}).`;
}
