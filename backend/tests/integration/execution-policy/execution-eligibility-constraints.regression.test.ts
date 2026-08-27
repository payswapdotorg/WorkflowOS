/**
 * WORK-043 (§33.3) — Execution Eligibility and Constraint Engine regression
 * tests.
 *
 * UNIT-style tests of the FOUR new hard-constraint families evaluated
 * BEFORE performance ranking. Pure-function tests of the eligibility
 * service — NO database required (the WORK-033 regression pattern).
 *
 * Families under test:
 *   QUOTA        — monthly/daily execution quotas vs. derived usage
 *                  (fail-closed when usage is unresolvable under an ACTIVE
 *                  quota — the evaluateConstrainedEvidence precedent).
 *   RATE LIMITS  — per-provider sliding-window dispatch limits
 *                  (fail-closed when window usage is unresolvable).
 *   SECURITY     — the project security classification vs. the external
 *                  execution ceiling (standard < confidential < restricted).
 *   AGENT POLICY — the WORK-037 project-scoped external-domain decision
 *                  (deny/ask/unresolved block; allow/constrained pass).
 *
 * Plus: status precedence among the new families and the
 * §33.3 "eligibility inputs, not quality scores" separation (a quota /
 * rate / security / policy block is a BLOCK — no score can lift it).
 */
import { describe, it, expect } from 'vitest';
import { DefaultExecutionEligibilityService } from '../../../src/execution-policy/internal/default-execution-eligibility-service.js';
import type {
  BenchmarkMode,
  BenchmarkPolicy,
  CostEstimate,
  EligibilityEvaluationInput,
  ExecutionCandidateInput,
  ExecutionConstraintSet,
  ExecutionTaskProfile,
  HistoricalPerformance,
  LatencyEstimate,
  PrivacyConstraints,
  ProviderAccessProfile,
  ProviderAvailability,
  ProviderCapabilityProfile,
  ToolPolicy,
} from '../../../src/execution-policy/types.js';
import type { ExecutionMode } from '../../../src/modules/agents/index.js';

// ============================================================================
// FIXTURE BUILDERS (the WORK-033 regression pattern — pure data only)
// ============================================================================

const DEFAULT_MAX_CONTEXT = Object.freeze({ tokens: null, source: 'unknown' });

function fullCapabilities(overrides: Partial<ProviderCapabilityProfile> = {}): ProviderCapabilityProfile {
  return {
    conversational: 'ready',
    codingAgent: 'ready',
    browser: 'unverified',
    repositoryAccess: 'ready',
    terminal: 'ready',
    nativeApi: 'ready',
    externalUi: 'ready',
    streaming: 'ready',
    toolUse: 'ready',
    maxContext: DEFAULT_MAX_CONTEXT,
    supportedExecutionModes: ['native', 'external'],
    ...overrides,
  };
}

function accessProfile(provider: string): ProviderAccessProfile {
  return {
    provider,
    plan: 'plus',
    codingAgent: 'ready',
    externalUi: 'ready',
    nativeApi: 'ready',
    statusSource: 'user_configured',
  };
}

function historical(sampleSize = 5, observedQuality = 90): HistoricalPerformance {
  return {
    sampleSize,
    sufficient: sampleSize >= 3,
    observedQuality,
    ciFirstPassRate: null,
    verificationFirstPassRate: null,
    medianCorrectionCycles: null,
    medianTimeToVerifiedMs: null,
    humanInterventionCount: null,
    evidenceCells: [],
  };
}

function costEstimate(cents: number | null): CostEstimate {
  return { cents, confidence: cents == null ? 'unknown' : 'estimated', currency: 'USD' };
}

function latencyEstimate(ms: number | null): LatencyEstimate {
  return { estimatedMs: ms, confidence: ms == null ? 'unknown' : 'estimated', source: ms == null ? 'unknown' : 'estimated' };
}

function makeCandidate(input: {
  provider: string;
  mode: ExecutionMode;
  quality?: number;
  costCents?: number | null;
  latencyMs?: number | null;
  availability?: ProviderAvailability;
}): ExecutionCandidateInput {
  return {
    provider: input.provider,
    name: input.provider,
    model: `${input.provider}-model`,
    executionMode: input.mode,
    capabilities: fullCapabilities(),
    accessProfile: accessProfile(input.provider),
    availability: input.availability ?? 'ready',
    estimatedCost: costEstimate(input.costCents ?? null),
    estimatedLatency: latencyEstimate(input.latencyMs ?? null),
    historicalPerformance: historical(5, input.quality ?? 90),
  };
}

function taskProfile(overrides: Partial<ExecutionTaskProfile> = {}): ExecutionTaskProfile {
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
    ...overrides,
  };
}

function makePolicy(overrides: Partial<BenchmarkPolicy> = {}): BenchmarkPolicy {
  const mode: BenchmarkMode = overrides.benchmarkMode ?? 'maximum_capability';
  const privacy: PrivacyConstraints = overrides.privacyRequirements ?? {
    level: 'standard',
    approvedLocations: [],
  };
  const toolPolicy: ToolPolicy =
    mode === 'controlled_comparison'
      ? { toolClassFixed: true, maximumCapability: false, noArtificialCaps: true }
      : { toolClassFixed: false, maximumCapability: mode === 'maximum_capability', noArtificialCaps: true };
  return {
    benchmarkMode: mode,
    maxCostCents: null,
    maxDurationMs: null,
    requiredCapabilities: [],
    allowedProviders: [],
    allowedModes: ['native', 'external'],
    privacyRequirements: privacy,
    subscriptionRequirement: { blockUnknownSubscription: true, requiredCodingAgentProviders: [] },
    toolPolicy,
    humanInterventionPolicy: { allowed: true, blockIfRequired: false },
    policyVersion: 1,
    frozen: false,
    ...overrides,
  };
}

function makeConstraints(overrides: Partial<ExecutionConstraintSet> = {}): ExecutionConstraintSet {
  return {
    capability: [],
    user: { allowedProviders: [], allowedModes: [], monthlyBudgetCents: null, maxPerTaskCostCents: null },
    project: {
      externalExecutionAllowed: true,
      nativeExecutionAllowed: true,
      providerAllowlist: [],
      providerDenylist: [],
      allowedModes: [],
      localOnly: false,
      privateRepositoryPolicy: false,
      dataResidency: null,
    },
    organization: {
      approvedModelsOnly: [],
      approvedProvidersOnly: [],
      noThirdPartyBrowserAutomation: false,
      maximumExecutionCostCents: null,
      securityClassification: null,
    },
    availability: {
      providerUnavailable: [],
      modelUnavailable: [],
      externalCompanionInstalled: true,
      codingSurfaceVerified: [],
    },
    subscription: { blockUnknownSubscription: true, requiredCodingAgentProviders: [] },
    privacy: { level: 'standard', approvedLocations: [] },
    // The WORK-043 families default to INACTIVE.
    quota: { monthlyMaxExecutions: null, dailyMaxExecutions: null, monthlyUsed: 0, dailyUsed: 0 },
    rateLimit: { maxRequestsPerWindow: null, windowSeconds: null, providerWindowUsage: {} },
    security: { projectClassification: 'standard', externalCeiling: null },
    agentPolicy: { externalDecision: 'allow', reason: null, policyVersion: null },
    ...overrides,
  };
}

function evaluate(
  candidate: ExecutionCandidateInput,
  constraints: ExecutionConstraintSet,
  policy: BenchmarkPolicy = makePolicy(),
  profile: ExecutionTaskProfile = taskProfile(),
) {
  const input: EligibilityEvaluationInput = { candidate, taskProfile: profile, policy, constraints };
  return new DefaultExecutionEligibilityService().evaluate(input);
}

// ============================================================================
// QUOTA (§33.3)
// ============================================================================

describe('WORK-043 — quota constraints', () => {
  it('monthly quota exhausted → ineligible (quota_exhausted) with the named constraint', () => {
    const candidate = makeCandidate({ provider: 'qwen', mode: 'native' });
    const result = evaluate(
      candidate,
      makeConstraints({ quota: { monthlyMaxExecutions: 10, dailyMaxExecutions: null, monthlyUsed: 10, dailyUsed: 0 } }),
    );
    expect(result.eligible).toBe(false);
    expect(result.status).toBe('quota_exhausted');
    expect(result.blockingReasons).toContainEqual(
      expect.objectContaining({ category: 'quota', constraint: 'monthly_quota_exhausted' }),
    );
    // The reason is human-readable + carries the numbers (§19 why).
    expect(result.blockingReasons[0]!.reason).toContain('10/10');
  });

  it('monthly quota under the cap → eligible with the satisfied marker', () => {
    const candidate = makeCandidate({ provider: 'qwen', mode: 'native' });
    const result = evaluate(
      candidate,
      makeConstraints({ quota: { monthlyMaxExecutions: 10, dailyMaxExecutions: null, monthlyUsed: 9, dailyUsed: 0 } }),
    );
    expect(result.eligible).toBe(true);
    expect(result.satisfiedConstraints).toContain('quota:monthly_9/10');
  });

  it('daily quota exhausted (monthly fine) → ineligible', () => {
    const candidate = makeCandidate({ provider: 'qwen', mode: 'external' });
    const result = evaluate(
      candidate,
      makeConstraints({ quota: { monthlyMaxExecutions: 100, dailyMaxExecutions: 2, monthlyUsed: 5, dailyUsed: 2 } }),
    );
    expect(result.eligible).toBe(false);
    expect(result.status).toBe('quota_exhausted');
    expect(result.blockingReasons.some((b) => b.constraint === 'daily_quota_exhausted')).toBe(true);
  });

  it('FAIL-CLOSED: an ACTIVE monthly quota with UNRESOLVABLE usage → ineligible (the constraint cannot be verified)', () => {
    const candidate = makeCandidate({ provider: 'qwen', mode: 'native' });
    const result = evaluate(
      candidate,
      makeConstraints({ quota: { monthlyMaxExecutions: 10, dailyMaxExecutions: null, monthlyUsed: null, dailyUsed: 0 } }),
    );
    expect(result.eligible).toBe(false);
    expect(result.status).toBe('quota_exhausted');
    expect(result.blockingReasons.some((b) => b.constraint === 'monthly_quota_usage_unresolvable')).toBe(true);
    expect(result.blockingReasons[0]!.reason).toContain('fail-closed');
  });

  it('FAIL-CLOSED: an ACTIVE daily quota with UNRESOLVABLE usage → ineligible', () => {
    const candidate = makeCandidate({ provider: 'qwen', mode: 'native' });
    const result = evaluate(
      candidate,
      makeConstraints({ quota: { monthlyMaxExecutions: null, dailyMaxExecutions: 5, monthlyUsed: 0, dailyUsed: null } }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockingReasons.some((b) => b.constraint === 'daily_quota_usage_unresolvable')).toBe(true);
  });

  it('UNRESOLVABLE usage with NO active quota → eligible (unknown is neutral exactly when unconstrained — §24)', () => {
    const candidate = makeCandidate({ provider: 'qwen', mode: 'native' });
    const result = evaluate(
      candidate,
      makeConstraints({ quota: { monthlyMaxExecutions: null, dailyMaxExecutions: null, monthlyUsed: null, dailyUsed: null } }),
    );
    expect(result.eligible).toBe(true);
    expect(result.satisfiedConstraints).toContain('quota:unlimited');
  });

  it('the quota is a per-CANDIDATE verdict: both native and external candidates of the same project block identically', () => {
    for (const mode of ['native', 'external'] as const) {
      const result = evaluate(
        makeCandidate({ provider: 'qwen', mode }),
        makeConstraints({ quota: { monthlyMaxExecutions: 1, dailyMaxExecutions: null, monthlyUsed: 1, dailyUsed: 0 } }),
      );
      expect(result.eligible, `mode=${mode}`).toBe(false);
      expect(result.status, `mode=${mode}`).toBe('quota_exhausted');
    }
  });
});

// ============================================================================
// RATE LIMITS (§33.3)
// ============================================================================

describe('WORK-043 — rate-limit constraints', () => {
  it('provider window exhausted → ineligible (rate_limited) naming the provider + window', () => {
    const candidate = makeCandidate({ provider: 'claude', mode: 'native' });
    const result = evaluate(
      candidate,
      makeConstraints({
        rateLimit: { maxRequestsPerWindow: 3, windowSeconds: 60, providerWindowUsage: { claude: 3 } },
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.status).toBe('rate_limited');
    const block = result.blockingReasons.find((b) => b.constraint === 'rate_limit_window_exhausted')!;
    expect(block.reason).toContain('claude');
    expect(block.reason).toContain('3/3');
  });

  it('the limit is PER-PROVIDER: an exhausted provider blocks, an untouched provider passes the SAME window', () => {
    const constraints = makeConstraints({
      rateLimit: { maxRequestsPerWindow: 2, windowSeconds: 60, providerWindowUsage: { claude: 2, qwen: 0 } },
    });
    const claude = evaluate(makeCandidate({ provider: 'claude', mode: 'native' }), constraints);
    const qwen = evaluate(makeCandidate({ provider: 'qwen', mode: 'native' }), constraints);
    expect(claude.eligible).toBe(false);
    expect(claude.status).toBe('rate_limited');
    expect(qwen.eligible).toBe(true);
    expect(qwen.satisfiedConstraints).toContain('rate_limit:0/2');
  });

  it('a provider ABSENT from the resolved usage map used 0 (the map is provider-scoped by construction)', () => {
    const result = evaluate(
      makeCandidate({ provider: 'qwen', mode: 'native' }),
      makeConstraints({
        rateLimit: { maxRequestsPerWindow: 2, windowSeconds: 60, providerWindowUsage: { claude: 2 } },
      }),
    );
    expect(result.eligible).toBe(true);
  });

  it('FAIL-CLOSED: an ACTIVE rate limit with an UNRESOLVABLE window map → ineligible', () => {
    const result = evaluate(
      makeCandidate({ provider: 'qwen', mode: 'native' }),
      makeConstraints({
        rateLimit: { maxRequestsPerWindow: 5, windowSeconds: 60, providerWindowUsage: null },
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.status).toBe('rate_limited');
    expect(result.blockingReasons.some((b) => b.constraint === 'rate_limit_usage_unresolvable')).toBe(true);
  });

  it('no rate limit configured → eligible (the family is inactive)', () => {
    const result = evaluate(
      makeCandidate({ provider: 'qwen', mode: 'native' }),
      makeConstraints({ rateLimit: { maxRequestsPerWindow: null, windowSeconds: null, providerWindowUsage: null } }),
    );
    expect(result.eligible).toBe(true);
    expect(result.satisfiedConstraints).toContain('rate_limit:none');
  });
});

// ============================================================================
// SECURITY (§33.3)
// ============================================================================

describe('WORK-043 — security requirements', () => {
  it('project classification ABOVE the external ceiling → EXTERNAL blocked (security_blocked), NATIVE eligible', () => {
    const constraints = makeConstraints({
      security: { projectClassification: 'restricted', externalCeiling: 'confidential' },
    });
    const external = evaluate(makeCandidate({ provider: 'claude', mode: 'external' }), constraints);
    const native = evaluate(makeCandidate({ provider: 'qwen', mode: 'native' }), constraints);
    expect(external.eligible).toBe(false);
    expect(external.status).toBe('security_blocked');
    expect(external.blockingReasons.some((b) => b.constraint === 'external_security_ceiling')).toBe(true);
    expect(external.blockingReasons[0]!.reason).toContain("'restricted'");
    expect(external.blockingReasons[0]!.reason).toContain("'confidential'");
    // Native execution stays inside the boundary — not security-blocked.
    expect(native.eligible).toBe(true);
    expect(native.satisfiedConstraints).toContain('security:within_ceiling');
  });

  it('classification AT the ceiling (equal rank) → eligible (the ceiling is inclusive)', () => {
    const result = evaluate(
      makeCandidate({ provider: 'claude', mode: 'external' }),
      makeConstraints({ security: { projectClassification: 'confidential', externalCeiling: 'confidential' } }),
    );
    expect(result.eligible).toBe(true);
    expect(result.satisfiedConstraints).toContain('security:external_ceiling');
  });

  it('classification BELOW the ceiling → eligible', () => {
    const result = evaluate(
      makeCandidate({ provider: 'claude', mode: 'external' }),
      makeConstraints({ security: { projectClassification: 'standard', externalCeiling: 'restricted' } }),
    );
    expect(result.eligible).toBe(true);
  });

  it('NULL ceiling → no external security restriction (the privacy family still applies independently)', () => {
    const result = evaluate(
      makeCandidate({ provider: 'claude', mode: 'external' }),
      makeConstraints({ security: { projectClassification: 'restricted', externalCeiling: null } }),
    );
    expect(result.eligible).toBe(true);
    expect(result.satisfiedConstraints).toContain('security:within_ceiling');
  });

  it('the ladder is ordered: standard < confidential < restricted (each step blocks at the step-below ceiling)', () => {
    // confidential project + standard ceiling → blocked.
    expect(
      evaluate(
        makeCandidate({ provider: 'x', mode: 'external' }),
        makeConstraints({ security: { projectClassification: 'confidential', externalCeiling: 'standard' } }),
      ).eligible,
    ).toBe(false);
    // standard project + any ceiling ≥ standard → allowed.
    expect(
      evaluate(
        makeCandidate({ provider: 'x', mode: 'external' }),
        makeConstraints({ security: { projectClassification: 'standard', externalCeiling: 'standard' } }),
      ).eligible,
    ).toBe(true);
    // restricted project + restricted ceiling → allowed.
    expect(
      evaluate(
        makeCandidate({ provider: 'x', mode: 'external' }),
        makeConstraints({ security: { projectClassification: 'restricted', externalCeiling: 'restricted' } }),
      ).eligible,
    ).toBe(true);
  });
});

// ============================================================================
// AGENT POLICY (WORK-037 → WORK-043)
// ============================================================================

describe('WORK-043 — agent-policy constraints (the WORK-037 external-domain decision)', () => {
  it('deny → EXTERNAL candidates blocked (agent_policy_blocked), NATIVE candidates pass', () => {
    const constraints = makeConstraints({
      agentPolicy: { externalDecision: 'deny', reason: 'rule ext-deny', policyVersion: 4 },
    });
    const external = evaluate(makeCandidate({ provider: 'claude', mode: 'external' }), constraints);
    const native = evaluate(makeCandidate({ provider: 'qwen', mode: 'native' }), constraints);
    expect(external.eligible).toBe(false);
    expect(external.status).toBe('agent_policy_blocked');
    expect(external.blockingReasons.some((b) => b.constraint === 'external_handoff_denied')).toBe(true);
    expect(external.blockingReasons[0]!.reason).toContain('ext-deny');
    expect(native.eligible).toBe(true);
    expect(native.satisfiedConstraints).toContain('agent_policy:native_within_boundary');
  });

  it('ask → blocked pending approval (a recommendation is NON-INTERACTIVE — it cannot pre-approve a future handoff)', () => {
    const result = evaluate(
      makeCandidate({ provider: 'claude', mode: 'external' }),
      makeConstraints({
        agentPolicy: { externalDecision: 'ask', reason: 'rule ext-ask', policyVersion: 4 },
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.status).toBe('agent_policy_blocked');
    expect(result.blockingReasons.some((b) => b.constraint === 'external_handoff_approval_required')).toBe(true);
  });

  it('unresolved → FAIL-CLOSED for external candidates', () => {
    const result = evaluate(
      makeCandidate({ provider: 'claude', mode: 'external' }),
      makeConstraints({
        agentPolicy: { externalDecision: 'unresolved', reason: 'engine unavailable', policyVersion: null },
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.status).toBe('agent_policy_blocked');
    expect(result.blockingReasons.some((b) => b.constraint === 'external_handoff_unresolved')).toBe(true);
    expect(result.blockingReasons[0]!.reason).toContain('failing closed');
  });

  it('allow → external candidates pass with the satisfied marker', () => {
    const result = evaluate(
      makeCandidate({ provider: 'claude', mode: 'external' }),
      makeConstraints({
        agentPolicy: { externalDecision: 'allow', reason: 'default allow', policyVersion: 0 },
      }),
    );
    expect(result.eligible).toBe(true);
    expect(result.satisfiedConstraints).toContain('agent_policy:external_allow');
  });

  it('constrained → PASSES (the constraints are ADVISORY to the external runtime — the WORK-037 decorator posture)', () => {
    const result = evaluate(
      makeCandidate({ provider: 'claude', mode: 'external' }),
      makeConstraints({
        agentPolicy: { externalDecision: 'constrained', reason: 'read-only', policyVersion: 4 },
      }),
    );
    expect(result.eligible).toBe(true);
    expect(result.satisfiedConstraints).toContain('agent_policy:external_constrained');
  });
});

// ============================================================================
// PRECEDENCE + the §33.3 hard-filter separation
// ============================================================================

describe('WORK-043 — status precedence + the hard-filter separation', () => {
  it('capability outranks the new families (the most specific structural verdict wins)', () => {
    // A capability-blocked candidate that is ALSO quota-exhausted + rate-limited.
    const result = evaluate(
      makeCandidate({ provider: 'weak', mode: 'external', availability: 'configuration_missing' }),
      makeConstraints({
        quota: { monthlyMaxExecutions: 1, dailyMaxExecutions: null, monthlyUsed: 1, dailyUsed: 0 },
        rateLimit: { maxRequestsPerWindow: 1, windowSeconds: 60, providerWindowUsage: { weak: 1 } },
        security: { projectClassification: 'restricted', externalCeiling: 'standard' },
        agentPolicy: { externalDecision: 'deny', reason: 'r', policyVersion: 1 },
      }),
      makePolicy(),
      taskProfile({ requiredCapabilities: ['browser'] }),
    );
    // 'weak' has browser: 'unverified' → capability-satisfied per §4.1
    // (unverified passes capability). Force a genuine capability block:
    const blocked = evaluate(
      { ...makeCandidate({ provider: 'weak', mode: 'external' }), capabilities: fullCapabilities({ browser: 'unavailable' }) },
      makeConstraints({
        quota: { monthlyMaxExecutions: 1, dailyMaxExecutions: null, monthlyUsed: 1, dailyUsed: 0 },
      }),
      makePolicy(),
      taskProfile({ requiredCapabilities: ['browser'] }),
    );
    expect(blocked.status).toBe('capability_blocked');
    expect(result.status).not.toBe('eligible');
  });

  it('security outranks quota/rate-limit/agent-policy; agent_policy outranks quota; quota outranks rate_limit', () => {
    const security = evaluate(
      makeCandidate({ provider: 'x', mode: 'external' }),
      makeConstraints({
        security: { projectClassification: 'restricted', externalCeiling: 'standard' },
        agentPolicy: { externalDecision: 'deny', reason: 'r', policyVersion: 1 },
        quota: { monthlyMaxExecutions: 1, dailyMaxExecutions: null, monthlyUsed: 1, dailyUsed: 0 },
        rateLimit: { maxRequestsPerWindow: 1, windowSeconds: 60, providerWindowUsage: { x: 1 } },
      }),
    );
    expect(security.status).toBe('security_blocked');

    const agentPolicy = evaluate(
      makeCandidate({ provider: 'x', mode: 'external' }),
      makeConstraints({
        agentPolicy: { externalDecision: 'deny', reason: 'r', policyVersion: 1 },
        quota: { monthlyMaxExecutions: 1, dailyMaxExecutions: null, monthlyUsed: 1, dailyUsed: 0 },
        rateLimit: { maxRequestsPerWindow: 1, windowSeconds: 60, providerWindowUsage: { x: 1 } },
      }),
    );
    expect(agentPolicy.status).toBe('agent_policy_blocked');

    const quota = evaluate(
      makeCandidate({ provider: 'x', mode: 'native' }),
      makeConstraints({
        quota: { monthlyMaxExecutions: 1, dailyMaxExecutions: null, monthlyUsed: 1, dailyUsed: 0 },
        rateLimit: { maxRequestsPerWindow: 1, windowSeconds: 60, providerWindowUsage: { x: 1 } },
      }),
    );
    expect(quota.status).toBe('quota_exhausted');
  });

  it('§33.3 — a quota block is a BLOCK: even a PERFECT candidate (quality 100, cheap, fast) stays ineligible', () => {
    const perfect = makeCandidate({ provider: 'best', mode: 'native', quality: 100, costCents: 1, latencyMs: 1 });
    const result = evaluate(
      perfect,
      makeConstraints({ quota: { monthlyMaxExecutions: 0, dailyMaxExecutions: null, monthlyUsed: 0, dailyUsed: 0 } }),
    );
    // Quota 0 with usage 0 → exhausted (max 0 = nothing may run).
    expect(result.eligible).toBe(false);
    expect(result.status).toBe('quota_exhausted');
  });

  it('all four families inactive → eligible (the pre-WORK-043 verdict preserved)', () => {
    const result = evaluate(makeCandidate({ provider: 'qwen', mode: 'native' }), makeConstraints());
    expect(result.eligible).toBe(true);
    expect(result.status).toBe('eligible');
    expect(result.blockingReasons).toEqual([]);
  });
});
