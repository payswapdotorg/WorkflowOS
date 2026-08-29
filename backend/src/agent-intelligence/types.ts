/**
 * WORK-047 — Agent Intelligence: the public advisory contracts.
 *
 * The agent-intelligence domain lives at `src/agent-intelligence/`
 * (application-layer ORCHESTRATOR outside src/modules/, mirroring the §34
 * benchmark / execution-policy / execution-routing / agent-roles /
 * delegation pattern — NOT the 18th frozen module). The terminal slice of
 * the forward dependency chain:
 *
 *   WORK-044 (routing) → WORK-045 Agent Roles → WORK-046 Delegation
 *        → WORK-047 Agent Intelligence
 *
 * THE INTELLIGENCE LAYER IS ADVISORY/RANKING ONLY (spec/architecture.md
 * §33.9 + spec/work-orders/WORK-047.md — the non-negotiable authority
 * ordering):
 *
 *   hard eligibility / constraints        (WORK-043 — the ONE engine)
 *           ↓
 *   eligible candidates
 *           ↓
 *   routing / execution policy            (WORK-044 + the §22 snapshot)
 *           ↓
 *   historical intelligence               (THIS layer — ranking only)
 *           ↓
 *   recommendation                        (advisory; the caller decides)
 *
 *   - The ranking input is the WORK-044 routing result's ALREADY-ELIGIBLE
 *     ranked set (consumed through AdaptiveExecutionRouterService). An
 *     ineligible candidate can NEVER be scored, ranked, recommended, or
 *     assigned: the seam REJECTS it with a typed error (defense in depth,
 *     mirroring the W044-AC01/W044-AC11 seam).
 *   - It never re-evaluates, reinterprets, weakens, or bypasses hard
 *     constraints; the excluded picture is carried through from the
 *     authority's verdicts VERBATIM (the authority's words, never invented
 *     exclusion reasons).
 *   - It never implements a second routing engine: the routing score is
 *     CONSUMED as a component; the only NEW signal is the observed
 *     execution history (terminal outcomes per (provider, model, mode) from
 *     the EXISTING wfos_executions store) — a signal WORK-044 does not see.
 *   - It never authors or redefines roles: role recommendations resolve
 *     through the WORK-045 AgentRoleCatalogService and pin the revision.
 *   - A decomposition recommendation is DATA the caller submits through the
 *     EXISTING WORK-046 delegation plan boundary; intelligence never creates
 *     or drives a plan and never executes anything.
 *   - Historical evidence comes from EXISTING authoritative stores ONLY
 *     (wfos_executions + the W046-AC10 delegation structured state + the
 *     benchmark evidence carried through the consumed recommendation): NO
 *     second historical-data store, NO migration, NO new tables.
 *   - It is STATELESS and DETERMINISTIC: identical inputs → identical
 *     recommendations; every ordering is decided by a documented total
 *     order; stale evidence is surfaced (observation windows), never
 *     presented as current.
 *   - It NEVER mutates workflow/execution/verification/review/delegation
 *     state; the only durable artifact of a recommendation is the §22
 *     policy decision persisted by the CONSUMED recommendation path
 *     (recorded truthfully on every result as `decisionId`).
 */

import type { AgentRoleId, AgentRoleResolution } from '../agent-roles/index.js';
import type {
  BenchmarkMode,
  ExecutionEligibilityResult,
  ExecutionTaskProfile,
  HistoricalPerformance,
} from '../execution-policy/index.js';
import type {
  RoutingCandidateIdentity,
  RoutingRankedCandidate,
} from '../execution-routing/index.js';

// ============================================================================
// HISTORICAL EVIDENCE — read-only aggregation over EXISTING stores
// ============================================================================

/** The evidence status of one signal (§14 precedent: never fabricate). */
export type IntelligenceSignalStatus = 'observed' | 'insufficient';

/**
 * The observed execution history of one (provider, model, mode) cell —
 * terminal outcomes aggregated from the EXISTING wfos_executions rows of the
 * scoped project. Succeeded = the execution record reached 'completed';
 * failed = a failed terminal state ('failed' | 'cancelled' | 'expired') —
 * the same terminal semantics the WORK-046 delegation attempt observation
 * uses. NO new rows are written; this is a read-only aggregate.
 */
export interface ExecutionHistoryCell {
  readonly provider: string;
  readonly model: string | null;
  readonly mode: 'native' | 'external';
  /** Terminal executions observed in the cell. */
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  /** succeeded / attempts; null iff attempts === 0 (never fabricated). */
  readonly successRate: number | null;
  /** Median duration over the SUCCEEDED executions (authoritative timestamps). */
  readonly medianDurationMs: number | null;
  /** The observation window — stale evidence is surfaced, never hidden. */
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
}

/**
 * The observed delegation history of one (role, provider, mode) cell —
 * terminal attempt outcomes aggregated from the EXISTING W046-AC10
 * delegation structured state, scoped to the project through the
 * authoritative work-item → architecture → project chain. `unresolved`
 * attempts count as attempts but NOT successes (conservative).
 */
export interface DelegationRoleHistoryCell {
  readonly roleId: AgentRoleId;
  /** The pinned catalog revision observed on the unit (W045-AC10). */
  readonly roleRevision: string;
  readonly provider: string;
  readonly mode: 'native' | 'external';
  /** Terminal attempts observed in the cell (outcome IS NOT NULL). */
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly unresolved: number;
  /** succeeded / attempts; null iff attempts === 0. */
  readonly successRate: number | null;
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
}

/**
 * The evidence summary backing a recommendation — the complete picture of
 * which historical evidence contributed, with the scope visible (tenant
 * isolation is inspectable, not just asserted).
 */
export interface IntelligenceEvidenceSummary {
  /** The project every cell was scoped to. */
  readonly scope: { readonly projectId: string };
  readonly executionCells: readonly ExecutionHistoryCell[];
  readonly roleCells: readonly DelegationRoleHistoryCell[];
  /** The benchmark evidence carried through the consumed routing result. */
  readonly benchmark: HistoricalPerformance;
  /** The derived task profile the routing consumed (§15 — carried through). */
  readonly taskProfile: ExecutionTaskProfile;
}

// ============================================================================
// SIGNALS + RANKING — the intelligence re-ranking of the eligible set
// ============================================================================

/**
 * The observed historical-success signal for one candidate. `successRate` is
 * null when no terminal execution was ever observed for the cell — the
 * documented NEUTRAL PRIOR then applies (status 'insufficient'; never a
 * fabricated rate). `sufficient` follows the §14 precedent: a sample below
 * INSUFFICIENT_SAMPLE (3) is never definitive.
 */
export interface HistoricalSuccessSignal {
  readonly successRate: number | null;
  readonly sampleSize: number;
  readonly sufficient: boolean;
  readonly lastObservedAt: Date | null;
}

/** One component of the intelligence score (value + evidence status). */
export interface IntelligenceComponent {
  /** The normalized component in [0,1] (higher is better). */
  readonly value: number;
  readonly status: IntelligenceSignalStatus;
}

/**
 * The per-candidate intelligence score components. The ROUTING score is
 * CONSUMED (carried through from the WORK-044 ranking — the authority's
 * order is visible, never recomputed); the HISTORICAL component is the
 * observed execution-history signal this layer adds.
 */
export interface IntelligenceScoreComponents {
  /** The WORK-044 score carried through (status always 'observed'). */
  readonly routing: IntelligenceComponent;
  /** The observed execution-history success component (neutral prior when insufficient). */
  readonly historicalSuccess: IntelligenceComponent;
}

/** One intelligence-ranked candidate. */
export interface IntelligenceRankedCandidate {
  readonly identity: RoutingCandidateIdentity;
  /** The composite intelligence score in [0,1]. */
  readonly score: number;
  readonly components: IntelligenceScoreComponents;
  /** The observed evidence behind the historical component. */
  readonly historicalSignal: HistoricalSuccessSignal;
  /** The WORK-043 verdict carried through (always eligible on ranked output). */
  readonly eligibility: ExecutionEligibilityResult;
  /** The candidate's position in the consumed routing ranking. */
  readonly routingRank: number;
}

/** An ineligible candidate surfaced for transparency with the AUTHORITY's reasons. */
export interface IntelligenceRejectedAlternative {
  readonly identity: RoutingCandidateIdentity;
  readonly eligibility: ExecutionEligibilityResult;
  /** Which authority excluded it (policy / capability / routing-carried) — descriptive. */
  readonly excludedThrough: 'policy' | 'capability' | 'routing' | 'other';
}

// ============================================================================
// PROVENANCE — the four questions (spec/work-orders/WORK-047.md)
// ============================================================================

/** One structured reason on a recommendation. */
export interface IntelligenceReason {
  readonly dimension: IntelligenceReasonDimension;
  readonly detail: string;
}

export type IntelligenceReasonDimension =
  | 'historical_success'      // observed execution-history evidence
  | 'routing_signal'          // the consumed WORK-044 ranking
  | 'benchmark_evidence'      // evidence carried through the routing result
  | 'task_profile'            // the derived task characteristics
  | 'hard_constraints'        // constraints already applied by the authority
  | 'determinism'             // tie-breaks and neutral-prior explanations
  | 'unavailable';            // explicit uncertainty (never fabricated)

/** One evidence contribution: which cell contributed, what it said. */
export interface EvidenceContribution {
  /** The evidence cell key (`provider/model/mode` or `role/provider/mode`). */
  readonly cell: string;
  readonly kind: 'execution-history' | 'role-history' | 'benchmark';
  readonly attempts: number;
  readonly succeeded: number;
  readonly successRate: number | null;
  /** The observation window — stale evidence surfaced, never hidden. */
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
}

/** The constraints-already-applied record (carried from the authority). */
export interface ConstraintsAppliedRecord {
  /** The §22 append-only decision id of the consumed recommendation — the durable audit anchor. */
  readonly decisionId: string;
  /** The WORK-043 satisfied constraints of the recommended candidate (carried verbatim). */
  readonly satisfiedConstraints: readonly string[];
}

/** The consumed routing result summary (the authority input, inspectable). */
export interface ConsumedRoutingSummary {
  readonly mode: 'recommendation';
  readonly decisionId: string;
  /** The router's top pick (the ranking this layer re-weighs). */
  readonly routingRecommended: RoutingCandidateIdentity | null;
  readonly eligibleCount: number;
  /** The router's order (identities in routing rank order). */
  readonly routingOrder: readonly RoutingCandidateIdentity[];
}

/** The full provenance model answering the four questions. */
export interface IntelligenceProvenance {
  /** Why was this recommended? */
  readonly headline: string;
  readonly reasons: readonly IntelligenceReason[];
  /** Which historical evidence contributed? */
  readonly contributingEvidence: readonly EvidenceContribution[];
  /** What constraints were already applied? */
  readonly constraintsApplied: ConstraintsAppliedRecord | null;
  /** What alternatives were rejected (and by which authority)? */
  readonly rejectedAlternatives: readonly IntelligenceRejectedAlternative[];
  /** The consumed routing result (the authority input). */
  readonly routing: ConsumedRoutingSummary;
  /** The confidence of the recommendation (deterministic function of the evidence). */
  readonly confidence: 'low' | 'medium' | 'high';
}

// ============================================================================
// THE EXECUTION RECOMMENDATION (advisory)
// ============================================================================

/**
 * The advisory execution recommendation: the intelligence re-ranking of the
 * router's eligible set, the ordered FALLBACK STRATEGY, and the full
 * provenance. `recommended` is null when NO eligible candidate exists — the
 * fail-closed answer (never a fallback to an ineligible candidate).
 */
export interface IntelligenceExecutionRecommendation {
  readonly mode: 'recommendation';
  readonly projectId: string;
  readonly workItemId: string;
  /** The top of the intelligence ranking (null iff no eligible candidates). */
  readonly recommended: IntelligenceRankedCandidate | null;
  /** The full intelligence order over the eligible set. */
  readonly ranked: readonly IntelligenceRankedCandidate[];
  /** The ordered fallback strategy (ranked[1..]) with the rationale on the result. */
  readonly fallbacks: readonly IntelligenceRankedCandidate[];
  /** The ineligible candidates with the AUTHORITY's blocking reasons. */
  readonly rejectedAlternatives: readonly IntelligenceRejectedAlternative[];
  readonly provenance: IntelligenceProvenance;
  readonly evidence: IntelligenceEvidenceSummary;
  readonly warnings: readonly string[];
}

// ============================================================================
// THE DELEGATION DECOMPOSITION RECOMMENDATION (advisory data, never executed)
// ============================================================================

/** One recommended delegation unit (the WORK-046 request vocabulary). */
export interface IntelligenceUnitRecommendation {
  readonly unitKey: string;
  /** A closed WORK-045 role identity — resolved + revision-pinned. */
  readonly role: AgentRoleId;
  readonly roleRevision: string;
  /**
   * The execution assignment from the intelligence ranking (the top
   * eligible candidate). null when NO eligible candidate exists — the unit
   * is still recommended (roles are provider-independent) with the
   * assignment explicitly unavailable.
   */
  readonly mode: 'native' | 'external' | null;
  readonly provider: string | null;
  readonly model: string | null;
  /** Unit KEYS this unit depends on (within the recommended plan). */
  readonly dependsOn: readonly string[];
  /** Why this role: the task-profile rule + the observed role history. */
  readonly why: readonly IntelligenceReason[];
  /** The observed role-history annotation (never drops the unit). */
  readonly roleHistory: EvidenceContribution | null;
}

/** A role considered for the decomposition but not recommended, with the reason. */
export interface IntelligenceRejectedRole {
  readonly role: AgentRoleId;
  readonly reason: string;
}

/**
 * The advisory delegation decomposition: a `DelegationPlanInput`-shaped
 * recommendation the caller submits through the EXISTING WORK-046 boundary
 * (POST …/delegation-plans), which validates roles/providers/dependencies
 * fail-closed. Intelligence never creates, drives, or executes a plan.
 */
export interface IntelligenceDelegationRecommendation {
  readonly mode: 'recommendation';
  readonly projectId: string;
  readonly workItemId: string;
  /** The suggested plan key for the submission ('intelligence-recommended'). */
  readonly planKey: string;
  readonly units: readonly IntelligenceUnitRecommendation[];
  /** Roles considered but not recommended, with reasons. */
  readonly rejectedRoles: readonly IntelligenceRejectedRole[];
  /** The execution recommendation the assignments came from (never null — the excluded picture explains unavailable assignments). */
  readonly execution: IntelligenceExecutionRecommendation;
  readonly evidence: IntelligenceEvidenceSummary;
  readonly warnings: readonly string[];
  /** The submission path (documentation — the EXISTING authority boundary). */
  readonly submissionPath: string;
}

// ============================================================================
// SERVICE CONTRACT
// ============================================================================

/**
 * The intelligence request. NO organization id (the AR-043-04 lesson,
 * mirrored from the routing contract): the organization scope is resolved
 * server-side by the CONSUMED routing path from the authoritative project →
 * organization relation.
 */
export interface IntelligenceRequestInput {
  readonly projectId: string;
  readonly workItemId: string;
  readonly userId: string;
  /** Optional request-scoped benchmark mode override (the WORK-043 contract, passed through). */
  readonly benchmarkMode?: BenchmarkMode;
}

/**
 * WORK-047 — the Agent Intelligence service. ADVISORY/RANKING ONLY: both
 * operations are read-only, deterministic, and project-scoped; neither
 * mutates ANY authoritative state (the only durable artifact is the §22
 * decision of the consumed recommendation path, anchored as decisionId).
 */
export interface AgentIntelligenceService {
  /**
   * The advisory execution recommendation: the intelligence re-ranking of
   * the WORK-044 routing result's already-eligible set using the observed
   * execution-history signal, plus the ordered fallback strategy and full
   * provenance. Fail-closed: no eligible candidates → recommended null
   * (never a fallback); an ineligible candidate at the seam → typed error.
   */
  recommendExecution(input: IntelligenceRequestInput): Promise<IntelligenceExecutionRecommendation>;

  /**
   * The advisory delegation decomposition: the deterministic,
   * task-profile-driven unit structure over the WORK-045 catalog with
   * execution assignments from the intelligence ranking, role-history
   * annotations, rejected role alternatives, and the submission path
   * through the EXISTING WORK-046 delegation boundary.
   */
  recommendDelegation(input: IntelligenceRequestInput): Promise<IntelligenceDelegationRecommendation>;
}

/** The read-only historical-evidence repository port (existing stores only). */
export interface AgentIntelligenceRepository {
  /** Terminal execution outcomes per (provider, model, mode), project-scoped. */
  collectExecutionHistory(projectId: string): Promise<readonly ExecutionHistoryCell[]>;
  /** Terminal delegation attempt outcomes per (role, provider, mode), project-scoped. */
  collectDelegationRoleHistory(projectId: string): Promise<readonly DelegationRoleHistoryCell[]>;
}

/** The role-catalog port (structurally satisfied by AgentRoleCatalogService). */
export interface IntelligenceRoleCatalogLike {
  resolveRole(identity: string): AgentRoleResolution | null;
}

// ============================================================================
// TYPED FAILURES — deterministic, documented, fail-closed
// ============================================================================

export type AgentIntelligenceErrorCode =
  /** An ineligible candidate reached the ranking seam (defense in depth — the public path cannot produce this). */
  | 'agent-intelligence-ineligible-candidate'
  /** A decomposition rule named a role absent from the WORK-045 catalog (fail closed). */
  | 'agent-intelligence-unknown-role'
  /** An evidence or ranking signal carries an invalid value (NaN, negative sample, out-of-range rate). */
  | 'agent-intelligence-invalid-signal'
  /** The consumed routing result is unusable (absent task profile / ranked set inconsistent). */
  | 'agent-intelligence-routing-input-invalid';

/** The typed, fail-closed intelligence error. Never falls back to an ineligible candidate. */
export class AgentIntelligenceError extends Error {
  readonly code: AgentIntelligenceErrorCode;

  constructor(code: AgentIntelligenceErrorCode, message: string) {
    super(`agent-intelligence: ${message}`);
    this.name = 'AgentIntelligenceError';
    this.code = code;
  }
}

// Re-exported for consumer convenience (the consumed authority's shapes).
export type { RoutingCandidateIdentity, RoutingRankedCandidate };
