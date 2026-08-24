/**
 * WORK-033 §1/§16 — DefaultExecutionPolicyService.
 *
 * The application-layer orchestrator. Produces recommendations, persists §22
 * append-only decisions, exposes project/user/org policy + preference CRUD,
 * and freezes policies when a benchmark experiment starts (§9).
 *
 * Authority model (mirrors §34 benchmark boundary):
 *   - reads provider capability via @modules/agents AgentProviderRegistry
 *   - reads historical evidence via @root/benchmark BenchmarkRepository
 *   - derives task profile via @modules/work-items repositories (types only)
 *   - NEVER mutates workflow state; NEVER stores credentials; NEVER invents
 *     capabilities (composes ExecutionProviderInfo + EXTERNAL_UI_CATALOG).
 *
 * The recommendation is ADVISORY: the caller (route layer) still submits via
 * ExecutionService.submit() — this layer never bypasses it (§34).
 */
import type {
  BenchmarkMode,
  BenchmarkPolicy,
  CostEstimate,
  EligibilityEvaluationInput,
  ExecutionCandidate,
  ExecutionCandidateInput,
  ExecutionConstraintSet,
  ExecutionEligibilityResult,
  ExecutionHandoffPolicy,
  ExecutionPolicyDecisionRecord,
  ExecutionPolicyService,
  ExecutionPreferenceProfile,
  ExecutionRecommendation,
  ExecutionTaskProfile,
  LatencyEstimate,
  ProjectPolicyRecord,
  ProviderAccessProfile,
  ProviderAccessProfileRecord,
  ProviderAvailability,
  UserPreferenceRecord,
  RecommendInput,
  RecommendationWhy,
  UpdateProjectPolicyInput,
  UpdateUserPreferencesInput,
  UpsertAccessProfileInput,
  ToolPolicy,
  ControlledComparisonDimensions,
} from '../types.js';
import type {
  DefaultExecutionPolicyServiceDeps,
  ResolvedOrgPolicy,
} from './execution-policy.types.js';
import { ProviderCapabilityNormalizer } from './provider-capability-normalizer.js';
import type { ExecutionProviderInfo } from '@modules/agents';

export class DefaultExecutionPolicyService implements ExecutionPolicyService {
  constructor(private readonly deps: DefaultExecutionPolicyServiceDeps) {}

  async recommend(input: RecommendInput): Promise<ExecutionRecommendation> {
    const { organizationId, projectId, workItemId, userId } = input;

    // --- load policy + preferences (create defaults if absent) ---
    let policy = await this.deps.repository.getProjectPolicy(projectId);
    if (!policy) policy = await this.deps.repository.insertDefaultProjectPolicy(organizationId, projectId);
    let prefs = await this.deps.repository.getUserPreferences(userId);
    if (!prefs) prefs = await this.deps.repository.insertDefaultUserPreferences(organizationId, userId);
    const accessProfiles = await this.deps.repository.listAccessProfiles(userId);

    // --- derive task profile (§15) ---
    const taskProfile = await this.deps.taskProfileBuilder.build(workItemId);

    // --- resolve benchmark mode (explicit > project default > user pref) ---
    const benchmarkMode: BenchmarkMode = input.benchmarkMode ?? policy.defaultBenchmarkMode;

    // PR #37 review fix (frozen-mode override): a FROZEN policy's benchmark
    // mode is part of the immutable §9 policy version. An explicit
    // ?benchmarkMode= differing from the frozen policy's mode would produce
    // a decision claiming policyVersion N while using a DIFFERENT mode —
    // undermining the §9 immutability/audit guarantee. The override is
    // REJECTED (passing the SAME mode is a no-op and stays allowed;
    // unfrozen policies keep the §16 request-scoped override). Checked
    // BEFORE the mode-constraint validation: a frozen-policy override is a
    // frozen-state violation first, not a missing-cap problem.
    if (policy.frozen && input.benchmarkMode != null && input.benchmarkMode !== policy.defaultBenchmarkMode) {
      throw new Error(
        `execution-policy-frozen-mode: the project policy is frozen (policyVersion=${policy.policyVersion}, benchmarkMode=${policy.defaultBenchmarkMode}) — the frozen benchmark mode cannot be overridden at recommendation time (§9)`,
      );
    }

    // PR #37 review fix (constrained modes must be MEANINGFUL): reject the
    // request rather than silently producing an unconstrained-but-labeled-
    // constrained policy snapshot. COST_CONSTRAINED requires a cost cap;
    // LATENCY_CONSTRAINED requires a duration cap. An explicit
    // ?benchmarkMode=cost_constrained against a capless project is a
    // client error, not a fallback to unconstrained behavior.
    validateBenchmarkModeConstraint(benchmarkMode, policy.maxCostPerTaskCents, policy.maxTimeToPrMs);

    // --- build the policy snapshot at decision time (§9) ---
    const policySnapshot = this.buildPolicySnapshot(policy, benchmarkMode);

    // --- build candidates from existing provider metadata (§6 — no invent) ---
    const providers = await this.deps.agentProviderRegistry.getExecutionProviders(projectId);
    const accessMap = new Map<string, ProviderAccessProfile>(
      accessProfiles.map((a) => [a.provider, { provider: a.provider, plan: a.plan, codingAgent: a.codingAgent, externalUi: a.externalUi, nativeApi: a.nativeApi, statusSource: a.statusSource }]),
    );
    const normalizer = new ProviderCapabilityNormalizer(accessMap);
    const candidates = await this.buildCandidates(providers, normalizer, projectId, policySnapshot, taskProfile, accessMap);

    // --- build the constraint set (§4) ---
    // PR #37 review fix (preferences are ADVISORY): the user PREFERENCE
    // profile (§12 — preferredMode, externalPreferred, nativePreferred,
    // the scoring weights) is deliberately NOT an input here. Hard
    // constraints come from the PROJECT policy + org policy ONLY; the
    // preferences flow exclusively into the recommendation ranking
    // (toPreferenceProfile → recommendationService.rank). Feeding
    // prefs.preferredMode into user.allowedModes made a PREFERENCE act as a
    // hard eligibility block (preferredMode='external' excluded every
    // native candidate even when native execution was fully allowed) —
    // violating the §12 contract "advisory; NEVER overrides hard
    // constraints".
    const orgPolicy = this.deps.orgPolicyResolver ? await this.deps.orgPolicyResolver.resolve(organizationId) : null;
    const constraints = this.buildConstraintSet(policy, orgPolicy);

    // --- evaluate eligibility (§3 hard filter) ---
    const evaluated = candidates.map((c) => {
      const eligibilityInput: EligibilityEvaluationInput = {
        candidate: c,
        taskProfile,
        policy: policySnapshot,
        constraints,
      };
      const eligibility = this.deps.eligibilityService.evaluate(eligibilityInput);
      return { candidate: c, eligibility };
    });

    const eligible = evaluated.filter((e) => e.eligibility.eligible).map((e) => e.candidate);
    const excluded = evaluated.filter((e) => !e.eligibility.eligible).map((e) => attachEligibility(e.candidate, e.eligibility));

    // --- rank eligible candidates (§13 — preserve capability ceiling) ---
    const preferenceProfile = toPreferenceProfile(prefs);
    const rank = this.deps.recommendationService.rank({
      eligibleCandidates: eligible,
      preferences: preferenceProfile,
      policy: policySnapshot,
      taskProfile,
    });

    // --- aggregate benchmark evidence for the project (§14) ---
    const evidence = await this.deps.benchmarkEvidenceProvider.aggregateForProject(projectId);

    // --- build the recommendation (§16) ---
    const recommended = rank.recommended
      ? toCandidate(rank.recommended, findEligibility(evaluated, rank.recommended), rank.ranked[0]?.score ?? 0, policySnapshot)
      : null;
    const eligibleCandidates = rank.ranked.map((r) =>
      toCandidate(r.candidate, findEligibility(evaluated, r.candidate), r.score, policySnapshot),
    );

    const why: RecommendationWhy = rank.why;

    // --- persist the §22 append-only decision ---
    const decisionRow = {
      policyVersion: policy.policyVersion,
      benchmarkMode: policySnapshot.benchmarkMode,
      taskProfile,
      eligibleCandidates: eligibleCandidates.map(stripForAudit),
      excludedCandidates: excluded.map(stripForAudit),
      recommendedCandidate: recommended ? stripForAudit(recommended) : null,
      whyExplanation: `${why.headline}\n${why.reasons.map((r) => `${r.satisfied ? '✓' : '✗'} ${r.dimension}: ${r.detail}`).join('\n')}`,
      scores: Object.fromEntries(rank.ranked.map((r) => [r.candidate.provider, r.score])),
      benchmarkEvidence: evidence,
    };
    const decision = await this.deps.repository.insertDecision(organizationId, projectId, workItemId, userId, decisionRow);

    return {
      workItemId,
      recommendedCandidate: recommended,
      eligibleCandidates,
      excludedCandidates: excluded,
      why,
      benchmarkEvidence: evidence,
      policy: policySnapshot,
      taskProfile,
      decisionId: decision.id,
    };
  }

  // ------------------------------------------------------------------ CRUD

  async listDecisions(workItemId: string): Promise<readonly ExecutionPolicyDecisionRecord[]> {
    return this.deps.repository.listDecisions(workItemId);
  }

  async getProjectPolicy(projectId: string): Promise<ProjectPolicyRecord | null> {
    return this.deps.repository.getProjectPolicy(projectId);
  }

  async ensureProjectPolicy(organizationId: string, projectId: string): Promise<ProjectPolicyRecord> {
    const existing = await this.deps.repository.getProjectPolicy(projectId);
    if (existing) return existing;
    return this.deps.repository.insertDefaultProjectPolicy(organizationId, projectId);
  }

  async updateProjectPolicy(projectId: string, input: UpdateProjectPolicyInput): Promise<ProjectPolicyRecord> {
    // PR #37 review fix (constrained modes must be MEANINGFUL): validate
    // the MERGED result (existing policy + patch), not just the patch —
    // setting the mode without a cap AND removing the cap while the mode
    // stays constrained are both rejected. The migration-0033 DB CHECK is
    // the backstop; this gives the caller a clear domain error instead of
    // a raw constraint violation.
    const existing = await this.deps.repository.getProjectPolicy(projectId);
    if (existing) {
      validateBenchmarkModeConstraint(
        input.defaultBenchmarkMode ?? existing.defaultBenchmarkMode,
        input.maxCostPerTaskCents !== undefined ? input.maxCostPerTaskCents : existing.maxCostPerTaskCents,
        input.maxTimeToPrMs !== undefined ? input.maxTimeToPrMs : existing.maxTimeToPrMs,
      );
    }
    const updated = await this.deps.repository.updateProjectPolicy(projectId, input);
    if (!updated) throw new Error(`execution-policy: project ${projectId} not found (or frozen)`);
    return updated;
  }

  async freezeProjectPolicy(projectId: string): Promise<ProjectPolicyRecord> {
    // NOTE (PR #37 review fix): this EXPLICIT freeze is a convenience for
    // pre-freezing a policy before any experiment starts. The §9 GUARANTEE
    // itself is enforced at the persistence boundary by migration 0032 —
    // an AFTER UPDATE trigger on wfos_benchmark_experiments freezes the
    // project's policy atomically with the authoritative created|paused →
    // running start transition (no crash window, no bypass), and a BEFORE
    // INSERT trigger births policies frozen for projects that already
    // have started experiments. There is no code path that can leave an
    // experiment running with a mutable policy.
    const frozen = await this.deps.repository.freezeProjectPolicy(projectId);
    if (!frozen) throw new Error(`execution-policy: project ${projectId} not found`);
    return frozen;
  }

  async getUserPreferences(userId: string): Promise<UserPreferenceRecord | null> {
    return this.deps.repository.getUserPreferences(userId);
  }

  async ensureUserPreferences(organizationId: string, userId: string): Promise<UserPreferenceRecord> {
    const existing = await this.deps.repository.getUserPreferences(userId);
    if (existing) return existing;
    return this.deps.repository.insertDefaultUserPreferences(organizationId, userId);
  }

  async updateUserPreferences(userId: string, input: UpdateUserPreferencesInput): Promise<UserPreferenceRecord> {
    const updated = await this.deps.repository.updateUserPreferences(userId, input);
    if (!updated) throw new Error(`execution-policy: user ${userId} not found`);
    return updated;
  }

  async listAccessProfiles(userId: string): Promise<readonly ProviderAccessProfileRecord[]> {
    return this.deps.repository.listAccessProfiles(userId);
  }

  async upsertAccessProfile(organizationId: string, userId: string, input: UpsertAccessProfileInput): Promise<ProviderAccessProfileRecord> {
    return this.deps.repository.upsertAccessProfile(organizationId, userId, input);
  }

  controlledComparisonDimensions(): ControlledComparisonDimensions {
    // §10: WorkflowOS guarantees these dimensions for controlled comparison.
    // Same task/architecture/baseline/implementation context/verification/tool
    // class are all controlled; surface, context window, and tool implementation
    // genuinely differ (and are displayed as ≠).
    return {
      sameTask: true,
      sameArchitecture: true,
      sameBaseline: true,
      sameImplementationContext: true,
      sameVerification: true,
      comparableToolClass: true,
      differingSurfaces: true,
      differingContextWindow: true,
      differingToolImplementation: true,
    };
  }

  // ------------------------------------------------------------------ private

  private buildPolicySnapshot(policy: ProjectPolicyRecord, benchmarkMode: BenchmarkMode): BenchmarkPolicy {
    const toolPolicy: ToolPolicy =
      benchmarkMode === 'controlled_comparison'
        ? { toolClassFixed: true, maximumCapability: false, noArtificialCaps: true }
        : { toolClassFixed: false, maximumCapability: benchmarkMode === 'maximum_capability', noArtificialCaps: true };
    return {
      benchmarkMode,
      maxCostCents: policy.maxCostPerTaskCents,
      maxDurationMs: policy.maxTimeToPrMs,
      requiredCapabilities: [],
      allowedProviders: policy.allowedProviders,
      allowedModes: policy.allowedModes.length === 0 ? ['native', 'external'] : policy.allowedModes,
      privacyRequirements: { level: policy.privacyLevel, approvedLocations: [] },
      subscriptionRequirement: { blockUnknownSubscription: true, requiredCodingAgentProviders: [] },
      toolPolicy,
      humanInterventionPolicy: { allowed: policy.humanInterventionAllowed, blockIfRequired: !policy.humanInterventionAllowed },
      policyVersion: policy.policyVersion,
      frozen: policy.frozen,
    };
  }

  private async buildCandidates(
    providers: readonly ExecutionProviderInfo[],
    normalizer: ProviderCapabilityNormalizer,
    projectId: string,
    _policy: BenchmarkPolicy,
    _taskProfile: ExecutionTaskProfile,
    _accessMap: Map<string, ProviderAccessProfile>,
  ): Promise<ExecutionCandidateInput[]> {
    const out: ExecutionCandidateInput[] = [];
    for (const p of providers) {
      const supportedModes = ((): ('native' | 'external')[] => {
        const m: ('native' | 'external')[] = [];
        if (p.nativeApi === 'ready') m.push('native');
        if (p.externalUi === 'available') m.push('external');
        return m;
      })();
      for (const mode of supportedModes) {
        const capabilities = normalizer.normalizeForMode(p, mode);
        const access = _accessMap.get(p.provider) ?? null;
        const evidence = await this.deps.benchmarkEvidenceProvider.historicalPerformanceForCell(projectId, p.provider, mode);
        const cost: CostEstimate = { cents: null, confidence: 'unknown', currency: 'USD' };
        const latency: LatencyEstimate = {
          estimatedMs: evidence.medianTimeToVerifiedMs ?? null,
          confidence: evidence.sufficient ? 'known' : 'unknown',
          source: evidence.sufficient ? 'historical_observed' : 'unknown',
        };
        const availability = computeAvailability(p, mode, access);
        out.push({
          provider: p.provider,
          name: p.name,
          model: p.model,
          executionMode: mode,
          capabilities,
          accessProfile: access,
          availability,
          estimatedCost: cost,
          estimatedLatency: latency,
          historicalPerformance: evidence,
        });
      }
    }
    return out;
  }

  private buildConstraintSet(
    policy: ProjectPolicyRecord,
    org: ResolvedOrgPolicy | null,
  ): ExecutionConstraintSet {
    return {
      capability: [],
      user: {
        allowedProviders: [],
        // PR #37 review fix (preferences are ADVISORY, §12): user.allowedModes
        // is a HARD-constraint slot for an EXPLICIT user-configured mode
        // restriction — it is deliberately NOT populated from the preference
        // profile's preferredMode. Preferences influence RANKING only
        // (recommendationService's preferenceComponent + weights). A user
        // who prefers external execution must not hard-block native
        // candidates that satisfy every hard constraint.
        allowedModes: [],
        monthlyBudgetCents: null,
        // The project policy's per-task cost cap is a REAL hard constraint
        // (explicitly configured, not a preference) — it flows into the
        // user-constraint slot (and, via the policy snapshot, into the
        // fail-closed evidence check).
        maxPerTaskCostCents: policy.maxCostPerTaskCents,
      },
      project: {
        externalExecutionAllowed: policy.externalExecutionAllowed,
        nativeExecutionAllowed: policy.nativeExecutionAllowed,
        providerAllowlist: policy.allowedProviders,
        providerDenylist: policy.deniedProviders,
        allowedModes: policy.allowedModes,
        localOnly: policy.privacyLevel === 'local_only',
        privateRepositoryPolicy: policy.privacyLevel === 'regulated',
        dataResidency: null,
      },
      organization: {
        approvedModelsOnly: [],
        approvedProvidersOnly: org?.allowedProviders ?? [],
        noThirdPartyBrowserAutomation: false,
        maximumExecutionCostCents: org?.maximumCostCents ?? null,
        securityClassification: null,
      },
      availability: {
        providerUnavailable: [],
        modelUnavailable: [],
        externalCompanionInstalled: true,
        codingSurfaceVerified: [],
      },
      subscription: {
        blockUnknownSubscription: true,
        // §5: requiredCodingAgentProviders is project-configurable; the default
        // is empty (no provider-specific hard-coding — preserves the WORK-027
        // invariant: no hard-coded provider names outside the agents catalog).
        requiredCodingAgentProviders: [],
      },
      privacy: {
        level: policy.privacyLevel,
        approvedLocations: [],
      },
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * PR #37 review fix (constrained modes must be MEANINGFUL): a benchmark
 * mode is not allowed to persist or evaluate while its constraint is
 * absent. Enforced at the POLICY BOUNDARY — both at policy WRITE time
 * (updateProjectPolicy, with the migration-0033 DB CHECK as the backstop)
 * and at RECOMMENDATION time (the resolved mode vs the project policy's
 * caps) — so the system rejects the combination rather than silently
 * falling back to unconstrained behavior:
 *
 *   COST_CONSTRAINED    → requires maxCostCents    (maxCostPerTaskCents) != null
 *   LATENCY_CONSTRAINED → requires maxDurationMs   (maxTimeToPrMs)      != null
 *
 * The thrown error message starts with 'execution-policy-invalid-mode' —
 * the route layer maps it to HTTP 400 (a client-supplied semantics error,
 * distinct from 409 frozen / 404 missing / 500 internal).
 */
export function validateBenchmarkModeConstraint(
  benchmarkMode: BenchmarkMode,
  maxCostCents: number | null,
  maxDurationMs: number | null,
): void {
  if (benchmarkMode === 'cost_constrained' && maxCostCents == null) {
    throw new Error(
      'execution-policy-invalid-mode-constraint: COST_CONSTRAINED requires a cost cap (maxCostPerTaskCents) — set the cap or choose a different benchmark mode; a constrained mode without its constraint is meaningless',
    );
  }
  if (benchmarkMode === 'latency_constrained' && maxDurationMs == null) {
    throw new Error(
      'execution-policy-invalid-mode-constraint: LATENCY_CONSTRAINED requires a duration cap (maxTimeToPrMs) — set the cap or choose a different benchmark mode; a constrained mode without its constraint is meaningless',
    );
  }
}

function computeAvailability(
  p: ExecutionProviderInfo,
  mode: 'native' | 'external',
  access: ProviderAccessProfile | null,
): ProviderAvailability {
  if (mode === 'native' && p.nativeApi !== 'ready') return 'configuration_missing';
  if (mode === 'external' && p.externalUi !== 'available') return 'unavailable';
  if (access && access.statusSource === 'unknown') return 'unverified';
  return 'ready';
}

function attachEligibility(c: ExecutionCandidateInput, eligibility: ExecutionEligibilityResult): ExecutionCandidate {
  return {
    ...c,
    eligibility,
    policyStatus: eligibility.status,
    recommendationScore: 0,
  };
}

function toCandidate(
  c: ExecutionCandidateInput,
  eligibility: ExecutionEligibilityResult,
  score: number,
  _policy: BenchmarkPolicy,
): ExecutionCandidate {
  return {
    ...c,
    eligibility,
    policyStatus: eligibility.status,
    recommendationScore: score,
  };
}

function findEligibility(
  evaluated: readonly { candidate: ExecutionCandidateInput; eligibility: ExecutionEligibilityResult }[],
  target: ExecutionCandidateInput,
): ExecutionEligibilityResult {
  const found = evaluated.find((e) => e.candidate.provider === target.provider && e.candidate.executionMode === target.executionMode);
  return found?.eligibility ?? { status: 'eligible', eligible: true, blockingReasons: [], satisfiedConstraints: [] };
}

function toPreferenceProfile(p: UserPreferenceRecord): ExecutionPreferenceProfile {
  return {
    quality: p.qualityWeight,
    cost: p.costWeight,
    latency: p.latencyWeight,
    privacy: p.privacyWeight,
    preferredMode: p.preferredMode,
    externalPreferred: p.externalPreferred,
    nativePreferred: p.nativePreferred,
    defaultBenchmarkMode: p.defaultBenchmarkMode,
  };
}

/** Strip a candidate to audit-safe JSON (no secrets — there are none). */
function stripForAudit(c: ExecutionCandidate): Record<string, unknown> {
  return {
    provider: c.provider,
    name: c.name,
    model: c.model,
    executionMode: c.executionMode,
    availability: c.availability,
    eligibility: { status: c.eligibility.status, blockingReasons: c.eligibility.blockingReasons },
    recommendationScore: c.recommendationScore,
    capabilities: c.capabilities,
    historicalPerformance: {
      sampleSize: c.historicalPerformance.sampleSize,
      sufficient: c.historicalPerformance.sufficient,
      observedQuality: c.historicalPerformance.observedQuality,
    },
  };
}

// Handoff contract is defined in the public types (ExecutionHandoffPolicy).
// Full cross-mode handoff implementation is deferred to WORK-042+ (§34).
export type { ExecutionHandoffPolicy };
