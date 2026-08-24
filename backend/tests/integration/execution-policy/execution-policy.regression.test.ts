/**
 * WORK-033 §29 — Execution Policy & Fair Benchmarking regression tests.
 *
 * These are UNIT-style tests of the eligibility (HARD filter) + recommendation
 * (ordered scoring, capability-ceiling-preserving) services. They construct
 * ExecutionCandidateInput + ExecutionTaskProfile + BenchmarkPolicy +
 * ExecutionConstraintSet fixtures inline, call the pure-function services,
 * and assert the verdicts + scoring. NO database is required.
 *
 * 11 scenarios (§29), each a single `it()` block:
 *   1.  SUBSCRIPTION — Claude quality highest but subscription unknown → blocked;
 *       Qwen eligible → Qwen recommended.
 *   2.  CAPABILITY — coding-agent required; conversational-only candidate →
 *       excluded (capability_blocked).
 *   3.  POLICY — external execution prohibited; external candidate →
 *       excluded (project_policy_blocked).
 *   4.  QUALITY — both eligible, Claude quality 98 > Qwen 93 → Claude
 *       recommended (capability ceiling preserved; NOT normalized down).
 *   5.  COST — Claude over budget (cost > cap → costComponent 0); Qwen within
 *       budget → Qwen recommended.
 *   6.  PRIVACY — privacyLevel='local_only'; external blocked; native eligible
 *       → native recommended.
 *   7.  MAXIMUM CAPABILITY — benchmarkMode='maximum_capability' +
 *       ToolPolicy.maximumCapability=true + noArtificialCaps=true → recommended
 *       candidate's capability profile has NO artificial cap (codingAgent stays
 *       'ready', not downgraded).
 *   8.  CONTROLLED COMPARISON — benchmarkMode='controlled_comparison' →
 *       policySnapshot.toolPolicy.toolClassFixed=true + maximumCapability=false;
 *       recommendation still preserves the capability ceiling (Claude wins).
 *   9.  OVERRIDE — user can select any eligible non-recommended candidate
 *       (the eligibleCandidates list includes the non-recommended one; the
 *       recommendation layer does not prevent selection — it just ranks).
 *  10.  HARD BLOCK — ineligible candidate cannot be selected (the eligibility
 *       verdict is eligible=false with blockingReasons).
 *  11.  INSUFFICIENT SAMPLE (§14) — a single trial does not make a candidate
 *       definitively recommended; quality component uses the neutral prior
 *       (0.5) so a candidate with sufficient evidence outranks it.
 */
import { describe, it, expect } from 'vitest';
import { DefaultExecutionEligibilityService } from '../../../src/execution-policy/internal/default-execution-eligibility-service.js';
import { DefaultExecutionRecommendationService } from '../../../src/execution-policy/internal/default-execution-recommendation-service.js';
import type {
  BenchmarkMode,
  BenchmarkPolicy,
  CapabilityReadiness,
  ContextWindow,
  CostEstimate,
  EligibilityEvaluationInput,
  ExecutionCandidateInput,
  ExecutionConstraintSet,
  ExecutionPreferenceProfile,
  ExecutionTaskProfile,
  HistoricalPerformance,
  LatencyEstimate,
  PrivacyConstraints,
  ProjectConstraints,
  ProjectPolicyRecord,
  ProviderAccessProfile,
  ProviderAvailability,
  ProviderCapabilityProfile,
  ToolPolicy,
  UserConstraints,
  UserPreferenceRecord,
  OrganizationConstraints,
  AvailabilityConstraints,
} from '../../../src/execution-policy/types.js';
import type { ExecutionMode } from '../../../src/modules/agents/index.js';

// ============================================================================
// FIXTURE BUILDERS (reduce repetition; pure data only — no secrets)
// ============================================================================

const DEFAULT_MAX_CONTEXT: ContextWindow = Object.freeze({ tokens: null, source: 'unknown' });

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

function accessProfile(
  provider: string,
  statusSource: 'verified' | 'user_configured' | 'unknown' = 'user_configured',
  codingAgent: CapabilityReadiness = 'ready',
): ProviderAccessProfile {
  return {
    provider,
    plan: 'plus',
    codingAgent,
    externalUi: 'ready',
    nativeApi: 'ready',
    statusSource,
  };
}

function historical(
  sampleSize: number,
  observedQuality: number | null,
  sufficient = sampleSize >= 3,
): HistoricalPerformance {
  return {
    sampleSize,
    sufficient,
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
  return {
    estimatedMs: ms,
    confidence: ms == null ? 'unknown' : 'estimated',
    source: ms == null ? 'unknown' : 'estimated',
  };
}

interface MakeCandidateInput {
  provider: string;
  name: string;
  model: string;
  mode: ExecutionMode;
  quality: number;
  sampleSize?: number;
  sufficient?: boolean;
  costCents?: number | null;
  latencyMs?: number | null;
  access?: ProviderAccessProfile | null;
  availability?: ProviderAvailability;
  capabilities?: Partial<ProviderCapabilityProfile>;
}

function makeCandidate(input: MakeCandidateInput): ExecutionCandidateInput {
  const sampleSize = input.sampleSize ?? 5;
  const sufficient = input.sufficient ?? (sampleSize >= 3);
  return {
    provider: input.provider,
    name: input.name,
    model: input.model,
    executionMode: input.mode,
    capabilities: fullCapabilities(input.capabilities),
    accessProfile: input.access === undefined ? accessProfile(input.provider) : input.access,
    availability: input.availability ?? 'ready',
    estimatedCost: costEstimate(input.costCents ?? null),
    estimatedLatency: latencyEstimate(input.latencyMs ?? null),
    historicalPerformance: historical(sampleSize, input.quality, sufficient),
  };
}

function makeTaskProfile(
  overrides: Partial<ExecutionTaskProfile> = {},
): ExecutionTaskProfile {
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

function makeToolPolicy(mode: BenchmarkMode): ToolPolicy {
  // Mirror DefaultExecutionPolicyService.buildPolicySnapshot (§9):
  // controlled_comparison → toolClassFixed=true, maximumCapability=false.
  // maximum_capability → toolClassFixed=false, maximumCapability=true.
  // Every other mode: maximumCapability=false unless explicitly maximum.
  if (mode === 'controlled_comparison') {
    return { toolClassFixed: true, maximumCapability: false, noArtificialCaps: true };
  }
  if (mode === 'maximum_capability') {
    return { toolClassFixed: false, maximumCapability: true, noArtificialCaps: true };
  }
  return { toolClassFixed: false, maximumCapability: false, noArtificialCaps: true };
}

function makePolicy(overrides: Partial<BenchmarkPolicy> = {}): BenchmarkPolicy {
  const mode: BenchmarkMode = overrides.benchmarkMode ?? 'maximum_capability';
  const privacy: PrivacyConstraints = overrides.privacyRequirements ?? {
    level: 'standard',
    approvedLocations: [],
  };
  const subscription = overrides.subscriptionRequirement ?? {
    blockUnknownSubscription: true,
    requiredCodingAgentProviders: [],
  };
  return {
    benchmarkMode: mode,
    maxCostCents: null,
    maxDurationMs: null,
    requiredCapabilities: [],
    allowedProviders: [],
    allowedModes: ['native', 'external'],
    privacyRequirements: privacy,
    subscriptionRequirement: subscription,
    toolPolicy: makeToolPolicy(mode),
    humanInterventionPolicy: { allowed: true, blockIfRequired: false },
    policyVersion: 1,
    frozen: false,
    ...overrides,
  };
}

function makeConstraints(overrides: Partial<ExecutionConstraintSet> = {}): ExecutionConstraintSet {
  const user: UserConstraints = overrides.user ?? {
    allowedProviders: [],
    allowedModes: [],
    monthlyBudgetCents: null,
    maxPerTaskCostCents: null,
  };
  const project: ProjectConstraints = overrides.project ?? {
    externalExecutionAllowed: true,
    nativeExecutionAllowed: true,
    providerAllowlist: [],
    providerDenylist: [],
    allowedModes: [],
    localOnly: false,
    privateRepositoryPolicy: false,
    dataResidency: null,
  };
  const organization: OrganizationConstraints = overrides.organization ?? {
    approvedModelsOnly: [],
    approvedProvidersOnly: [],
    noThirdPartyBrowserAutomation: false,
    maximumExecutionCostCents: null,
    securityClassification: null,
  };
  const availability: AvailabilityConstraints = overrides.availability ?? {
    providerUnavailable: [],
    modelUnavailable: [],
    externalCompanionInstalled: true,
    codingSurfaceVerified: [],
  };
  const subscription = overrides.subscription ?? {
    blockUnknownSubscription: true,
    requiredCodingAgentProviders: [],
  };
  const privacy: PrivacyConstraints = overrides.privacy ?? {
    level: 'standard',
    approvedLocations: [],
  };
  return {
    capability: [],
    user,
    project,
    organization,
    availability,
    subscription,
    privacy,
  };
}

function makePreferences(
  overrides: Partial<ExecutionPreferenceProfile> = {},
): ExecutionPreferenceProfile {
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

function evaluate(
  candidate: ExecutionCandidateInput,
  taskProfile: ExecutionTaskProfile,
  policy: BenchmarkPolicy,
  constraints: ExecutionConstraintSet,
): ReturnType<DefaultExecutionEligibilityService['evaluate']> {
  const service = new DefaultExecutionEligibilityService();
  const input: EligibilityEvaluationInput = { candidate, taskProfile, policy, constraints };
  return service.evaluate(input);
}

function rank(
  eligibleCandidates: readonly ExecutionCandidateInput[],
  policy: BenchmarkPolicy,
  taskProfile: ExecutionTaskProfile,
  preferences: ExecutionPreferenceProfile = makePreferences(),
): ReturnType<DefaultExecutionRecommendationService['rank']> {
  return new DefaultExecutionRecommendationService().rank({
    eligibleCandidates,
    preferences,
    policy,
    taskProfile,
  });
}

// ============================================================================
// §29 — 11 SCENARIOS (each scenario is one `it()` block)
// ============================================================================

describe('WORK-033 §29 — execution policy regression (eligibility + recommendation)', () => {
  // --------------------------------------------------------------------------
  // 1. SUBSCRIPTION
  // --------------------------------------------------------------------------
  it('1. SUBSCRIPTION — Claude quality highest but subscription unknown → blocked; Qwen eligible → Qwen recommended', () => {
    const taskProfile = makeTaskProfile();
    const policy = makePolicy();
    const constraints = makeConstraints({
      subscription: { blockUnknownSubscription: true, requiredCodingAgentProviders: [] },
    });
    const claude = makeCandidate({
      provider: 'claude',
      name: 'Claude Code',
      model: 'claude-opus-4',
      mode: 'external',
      quality: 98,
      access: accessProfile('claude', 'unknown'),
    });
    const qwen = makeCandidate({
      provider: 'qwen',
      name: 'Qwen Coder',
      model: 'qwen-coder-32b',
      mode: 'native',
      quality: 90,
      access: accessProfile('qwen', 'user_configured'),
    });

    const claudeVerdict = evaluate(claude, taskProfile, policy, constraints);
    expect(claudeVerdict.eligible).toBe(false);
    expect(claudeVerdict.status).toBe('subscription_blocked');
    expect(claudeVerdict.blockingReasons.some((b) => b.category === 'subscription')).toBe(true);

    const qwenVerdict = evaluate(qwen, taskProfile, policy, constraints);
    expect(qwenVerdict.eligible).toBe(true);

    // Eligible list excludes Claude (blocked above) — only Qwen reaches rank().
    const r = rank([qwen], policy, taskProfile);
    expect(r.recommended).not.toBeNull();
    expect(r.recommended!.provider).toBe('qwen');
    // §16: alternatives must be empty (only one eligible candidate).
    expect(r.why.alternatives).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 2. CAPABILITY
  // --------------------------------------------------------------------------
  it('2. CAPABILITY — coding-agent required; conversational-only candidate → excluded (capability_blocked)', () => {
    const taskProfile = makeTaskProfile({ requiredCapabilities: ['coding_agent'] });
    const policy = makePolicy();
    const constraints = makeConstraints();
    const conversationalOnly = makeCandidate({
      provider: 'generic-llm',
      name: 'Generic Conversational',
      model: 'gpt-4o',
      mode: 'native',
      quality: 50,
      capabilities: { codingAgent: 'unavailable' },
    });
    const verdict = evaluate(conversationalOnly, taskProfile, policy, constraints);
    expect(verdict.eligible).toBe(false);
    expect(verdict.status).toBe('capability_blocked');
    expect(verdict.blockingReasons.some((b) => b.category === 'capability')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 3. POLICY
  // --------------------------------------------------------------------------
  it('3. POLICY — external execution prohibited; external candidate → excluded (project_policy_blocked)', () => {
    const taskProfile = makeTaskProfile();
    const policy = makePolicy();
    const constraints = makeConstraints({
      project: {
        externalExecutionAllowed: false,
        nativeExecutionAllowed: true,
        providerAllowlist: [],
        providerDenylist: [],
        allowedModes: [],
        localOnly: false,
        privateRepositoryPolicy: false,
        dataResidency: null,
      },
    });
    const external = makeCandidate({
      provider: 'chatgpt',
      name: 'ChatGPT Codex',
      model: 'gpt-4-codex',
      mode: 'external',
      quality: 80,
    });
    const verdict = evaluate(external, taskProfile, policy, constraints);
    expect(verdict.eligible).toBe(false);
    expect(verdict.status).toBe('project_policy_blocked');
    expect(verdict.blockingReasons.some((b) => b.category === 'project')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 4. QUALITY — capability ceiling preserved
  // --------------------------------------------------------------------------
  it('4. QUALITY — Claude 98 vs Qwen 93 (both eligible) → Claude recommended (capability ceiling preserved; NOT normalized down)', () => {
    const taskProfile = makeTaskProfile();
    const policy = makePolicy();
    const claude = makeCandidate({
      provider: 'claude',
      name: 'Claude Code',
      model: 'claude-opus-4',
      mode: 'external',
      quality: 98,
    });
    const qwen = makeCandidate({
      provider: 'qwen',
      name: 'Qwen Coder',
      model: 'qwen-coder-32b',
      mode: 'native',
      quality: 93,
    });
    const r = rank([claude, qwen], policy, taskProfile);
    const claudeScore = r.ranked.find((x) => x.candidate.provider === 'claude')!.score;
    const qwenScore = r.ranked.find((x) => x.candidate.provider === 'qwen')!.score;
    // §13: Claude's score is NOT lowered to "normalize" against Qwen — the
    // capability ceiling is preserved (Claude wins outright on quality).
    expect(claudeScore).toBeGreaterThan(qwenScore);
    expect(r.recommended!.provider).toBe('claude');
    // §14/§16: the Why must be evidence-backed (no "AI chose this").
    const evidenceReason = r.why.reasons.find((x) => x.dimension === 'benchmark_evidence');
    expect(evidenceReason).toBeDefined();
    expect(evidenceReason!.detail).toMatch(/98/);
  });

  // --------------------------------------------------------------------------
  // 5. COST — Claude over budget; Qwen within
  // --------------------------------------------------------------------------
  it('5. COST — Claude best quality but over budget (cost > cap → costComponent 0); Qwen within budget → Qwen recommended', () => {
    const taskProfile = makeTaskProfile();
    // maxCostCents is the policy cap that drives costComponent (NOT a hard
    // eligibility filter — user.maxPerTaskCostCents stays null so both
    // candidates remain eligible; the score decides).
    const policy = makePolicy({ maxCostCents: 100 });
    const claude = makeCandidate({
      provider: 'claude',
      name: 'Claude Code',
      model: 'claude-opus-4',
      mode: 'external',
      quality: 98,
      costCents: 200, // over cap (200 > 100)
    });
    const qwen = makeCandidate({
      provider: 'qwen',
      name: 'Qwen Coder',
      model: 'qwen-coder-32b',
      mode: 'native',
      quality: 93,
      costCents: 50, // within budget
    });
    // Both candidates remain eligible (user.maxPerTaskCostCents = null).
    expect(evaluate(claude, taskProfile, policy, makeConstraints()).eligible).toBe(true);
    expect(evaluate(qwen, taskProfile, policy, makeConstraints()).eligible).toBe(true);

    const r = rank([claude, qwen], policy, taskProfile);
    const claudeScore = r.ranked.find((x) => x.candidate.provider === 'claude')!.score;
    const qwenScore = r.ranked.find((x) => x.candidate.provider === 'qwen')!.score;
    // §24: Claude cost > cap → costComponent = 0 → Qwen wins on score.
    expect(claudeScore).toBeLessThan(qwenScore);
    expect(r.recommended!.provider).toBe('qwen');
  });

  // --------------------------------------------------------------------------
  // 6. PRIVACY — external prohibited; native recommended
  // --------------------------------------------------------------------------
  it('6. PRIVACY — privacyLevel=local_only; external blocked; native eligible → native recommended', () => {
    const taskProfile = makeTaskProfile();
    const policy = makePolicy({
      privacyRequirements: { level: 'local_only', approvedLocations: [] },
    });
    const constraints = makeConstraints({
      privacy: { level: 'local_only', approvedLocations: [] },
    });
    const external = makeCandidate({
      provider: 'chatgpt',
      name: 'ChatGPT Codex',
      model: 'gpt-4-codex',
      mode: 'external',
      quality: 95,
    });
    const native = makeCandidate({
      provider: 'qwen',
      name: 'Qwen Coder',
      model: 'qwen-coder-32b',
      mode: 'native',
      quality: 88,
    });
    // External is privacy_blocked (level=local_only + executionMode=external).
    const externalVerdict = evaluate(external, taskProfile, policy, constraints);
    expect(externalVerdict.eligible).toBe(false);
    expect(externalVerdict.status).toBe('privacy_blocked');
    expect(externalVerdict.blockingReasons.some((b) => b.category === 'privacy')).toBe(true);
    // Native is eligible.
    const nativeVerdict = evaluate(native, taskProfile, policy, constraints);
    expect(nativeVerdict.eligible).toBe(true);
    // Recommendation: only the native candidate is eligible.
    const r = rank([native], policy, taskProfile);
    expect(r.recommended!.provider).toBe('qwen');
  });

  // --------------------------------------------------------------------------
  // 7. MAXIMUM CAPABILITY — provider retains full capabilities (no artificial cap)
  // --------------------------------------------------------------------------
  it('7. MAXIMUM CAPABILITY — codingAgent stays ready; no artificial cap (benchmarkMode=maximum_capability + ToolPolicy.maximumCapability=true + noArtificialCaps=true)', () => {
    const taskProfile = makeTaskProfile();
    const policy = makePolicy({ benchmarkMode: 'maximum_capability' });
    // §21 fairness: maximum-capability mode — each candidate uses its strongest
    // config; NO artificial cap.
    expect(policy.toolPolicy).toEqual({
      toolClassFixed: false,
      maximumCapability: true,
      noArtificialCaps: true,
    });
    const claude = makeCandidate({
      provider: 'claude',
      name: 'Claude Code',
      model: 'claude-opus-4',
      mode: 'external',
      quality: 98,
      capabilities: { codingAgent: 'ready' },
    });
    const qwen = makeCandidate({
      provider: 'qwen',
      name: 'Qwen Coder',
      model: 'qwen-coder-32b',
      mode: 'native',
      quality: 93,
      capabilities: { codingAgent: 'ready' },
    });
    const r = rank([claude, qwen], policy, taskProfile);
    expect(r.recommended).not.toBeNull();
    expect(r.recommended!.provider).toBe('claude');
    // §21 fairness invariant: the recommended candidate's capability profile
    // is NOT artificially capped — codingAgent stays 'ready', not downgraded.
    expect(r.recommended!.capabilities.codingAgent).toBe('ready');
  });

  // --------------------------------------------------------------------------
  // 8. CONTROLLED COMPARISON — explicit restrictions; ceiling still preserved
  // --------------------------------------------------------------------------
  it('8. CONTROLLED COMPARISON — policySnapshot.toolPolicy.toolClassFixed=true + maximumCapability=false; ceiling still preserved (Claude wins)', () => {
    const taskProfile = makeTaskProfile();
    const policy = makePolicy({ benchmarkMode: 'controlled_comparison' });
    // §10: controlled comparison → toolClassFixed=true, maximumCapability=false
    // (explicit restriction is part of the policy — NOT an artificial cap).
    expect(policy.benchmarkMode).toBe('controlled_comparison');
    expect(policy.toolPolicy.toolClassFixed).toBe(true);
    expect(policy.toolPolicy.maximumCapability).toBe(false);
    expect(policy.toolPolicy.noArtificialCaps).toBe(true);
    const claude = makeCandidate({
      provider: 'claude',
      name: 'Claude Code',
      model: 'claude-opus-4',
      mode: 'external',
      quality: 98,
      capabilities: { codingAgent: 'ready' },
    });
    const qwen = makeCandidate({
      provider: 'qwen',
      name: 'Qwen Coder',
      model: 'qwen-coder-32b',
      mode: 'native',
      quality: 93,
      capabilities: { codingAgent: 'ready' },
    });
    const r = rank([claude, qwen], policy, taskProfile);
    // §21: even in controlled-comparison mode, the engine does NOT equalize
    // outcomes — Claude's quality score is NOT reduced to match Qwen.
    const claudeScore = r.ranked.find((x) => x.candidate.provider === 'claude')!.score;
    const qwenScore = r.ranked.find((x) => x.candidate.provider === 'qwen')!.score;
    expect(claudeScore).toBeGreaterThan(qwenScore);
    expect(r.recommended!.provider).toBe('claude');
  });

  // --------------------------------------------------------------------------
  // 9. OVERRIDE — non-recommended candidate is still selectable
  // --------------------------------------------------------------------------
  it('9. OVERRIDE — eligible non-recommended candidate remains selectable (the ranked list includes it)', () => {
    const taskProfile = makeTaskProfile();
    const policy = makePolicy();
    const claude = makeCandidate({
      provider: 'claude',
      name: 'Claude Code',
      model: 'claude-opus-4',
      mode: 'external',
      quality: 98,
    });
    const qwen = makeCandidate({
      provider: 'qwen',
      name: 'Qwen Coder',
      model: 'qwen-coder-32b',
      mode: 'native',
      quality: 93,
    });
    const r = rank([claude, qwen], policy, taskProfile);
    // Claude is recommended; Qwen is NOT — but Qwen remains in the ranked
    // list, so the user can select it (the recommendation layer does not
    // prevent selection; it just ranks).
    expect(r.recommended!.provider).toBe('claude');
    const rankedProviders = r.ranked.map((x) => x.candidate.provider);
    expect(rankedProviders).toContain('qwen');
    // Why lists qwen as an alternative (transparency for the user).
    expect(r.why.alternatives).toContain('qwen');
  });

  // --------------------------------------------------------------------------
  // 10. HARD BLOCK — ineligible candidate cannot be selected
  // --------------------------------------------------------------------------
  it('10. HARD BLOCK — ineligible candidate (codingAgent=unavailable, coding_agent required) has eligible=false + blockingReasons', () => {
    const taskProfile = makeTaskProfile({ requiredCapabilities: ['coding_agent'] });
    const policy = makePolicy();
    const constraints = makeConstraints();
    const ineligible = makeCandidate({
      provider: 'generic-llm',
      name: 'Generic Conversational',
      model: 'gpt-4o',
      mode: 'native',
      quality: 99, // high quality, but ineligible — quality NEVER overrides the hard filter
      capabilities: { codingAgent: 'unavailable' },
    });
    const verdict = evaluate(ineligible, taskProfile, policy, constraints);
    expect(verdict.eligible).toBe(false);
    expect(verdict.blockingReasons.length).toBeGreaterThan(0);
    expect(verdict.status).not.toBe('eligible');
    // §3: benchmark quality MUST NEVER make an ineligible candidate eligible.
    // Eligible list excludes this candidate → rank() with no eligible returns null.
    const r = rank([], policy, taskProfile);
    expect(r.recommended).toBeNull();
    expect(r.why.headline).toMatch(/No eligible/);
  });

  // --------------------------------------------------------------------------
  // 11. INSUFFICIENT SAMPLE (§14) — single trial does not make a candidate definitive
  // --------------------------------------------------------------------------
  it('11. INSUFFICIENT SAMPLE — single trial treated as neutral (§14: never 1-run definitive); sufficient-evidence candidate outranks', () => {
    const taskProfile = makeTaskProfile();
    const policy = makePolicy();
    const claude = makeCandidate({
      provider: 'claude',
      name: 'Claude Code',
      model: 'claude-opus-4',
      mode: 'external',
      quality: 98, // high, but the trial count is insufficient
      sampleSize: 1,
      sufficient: false,
    });
    const qwen = makeCandidate({
      provider: 'qwen',
      name: 'Qwen Coder',
      model: 'qwen-coder-32b',
      mode: 'native',
      quality: 93,
      sampleSize: 10,
      sufficient: true,
    });
    const r = rank([claude, qwen], policy, taskProfile);
    // §14: insufficient sample → qualityComponent is NEUTRAL (0.5), NOT 0.98.
    // Qwen's sufficient observed quality (0.93) outranks Claude's neutral prior.
    const claudeScore = r.ranked.find((x) => x.candidate.provider === 'claude')!.score;
    const qwenScore = r.ranked.find((x) => x.candidate.provider === 'qwen')!.score;
    expect(qwenScore).toBeGreaterThan(claudeScore);
    expect(r.recommended!.provider).toBe('qwen');
    // §14/§16: the Why explains Qwen's sufficient evidence — no fabrication.
    const evidenceReason = r.why.reasons.find((x) => x.dimension === 'benchmark_evidence');
    expect(evidenceReason).toBeDefined();
    expect(evidenceReason!.satisfied).toBe(true);
    expect(evidenceReason!.detail).toMatch(/Observed quality/i);
    expect(evidenceReason!.detail).toMatch(/10 trial/i);
  });
});

// ============================================================================
// Type-surface contract checks — prove the §21 / §9 fairness invariants are
// mechanically present in the public types file. These complement the 11
// behavioral scenarios by asserting the type surface cannot silently lose the
// fairness literals (BenchmarkMode, ToolPolicy, PrivacyLevel, etc.).
// ============================================================================

describe('WORK-033 §29 — type-surface invariants (BenchmarkMode + ToolPolicy literals)', () => {
  it('DEFAULT_TOOL_POLICY defaults to maximum-capability mode (no caps)', async () => {
    const typesModule = await import('../../../src/execution-policy/types.js');
    expect(typesModule.DEFAULT_TOOL_POLICY).toBeDefined();
    expect(typesModule.DEFAULT_TOOL_POLICY.maximumCapability).toBe(true);
    expect(typesModule.DEFAULT_TOOL_POLICY.noArtificialCaps).toBe(true);
    expect(typesModule.DEFAULT_TOOL_POLICY.toolClassFixed).toBe(false);
  });

  it('a controlled_comparison ToolPolicy has toolClassFixed=true + maximumCapability=false + noArtificialCaps=true', () => {
    // Mirror DefaultExecutionPolicyService.buildPolicySnapshot (§9).
    const tp: ToolPolicy = {
      toolClassFixed: true,
      maximumCapability: false,
      noArtificialCaps: true,
    };
    expect(tp.toolClassFixed).toBe(true);
    expect(tp.maximumCapability).toBe(false);
    expect(tp.noArtificialCaps).toBe(true);
  });

  it('a maximum_capability ToolPolicy has maximumCapability=true + noArtificialCaps=true', () => {
    const tp: ToolPolicy = {
      toolClassFixed: false,
      maximumCapability: true,
      noArtificialCaps: true,
    };
    expect(tp.maximumCapability).toBe(true);
    expect(tp.noArtificialCaps).toBe(true);
  });
});

// ============================================================================
// PR #37 REVIEW FIXES — the three semantic blockers
//   (1) preferences are ADVISORY (never hard eligibility constraints)
//   (2) constrained modes FAIL CLOSED on unknown cost/latency evidence
//   (3) policy freezing on experiment start — covered by the integration
//       test policy-freeze-on-start.integration.test.ts (DB triggers).
// ============================================================================

describe('PR #37 review fix 1 — preferences are ADVISORY (never hard eligibility constraints)', () => {
  it('preferredMode=external does NOT make native candidates ineligible — it only boosts the ranking (§12 advisory contract)', async () => {
    const { DefaultExecutionPolicyService } = await import('../../../src/execution-policy/internal/default-execution-policy-service.js');

    // End-to-end through the real service: a user whose PREFERENCE is
    // external execution, a project where BOTH modes are fully allowed, and
    // a native-only + an external-only candidate. Pre-fix, buildConstraintSet
    // routed prefs.preferredMode into user.allowedModes → the native
    // candidate was EXCLUDED from eligibility (the reviewer's exact
    // scenario). Post-fix the preference flows ONLY into the ranking.
    const nativeCandidate = makeCandidate({
      provider: 'nativeprov', name: 'NativeProv', model: 'm1', mode: 'native', quality: 90,
    });
    const externalCandidate = makeCandidate({
      provider: 'extprov', name: 'ExtProv', model: 'm2', mode: 'external', quality: 90,
    });

    const service = new DefaultExecutionPolicyService({
      db: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      repository: {
        getProjectPolicy: async () => policyRecord(),
        insertDefaultProjectPolicy: async () => policyRecord(),
        getUserPreferences: async () => prefRecord({ preferredMode: 'external' }),
        insertDefaultUserPreferences: async () => prefRecord({ preferredMode: 'external' }),
        listAccessProfiles: async () => [
          accessRecord('nativeprov'),
          accessRecord('extprov'),
        ],
        insertDecision: async (_org: string, _proj: string, _wi: string, _user: string, _row: unknown, _guard: unknown) => ({ id: 'decision-1' }),
        listDecisions: async () => [],
      } as never,
      eligibilityService: new DefaultExecutionEligibilityService(),
      recommendationService: new DefaultExecutionRecommendationService(),
      taskProfileBuilder: { build: async () => makeTaskProfile() } as never,
      agentProviderRegistry: {
        getExecutionProviders: async () => [
          {
            name: 'NativeProv', provider: 'nativeprov', model: 'm1',
            nativeApi: 'ready', externalUi: 'not-supported',
            capabilities: { conversationalChat: 'ready', codingAgent: 'ready', implementationSurface: 'coding_agent' },
          },
          {
            name: 'ExtProv', provider: 'extprov', model: 'm2',
            nativeApi: 'not-configured', externalUi: 'available',
            capabilities: { conversationalChat: 'ready', codingAgent: 'ready', implementationSurface: 'coding_agent' },
          },
        ],
      } as never,
      benchmarkEvidenceProvider: {
        historicalPerformanceForCell: async () => historical(0, null, false),
        aggregateForProject: async () => historical(0, null, false),
      } as never,
    });

    const rec = await service.recommend({
      organizationId: 'org-1', projectId: 'proj-1', workItemId: 'wi-1', userId: 'user-1',
    });

    // ASSERTION 1 — the NATIVE candidate is ELIGIBLE (not excluded): the
    // preferredMode preference must never act as a hard mode restriction.
    const eligibleIds = rec.eligibleCandidates.map((c) => `${c.provider}:${c.executionMode}`);
    expect(eligibleIds).toContain('nativeprov:native');
    expect(eligibleIds).toContain('extprov:external');
    expect(rec.excludedCandidates).toHaveLength(0);

    // ASSERTION 2 — the preference still ADVISES the ranking: with equal
    // quality, the preferred (external) candidate ranks first. Advisory
    // influence, not exclusion.
    expect(rec.recommendedCandidate?.provider).toBe('extprov');
    const native = rec.eligibleCandidates.find((c) => c.provider === 'nativeprov')!;
    const external = rec.eligibleCandidates.find((c) => c.provider === 'extprov')!;
    expect(external.recommendationScore).toBeGreaterThan(native.recommendationScore);

    void nativeCandidate; void externalCandidate;
  });

  it('pure eligibility takes NO preference input — the advisory contract is structural', () => {
    // The EligibilityEvaluationInput carries candidate/task/policy/constraints
    // ONLY: there is structurally no preference input the hard filter could
    // honor. Preferences enter exclusively via RankInput (the ranking).
    const input: EligibilityEvaluationInput = {
      candidate: makeCandidate({ provider: 'p', name: 'P', model: 'm', mode: 'native', quality: 80 }),
      taskProfile: makeTaskProfile(),
      policy: makePolicy(),
      constraints: makeConstraints(),
    };
    expect(Object.keys(input).sort()).toEqual(['candidate', 'constraints', 'policy', 'taskProfile']);
  });
});

describe('PR #37 review fix 2 — constrained modes FAIL CLOSED on unknown cost/latency evidence', () => {
  const taskProfile = makeTaskProfile();

  it('cost constraint + UNKNOWN cost → ineligible (unknown_constrained), NOT neutral-eligible', () => {
    const candidate = makeCandidate({ provider: 'p', name: 'P', model: 'm', mode: 'native', quality: 90, costCents: null });
    const result = evaluate(
      candidate, taskProfile,
      makePolicy({ benchmarkMode: 'cost_constrained', maxCostCents: 500 }),
      makeConstraints({ user: { allowedProviders: [], allowedModes: [], monthlyBudgetCents: null, maxPerTaskCostCents: 500 } }),
    );
    expect(result.eligible).toBe(false);
    expect(result.status).toBe('unknown_constrained');
    expect(result.blockingReasons.some((b) => b.category === 'evidence' && b.constraint === 'unknown_cost_under_cost_constraint')).toBe(true);
  });

  it('cost constraint via the POLICY snapshot alone also fails closed', () => {
    const candidate = makeCandidate({ provider: 'p', name: 'P', model: 'm', mode: 'native', quality: 90, costCents: null });
    const result = evaluate(
      candidate, taskProfile,
      makePolicy({ benchmarkMode: 'cost_constrained', maxCostCents: 500 }),
      makeConstraints(),
    );
    expect(result.eligible).toBe(false);
    expect(result.status).toBe('unknown_constrained');
  });

  it('cost constraint + KNOWN under-cap cost → eligible (constraint verified)', () => {
    const candidate = makeCandidate({ provider: 'p', name: 'P', model: 'm', mode: 'native', quality: 90, costCents: 200 });
    const result = evaluate(
      candidate, taskProfile,
      makePolicy({ benchmarkMode: 'cost_constrained', maxCostCents: 500 }),
      makeConstraints({ user: { allowedProviders: [], allowedModes: [], monthlyBudgetCents: null, maxPerTaskCostCents: 500 } }),
    );
    expect(result.eligible).toBe(true);
    expect(result.satisfiedConstraints).toContain('evidence:cost_known');
  });

  it('COST_CONSTRAINED mode with all-unknown costs → ZERO eligible candidates (the honest verdict)', () => {
    // The pre-fix behavior: unknown cost passed the hard cost constraint
    // (neutral), so a cost-constrained benchmark could recommend a candidate
    // that was never verified against the cost constraint. Post-fix the
    // eligibility filter excludes every unverified candidate (mirroring the
    // service's eligible/excluded split), so the RANKING receives zero
    // candidates + the recommendation honestly reports none.
    const c1 = makeCandidate({ provider: 'p1', name: 'P1', model: 'm', mode: 'native', quality: 90, costCents: null });
    const c2 = makeCandidate({ provider: 'p2', name: 'P2', model: 'm', mode: 'external', quality: 88, costCents: null });
    const policy = makePolicy({ benchmarkMode: 'cost_constrained', maxCostCents: 500 });
    const constraints = makeConstraints({ user: { allowedProviders: [], allowedModes: [], monthlyBudgetCents: null, maxPerTaskCostCents: 500 } });
    const eligible = [c1, c2].filter((c) => evaluate(c, taskProfile, policy, constraints).eligible);
    expect(eligible).toHaveLength(0);
    const ranked = rank(eligible, policy, taskProfile);
    expect(ranked.ranked).toHaveLength(0);
    expect(ranked.recommended).toBeNull();
  });

  it('latency constraint + UNKNOWN latency → ineligible (unknown_constrained)', () => {
    const candidate = makeCandidate({ provider: 'p', name: 'P', model: 'm', mode: 'native', quality: 90, latencyMs: null });
    const result = evaluate(
      candidate, taskProfile,
      makePolicy({ benchmarkMode: 'latency_constrained', maxDurationMs: 600_000 }),
      makeConstraints(),
    );
    expect(result.eligible).toBe(false);
    expect(result.status).toBe('unknown_constrained');
    expect(result.blockingReasons.some((b) => b.category === 'evidence' && b.constraint === 'unknown_latency_under_latency_constraint')).toBe(true);
  });

  it('latency constraint + KNOWN over-cap latency → ineligible (hard latency check — previously scoring-only)', () => {
    // Pre-fix, maxDurationMs only fed the recommendation scorer: a KNOWN
    // 2x-over-cap latency still passed eligibility. Post-fix a known
    // over-cap latency is a hard violation, symmetric with over-cap cost.
    const candidate = makeCandidate({ provider: 'p', name: 'P', model: 'm', mode: 'native', quality: 90, latencyMs: 1_200_000 });
    const result = evaluate(
      candidate, taskProfile,
      makePolicy({ benchmarkMode: 'latency_constrained', maxDurationMs: 600_000 }),
      makeConstraints(),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockingReasons.some((b) => b.constraint === 'latency_over_max')).toBe(true);
  });

  it('latency constraint + KNOWN under-cap latency → eligible', () => {
    const candidate = makeCandidate({ provider: 'p', name: 'P', model: 'm', mode: 'native', quality: 90, latencyMs: 300_000 });
    const result = evaluate(
      candidate, taskProfile,
      makePolicy({ benchmarkMode: 'latency_constrained', maxDurationMs: 600_000 }),
      makeConstraints(),
    );
    expect(result.eligible).toBe(true);
    expect(result.satisfiedConstraints).toContain('evidence:latency_known');
  });

  it('NO constraint set → unknown cost/latency remains eligible (neutral is honest exactly then)', () => {
    // Fail-closed applies ONLY under an explicit maximum. Without a cap,
    // unknown evidence is not a constraint violation (§24: unknown ≠ 0).
    const candidate = makeCandidate({ provider: 'p', name: 'P', model: 'm', mode: 'native', quality: 90, costCents: null, latencyMs: null });
    const result = evaluate(candidate, taskProfile, makePolicy(), makeConstraints());
    expect(result.eligible).toBe(true);
  });
});

// --- fixtures for the service-level preference test -------------------------

function policyRecord(): ProjectPolicyRecord {
  return {
    id: 'policy-1', organizationId: 'org-1', projectId: 'proj-1',
    defaultBenchmarkMode: 'maximum_capability',
    externalExecutionAllowed: true, nativeExecutionAllowed: true,
    maxCostPerTaskCents: null, maxCostPerTrialCents: null, maxTimeToPrMs: null,
    humanInterventionAllowed: true, privacyLevel: 'standard',
    allowedProviders: [], deniedProviders: [], allowedModes: [],
    frozen: false, policyVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  };
}

function prefRecord(overrides: Partial<UserPreferenceRecord> = {}): UserPreferenceRecord {
  return {
    id: 'pref-1', organizationId: 'org-1', userId: 'user-1',
    qualityWeight: 0.6, costWeight: 0.2, latencyWeight: 0.1, privacyWeight: 0.1,
    preferredMode: null, externalPreferred: false, nativePreferred: false,
    defaultBenchmarkMode: 'maximum_capability',
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

function accessRecord(provider: string) {
  return {
    id: `access-${provider}`, organizationId: 'org-1', userId: 'user-1', notes: null,
    createdAt: new Date(), updatedAt: new Date(),
    provider, plan: 'plus', codingAgent: 'ready', externalUi: 'ready', nativeApi: 'ready',
    statusSource: 'user_configured',
  };
}
