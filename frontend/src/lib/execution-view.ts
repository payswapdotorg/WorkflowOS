/**
 * WORK-050 — the PURE unified-execution view derivation.
 *
 * Facts in → view out (the WORK-048 work-graph.ts / WORK-049 health.ts
 * precedent): every value in the derived view is an AUTHORITATIVE fact from a
 * backend authority's own response — the execution records (the execution
 * authority), the WORK-044 routing recommendation (advisory), the WORK-047
 * intelligence recommendation (advisory), the WORK-043 policy recommendation
 * (the constraints), the WORK-042 cross-mode handoff log row (the handoff
 * state), the WORK-046 delegation plans (the delegated units), the
 * verification runs, and the workflow authority's state + merge readiness.
 *
 * THE NON-NEGOTIABLE RULE (the work order's authority model):
 *
 *   WORK-044 routing recommendation      ≠ execution decision
 *   WORK-047 intelligence recommendation ≠ execution decision
 *
 * `actuallySelected` is read ONLY from the authoritative execution record's
 * own mode/provider/model fields. The recommendations live in their own
 * `routingAdvisory` / `intelligenceAdvisory` structures — structurally
 * distinct, so no presentation layer can ever render a recommendation as the
 * selection. The one comparison the view performs (`selectionDiffersFrom...`)
 * is presentation grouping over BOTH authorities' own values (a badge that
 * says the advisory differs from the recorded selection) — it never feeds
 * back into anything.
 *
 * PURE + DETERMINISTIC: no fetch, no state, no persistence, no engine — the
 * SAME facts always produce the SAME view; fresh facts produce the fresh view
 * (refresh consistency is proven by regression). Statuses are the
 * authorities' own values rendered verbatim — never normalized, never
 * synthesized, never fabricated.
 */
import type {
  ExecutionSummary,
  ExecutionMode,
  RoutingRecommendation,
  AgentIntelligenceRecommendation,
  ExecutionRecommendation,
  CrossModeHandoffView,
  DelegationPlanView,
  VerificationRun,
  MergeGateResult,
} from '@/api/client';

/** The authoritative facts the unified execution view derives from. */
export interface ExecutionViewFacts {
  /** The execution authority's own records (its own newest-first order). */
  readonly executions: readonly ExecutionSummary[];
  /** The WORK-042 handoff log row for the CURRENT execution (null = genuinely none). */
  readonly handoff: CrossModeHandoffView | null;
  /** The WORK-044 routing recommendation (advisory). */
  readonly routing: RoutingRecommendation | null;
  /** The WORK-047 intelligence recommendation (advisory). */
  readonly intelligence: AgentIntelligenceRecommendation | null;
  /** The WORK-043 policy recommendation (the constraints/eligibility facts). */
  readonly policy: ExecutionRecommendation | null;
  /** The WORK-046 delegation plans (the delegated execution units). */
  readonly delegationPlans: readonly DelegationPlanView[];
  /** The verification authority's own runs. */
  readonly verificationRuns: readonly VerificationRun[];
  /** The workflow authority's current state (null before the first transition). */
  readonly workflowState: string | null;
  /** The workflow authority's merge-readiness verdict. */
  readonly mergeReadiness: MergeGateResult | null;
}

/** What was ACTUALLY selected — the execution record's OWN identity fields. */
export interface ActuallySelected {
  readonly provider: string;
  readonly model: string | null;
  readonly mode: ExecutionMode;
}

/** The WORK-044 routing advisory — the authority's own fields, verbatim. */
export interface RoutingAdvisory {
  readonly recommends: {
    readonly provider: string;
    readonly model: string;
    readonly executionMode: string;
    readonly score: number;
  } | null;
  readonly rankedCount: number;
  readonly eligibleCount: number;
  readonly excludedCount: number;
  readonly selectionReason: string;
  readonly methodology: string;
}

/** The WORK-047 intelligence advisory — the authority's own fields, verbatim. */
export interface IntelligenceAdvisory {
  readonly recommends: {
    readonly provider: string;
    readonly model: string;
    readonly executionMode: string;
    readonly score: number;
    readonly routingRank: number | undefined;
  } | null;
  readonly headline: string;
  readonly reasons: ReadonlyArray<{ dimension: string; detail: string }>;
  readonly fallbackCount: number;
  readonly rejectedAlternatives: ReadonlyArray<{
    provider: string;
    model: string;
    executionMode: string;
    reason: string;
  }>;
  readonly warnings: readonly string[];
  readonly confidence: string | undefined;
}

/** The WORK-043 constraints — the policy authority's own facts, verbatim. */
export interface ConstraintsView {
  readonly eligibleCount: number;
  readonly excludedCount: number;
  readonly benchmarkMode: string | null;
  readonly allowedProviders: readonly string[];
  readonly allowedModes: readonly string[];
  readonly frozen: boolean | null;
  readonly headline: string;
}

/** The WORK-042 handoff — the log row's own values, verbatim. */
export interface HandoffView {
  readonly fromMode: 'native' | 'external';
  readonly toMode: 'native' | 'external';
  readonly reason: string | null;
  readonly resultingStatus: string;
  readonly authorized: boolean;
  readonly createdAt: string;
}

/** A delegated execution unit — the delegation record's own values, verbatim. */
export interface DelegatedUnitView {
  readonly planKey: string;
  readonly unitKey: string;
  readonly roleId: string;
  readonly roleRevision: string;
  readonly mode: 'native' | 'external';
  readonly provider: string;
  readonly model: string | null;
  readonly status: string;
  readonly attemptCount: number;
}

/** The verification state — the authority's own run statuses, verbatim. */
export interface VerificationView {
  readonly latestStatus: string | null;
  readonly runCount: number;
  readonly latestRunId: string | null;
}

/** The next action — the workflow authority's OWN facts, never a frontend decision. */
export interface NextActionView {
  readonly currentState: string | null;
  readonly mergeReady: boolean | null;
  readonly reasons: readonly string[];
}

/** The derived unified execution view (all values authoritative/verbatim). */
export interface ExecutionView {
  /** The execution authority's own newest record (null = the authority answered empty). */
  readonly currentExecution: ExecutionSummary | null;
  /** The recorded selection — the CURRENT execution record's OWN identity fields. */
  readonly actuallySelected: ActuallySelected | null;
  /** The execution history in the authority's own order. */
  readonly executionHistory: readonly ExecutionSummary[];
  readonly routingAdvisory: RoutingAdvisory;
  readonly intelligenceAdvisory: IntelligenceAdvisory;
  readonly constraints: ConstraintsView;
  readonly handoff: HandoffView | null;
  readonly delegatedUnits: readonly DelegatedUnitView[];
  readonly delegatedUnitCount: number;
  readonly verification: VerificationView;
  readonly nextAction: NextActionView;
  /**
   * PRESENTATION fact: the routing recommendation's identity DIFFERS from the
   * recorded selection (both are the authorities' own values; the comparison
   * only drives a "differs" badge — it decides nothing). null when either
   * side is absent (nothing to compare).
   */
  readonly selectionDiffersFromRoutingRecommendation: boolean | null;
}

/**
 * Derive the unified execution view from authoritative facts. DETERMINISTIC:
 * the same facts always produce the same view. `actuallySelected` comes ONLY
 * from the newest execution record (the authority's own ordering — its first
 * item); it is NEVER derived from a recommendation.
 */
export function deriveExecutionView(facts: ExecutionViewFacts): ExecutionView {
  // The current execution is the authority's own newest record (its
  // newest-first ordering is the authority's; the view does not re-sort).
  const currentExecution = facts.executions[0] ?? null;

  // What was ACTUALLY selected — the record's OWN fields, nothing else.
  const actuallySelected: ActuallySelected | null = currentExecution
    ? {
        provider: currentExecution.provider,
        model: currentExecution.model,
        mode: currentExecution.mode,
      }
    : null;

  // The WORK-044 advisory — the routing authority's own fields, verbatim.
  const routingAdvisory: RoutingAdvisory = {
    recommends: facts.routing?.selected
      ? {
          provider: facts.routing.selected.identity.provider,
          model: facts.routing.selected.identity.model,
          executionMode: facts.routing.selected.identity.executionMode,
          score: facts.routing.selected.score,
        }
      : null,
    rankedCount: facts.routing?.ranked.length ?? 0,
    eligibleCount: facts.routing?.explanation.eligibleCount ?? 0,
    excludedCount: facts.routing?.explanation.excluded.length ?? 0,
    selectionReason: facts.routing?.explanation.selectionReason ?? '',
    methodology: facts.routing?.explanation.methodology ?? '',
  };

  // The WORK-047 advisory — the intelligence authority's own fields, verbatim.
  const intelligenceAdvisory: IntelligenceAdvisory = {
    recommends: facts.intelligence?.recommended
      ? {
          provider: facts.intelligence.recommended.identity.provider,
          model: facts.intelligence.recommended.identity.model,
          executionMode: facts.intelligence.recommended.identity.executionMode,
          score: facts.intelligence.recommended.score,
          routingRank: facts.intelligence.recommended.routingRank,
        }
      : null,
    headline: facts.intelligence?.provenance.headline ?? '',
    reasons: facts.intelligence?.provenance.reasons ?? [],
    fallbackCount: facts.intelligence?.fallbacks.length ?? 0,
    rejectedAlternatives:
      facts.intelligence?.provenance.rejectedAlternatives.map((r) => ({
        provider: r.provider,
        model: r.model,
        executionMode: r.executionMode,
        reason: r.reason,
      })) ?? [],
    warnings: facts.intelligence?.warnings ?? [],
    confidence: facts.intelligence?.provenance.confidence,
  };

  // The WORK-043 constraints — the policy authority's own facts, verbatim.
  const constraints: ConstraintsView = {
    eligibleCount: facts.policy?.eligibleCandidates.length ?? 0,
    excludedCount: facts.policy?.excludedCandidates.length ?? 0,
    benchmarkMode: facts.policy?.policy.benchmarkMode ?? null,
    allowedProviders: facts.policy?.policy.allowedProviders ?? [],
    allowedModes: facts.policy?.policy.allowedModes ?? [],
    frozen: facts.policy?.policy.frozen ?? null,
    headline: facts.policy?.why.headline ?? '',
  };

  // The WORK-042 handoff — the log row's own values, verbatim.
  const handoff: HandoffView | null = facts.handoff
    ? {
        fromMode: facts.handoff.fromMode,
        toMode: facts.handoff.toMode,
        reason: facts.handoff.reason,
        resultingStatus: facts.handoff.resultingStatus,
        authorized: facts.handoff.authorized,
        createdAt: facts.handoff.createdAt,
      }
    : null;

  // The delegated units — the delegation records' own values, verbatim.
  const delegatedUnits: DelegatedUnitView[] = [];
  for (const plan of facts.delegationPlans) {
    for (const unit of plan.units) {
      delegatedUnits.push({
        planKey: plan.planKey,
        unitKey: unit.unitKey,
        roleId: unit.role.roleId,
        roleRevision: unit.role.roleRevision,
        mode: unit.mode,
        provider: unit.provider,
        model: unit.model,
        status: unit.status,
        attemptCount: unit.attemptCount,
      });
    }
  }

  // The verification state — the authority's own run statuses, verbatim.
  const verification: VerificationView = {
    latestStatus: facts.verificationRuns[0]?.status ?? null,
    runCount: facts.verificationRuns.length,
    latestRunId: facts.verificationRuns[0]?.id ?? null,
  };

  // The next action — the workflow authority's OWN facts (state + gates).
  const nextAction: NextActionView = {
    currentState: facts.workflowState,
    mergeReady: facts.mergeReadiness?.ready ?? null,
    reasons: facts.mergeReadiness?.reasons ?? [],
  };

  // The presentation-only comparison: does the routing recommendation differ
  // from the RECORDED selection? (Both sides are authorities' own values.)
  const routingIdentity = facts.routing?.selected?.identity;
  const selectionDiffersFromRoutingRecommendation: boolean | null =
    routingIdentity && actuallySelected
      ? routingIdentity.provider !== actuallySelected.provider ||
        routingIdentity.model !== actuallySelected.model ||
        routingIdentity.executionMode !== actuallySelected.mode
      : null;

  return {
    currentExecution,
    actuallySelected,
    executionHistory: facts.executions,
    routingAdvisory,
    intelligenceAdvisory,
    constraints,
    handoff,
    delegatedUnits,
    delegatedUnitCount: delegatedUnits.length,
    verification,
    nextAction,
    selectionDiffersFromRoutingRecommendation,
  };
}
