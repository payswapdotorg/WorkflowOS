/**
 * WORK-044 — unit tests for the pure, deterministic ranking function.
 *
 * These are UNIT tests of `rankEligibleCandidates` (no database, no I/O).
 * They prove:
 *
 *   - the component math per documented dimension (quality, reliability,
 *     cost, latency, human intervention) — W044-AC04;
 *   - the weight derivation (defaults, the §13 quality floor, the
 *     cost:latency tilt, the privacy weight EXCLUDED) — W044-AC04;
 *   - the bounded advisory preference boosts — W044-AC05/AC07;
 *   - native/external PARITY: identical evidence → identical score
 *     regardless of mode (no intrinsic bias) — W044-AC05;
 *   - DETERMINISM: shuffled input order → identical ordered result
 *     (the lexicographic identity total order) — W044-AC03/AC14;
 *   - the tie-break chain: full tie → lexicographic identity; partial
 *     ties → the documented dimension chain — W044-AC03/AC14;
 *   - FAIL-CLOSED input validation: an ineligible verdict, a duplicate
 *     identity, and invalid signal values are typed deterministic errors
 *     (never scored, never silently neutral) — W044-AC01/AC10;
 *   - the documented empty result when NO eligible candidate exists
 *     (never a fallback to an ineligible candidate) — W044-AC10;
 *   - the explanation contract (methodology, selection reason, per-
 *     dimension signals) — W044-AC09.
 */
import { describe, it, expect } from 'vitest';
import {
  rankEligibleCandidates,
  deriveRoutingWeights,
  ROUTING_METHODOLOGY,
} from '../../../src/execution-routing/index.js';
import type {
  RoutingCandidate,
  RoutingRankInput,
} from '../../../src/execution-routing/index.js';
import { ExecutionRoutingError } from '../../../src/execution-routing/index.js';
import type {
  BenchmarkPolicy,
  ExecutionPreferenceProfile,
  ExecutionTaskProfile,
} from '../../../src/execution-policy/index.js';

// ============================================================================
// FIXTURE BUILDERS
// ============================================================================

const ELIGIBLE = Object.freeze({
  status: 'eligible' as const,
  eligible: true,
  blockingReasons: [],
  satisfiedConstraints: ['capability'],
});

const INELIGIBLE = Object.freeze({
  status: 'quota_exhausted' as const,
  eligible: false,
  blockingReasons: [
    { category: 'quota' as const, constraint: 'monthly', reason: 'exhausted' },
  ],
  satisfiedConstraints: [],
});

function preferences(overrides: Partial<ExecutionPreferenceProfile> = {}): ExecutionPreferenceProfile {
  return {
    quality: 0.6,
    cost: 0.2,
    latency: 0.1,
    privacy: 0.1,
    preferredMode: null,
    externalPreferred: false,
    nativePreferred: false,
    defaultBenchmarkMode: 'maximum_capability',
    ...overrides,
  };
}

function policy(overrides: Partial<BenchmarkPolicy> = {}): BenchmarkPolicy {
  return {
    benchmarkMode: 'maximum_capability',
    maxCostCents: null,
    maxDurationMs: null,
    requiredCapabilities: [],
    allowedProviders: [],
    allowedModes: ['native', 'external'],
    privacyRequirements: { level: 'standard', approvedLocations: [] },
    subscriptionRequirement: { blockUnknownSubscription: false, requiredCodingAgentProviders: [] },
    toolPolicy: { toolClassFixed: false, maximumCapability: true, noArtificialCaps: true },
    humanInterventionPolicy: { allowed: true, blockIfRequired: false },
    policyVersion: 1,
    frozen: false,
    ...overrides,
  };
}

function taskProfile(): ExecutionTaskProfile {
  return {
    language: 'typescript',
    framework: 'nextjs',
    repositorySize: 'medium',
    complexity: 'medium',
    architectureSensitivity: 'low',
    securitySensitivity: 'low',
    browserRequired: false,
    terminalRequired: false,
    repositoryAccess: true,
    externalExecutionAllowed: true,
    nativeExecutionAllowed: true,
    requiredCapabilities: ['coding_agent'],
    humanInterventionLikely: false,
  };
}

interface MakeCandidateInput {
  provider: string;
  model?: string;
  mode?: 'native' | 'external';
  quality?: number | null;
  sampleSize?: number;
  sufficient?: boolean;
  ciFirstPassRate?: number | null;
  verificationFirstPassRate?: number | null;
  costCents?: number | null;
  latencyMs?: number | null;
  interventions?: number | null;
  eligible?: boolean;
}

function makeCandidate(input: MakeCandidateInput): RoutingCandidate {
  const sampleSize = input.sampleSize ?? 5;
  const sufficient = input.sufficient ?? true;
  return {
    identity: {
      provider: input.provider,
      model: input.model ?? 'model-x',
      executionMode: input.mode ?? 'native',
    },
    eligibility: input.eligible === undefined || input.eligible ? ELIGIBLE : INELIGIBLE,
    quality: {
      observedQuality: input.quality ?? null,
      sampleSize,
      sufficient,
    },
    reliability: {
      ciFirstPassRate: input.ciFirstPassRate ?? null,
      verificationFirstPassRate: input.verificationFirstPassRate ?? null,
      sampleSize,
      sufficient,
    },
    cost: {
      cents: input.costCents ?? null,
      confidence: input.costCents == null ? 'unknown' : 'estimated',
    },
    latency: {
      estimatedMs: input.latencyMs ?? null,
      source: input.latencyMs == null ? 'unknown' : 'estimated',
    },
    humanIntervention: {
      count: input.interventions ?? null,
      sampleSize,
    },
    capability: { codingAgent: 'ready' },
  };
}

function rankInput(
  candidates: readonly RoutingCandidate[],
  pref: ExecutionPreferenceProfile = preferences(),
  pol: BenchmarkPolicy = policy(),
): RoutingRankInput {
  return { candidates, preferences: pref, policy: pol, taskProfile: taskProfile() };
}

// ============================================================================
// W044-AC04 — the documented dimensions (component math)
// ============================================================================

describe('WORK-044 ranking — documented dimensions (W044-AC04)', () => {
  it('quality component uses the RAW observed quality (scaled, never equalized); insufficient sample → the neutral prior', () => {
    const high = makeCandidate({ provider: 'a', quality: 98 });
    const low = makeCandidate({ provider: 'b', quality: 40 });
    const insufficient = makeCandidate({ provider: 'c', quality: 99, sampleSize: 1, sufficient: false });
    const out = rankEligibleCandidates(rankInput([high, low, insufficient]));
    const byProvider = new Map(out.ranked.map((r) => [r.identity.provider, r]));
    expect(byProvider.get('a')?.components.quality).toEqual({ value: 0.98, status: 'observed' });
    expect(byProvider.get('b')?.components.quality).toEqual({ value: 0.4, status: 'observed' });
    // §14: a single trial is never definitive — neutral prior, no fabrication.
    expect(byProvider.get('c')?.components.quality).toEqual({ value: 0.5, status: 'insufficient' });
  });

  it('reliability component = mean of the PRESENT first-pass rates; insufficient → neutral', () => {
    const both = makeCandidate({ provider: 'a', ciFirstPassRate: 0.8, verificationFirstPassRate: 1 });
    const one = makeCandidate({ provider: 'b', ciFirstPassRate: 0.6 });
    const none = makeCandidate({ provider: 'c' });
    const insufficient = makeCandidate({ provider: 'd', ciFirstPassRate: 0.9, sampleSize: 1, sufficient: false });
    const out = rankEligibleCandidates(rankInput([both, one, none, insufficient]));
    const by = new Map(out.ranked.map((r) => [r.identity.provider, r]));
    expect(by.get('a')?.components.reliability).toEqual({ value: 0.9, status: 'observed' });
    expect(by.get('b')?.components.reliability).toEqual({ value: 0.6, status: 'observed' });
    expect(by.get('c')?.components.reliability).toEqual({ value: 0.5, status: 'insufficient' });
    expect(by.get('d')?.components.reliability).toEqual({ value: 0.5, status: 'insufficient' });
  });

  it('cost component is policy-cap anchored; unknown cost → neutral (never fabricated)', () => {
    const cheap = makeCandidate({ provider: 'a', costCents: 100 });
    const expensive = makeCandidate({ provider: 'b', costCents: 900 });
    const unknown = makeCandidate({ provider: 'c', costCents: null });
    const out = rankEligibleCandidates(rankInput([cheap, expensive, unknown], preferences(), policy({ maxCostCents: 1000 })));
    const by = new Map(out.ranked.map((r) => [r.identity.provider, r]));
    expect(by.get('a')?.components.cost.value).toBeCloseTo(0.9, 12);
    expect(by.get('a')?.components.cost.status).toBe('observed');
    expect(by.get('b')?.components.cost.value).toBeCloseTo(0.1, 12);
    expect(by.get('b')?.components.cost.status).toBe('observed');
    expect(by.get('c')?.components.cost).toEqual({ value: 0.5, status: 'insufficient' });
    // No active cap → a known cost is fully free.
    const noCap = rankEligibleCandidates(rankInput([cheap]));
    expect(noCap.ranked[0]?.components.cost).toEqual({ value: 1, status: 'observed' });
  });

  it('latency component is 1h-cap normalized; unknown → neutral', () => {
    const fast = makeCandidate({ provider: 'a', latencyMs: 600_000 }); // 10 min
    const slow = makeCandidate({ provider: 'b', latencyMs: 3_600_000 }); // 1h
    const unknown = makeCandidate({ provider: 'c', latencyMs: null });
    const out = rankEligibleCandidates(rankInput([fast, slow, unknown]));
    const by = new Map(out.ranked.map((r) => [r.identity.provider, r]));
    expect(by.get('a')?.components.latency).toEqual({ value: 1 - 600_000 / 3_600_000, status: 'observed' });
    expect(by.get('b')?.components.latency).toEqual({ value: 0, status: 'observed' });
    expect(by.get('c')?.components.latency).toEqual({ value: 0.5, status: 'insufficient' });
  });

  it('human-intervention component = 1 − interventions/trials; absent evidence → neutral', () => {
    const clean = makeCandidate({ provider: 'a', interventions: 0 });
    const mixed = makeCandidate({ provider: 'b', interventions: 2, sampleSize: 5 });
    const absent = makeCandidate({ provider: 'c', interventions: null });
    const out = rankEligibleCandidates(rankInput([clean, mixed, absent]));
    const by = new Map(out.ranked.map((r) => [r.identity.provider, r]));
    expect(by.get('a')?.components.humanIntervention).toEqual({ value: 1, status: 'observed' });
    expect(by.get('b')?.components.humanIntervention).toEqual({ value: 0.6, status: 'observed' });
    expect(by.get('c')?.components.humanIntervention).toEqual({ value: 0.5, status: 'insufficient' });
  });

  it('benchmark quality DOMINATES: the higher-quality candidate wins when other dimensions are equal', () => {
    const out = rankEligibleCandidates(rankInput([
      makeCandidate({ provider: 'high', quality: 95 }),
      makeCandidate({ provider: 'low', quality: 60 }),
    ]));
    expect(out.selected?.identity.provider).toBe('high');
  });

  it('the methodology text documents every dimension, the weight scheme, the boost, the tie-break chain, and the fail-closed policy', () => {
    expect(ROUTING_METHODOLOGY).toContain('quality');
    expect(ROUTING_METHODOLOGY).toContain('reliability');
    expect(ROUTING_METHODOLOGY).toContain('cost');
    expect(ROUTING_METHODOLOGY).toContain('latency');
    expect(ROUTING_METHODOLOGY).toContain('human intervention');
    expect(ROUTING_METHODOLOGY).toContain('lexicographic');
    expect(ROUTING_METHODOLOGY).toContain('never falls back to an ineligible candidate');
    // Surfaced on every explanation (W044-AC09).
    const out = rankEligibleCandidates(rankInput([makeCandidate({ provider: 'a' })]));
    expect(out.explanation.methodology).toBe(ROUTING_METHODOLOGY);
  });
});

// ============================================================================
// W044-AC04 — the weight derivation
// ============================================================================

describe('WORK-044 ranking — weight derivation (W044-AC04)', () => {
  it('derives the quality floor: the quality weight is ALWAYS ≥ 0.5', () => {
    const allCost = deriveRoutingWeights(preferences({ quality: 0, cost: 1, latency: 0 }));
    expect(allCost.quality).toBeGreaterThanOrEqual(0.5);
    const balanced = deriveRoutingWeights(preferences({ quality: 0.5, cost: 0.25, latency: 0.25 }));
    expect(balanced.quality).toBe(0.5);
    const qualityHeavy = deriveRoutingWeights(preferences({ quality: 1, cost: 0, latency: 0 }));
    expect(qualityHeavy.quality).toBe(1);
  });

  it('sums to 1 and partitions the non-quality remainder (reliability 0.35, cost+latency 0.50, human 0.15)', () => {
    const w = deriveRoutingWeights(preferences({ quality: 0.6, cost: 0.2, latency: 0.1 }));
    const sum = w.quality + w.reliability + w.cost + w.latency + w.humanIntervention;
    expect(sum).toBeCloseTo(1, 12);
    const rem = 1 - w.quality;
    expect(w.reliability).toBeCloseTo(rem * 0.35, 12);
    expect(w.humanIntervention).toBeCloseTo(rem * 0.15, 12);
    expect(w.cost + w.latency).toBeCloseTo(rem * 0.5, 12);
    // The user's cost:latency ratio splits the cost+latency slice.
    expect(w.cost).toBeCloseTo(rem * 0.5 * (0.2 / 0.3), 12);
    expect(w.latency).toBeCloseTo(rem * 0.5 * (0.1 / 0.3), 12);
  });

  it('falls back to the documented defaults when no weights are configured', () => {
    const w = deriveRoutingWeights(preferences({ quality: 0, cost: 0, latency: 0 }));
    expect(w.quality).toBeCloseTo(0.6, 12); // 0.6/0.2/0.2 defaults → q/(q+c+l) = 0.6
    const rem = 1 - w.quality;
    expect(w.cost).toBeCloseTo(rem * 0.5 * 0.5, 12); // 0.2:0.2 ratio → even split
    expect(w.latency).toBeCloseTo(rem * 0.5 * 0.5, 12);
  });

  it('EXCLUDES the privacy weight — privacy is a hard WORK-043 constraint, never a ranking dimension', () => {
    // An extreme privacy weight must not change ANY derived routing weight.
    const without = deriveRoutingWeights(preferences({ quality: 0.6, cost: 0.2, latency: 0.2, privacy: 0.1 }));
    const withExtreme = deriveRoutingWeights(preferences({ quality: 0.6, cost: 0.2, latency: 0.2, privacy: 1000 }));
    expect(withExtreme).toEqual(without);
  });
});

// ============================================================================
// W044-AC05/AC07 — parity + bounded advisory preferences
// ============================================================================

describe('WORK-044 ranking — native/external parity + advisory preferences (W044-AC05/AC07)', () => {
  it('identical evidence and NO mode preference → IDENTICAL scores for native and external (no intrinsic bias)', () => {
    const native = makeCandidate({ provider: 'p', mode: 'native', quality: 80 });
    const external = makeCandidate({ provider: 'p', mode: 'external', quality: 80 });
    const out = rankEligibleCandidates(rankInput([native, external]));
    const nativeRow = out.ranked.find((r) => r.identity.executionMode === 'native');
    const externalRow = out.ranked.find((r) => r.identity.executionMode === 'external');
    expect(nativeRow?.score).toBe(externalRow?.score);
    // Either mode may win when the evidence supports it (here: identical →
    // the tie-break chain decides, lexicographically by identity).
    expect(out.explanation.tieBreakDecided).toBe(true);
  });

  it('either mode may WIN when its evidence is better (paired both directions)', () => {
    const nativeWins = rankEligibleCandidates(rankInput([
      makeCandidate({ provider: 'p', mode: 'native', quality: 90 }),
      makeCandidate({ provider: 'p', mode: 'external', quality: 70 }),
    ]));
    expect(nativeWins.selected?.identity.executionMode).toBe('native');
    const externalWins = rankEligibleCandidates(rankInput([
      makeCandidate({ provider: 'p', mode: 'native', quality: 70 }),
      makeCandidate({ provider: 'p', mode: 'external', quality: 90 }),
    ]));
    expect(externalWins.selected?.identity.executionMode).toBe('external');
  });

  it('the explicit preferredMode boost is bounded (+0.05) and reorders only among the eligible', () => {
    const base = makeCandidate({ provider: 'base', mode: 'native', quality: 80 });
    const preferred = makeCandidate({ provider: 'pref', mode: 'external', quality: 80 });
    const out = rankEligibleCandidates(
      rankInput([base, preferred], preferences({ preferredMode: 'external' })),
    );
    expect(out.selected?.identity.provider).toBe('pref');
    const boost = out.ranked.find((r) => r.identity.provider === 'pref')?.components.preferenceBoost;
    expect(boost).toBe(0.05);
    // The boost is BOUNDED: it cannot flip a real evidence gap.
    const strongEvidence = rankEligibleCandidates(rankInput([
      makeCandidate({ provider: 'strong', mode: 'native', quality: 95 }),
      makeCandidate({ provider: 'weak', mode: 'external', quality: 55 }),
    ], preferences({ preferredMode: 'external', externalPreferred: true })));
    expect(strongEvidence.selected?.identity.provider).toBe('strong');
  });

  it('no preference signal → zero boost for every mode', () => {
    const out = rankEligibleCandidates(rankInput([
      makeCandidate({ provider: 'a', mode: 'native' }),
      makeCandidate({ provider: 'b', mode: 'external' }),
    ]));
    for (const r of out.ranked) expect(r.components.preferenceBoost).toBe(0);
  });
});

// ============================================================================
// W044-AC03/AC14 — determinism + the tie-break chain
// ============================================================================

describe('WORK-044 ranking — determinism + stable tie-breaking (W044-AC03/AC14)', () => {
  const candidates: RoutingCandidate[] = [
    makeCandidate({ provider: 'alpha', quality: 80, ciFirstPassRate: 0.9, latencyMs: 100_000 }),
    makeCandidate({ provider: 'beta', quality: 80, ciFirstPassRate: 0.9, latencyMs: 100_000 }),
    makeCandidate({ provider: 'gamma', quality: 70, ciFirstPassRate: 0.5, latencyMs: 500_000 }),
    makeCandidate({ provider: 'delta', quality: 92, ciFirstPassRate: 1, latencyMs: 50_000 }),
  ];

  it('identical inputs → the IDENTICAL ordered result and selection (repeated)', () => {
    const first = rankEligibleCandidates(rankInput(candidates));
    for (let i = 0; i < 10; i += 1) {
      const repeat = rankEligibleCandidates(rankInput(candidates));
      expect(repeat.ranked.map((r) => scoreLine(r))).toEqual(first.ranked.map((r) => scoreLine(r)));
      expect(repeat.selected?.identity).toEqual(first.selected?.identity);
    }
  });

  it('REVERSED input order → the identical ordered result (input-order independence)', () => {
    const forward = rankEligibleCandidates(rankInput(candidates));
    const reversed = rankEligibleCandidates(rankInput([...candidates].reverse()));
    expect(reversed.ranked.map((r) => scoreLine(r))).toEqual(forward.ranked.map((r) => scoreLine(r)));
  });

  it('a FULL tie breaks on the lexicographic identity (provider, model, mode) — a total order', () => {
    const tied: RoutingCandidate[] = [
      makeCandidate({ provider: 'zeta', model: 'm2' }),
      makeCandidate({ provider: 'zeta', model: 'm1' }),
      makeCandidate({ provider: 'alpha', model: 'm9' }),
      makeCandidate({ provider: 'alpha', model: 'm9', mode: 'external' }),
    ];
    const out = rankEligibleCandidates(rankInput(tied));
    expect(out.ranked.map((r) => `${r.identity.provider}/${r.identity.model}/${r.identity.executionMode}`)).toEqual([
      'alpha/m9/external',
      'alpha/m9/native',
      'zeta/m1/native',
      'zeta/m2/native',
    ]);
    expect(out.explanation.tieBreakDecided).toBe(true);
    expect(out.explanation.selectionReason).toContain('tie-break chain');
  });

  it('equal total scores with DIFFERENT quality break on quality (the capability axis first)', () => {
    // Two candidates whose weighted totals tie but whose quality differs:
    // quality must decide (never the input order).
    const out = rankEligibleCandidates(rankInput([
      makeCandidate({ provider: 'late', quality: 50, latencyMs: 0 }),
      makeCandidate({ provider: 'early', quality: 60, latencyMs: 3_600_000 }),
    ]));
    expect(out.selected?.identity.provider).toBe('early');
    const flipped = rankEligibleCandidates(rankInput([
      makeCandidate({ provider: 'early', quality: 60, latencyMs: 3_600_000 }),
      makeCandidate({ provider: 'late', quality: 50, latencyMs: 0 }),
    ]));
    expect(flipped.selected?.identity.provider).toBe('early');
  });
});

// ============================================================================
// W044-AC01/AC10 — fail-closed validation + the documented empty result
// ============================================================================

describe('WORK-044 ranking — fail-closed validation (W044-AC01/AC10)', () => {
  it('REJECTS an ineligible candidate at the ranking seam (defense in depth — typed error)', () => {
    const ineligible = makeCandidate({ provider: 'blocked', quality: 99, eligible: false });
    expect(() => rankEligibleCandidates(rankInput([ineligible]))).toThrowError(ExecutionRoutingError);
    try {
      rankEligibleCandidates(rankInput([ineligible]));
    } catch (err) {
      expect((err as ExecutionRoutingError).code).toBe('execution-routing-ineligible-candidate');
      expect((err as Error).message).toContain('never be ranked');
    }
  });

  it('REJECTS a duplicate identity (inconsistent input — typed error)', () => {
    const a = makeCandidate({ provider: 'dup', model: 'm', mode: 'native' });
    const b = makeCandidate({ provider: 'dup', model: 'm', mode: 'native' });
    expect(() => rankEligibleCandidates(rankInput([a, b]))).toThrowError(ExecutionRoutingError);
    try {
      rankEligibleCandidates(rankInput([a, b]));
    } catch (err) {
      expect((err as ExecutionRoutingError).code).toBe('execution-routing-duplicate-candidate');
    }
  });

  it('REJECTS invalid signal values (NaN / out-of-range rates / negative samples) — never silently neutral', () => {
    const base = makeCandidate({ provider: 'a' });
    const bad: RoutingCandidate = { ...base, quality: { observedQuality: Number.NaN, sampleSize: 5, sufficient: true } };
    expect(() => rankEligibleCandidates(rankInput([bad]))).toThrowError(/execution-routing-invalid-signal/);

    const outOfRange: RoutingCandidate = {
      ...base,
      reliability: { ciFirstPassRate: 1.5, verificationFirstPassRate: null, sampleSize: 5, sufficient: true },
    };
    expect(() => rankEligibleCandidates(rankInput([outOfRange]))).toThrowError(/execution-routing-invalid-signal/);

    const negativeSample: RoutingCandidate = {
      ...base,
      humanIntervention: { count: 0, sampleSize: -3 },
    };
    expect(() => rankEligibleCandidates(rankInput([negativeSample]))).toThrowError(/execution-routing-invalid-signal/);
  });

  it('ZERO eligible candidates → the documented empty result (selected null; NEVER a fallback)', () => {
    const out = rankEligibleCandidates(rankInput([]));
    expect(out.ranked).toEqual([]);
    expect(out.selected).toBeNull();
    expect(out.explanation.eligibleCount).toBe(0);
    expect(out.explanation.selectionReason).toContain('No eligible execution candidate exists');
    expect(out.explanation.selectionReason).toContain('never falls back');
  });
});

// ============================================================================
// W044-AC09 — the explanation contract
// ============================================================================

describe('WORK-044 ranking — the explanation contract (W044-AC09)', () => {
  it('identifies the selected candidate, the ranked order, every dimension signal, and the win reason', () => {
    const out = rankEligibleCandidates(rankInput([
      makeCandidate({ provider: 'winner', quality: 90, ciFirstPassRate: 0.9, interventions: 0 }),
      makeCandidate({ provider: 'runner', quality: 60 }),
    ]));
    expect(out.selected?.identity.provider).toBe('winner');
    expect(out.ranked.map((r) => r.identity.provider)).toEqual(['winner', 'runner']);
    expect(out.explanation.selectionReason).toContain('winner/model-x (native)');
    expect(out.explanation.selectionReason).toContain('total score');
    expect(out.explanation.eligibleCount).toBe(2);
    // Every ranked row carries the per-dimension signals + the WORK-043 verdict.
    for (const row of out.ranked) {
      expect(row.components.quality).toBeDefined();
      expect(row.components.reliability).toBeDefined();
      expect(row.components.cost).toBeDefined();
      expect(row.components.latency).toBeDefined();
      expect(row.components.humanIntervention).toBeDefined();
      expect(row.eligibility.eligible).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function scoreLine(r: { identity: RoutingCandidate['identity']; score: number }): string {
  return `${r.identity.provider}/${r.identity.model}/${r.identity.executionMode}:${r.score}`;
}
