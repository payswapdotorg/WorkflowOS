/**
 * WORK-044 — the Adaptive Execution Router (internal service).
 *
 * A SELECTION layer ONLY, sitting strictly BELOW the WORK-043 eligibility
 * boundary:
 *
 *   WORK-043 eligibility  (DefaultExecutionPolicyService.recommend — the
 *         ↓               authoritative HARD gate + the §22 audit record)
 *   eligible candidates only  (recommendation.eligibleCandidates)
 *         ↓
 *   WORK-044 ranking      (rankEligibleCandidates — THIS domain)
 *         ↓
 *   recommend / select    (advisory; the caller dispatches via the
 *                         existing ExecutionService.submit() authority)
 *
 * What this service does:
 *   1. Resolves the organization scope SERVER-SIDE from the authoritative
 *      project → organization relation (the AR-043-04 lesson: no caller
 *      supplies — and none can spoof — the org scope; unresolvable fails
 *      closed).
 *   2. Consumes the WORK-043 contract: ExecutionPolicyService.recommend()
 *      evaluates the FULL constraint set (capability, subscription,
 *      availability, privacy, security, agent policy, quota, rate limits,
 *      project/org policy) and returns the eligible candidates WITH their
 *      verdicts + the policy snapshot + the task profile + the §14
 *      benchmark evidence + the §22 decision id. The router NEVER
 *      re-evaluates a hard constraint (W044-AC11 — no parallel engine).
 *   3. Maps the eligible candidates into the routing input model and ranks
 *      them with the pure deterministic function.
 *   4. Returns the inspectable routing explanation. Both modes
 *      (recommendation + automatic selection) are ADVISORY: neither mutates
 *      workflow state, and neither dispatches.
 *
 * The service is STATELESS: it persists NOTHING of its own (no routing
 * table, no parallel decision ledger). Every routing's audit trail is the
 * §22 append-only decision persisted by the consumed recommendation
 * (decisionId on both result shapes).
 */
import type { Logger } from '@platform/logger.js';
import type {
  BenchmarkMode,
  ExecutionCandidate,
  ExecutionPreferenceProfile,
  ExecutionPolicyService,
  RecommendInput,
} from '../../execution-policy/index.js';
import type {
  AdaptiveExecutionRouterService,
  RoutingCandidate,
  RoutingExplanation,
  RoutingRecommendationResult,
  RoutingRequestInput,
  RoutingSelectionResult,
} from '../types.js';
import { ExecutionRoutingError } from '../types.js';
import { excludedViewOf, rankEligibleCandidates } from './execution-ranking.js';

/** The documented default preference profile (mirrors the §12 DB defaults). */
export const DEFAULT_ROUTING_PREFERENCES: ExecutionPreferenceProfile = Object.freeze({
  quality: 0.6,
  cost: 0.2,
  latency: 0.1,
  privacy: 0.1,
  preferredMode: null,
  externalPreferred: false,
  nativePreferred: false,
  defaultBenchmarkMode: 'maximum_capability',
});

/**
 * The PROJECT→ORGANIZATION authority port (the AR-043-04 pattern — the
 * projects module's ProjectRepository satisfies this structurally;
 * findById → project.organizationId). Returns NULL when the project does
 * not resolve (fail-closed upstream).
 */
export interface RoutingProjectOrganizationResolverLike {
  resolveProjectOrganization(projectId: string): Promise<string | null>;
}

export interface AdaptiveExecutionRouterDeps {
  /** The WORK-043 contract — the ONE eligibility/policy authority. */
  readonly executionPolicyService: ExecutionPolicyService;
  /** The project → organization authority (AR-043-04 — server-side scope). */
  readonly projectOrganizationResolver: RoutingProjectOrganizationResolverLike;
  readonly logger: Logger;
}

interface RoutedOutcome {
  readonly recommendation: Awaited<ReturnType<ExecutionPolicyService['recommend']>>;
  readonly ranked: ReturnType<typeof rankEligibleCandidates>['ranked'];
  readonly selected: ReturnType<typeof rankEligibleCandidates>['selected'];
  readonly explanation: RoutingExplanation;
}

export class AdaptiveExecutionRouter implements AdaptiveExecutionRouterService {
  constructor(private readonly deps: AdaptiveExecutionRouterDeps) {}

  /** W044-AC08 — recommendation mode: inspectable ranking, no selection commitment. */
  async recommendExecution(input: RoutingRequestInput): Promise<RoutingRecommendationResult> {
    const outcome = await this.route(input);
    return {
      mode: 'recommendation',
      workItemId: input.workItemId,
      projectId: input.projectId,
      decisionId: outcome.recommendation.decisionId,
      recommended: outcome.selected,
      ranked: outcome.ranked,
      explanation: outcome.explanation,
      policy: outcome.recommendation.policy,
      taskProfile: outcome.recommendation.taskProfile,
      benchmarkEvidence: outcome.recommendation.benchmarkEvidence,
    };
  }

  /** W044-AC08 — automatic-selection mode: the selected candidate + why it won. */
  async selectExecution(input: RoutingRequestInput): Promise<RoutingSelectionResult> {
    const outcome = await this.route(input);
    return {
      mode: 'automatic_selection',
      workItemId: input.workItemId,
      projectId: input.projectId,
      decisionId: outcome.recommendation.decisionId,
      selected: outcome.selected,
      alternatives: outcome.ranked.slice(1),
      explanation: outcome.explanation,
      policy: outcome.recommendation.policy,
      taskProfile: outcome.recommendation.taskProfile,
    };
  }

  // -------------------------------------------------------------------------
  // The shared routing pipeline — eligibility BEFORE ranking, always
  // -------------------------------------------------------------------------

  private async route(input: RoutingRequestInput): Promise<RoutedOutcome> {
    // --- 1. server-side organization scope (AR-043-04 — fail closed) -------
    const organizationId = await this.deps.projectOrganizationResolver.resolveProjectOrganization(input.projectId);
    if (!organizationId) {
      throw new ExecutionRoutingError(
        'execution-routing-organization-unresolved',
        `execution-routing-organization-unresolved: the organization scope for project ${input.projectId} could not be resolved from the authoritative project → organization relation — the routing fails closed (an unresolvable scope cannot be declared unconstrained)`,
      );
    }

    // --- 2. consume the WORK-043 contract (the authoritative eligibility) --
    // The recommendation evaluates the FULL constraint set for every
    // provider × mode candidate and returns ONLY the eligible ones (each
    // carrying its verdict) + the excluded ones (each carrying its blocking
    // reasons). This is the ONE eligibility evaluation — the router never
    // re-runs a constraint.
    const recommendInput: RecommendInput = {
      organizationId,
      projectId: input.projectId,
      workItemId: input.workItemId,
      userId: input.userId,
      benchmarkMode: input.benchmarkMode,
    };
    const recommendation = await this.deps.executionPolicyService.recommend(recommendInput);

    // --- 3. the advisory preference profile (§12 — loaded AFTER the
    //        recommendation, which get-or-creates the user's defaults;
    //        preferences are RANKING inputs ONLY, never constraints) --------
    const prefsRecord = await this.deps.executionPolicyService.getUserPreferences(input.userId);
    const preferences = prefsRecord ? toPreferenceProfile(prefsRecord) : DEFAULT_ROUTING_PREFERENCES;

    // --- 4. map the ALREADY-ELIGIBLE candidates into the routing model ----
    // W044-AC01: ONLY recommendation.eligibleCandidates are mapped. An
    // ineligible candidate is never constructed as a ranking input on this
    // path — and the pure ranking seam independently rejects a non-eligible
    // verdict (defense in depth).
    const candidates = recommendation.eligibleCandidates.map(toRoutingCandidate);

    // --- 5. rank (pure + deterministic) ------------------------------------
    const ranking = rankEligibleCandidates({
      candidates,
      preferences,
      policy: recommendation.policy,
      taskProfile: recommendation.taskProfile,
    });

    // --- 6. the explanation + the excluded picture (transparency) ----------
    const excluded = recommendation.excludedCandidates.map((c) =>
      excludedViewOf(
        { provider: c.provider, model: c.model, executionMode: c.executionMode },
        c.eligibility,
      ),
    );
    const explanation: RoutingExplanation = { ...ranking.explanation, excluded };

    this.deps.logger.debug(
      'execution-routing: routed eligible candidates (WORK-044 selection layer; WORK-043 eligibility authoritative)',
      {
        workItemId: input.workItemId,
        projectId: input.projectId,
        eligible: candidates.length,
        excluded: excluded.length,
        selected: ranking.selected
          ? `${ranking.selected.identity.provider}/${ranking.selected.identity.model}/${ranking.selected.identity.executionMode}`
          : null,
        decisionId: recommendation.decisionId,
      },
    );

    return { recommendation, ranked: ranking.ranked, selected: ranking.selected, explanation };
  }
}

// ---------------------------------------------------------------------------
// mappers (ExecutionCandidate → RoutingCandidate; UserPreferenceRecord → profile)
// ---------------------------------------------------------------------------

/**
 * Map one ALREADY-ELIGIBLE ExecutionCandidate (the WORK-043 output) into the
 * routing input model. The capability profile passes through READ-ONLY
 * (W044-AC06 — never modified, truncated, or downgraded).
 */
function toRoutingCandidate(c: ExecutionCandidate): RoutingCandidate {
  return {
    identity: { provider: c.provider, model: c.model, executionMode: c.executionMode },
    eligibility: c.eligibility,
    quality: {
      observedQuality: c.historicalPerformance.observedQuality,
      sampleSize: c.historicalPerformance.sampleSize,
      sufficient: c.historicalPerformance.sufficient,
    },
    reliability: {
      ciFirstPassRate: c.historicalPerformance.ciFirstPassRate,
      verificationFirstPassRate: c.historicalPerformance.verificationFirstPassRate,
      sampleSize: c.historicalPerformance.sampleSize,
      sufficient: c.historicalPerformance.sufficient,
    },
    cost: { cents: c.estimatedCost.cents, confidence: c.estimatedCost.confidence },
    latency: { estimatedMs: c.estimatedLatency.estimatedMs, source: c.estimatedLatency.source },
    humanIntervention: {
      count: c.historicalPerformance.humanInterventionCount,
      sampleSize: c.historicalPerformance.sampleSize,
    },
    capability: c.capabilities as unknown as Readonly<Record<string, unknown>>,
  };
}

/** The §12 preference-profile mapping (the record fields → the profile shape). */
function toPreferenceProfile(p: {
  qualityWeight: number;
  costWeight: number;
  latencyWeight: number;
  privacyWeight: number;
  preferredMode: ExecutionPreferenceProfile['preferredMode'];
  externalPreferred: boolean;
  nativePreferred: boolean;
  defaultBenchmarkMode: BenchmarkMode;
}): ExecutionPreferenceProfile {
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
