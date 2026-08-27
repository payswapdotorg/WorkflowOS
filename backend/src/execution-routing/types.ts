/**
 * WORK-044 — Adaptive Execution Router (PUBLIC CONTRACT).
 *
 * The execution-routing domain is an APPLICATION-LAYER ORCHESTRATOR that
 * lives at `src/execution-routing/` (mirrors the §34 benchmark +
 * execution-policy pattern: NOT the 18th frozen module — it CONSUMES the
 * frozen modules + the execution-policy domain via their public barrels).
 *
 * THE CRITICAL ARCHITECTURAL BOUNDARY (Work Order WORK-044):
 *
 *   WORK-043 eligibility            (the authoritative HARD gate)
 *           ↓
 *   eligible candidates only        (nothing else reaches ranking)
 *           ↓
 *   WORK-044 ranking                (THIS layer — selection only)
 *           ↓
 *   recommend / select              (advisory; the caller dispatches)
 *
 * The router is a SELECTION layer ONLY:
 *   - It consumes the authoritative WORK-043 eligibility verdict (produced
 *     by the ONE eligibility engine inside src/execution-policy/) and never
 *     re-evaluates, reinterprets, weakens, or bypasses hard constraints.
 *   - Benchmark evidence is a RANKING signal, never an eligibility override.
 *   - Native and external execution remain FIRST-CLASS modes: no ranking
 *     rule intrinsically prefers either (mode enters the score only through
 *     the explicit user-preference component).
 *   - Provider capability is NEVER modified, truncated, or downgraded to
 *     equalize benchmark outcomes (§21/§33.2 full-capability principle).
 *   - It NEVER mutates workflow state, NEVER authorizes, NEVER verifies,
 *     NEVER merges, NEVER stores credentials, and NEVER dispatches — both
 *     routing modes return an advisory result; the caller submits through
 *     the existing ExecutionService.submit() authority.
 *   - It is STATELESS: no routing table, no parallel decision ledger, no
 *     parallel usage ledger. The §22 append-only decision persisted by the
 *     consumed WORK-043 recommendation anchors every routing's audit trail
 *     (decisionId on the result).
 */
import type { ExecutionMode } from '@modules/agents';
import type {
  BenchmarkMode,
  BenchmarkPolicy,
  ExecutionCandidate,
  ExecutionEligibilityResult,
  ExecutionPreferenceProfile,
  ExecutionTaskProfile,
  HistoricalPerformance,
} from '../execution-policy/index.js';

// ============================================================================
// CANDIDATE IDENTITY — the total-order key (W044-AC14)
// ============================================================================

/**
 * The identity of one routing candidate: the (provider, model, execution
 * mode) triple. This is ALSO the final tie-break key: the lexicographic
 * order over (provider, model, executionMode) is a TOTAL ORDER over
 * candidate identities — independent of input order, object/hash iteration
 * order, or nondeterministic database ordering (W044-AC14).
 */
export interface RoutingCandidateIdentity {
  readonly provider: string;
  readonly model: string;
  readonly executionMode: ExecutionMode;
}

// ============================================================================
// RANKING SIGNALS — explicit, evidence-derived, never fabricated
// ============================================================================

/** The status of one ranking signal: observed evidence vs. insufficient. */
export type RoutingSignalStatus = 'observed' | 'insufficient';

/**
 * W044-AC04 dimension 1 — quality / benchmark outcome (§33.3: "historical
 * benchmark performance" — the DOMINANT axis). Raw observed
 * engineeringQualityScore (0–100); NEVER reduced to equalize providers
 * (§13 capability-ceiling invariant). `insufficient` mirrors §14: a single
 * trial is never definitive — the neutral prior applies, no fabrication.
 */
export interface QualitySignal {
  readonly observedQuality: number | null;
  readonly sampleSize: number;
  readonly sufficient: boolean;
}

/**
 * W044-AC04 dimension 2 — reliability: the candidate's demonstrated
 * tendency to produce work that passes CI + verification on the first
 * attempt (the two first-pass rates from the WORK-032 benchmark evidence).
 */
export interface ReliabilitySignal {
  readonly ciFirstPassRate: number | null;
  readonly verificationFirstPassRate: number | null;
  readonly sampleSize: number;
  readonly sufficient: boolean;
}

/**
 * W044-AC04 dimension 3 — cost (§24: never fabricated; unknown stays
 * unknown with the neutral component + `insufficient` status).
 */
export interface CostSignal {
  readonly cents: number | null;
  readonly confidence: 'known' | 'estimated' | 'unknown';
}

/**
 * W044-AC04 dimension 4 — latency (§25: authoritative WorkflowOS
 * timestamps only — median time-to-verified from benchmark evidence).
 */
export interface LatencySignal {
  readonly estimatedMs: number | null;
  readonly source: 'historical_observed' | 'estimated' | 'unknown';
}

/**
 * W044-AC04 dimension 5 — human intervention: the historical rate of
 * interventions the candidate's executions required (lower is better).
 * `humanInterventionCount` is the aggregate count over `sampleSize`
 * completed trials in the evidence cell.
 */
export interface HumanInterventionSignal {
  readonly count: number | null;
  readonly sampleSize: number;
}

/** One signal's normalized [0,1] component + its evidence status. */
export interface RankingComponent {
  /** The normalized component in [0,1] (higher is better). */
  readonly value: number;
  /** Whether this component rests on observed evidence or the documented neutral prior. */
  readonly status: RoutingSignalStatus;
}

// ============================================================================
// THE ROUTING INPUT MODEL — over ALREADY-ELIGIBLE candidates only
// ============================================================================

/**
 * W044-AC01/W044-AC11 — the explicit routing input model over
 * ALREADY-ELIGIBLE candidates. `eligibility` is the AUTHORITATIVE WORK-043
 * verdict carried through from the consumed recommendation; the ranking
 * seam REJECTS (fail-closed, typed error) any candidate whose verdict is
 * not `eligible` — an ineligible candidate can never be scored. The
 * capability profile is supplied read-only (W044-AC06: the router never
 * modifies, truncates, or downgrades it).
 */
export interface RoutingCandidate {
  readonly identity: RoutingCandidateIdentity;
  /** The authoritative WORK-043 verdict. MUST be eligible to enter ranking. */
  readonly eligibility: ExecutionEligibilityResult;
  readonly quality: QualitySignal;
  readonly reliability: ReliabilitySignal;
  readonly cost: CostSignal;
  readonly latency: LatencySignal;
  readonly humanIntervention: HumanInterventionSignal;
  /**
   * W044-AC06: the provider's capability profile, supplied by the
   * provider/eligibility inputs — passed through READ-ONLY. Capability
   * differences are used as hard constraints ONLY where WORK-043 requires
   * them; the router never equalizes them.
   */
  readonly capability: Readonly<Record<string, unknown>>;
}

/**
 * The pure ranking input (W044-AC04): the eligible candidates, the user's
 * advisory preference profile, the policy snapshot at decision time, and
 * the derived task profile.
 */
export interface RoutingRankInput {
  readonly candidates: readonly RoutingCandidate[];
  readonly preferences: ExecutionPreferenceProfile;
  readonly policy: BenchmarkPolicy;
  readonly taskProfile: ExecutionTaskProfile;
}

// ============================================================================
// RANKING OUTPUT — inspectable, deterministic
// ============================================================================

/** All five dimension components for one ranked candidate. */
export interface RoutingScoreComponents {
  readonly quality: RankingComponent;
  readonly reliability: RankingComponent;
  readonly cost: RankingComponent;
  readonly latency: RankingComponent;
  readonly humanIntervention: RankingComponent;
  /** The bounded advisory preference boost applied AFTER evidence scoring. */
  readonly preferenceBoost: number;
}

/** One ranked candidate: identity, total score, per-dimension components. */
export interface RoutingRankedCandidate {
  readonly identity: RoutingCandidateIdentity;
  /** The total score in [0,1] (evidence-weighted sum + bounded preference boost). */
  readonly score: number;
  readonly components: RoutingScoreComponents;
  /** The WORK-043 verdict carried through (always `eligible` on ranked output). */
  readonly eligibility: ExecutionEligibilityResult;
}

/**
 * W044-AC09 — the inspectable routing explanation: the selected candidate,
 * the ranked alternatives, the eligibility picture, the ranking signals
 * used, and the reason the selected candidate won among eligible options.
 */
export interface RoutingExplanation {
  /** Why the selected candidate won among the eligible options. */
  readonly selectionReason: string;
  /** The documented ranking methodology (dimensions, weights, tie-break chain). */
  readonly methodology: string;
  /** The number of eligible candidates ranked. */
  readonly eligibleCount: number;
  /**
   * The excluded candidates with their WORK-043 blocking reasons
   * (transparency: eligibility status of everyone who did NOT compete).
   */
  readonly excluded: readonly RoutingExcludedCandidate[];
  /** True when the winner was decided by the documented tie-break chain, not a score gap. */
  readonly tieBreakDecided: boolean;
}

/** An ineligible candidate surfaced for transparency (never ranked). */
export interface RoutingExcludedCandidate {
  readonly identity: RoutingCandidateIdentity;
  readonly eligibility: ExecutionEligibilityResult;
}

/** The pure ranking output. */
export interface RoutingRankOutput {
  readonly ranked: readonly RoutingRankedCandidate[];
  /** The top-ranked candidate (null iff no eligible candidates existed). */
  readonly selected: RoutingRankedCandidate | null;
  readonly explanation: RoutingExplanation;
}

// ============================================================================
// SERVICE CONTRACT — recommendation vs automatic selection
// ============================================================================

/**
 * The routing request. NO organization id is accepted (AR-043-04 lesson):
 * the organization scope is resolved SERVER-SIDE from the authoritative
 * project → organization relation (wfos_projects.organization_id), so the
 * org-scoped policy families are ACTIVE for every caller and can never be
 * spoofed or declared absent.
 */
export interface RoutingRequestInput {
  readonly projectId: string;
  readonly workItemId: string;
  readonly userId: string;
  /** Optional request-scoped benchmark mode override (the WORK-043 contract). */
  readonly benchmarkMode?: BenchmarkMode;
}

/**
 * W044-AC08 — RECOMMENDATION MODE: returns the inspectable ranking +
 * explanation WITHOUT mutating workflow state. The `recommended` candidate
 * is the top of the ranking (advisory; no selection commitment).
 */
export interface RoutingRecommendationResult {
  readonly mode: 'recommendation';
  readonly workItemId: string;
  readonly projectId: string;
  /** The §22 append-only decision id anchoring this routing's audit trail. */
  readonly decisionId: string;
  /** The top-ranked eligible candidate (advisory recommendation). */
  readonly recommended: RoutingRankedCandidate | null;
  /** The full ranked order over eligible candidates. */
  readonly ranked: readonly RoutingRankedCandidate[];
  readonly explanation: RoutingExplanation;
  /** The policy snapshot + task profile the ranking was computed under. */
  readonly policy: BenchmarkPolicy;
  readonly taskProfile: ExecutionTaskProfile;
  /** The project-level benchmark evidence summary (§14). */
  readonly benchmarkEvidence: HistoricalPerformance;
}

/**
 * W044-AC08 — AUTOMATIC-SELECTION MODE: the caller's explicit intent that
 * WorkflowOS choose the execution destination. Returns the SELECTED
 * eligible candidate + why it won + the alternatives it beat. Still does
 * NOT directly mutate authoritative workflow state — the caller dispatches
 * through the existing ExecutionService.submit() authority.
 */
export interface RoutingSelectionResult {
  readonly mode: 'automatic_selection';
  readonly workItemId: string;
  readonly projectId: string;
  readonly decisionId: string;
  /** The selected eligible candidate (null when NO eligible candidate exists — fail-safe, never falls back). */
  readonly selected: RoutingRankedCandidate | null;
  /** The eligible candidates the selection beat, in ranked order. */
  readonly alternatives: readonly RoutingRankedCandidate[];
  readonly explanation: RoutingExplanation;
  readonly policy: BenchmarkPolicy;
  readonly taskProfile: ExecutionTaskProfile;
}

/**
 * WORK-044 — the Adaptive Execution Router service. A SELECTION layer
 * ONLY: it consumes the WORK-043 eligibility verdict (via the
 * execution-policy domain's recommendation contract) and ranks the
 * ALREADY-ELIGIBLE candidates. It NEVER re-evaluates hard constraints.
 */
export interface AdaptiveExecutionRouterService {
  /** Recommendation mode (W044-AC08): inspectable ranking, no selection commitment. */
  recommendExecution(input: RoutingRequestInput): Promise<RoutingRecommendationResult>;
  /** Automatic-selection mode (W044-AC08): the selected eligible candidate + why it won. */
  selectExecution(input: RoutingRequestInput): Promise<RoutingSelectionResult>;
}

/** The candidate-consumption port (structurally satisfied by ExecutionRecommendation). */
export interface RoutingEligibilitySource {
  readonly eligibleCandidates: readonly ExecutionCandidate[];
  readonly excludedCandidates: readonly ExecutionCandidate[];
  readonly policy: BenchmarkPolicy;
  readonly taskProfile: ExecutionTaskProfile;
  readonly benchmarkEvidence: HistoricalPerformance;
  readonly decisionId: string;
}

// ============================================================================
// TYPED FAILURES — deterministic, documented, fail-closed (W044-AC10)
// ============================================================================

export type ExecutionRoutingErrorCode =
  /** An ineligible candidate reached the ranking seam (defense in depth — the public path cannot produce this). */
  | 'execution-routing-ineligible-candidate'
  /** Two candidates share the same identity (provider, model, mode) — inconsistent input. */
  | 'execution-routing-duplicate-candidate'
  /** A ranking signal carries an invalid value (NaN, negative sample, out-of-range rate). */
  | 'execution-routing-invalid-signal'
  /** The project's organization scope could not be resolved — fail closed (AR-043-04 lesson). */
  | 'execution-routing-organization-unresolved';

/** The typed, fail-closed routing error. Never falls back to an ineligible candidate. */
export class ExecutionRoutingError extends Error {
  readonly code: ExecutionRoutingErrorCode;
  constructor(code: ExecutionRoutingErrorCode, message: string) {
    super(message);
    this.name = 'ExecutionRoutingError';
    this.code = code;
  }
}
