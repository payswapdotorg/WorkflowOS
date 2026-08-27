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
  CandidateEligibilityInput,
  CandidateEligibilityResult,
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
  AgentPolicyConstraints,
  QuotaConstraints,
  RateLimitConstraints,
} from '../types.js';
import type {
  AgentPolicyProjectGateLike,
  DefaultExecutionPolicyServiceDeps,
  ResolvedOrgPolicy,
} from './execution-policy.types.js';
import { ProviderCapabilityNormalizer } from './provider-capability-normalizer.js';
import type { ExecutionProviderInfo } from '@modules/agents';

export class DefaultExecutionPolicyService implements ExecutionPolicyService {
  constructor(private readonly deps: DefaultExecutionPolicyServiceDeps) {}

  /** WORK-043: the clock seam (period/window boundaries). */
  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

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
    // --- WORK-043 (§33.3): resolve the NEW constraint-family inputs ---
    // Usage is DERIVED from the authoritative execution records (no parallel
    // ledger); the agent-policy external decision is resolved ONCE per scope
    // (the external-domain rule is project-scoped, not provider-refined).
    const providerNames = providers.map((p) => p.provider);
    const usage = await this.resolveUsageConstraints(policy, projectId, providerNames);
    const agentPolicy = await this.resolveAgentPolicyConstraint(organizationId, projectId);
    const constraints = this.buildConstraintSet(policy, orgPolicy, usage, agentPolicy);

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

    // --- persist the §22 append-only decision (ATOMIC SNAPSHOT VALIDATION) ---
    // PR #37 review fix (TOCTOU): the decision write is conditioned on the
    // CURRENT authoritative policy row still matching the snapshot this
    // recommendation was computed from (same version + not frozen-with-a-
    // differing-mode). A policy mutation or §9 freeze that raced the
    // recommendation → the insert yields NO row → the retryable
    // stale-snapshot error (the caller retries with the fresh policy; the
    // retry then either succeeds against the new version or hits the
    // frozen-mode guard). This eliminates the window where a decision could
    // be persisted claiming a stale policyVersion or a mode that was valid
    // only before a concurrent freeze.
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
    const decision = await this.deps.repository.insertDecision(
      organizationId, projectId, workItemId, userId, decisionRow,
      { snapshotPolicyVersion: policy.policyVersion },
    );
    if (!decision) {
      throw new Error(
        `execution-policy-snapshot-stale: the project policy changed during the recommendation (snapshot v${policy.policyVersion} is no longer the current authoritative version${input.benchmarkMode ? ` — the request-scoped benchmark mode '${input.benchmarkMode}' may no longer be valid` : ''}) — retry with the fresh policy`,
      );
    }

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
      // WORK-043 (§33.3): validate the merged quota / rate-limit / security
      // fields (clean domain errors; migration 0051's CHECKs are the
      // backstop — the same two-boundary pattern).
      validateWork043PolicyFields({
        maxExecutionsPerMonth: input.maxExecutionsPerMonth !== undefined ? input.maxExecutionsPerMonth : existing.maxExecutionsPerMonth,
        maxExecutionsPerDay: input.maxExecutionsPerDay !== undefined ? input.maxExecutionsPerDay : existing.maxExecutionsPerDay,
        rateLimitMaxRequests: input.rateLimitMaxRequests !== undefined ? input.rateLimitMaxRequests : existing.rateLimitMaxRequests,
        rateLimitWindowSeconds: input.rateLimitWindowSeconds !== undefined ? input.rateLimitWindowSeconds : existing.rateLimitWindowSeconds,
        securityClassification: input.securityClassification ?? existing.securityClassification,
        externalSecurityCeiling: input.externalSecurityCeiling !== undefined ? input.externalSecurityCeiling : existing.externalSecurityCeiling,
      });
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

  // ------------------------------------------------------------------ WORK-043

  /**
   * WORK-043 (§33.3): point-in-time single-candidate eligibility — the SAME
   * engine the recommendation path uses, exposed for re-eligibility at a
   * mode transition (the WORK-042 cross-mode handoff destination gate: the
   * logical task continues in the OTHER mode; the destination candidate must
   * still clear EVERY hard constraint family — capability, subscription,
   * privacy, security, quota, rate limits, agent policy, org/project
   * policy). Persists NOTHING (no §22 decision — this is not a
   * recommendation).
   */
  async evaluateCandidateEligibility(input: CandidateEligibilityInput): Promise<CandidateEligibilityResult> {
    const { projectId, workItemId, provider, model, executionMode } = input;
    const organizationId = input.organizationId ?? null;

    let policy = await this.deps.repository.getProjectPolicy(projectId);
    if (!policy) {
      // No policy row AND no org context (the handoff path for a project
      // that never evaluated a recommendation): evaluate against the SAME
      // defaults insertDefaultProjectPolicy would create (the in-memory
      // mirror of the SQL DEFAULTs — both modes allowed, no quotas, no rate
      // limits, standard classification). Consistency note: the handoff's
      // native gate ALREADY fails closed on a missing policy row
      // (nativeExecutionAllowed ?? false) BEFORE this gate runs, so the
      // only reachable path here is an EXTERNAL destination — whose
      // pre-WORK-043 posture (agent policy only) is exactly preserved.
      policy = defaultProjectPolicyRecord(organizationId, projectId);
    }
    const taskProfile = await this.deps.taskProfileBuilder.build(workItemId);
    const policySnapshot = this.buildPolicySnapshot(policy, policy.defaultBenchmarkMode);

    // The candidate: resolved from the SAME provider registry the
    // recommendation path uses (no invented capabilities — §6). A provider
    // absent from the registry is a configuration_missing candidate. The
    // optional userId (the handoff actor) resolves the user-scoped
    // access-profile constraints; absent → no access profile (the
    // subscription family treats an absent profile as unknown).
    const providers = await this.deps.agentProviderRegistry.getExecutionProviders(projectId);
    const accessProfiles = input.userId ? await this.deps.repository.listAccessProfiles(input.userId) : [];
    const accessMap = new Map<string, ProviderAccessProfile>(
      accessProfiles.map((a) => [a.provider, { provider: a.provider, plan: a.plan, codingAgent: a.codingAgent, externalUi: a.externalUi, nativeApi: a.nativeApi, statusSource: a.statusSource }]),
    );
    const normalizer = new ProviderCapabilityNormalizer(accessMap);
    const candidate = await this.buildSingleCandidate(
      providers, normalizer, projectId, provider, model, executionMode, accessMap,
    );

    // The constraint set: the SAME families the recommendation path
    // evaluates (usage derived from the authoritative execution records; the
    // project-scoped agent-policy decision; security classification).
    // Org-scoped families are INACTIVE without an organizationId (the
    // handoff path's own per-execution agent-policy gate is STRICTER — no
    // coverage lost).
    const orgPolicy = organizationId && this.deps.orgPolicyResolver
      ? await this.deps.orgPolicyResolver.resolve(organizationId)
      : null;
    const usage = await this.resolveUsageConstraints(policy, projectId, [provider]);
    const agentPolicy = organizationId
      ? await this.resolveAgentPolicyConstraint(organizationId, projectId)
      : { externalDecision: 'allow' as const, reason: 'organization scope absent (handoff path — the per-execution agent-policy gate enforces the external domain)', policyVersion: null };
    // POINT-IN-TIME posture: the subscription family's "unknown subscription
    // → blocked" is the INTERACTIVE recommendation nudge (§5: the user should
    // configure their access profile). At a mode transition the question is
    // DEPLOYABILITY — the destination's actual usability is availability
    // (the registry configuration, already fail-closed) + the hard families
    // below. The actor's absent access profile must not spuriously deny a
    // handoff to a platform-configured destination.
    const constraints = this.buildConstraintSet(policy, orgPolicy, usage, agentPolicy, {
      subscriptionBlockUnknown: false,
    });

    const eligibility = this.deps.eligibilityService.evaluate({
      candidate,
      taskProfile,
      policy: policySnapshot,
      constraints,
    });
    return { eligibility, constraints, policyVersion: policy.policyVersion };
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
        out.push(await this.buildCandidateForProvider(p, mode, projectId, normalizer, _accessMap));
      }
    }
    return out;
  }

  /**
   * WORK-043: the shared per-provider candidate builder — used by BOTH the
   * recommendation path (all providers × supported modes) and the
   * point-in-time single-candidate evaluation (the handoff destination
   * gate). One construction path = one capability/availability/evidence
   * model (no divergent candidate shapes between the two entries).
   */
  private async buildCandidateForProvider(
    p: ExecutionProviderInfo,
    mode: 'native' | 'external',
    projectId: string,
    normalizer: ProviderCapabilityNormalizer,
    accessMap: Map<string, ProviderAccessProfile>,
  ): Promise<ExecutionCandidateInput> {
    const capabilities = normalizer.normalizeForMode(p, mode);
    const access = accessMap.get(p.provider) ?? null;
    const evidence = await this.deps.benchmarkEvidenceProvider.historicalPerformanceForCell(projectId, p.provider, mode);
    const cost: CostEstimate = { cents: null, confidence: 'unknown', currency: 'USD' };
    const latency: LatencyEstimate = {
      estimatedMs: evidence.medianTimeToVerifiedMs ?? null,
      confidence: evidence.sufficient ? 'known' : 'unknown',
      source: evidence.sufficient ? 'historical_observed' : 'unknown',
    };
    const availability = computeAvailability(p, mode, access);
    return {
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
    };
  }

  /**
   * WORK-043: build the SINGLE (provider, mode) candidate for the
   * point-in-time evaluation. A provider present in the registry but
   * WITHOUT the requested mode surfaces as a configuration_missing /
   * unavailable candidate (the honest verdict); a provider ABSENT from the
   * registry entirely yields a synthetic not-configured candidate (the
   * evaluator's availability family blocks it with configuration_missing).
   */
  private async buildSingleCandidate(
    providers: readonly ExecutionProviderInfo[],
    normalizer: ProviderCapabilityNormalizer,
    projectId: string,
    provider: string,
    model: string | null,
    mode: 'native' | 'external',
    accessMap: Map<string, ProviderAccessProfile>,
  ): Promise<ExecutionCandidateInput> {
    const info = providers.find((p) => p.provider === provider);
    if (!info) {
      // Not in the registry at all: no invented capabilities (§6) — a bare
      // not-configured candidate the evaluator blocks honestly.
      return {
        provider,
        name: provider,
        model: model ?? '',
        executionMode: mode,
        capabilities: ProviderCapabilityNormalizer.notConfigured(mode),
        accessProfile: accessMap.get(provider) ?? null,
        availability: 'configuration_missing',
        estimatedCost: { cents: null, confidence: 'unknown', currency: 'USD' },
        estimatedLatency: { estimatedMs: null, confidence: 'unknown', source: 'unknown' },
        historicalPerformance: ProviderCapabilityNormalizer.noEvidence(),
      };
    }
    const candidate = await this.buildCandidateForProvider(info, mode, projectId, normalizer, accessMap);
    // The caller's model override wins when provided (the handoff resolves
    // the destination model explicitly).
    return model != null && model !== '' ? { ...candidate, model } : candidate;
  }

  // ----- WORK-043: constraint-family resolution -----

  /**
   * WORK-043 (§33.3): resolve the QUOTA + RATE-LIMIT usage from the
   * AUTHORITATIVE execution records (wfos_executions + wfos_agent_runs +
   * wfos_execution_mode_handoffs via the repository's two derivation
   * seams — NO parallel usage ledger). AR-043-02 — the two usage models
   * are DISTINCT:
   *
   *   QUOTA     — the project's LOGICAL EXECUTIONS (one per execution row
   *               that dispatched; project-wide). A cross-mode handed-off
   *               execution is ONE logical execution → ONE quota unit.
   *   RATE-LIMIT — PROVIDER DISPATCH EVENTS per provider (each ACTUAL
   *               dispatch attributed to the provider that dispatched it:
   *               the AgentRun ledger row's OWN provider — native; the
   *               package artifact's OWN provider field — external,
   *               including a handed-off-away external phase's snapshot).
   *               A cross-mode handed-off execution contributes ONE event
   *               to EACH provider that dispatched. Each event gates the
   *               window by ITS OWN authoritative dispatch timestamp
   *               (AR-043-03): the run row's created_at (native) / the
   *               package's dispatchedAt (external, snapshots included) —
   *               never a reservation timestamp (the execution/handoff-log
   *               row creations can precede the actual dispatch by an
   *               arbitrary scheduling gap).
   *
   * Neither model ever counts mere execution-row existence: a
   * created-without-dispatch record or a rejected-before-dispatch attempt
   * consumed no provider capacity and must not consume quota/window
   * capacity (the AR-043-01 proofs). Period boundaries are UTC calendar
   * boundaries; the rate window is the trailing sliding window. Any
   * UNRESOLVABLE usage (query failure → null) stays null — the evaluator
   * fails CLOSED while the corresponding constraint is active.
   */
  private async resolveUsageConstraints(
    policy: ProjectPolicyRecord,
    projectId: string,
    providers: readonly string[],
  ): Promise<{ quota: QuotaConstraints; rateLimit: RateLimitConstraints }> {
    const now = this.now();
    // UTC calendar month + day starts.
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const quotaActive = policy.maxExecutionsPerMonth != null || policy.maxExecutionsPerDay != null;
    const rateActive = policy.rateLimitMaxRequests != null && policy.rateLimitWindowSeconds != null;

    // Quota usage — LOGICAL EXECUTIONS (one per dispatched execution row,
    // project-wide), resolved ONLY while a quota is active (no constraint →
    // no query → usage 0; the evaluator's quota family is inactive anyway).
    let monthlyUsed: number | null = 0;
    let dailyUsed: number | null = 0;
    if (quotaActive) {
      const monthly = policy.maxExecutionsPerMonth != null
        ? await this.deps.repository.countProjectDispatchedExecutionsSince(projectId, monthStart)
        : 0;
      const daily = policy.maxExecutionsPerDay != null
        ? await this.deps.repository.countProjectDispatchedExecutionsSince(projectId, dayStart)
        : 0;
      // A failure on EITHER period check fails the whole quota family
      // closed (the constraint cannot be verified).
      monthlyUsed = monthly;
      dailyUsed = daily;
    }

    // Rate-window usage — PROVIDER DISPATCH EVENTS per provider (each
    // actual dispatch attributed to the provider that dispatched it),
    // resolved ONLY while a limit is active, and only for the providers
    // under evaluation. ONE failed provider query nulls the WHOLE map
    // (systemic failure → fail closed for every provider under the active
    // limit).
    let providerWindowUsage: Readonly<Record<string, number>> | null = {};
    if (rateActive && policy.rateLimitWindowSeconds != null) {
      const windowStart = new Date(now.getTime() - policy.rateLimitWindowSeconds * 1000);
      const map: Record<string, number> = {};
      for (const provider of providers) {
        const used = await this.deps.repository.countProjectProviderDispatchesSince(projectId, provider, windowStart);
        if (used == null) {
          providerWindowUsage = null;
          break;
        }
        map[provider] = used;
      }
      if (providerWindowUsage != null) providerWindowUsage = map;
    }

    return {
      quota: {
        monthlyMaxExecutions: policy.maxExecutionsPerMonth,
        dailyMaxExecutions: policy.maxExecutionsPerDay,
        monthlyUsed,
        dailyUsed,
      },
      rateLimit: {
        maxRequestsPerWindow: policy.rateLimitMaxRequests,
        windowSeconds: policy.rateLimitWindowSeconds,
        providerWindowUsage,
      },
    };
  }

  /**
   * WORK-043 (§33.3): resolve the project-scoped agent-policy external-domain
   * decision (WORK-037) as a constraint input. Postures:
   *   - gate NOT wired        → 'allow' (the family is INACTIVE — the runtime
   *                             handoff gate + tool gates still enforce the
   *                             policy; this layer simply has no
   *                             recommendation-time input);
   *   - gate wired, succeeded → the engine's decision (allow/constrained/
   *                             deny/ask — the engine itself fails closed to
   *                             'deny' on internal errors);
   *   - gate wired, THREW     → 'unresolved' (fail-closed for external
   *                             candidates).
   */
  private async resolveAgentPolicyConstraint(
    organizationId: string,
    projectId: string,
  ): Promise<AgentPolicyConstraints> {
    const gate: AgentPolicyProjectGateLike | undefined = this.deps.agentPolicyProjectGate;
    if (!gate) {
      return { externalDecision: 'allow', reason: 'agent-policy gate not configured for recommendation-time eligibility', policyVersion: null };
    }
    try {
      const decision = await gate.evaluateExternalForProject({ organizationId, projectId });
      return {
        externalDecision: decision.decision,
        reason: decision.reason,
        policyVersion: decision.policyVersion,
      };
    } catch (err) {
      this.deps.logger.warn('execution-policy.agent-policy-gate-failed', {
        organizationId,
        projectId,
        error: (err as Error).message,
      });
      return {
        externalDecision: 'unresolved',
        reason: `the agent-policy gate could not be consulted (${(err as Error).message})`,
        policyVersion: null,
      };
    }
  }

  private buildConstraintSet(
    policy: ProjectPolicyRecord,
    org: ResolvedOrgPolicy | null,
    usage: { quota: QuotaConstraints; rateLimit: RateLimitConstraints },
    agentPolicy: AgentPolicyConstraints,
    options: { subscriptionBlockUnknown?: boolean } = {},
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
        // WORK-043: the org-provided external security ceiling (§32 resolved
        // org policy; NULL = unset — the project policy's own
        // externalSecurityCeiling governs below).
        securityClassification: null,
      },
      availability: {
        providerUnavailable: [],
        modelUnavailable: [],
        externalCompanionInstalled: true,
        codingSurfaceVerified: [],
      },
      subscription: {
        // §5: candidates whose subscription capability is 'unknown' default
        // to blocked IN RECOMMENDATIONS (the interactive configure-your-
        // profile nudge). The point-in-time candidate evaluation (the handoff
        // destination gate) passes subscriptionBlockUnknown: false — its
        // question is deployability, and the destination's actual usability
        // is the availability family (registry configuration, fail-closed).
        blockUnknownSubscription: options.subscriptionBlockUnknown ?? true,
        // §5: requiredCodingAgentProviders is project-configurable; the default
        // is empty (no provider-specific hard-coding — preserves the WORK-027
        // invariant: no hard-coded provider names outside the agents catalog).
        requiredCodingAgentProviders: [],
      },
      privacy: {
        level: policy.privacyLevel,
        approvedLocations: [],
      },
      // --- WORK-043 (§33.3): the new constraint families ---
      quota: usage.quota,
      rateLimit: usage.rateLimit,
      security: {
        projectClassification: policy.securityClassification,
        externalCeiling: policy.externalSecurityCeiling,
      },
      agentPolicy,
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

/**
 * WORK-043 (§33.3): validate the merged quota / rate-limit / security fields
 * at the POLICY BOUNDARY (clean domain errors; migration 0051's CHECK
 * constraints are the DB backstop — the same two-boundary pattern as the
 * constrained-mode validation):
 *
 *   quotas                  → non-negative when set
 *   rate limit              → BOTH halves (max requests AND a positive
 *                             window) or NEITHER — a labeled limit without
 *                             the data to evaluate it is meaningless
 *   security classification → the closed ladder
 *                             standard < confidential < restricted
 *
 * Error messages start with 'execution-policy-invalid-constraint' — the
 * route layer maps them to HTTP 400 (client-supplied semantics errors).
 */
export function validateWork043PolicyFields(merged: {
  maxExecutionsPerMonth: number | null;
  maxExecutionsPerDay: number | null;
  rateLimitMaxRequests: number | null;
  rateLimitWindowSeconds: number | null;
  securityClassification: string;
  externalSecurityCeiling: string | null;
}): void {
  const {
    maxExecutionsPerMonth, maxExecutionsPerDay,
    rateLimitMaxRequests, rateLimitWindowSeconds,
    securityClassification, externalSecurityCeiling,
  } = merged;
  if (maxExecutionsPerMonth != null && (!Number.isInteger(maxExecutionsPerMonth) || maxExecutionsPerMonth < 0)) {
    throw new Error(
      'execution-policy-invalid-constraint: maxExecutionsPerMonth must be a non-negative integer (or null = unlimited)',
    );
  }
  if (maxExecutionsPerDay != null && (!Number.isInteger(maxExecutionsPerDay) || maxExecutionsPerDay < 0)) {
    throw new Error(
      'execution-policy-invalid-constraint: maxExecutionsPerDay must be a non-negative integer (or null = unlimited)',
    );
  }
  const hasMax = rateLimitMaxRequests != null;
  const hasWindow = rateLimitWindowSeconds != null;
  if (hasMax !== hasWindow) {
    throw new Error(
      'execution-policy-invalid-constraint: a rate limit requires BOTH halves — rateLimitMaxRequests (max dispatches) AND rateLimitWindowSeconds (the sliding-window width, a positive integer); set both or clear both',
    );
  }
  if (hasMax && hasWindow) {
    if (!Number.isInteger(rateLimitMaxRequests!) || rateLimitMaxRequests! < 0) {
      throw new Error(
        'execution-policy-invalid-constraint: rateLimitMaxRequests must be a non-negative integer',
      );
    }
    if (!Number.isInteger(rateLimitWindowSeconds!) || rateLimitWindowSeconds! <= 0) {
      throw new Error(
        'execution-policy-invalid-constraint: rateLimitWindowSeconds must be a positive integer (the sliding-window width in seconds)',
      );
    }
  }
  const ladder = new Set(['standard', 'confidential', 'restricted']);
  if (!ladder.has(securityClassification)) {
    throw new Error(
      'execution-policy-invalid-constraint: securityClassification must be one of standard | confidential | restricted',
    );
  }
  if (externalSecurityCeiling != null && !ladder.has(externalSecurityCeiling)) {
    throw new Error(
      'execution-policy-invalid-constraint: externalSecurityCeiling must be one of standard | confidential | restricted (or null = no external security restriction)',
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

/**
 * WORK-043: the in-memory mirror of insertDefaultProjectPolicy's SQL
 * DEFAULTs — used by the point-in-time candidate evaluation when no policy
 * row exists AND no organization context is available to create one (the
 * cross-mode handoff path for a project that never evaluated a
 * recommendation). Both modes allowed, no quotas, no rate limits, standard
 * classification — the exact defaults migration 0026 + 0051 define.
 */
function defaultProjectPolicyRecord(
  organizationId: string | null,
  projectId: string,
): ProjectPolicyRecord {
  const now = new Date();
  return {
    id: `in-memory-default-${projectId}`,
    organizationId: organizationId ?? 'unknown',
    projectId,
    defaultBenchmarkMode: 'maximum_capability',
    externalExecutionAllowed: true,
    nativeExecutionAllowed: true,
    maxCostPerTaskCents: null,
    maxCostPerTrialCents: null,
    maxTimeToPrMs: null,
    humanInterventionAllowed: true,
    privacyLevel: 'standard',
    allowedProviders: [],
    deniedProviders: [],
    allowedModes: [],
    maxExecutionsPerMonth: null,
    maxExecutionsPerDay: null,
    rateLimitMaxRequests: null,
    rateLimitWindowSeconds: null,
    securityClassification: 'standard',
    externalSecurityCeiling: null,
    frozen: false,
    policyVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
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
