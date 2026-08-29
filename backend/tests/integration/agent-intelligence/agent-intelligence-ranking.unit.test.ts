/**
 * WORK-047 — unit tests for the PURE intelligence functions (no I/O):
 * the ranking composite, the eligibility seam, signal validation, the
 * deterministic tie-break chain, the neutral prior, the confidence model,
 * the exclusion classification, and the decomposition rules across task
 * profiles (including the dependency topology + the fail-closed unknown-role
 * seam, which is additionally pinned in the integration suite).
 */
import { describe, it, expect } from 'vitest';
import {
  rankWithIntelligence,
  assertEligibleAtSeam,
  compositeScore,
  historicalComponent,
  deriveHistoricalSignal,
  executionCellKey,
  findExecutionCell,
  validateExecutionCell,
  compareIntelligenceRanked,
  classifyExclusion,
  buildRejectedAlternatives,
  confidenceOf,
  executionContribution,
  ROUTING_WEIGHT,
  HISTORY_WEIGHT,
  NEUTRAL_PRIOR,
  INSUFFICIENT_SAMPLE,
  computeDecomposition,
  aggregateRoleHistory,
  DECOMPOSITION_RULES,
  AgentIntelligenceError,
  type ExecutionHistoryCell,
  type DelegationRoleHistoryCell,
  type DecompositionRule,
} from '../../../src/agent-intelligence/index.js';
import { DefaultAgentRoleCatalogService } from '../../../src/agent-roles/index.js';
import type { ExecutionTaskProfile } from '../../../src/execution-policy/index.js';

const ELIGIBLE = {
  status: 'eligible' as const,
  eligible: true,
  blockingReasons: [],
  satisfiedConstraints: ['capability:coding_agent'],
};
const INELIGIBLE = {
  status: 'policy_blocked' as const,
  eligible: false,
  blockingReasons: [{ category: 'project' as const, constraint: 'provider_denylist', reason: 'denied' }],
  satisfiedConstraints: [],
};

const BASE_PROFILE: ExecutionTaskProfile = {
  language: 'typescript',
  framework: null,
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

function cell(provider: string, model: string | null, mode: 'native' | 'external', attempts: number, succeeded: number, overrides: Partial<ExecutionHistoryCell> = {}): ExecutionHistoryCell {
  return {
    provider,
    model,
    mode,
    attempts,
    succeeded,
    failed: attempts - succeeded,
    successRate: attempts > 0 ? succeeded / attempts : null,
    medianDurationMs: null,
    firstObservedAt: new Date('2026-01-01T00:00:00Z'),
    lastObservedAt: new Date('2026-02-01T00:00:00Z'),
    ...overrides,
  };
}

function rankedRow(provider: string, model: string, mode: 'native' | 'external', score: number, eligibility: { status: string; eligible: boolean; blockingReasons: unknown[]; satisfiedConstraints: string[] } = ELIGIBLE) {
  return {
    identity: { provider, model, executionMode: mode },
    score,
    components: {
      quality: { observedQuality: null, sampleSize: 0, sufficient: false },
      reliability: { ciFirstPassRate: null, verificationFirstPassRate: null, sampleSize: 0, sufficient: false },
      cost: { cents: null, confidence: 'unknown' as const },
      latency: { estimatedMs: null, source: 'unknown' as const },
      humanIntervention: { count: null, sampleSize: 0 },
      preferenceBoost: 0,
    },
    eligibility,
  };
}

describe('WORK-047 unit — the intelligence ranking functions', () => {
  it('the composite is the documented formula (0.6 routing + 0.4 history)', () => {
    expect(ROUTING_WEIGHT).toBe(0.6);
    expect(HISTORY_WEIGHT).toBe(0.4);
    expect(ROUTING_WEIGHT + HISTORY_WEIGHT).toBe(1);
    const score = compositeScore({
      routing: { value: 0.8, status: 'observed' },
      historicalSuccess: { value: 0.75, status: 'observed' },
    });
    expect(score).toBeCloseTo(0.6 * 0.8 + 0.4 * 0.75, 10);
  });

  it('the neutral prior applies when no evidence exists; observed rates apply with honest sufficiency', () => {
    expect(historicalComponent({ successRate: null, sampleSize: 0, sufficient: false, lastObservedAt: null }))
      .toEqual({ value: NEUTRAL_PRIOR, status: 'insufficient' });
    // Thin observed sample: the OBSERVED rate, marked insufficient (§14).
    expect(historicalComponent({ successRate: 0.5, sampleSize: 1, sufficient: false, lastObservedAt: new Date() }))
      .toEqual({ value: 0.5, status: 'insufficient' });
    expect(historicalComponent({ successRate: 0.9, sampleSize: INSUFFICIENT_SAMPLE, sufficient: true, lastObservedAt: new Date() }))
      .toEqual({ value: 0.9, status: 'observed' });
    expect(INSUFFICIENT_SAMPLE).toBe(3);
  });

  it('THE SEAM: an ineligible candidate is REJECTED with the typed error (never scored)', () => {
    expect(() => assertEligibleAtSeam({ eligibility: INELIGIBLE, identity: { provider: 'x', model: 'm', executionMode: 'native' } })).toThrowError(AgentIntelligenceError);
    try {
      assertEligibleAtSeam({ eligibility: INELIGIBLE, identity: { provider: 'x', model: 'm', executionMode: 'native' } });
      expect.unreachable();
    } catch (err) {
      expect((err as AgentIntelligenceError).code).toBe('agent-intelligence-ineligible-candidate');
    }
    // The eligible control passes.
    expect(() => assertEligibleAtSeam({ eligibility: ELIGIBLE, identity: { provider: 'x', model: 'm', executionMode: 'native' } })).not.toThrow();
    // A non-'eligible' STATUS is also rejected (defense in depth).
    expect(() =>
      assertEligibleAtSeam({ eligibility: { ...ELIGIBLE, status: 'quota_exhausted' }, identity: { provider: 'x', model: 'm', executionMode: 'native' } }),
    ).toThrowError(AgentIntelligenceError);
  });

  it('the ranking seam rejects an ineligible candidate inside rankWithIntelligence too', () => {
    expect(() =>
      rankWithIntelligence({ ranked: [rankedRow('gamma', 'g', 'native', 0.9, INELIGIBLE) as never], executionCells: [] }),
    ).toThrowError(AgentIntelligenceError);
  });

  it('invalid evidence signals fail closed (NaN / inconsistent / out-of-range)', () => {
    expect(() => validateExecutionCell(cell('a', 'm', 'native', 5, 6))).toThrowError(AgentIntelligenceError); // succeeded > attempts
    expect(() => validateExecutionCell({ ...cell('a', 'm', 'native', 2, 1), successRate: 1.5 })).toThrowError(AgentIntelligenceError);
    expect(() => validateExecutionCell({ ...cell('a', 'm', 'native', 2, 1), attempts: -1 })).toThrowError(AgentIntelligenceError);
    expect(() =>
      rankWithIntelligence({
        ranked: [rankedRow('a', 'm', 'native', 0.5) as never],
        executionCells: [{ ...cell('a', 'm', 'native', 2, 1), successRate: Number.NaN }],
      }),
    ).toThrowError(AgentIntelligenceError);
    // The consistent control passes.
    expect(() => validateExecutionCell(cell('a', 'm', 'native', 2, 1))).not.toThrow();
  });

  it('THE TIE-BREAK CHAIN: equal scores → routing desc → lexicographic (a total order)', () => {
    const a = { identity: { provider: 'b', model: 'm1', executionMode: 'native' as const }, score: 0.7, components: { routing: { value: 0.7, status: 'observed' as const }, historicalSuccess: { value: 0.7, status: 'observed' as const } }, historicalSignal: { successRate: 0.7, sampleSize: 5, sufficient: true, lastObservedAt: null }, eligibility: ELIGIBLE, routingRank: 1 };
    const b = { ...a, identity: { provider: 'a', model: 'm1', executionMode: 'native' as const } };
    const c = { ...a, identity: { provider: 'a', model: 'm0', executionMode: 'native' as const } };
    // Equal score + equal routing → lexicographic: a/m0 < a/m1 < b/m1.
    expect(compareIntelligenceRanked(c, b)).toBeLessThan(0);
    expect(compareIntelligenceRanked(b, c)).toBeGreaterThan(0);
    expect(compareIntelligenceRanked(c, a)).toBeLessThan(0);
    // Equal score, higher routing wins.
    const d = { ...a, components: { routing: { value: 0.9, status: 'observed' as const }, historicalSuccess: { value: 0.5, status: 'observed' as const } } };
    expect(compareIntelligenceRanked(d, a)).toBeLessThan(0);
  });

  it('rankWithIntelligence: observed history reorders equal-routing candidates deterministically', () => {
    const ranked = [rankedRow('alpha', 'm', 'native', 0.7) as never, rankedRow('beta', 'm', 'native', 0.7) as never];
    const cells = [cell('beta', 'm', 'native', 10, 10)]; // beta: perfect history
    const out = rankWithIntelligence({ ranked, executionCells: cells });
    // beta's history (1.0) lifts it above alpha's neutral prior.
    expect(out.ranked[0]!.identity.provider).toBe('beta');
    expect(out.ranked[0]!.score).toBeCloseTo(0.6 * 0.7 + 0.4 * 1.0, 10);
    expect(out.ranked[1]!.score).toBeCloseTo(0.6 * 0.7 + 0.4 * 0.5, 10);
    expect(out.selected).toBe(out.ranked[0]);
  });

  it('the cell lookup + key derivation (null-safe model matching)', () => {
    expect(executionCellKey('p', null, 'external')).toBe('p/_null_/external');
    expect(executionCellKey('p', 'm', 'native')).toBe('p/m/native');
    const cells = [cell('p', null, 'external', 1, 1), cell('p', 'm', 'native', 2, 1)];
    expect(findExecutionCell(cells, { provider: 'p', model: 'm', executionMode: 'native' })).toBe(cells[1]);
    expect(findExecutionCell(cells, { provider: 'p', model: '', executionMode: 'external' })).toBe(cells[0]);
    expect(findExecutionCell(cells, { provider: 'q', model: 'm', executionMode: 'native' })).toBeNull();
    // deriveHistoricalSignal: no cell → insufficient.
    expect(deriveHistoricalSignal(null)).toEqual({ successRate: null, sampleSize: 0, sufficient: false, lastObservedAt: null });
  });

  it('exclusion classification + rejected alternatives carry the authority verdicts verbatim', () => {
    expect(classifyExclusion({ ...INELIGIBLE, status: 'project_policy_blocked' })).toBe('policy');
    expect(classifyExclusion({ ...INELIGIBLE, status: 'capability_blocked' })).toBe('capability');
    expect(classifyExclusion({ ...INELIGIBLE, status: 'subscription_blocked' })).toBe('policy');
    expect(classifyExclusion({ ...INELIGIBLE, status: 'unavailable' })).toBe('routing');
    const rejected = buildRejectedAlternatives([
      { identity: { provider: 'gamma', model: 'g', executionMode: 'native' }, eligibility: INELIGIBLE },
    ]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.excludedThrough).toBe('policy');
    expect(rejected[0]!.eligibility.blockingReasons[0]!.constraint).toBe('provider_denylist');
  });

  it('the confidence model is a deterministic function of the evidence', () => {
    const suff = { identity: { provider: 'a', model: 'm', executionMode: 'native' as const }, score: 0.9, components: { routing: { value: 1, status: 'observed' as const }, historicalSuccess: { value: 0.8, status: 'observed' as const } }, historicalSignal: { successRate: 0.8, sampleSize: 5, sufficient: true, lastObservedAt: null }, eligibility: ELIGIBLE, routingRank: 1 };
    const thin = { ...suff, historicalSignal: { successRate: 0.8, sampleSize: 1, sufficient: false, lastObservedAt: null } };
    expect(confidenceOf(suff, 5)).toBe('high');
    expect(confidenceOf(thin, 1)).toBe('medium');
    expect(confidenceOf(thin, 0)).toBe('low');
    expect(confidenceOf(null, 10)).toBe('low');
  });

  it('executionContribution surfaces the observation window', () => {
    const c = executionContribution(cell('p', 'm', 'native', 4, 3, { firstObservedAt: new Date('2026-01-02T00:00:00Z'), lastObservedAt: new Date('2026-03-04T00:00:00Z') }));
    expect(c.cell).toBe('p/m/native');
    expect(c.attempts).toBe(4);
    expect(c.succeeded).toBe(3);
    expect(c.firstObservedAt.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(c.lastObservedAt.toISOString()).toBe('2026-03-04T00:00:00.000Z');
  });
});

describe('WORK-047 unit — the decomposition rules', () => {
  const catalog = new DefaultAgentRoleCatalogService();
  const resolve = (identity: string) => catalog.resolveRole(identity);

  it('the medium baseline recommends implementer + tester only', () => {
    const out = computeDecomposition({ taskProfile: BASE_PROFILE, roleCells: [], resolveRole: resolve });
    expect(out.units.map((u) => u.role)).toEqual(['implementer', 'tester']);
    expect(out.units.map((u) => u.dependsOn)).toEqual([[], ['implementer']]);
  });

  it('the rich profile recommends the full set with the fixed topological dependencies', () => {
    const rich: ExecutionTaskProfile = {
      ...BASE_PROFILE,
      complexity: 'high',
      architectureSensitivity: 'high',
      securitySensitivity: 'high',
      terminalRequired: true,
    };
    const out = computeDecomposition({ taskProfile: rich, roleCells: [], resolveRole: resolve });
    expect(out.units.map((u) => u.role).sort()).toEqual(
      ['architect', 'implementer', 'performance-reviewer', 'planner', 'security-reviewer', 'tester'],
    );
    const byRole = new Map(out.units.map((u) => [u.role, u]));
    expect(byRole.get('architect')!.dependsOn).toEqual([]);
    expect(byRole.get('planner')!.dependsOn).toEqual(['architect']);
    expect(byRole.get('implementer')!.dependsOn).toEqual(['planner']);
    expect(byRole.get('tester')!.dependsOn).toEqual(['implementer']);
    expect(byRole.get('security-reviewer')!.dependsOn).toEqual(['implementer']);
    expect(byRole.get('performance-reviewer')!.dependsOn).toEqual(['implementer']);
    // Every role revision is the catalog's current revision (pinned).
    for (const unit of out.units) {
      expect(unit.roleRevision).toBe(resolve(unit.role)!.role.lifecycle.revision);
    }
  });

  it('unknown complexity is FAIL-SAFE (the tester is recommended)', () => {
    const unknown: ExecutionTaskProfile = { ...BASE_PROFILE, complexity: 'unknown' };
    const out = computeDecomposition({ taskProfile: unknown, roleCells: [], resolveRole: resolve });
    expect(out.units.map((u) => u.role)).toContain('tester');
  });

  it('the low-complexity minimal shape + the explicit rejected alternatives', () => {
    const low: ExecutionTaskProfile = { ...BASE_PROFILE, complexity: 'low' };
    const out = computeDecomposition({ taskProfile: low, roleCells: [], resolveRole: resolve });
    expect(out.units.map((u) => u.role)).toEqual(['implementer']);
    const rejected = new Map(out.rejectedRoles.map((r) => [r.role, r.reason]));
    expect(rejected.get('tester')).toContain('low complexity');
    expect(rejected.get('ux-reviewer')).toContain('no UX axis');
    expect(rejected.get('release-engineer')).toContain('lifecycle concern');
  });

  it('role history ANNOTATES (with warnings for poor observed success) and NEVER drops a unit', () => {
    const rich: ExecutionTaskProfile = { ...BASE_PROFILE, securitySensitivity: 'high' };
    const cells: DelegationRoleHistoryCell[] = [
      {
        roleId: 'security-reviewer',
        roleRevision: 'rev',
        provider: 'alpha',
        mode: 'native',
        attempts: 4,
        succeeded: 1,
        failed: 3,
        unresolved: 0,
        successRate: 0.25,
        firstObservedAt: new Date('2026-01-01T00:00:00Z'),
        lastObservedAt: new Date('2026-02-01T00:00:00Z'),
      },
    ];
    const out = computeDecomposition({ taskProfile: rich, roleCells: cells, resolveRole: resolve });
    const unit = out.units.find((u) => u.role === 'security-reviewer')!;
    expect(unit).toBeTruthy(); // NEVER dropped
    expect(unit.roleHistory!.attempts).toBe(4);
    expect(unit.roleHistory!.successRate).toBeCloseTo(0.25, 10);
    expect(out.warnings.some((w) => w.includes('security-reviewer'))).toBe(true);
    // Thin evidence never warns (§14 — a single run is never definitive).
    const thin = computeDecomposition({
      taskProfile: rich,
      roleCells: [{ ...cells[0]!, attempts: 1, succeeded: 0, failed: 1, successRate: 0 }],
      resolveRole: resolve,
    });
    expect(thin.warnings.some((w) => w.includes('security-reviewer'))).toBe(false);
  });

  it('aggregateRoleHistory aggregates deterministically across cells (window = min first / max last)', () => {
    const cells: DelegationRoleHistoryCell[] = [
      { roleId: 'tester', roleRevision: 'r', provider: 'a', mode: 'native', attempts: 2, succeeded: 1, failed: 1, unresolved: 0, successRate: 0.5, firstObservedAt: new Date('2026-01-01T00:00:00Z'), lastObservedAt: new Date('2026-01-15T00:00:00Z') },
      { roleId: 'tester', roleRevision: 'r', provider: 'b', mode: 'external', attempts: 3, succeeded: 2, failed: 1, unresolved: 0, successRate: 2 / 3, firstObservedAt: new Date('2026-01-05T00:00:00Z'), lastObservedAt: new Date('2026-02-01T00:00:00Z') },
    ];
    const agg = aggregateRoleHistory(cells, 'tester')!;
    expect(agg.attempts).toBe(5);
    expect(agg.succeeded).toBe(3);
    expect(agg.successRate).toBeCloseTo(0.6, 10);
    expect(agg.firstObservedAt).toBe(cells[0]!.firstObservedAt);
    expect(agg.lastObservedAt).toBe(cells[1]!.lastObservedAt);
    expect(aggregateRoleHistory(cells, 'architect')).toBeNull();
  });

  it('the UNKNOWN-ROLE seam fails closed (typed error, the corrupted-rule proof)', () => {
    const corrupted: readonly DecompositionRule[] = [
      {
        role: 'wizard-of-oz' as never,
        applies: () => true,
        recommendationReason: () => 'corrupted',
        rejectionReason: 'corrupted',
        dependsOn: [],
      },
    ];
    expect(() =>
      computeDecomposition({ taskProfile: BASE_PROFILE, roleCells: [], resolveRole: resolve, rules: corrupted }),
    ).toThrowError(AgentIntelligenceError);
  });

  it('the rule table covers exactly the eight closed-catalog roles (no invented roles)', () => {
    const ruleRoles = DECOMPOSITION_RULES.map((r) => r.role).sort();
    expect(ruleRoles).toEqual([
      'architect', 'implementer', 'performance-reviewer', 'planner',
      'release-engineer', 'security-reviewer', 'tester', 'ux-reviewer',
    ]);
    for (const rule of DECOMPOSITION_RULES) {
      expect(catalog.resolveRole(rule.role)).toBeTruthy(); // every rule role resolves in the catalog
    }
  });
});
