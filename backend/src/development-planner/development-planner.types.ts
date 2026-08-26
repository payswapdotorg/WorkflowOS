/**
 * WORK-040: Continuous Development Planner — the application/planning-
 * intelligence capability that turns product goals, technical debt, refactors,
 * performance opportunities, developer requests, and dependency-aware
 * priorities into GOVERNED WORK ITEMS through the EXISTING /work-items
 * authority.
 *
 * This directory is NOT a frozen module (it is not under src/modules/) and is
 * NOT an authority. It is an APPLICATION/PLANNING CAPABILITY (analogous to
 * src/onboarding/, src/repository-intelligence/, src/execution-policy/,
 * src/benchmark/) that COMPOSES the EXISTING domain authorities to decide
 * "what should be done next?" + convergently create authoritative Work Items:
 *
 *   * /work-items — the AUTHORITATIVE Work Item authority. The planner CREATES
 *                  Work Items through the existing WorkItemRepository.create
 *                  (the single creation path). The dedup natural key is the
 *                  existing UNIQUE(architecture_version_id, work_item_id) DB
 *                  constraint + the planner's deterministic proposedWorkItemId.
 *                  The planner NEVER mutates the dependency graph (no add /
 *                  remove); it READS it for dependency-aware explanation only.
 *   * /architecture — read-only authority references (the planner resolves the
 *                  target ArchitectureVersion + cites ADRs as evidence; it
 *                  NEVER auto-freezes / never creates versions).
 *   * /requirements — read-only authority references (cited as evidence).
 *   * /projects  — the planner resolves the project + organizationId for
 *                  tenant scoping; it NEVER creates projects.
 *   * /github    — NEVER imported by the planner domain (the revision-bound
 *                  baselineCommitSha is carried in the signal; the planner does
 *                  NOT re-resolve the repo — that is the WORK-039 caller's job).
 *   * WORK-039   — CONSUMED at the SIGNAL-PRODUCTION layer (the explicit
 *                  trigger caller MAY derive PlanningSignals from
 *                  retrieveExisting; the planner itself does NOT call
 *                  retrieveExisting — it does NOT rebuild the context engine).
 *   * /workflows, /verification, /reviews, /agents — NEVER mutated/invoked.
 *
 * THE MOST IMPORTANT DISTINCTION (the WORK-040 prompt):
 *   SOURCE FACT            — "src/api/users.ts exists."           (the repo)
 *   BASELINE OBSERVATION   — "The repository contains an Express API."
 *   PLANNER CANDIDATE      — "OAuth refresh refactor recommended." (this)
 *   AUTHORITATIVE WORK ITEM— the row in wfos_work_items.          (/work-items)
 * These concepts are NEVER collapsed. A planner recommendation is `proposed`;
 * it NEVER becomes `confirmed` without an authorized confirmation path.
 *
 * PROVENANCE PRESERVATION. Every planning signal + recommendation carries the
 * SAME provenance vocabulary as WORK-038 (observed | inferred | confirmed |
 * proposed). A planner recommendation is `proposed` (or `observed`/`inferred`
 * when the signal carries that provenance). The planner NEVER promotes
 * provenance to `confirmed` — confirmation is a separate authorized path on a
 * baseline observation. Provenance is recorded in the Work Item's
 * `metadata.planner.provenance` (NOT a new column; NOT an authority mutation).
 *
 * DEDUP / IDEMPOTENCY. The planner computes a deterministic proposedWorkItemId
 * = "PLAN-" + sha256(canonical(goal) + "|" + canonical(scope)).slice(0,10).
 * The existing UNIQUE(architecture_version_id, work_item_id) DB constraint is
 * the persistence-level dedup fence. Two concurrent planner runs evaluating
 * the same signal produce the same proposedWorkItemId → the second INSERT
 * throws unique-violation → the planner catches + re-queries → CONVERGES. No
 * application-level "check-then-insert" reliance — the DB constraint is the
 * hard guarantee.
 *
 * TRIGGER MODEL. "Continuous" does NOT mean polling. The planner is triggered
 * EXPLICITLY: POST .../planning/evaluate (synchronous mutation, project.write)
 * is the canonical trigger. A durable `planning.evaluate` JobHandler (idempotent
 * + redeliveryPolicy) is registered with the existing WorkerHost so future
 * async signals (completed-work, architecture-change) can enqueue planner runs
 * — reusing the EXISTING Queue + WorkerHost, NO new scheduler, NO setInterval,
 * NO cron, NO forever-loop.
 *
 * The planner NEVER mutates workflow / verification / review / execution state,
 * NEVER starts execution, NEVER selects a provider, NEVER bypasses policy, and
 * NEVER imports provider SDKs (no pg/redis/pglite/github-sdk here — those stay
 * in /platform + /github internal). The authoritative Work Item the planner
 * creates enters the EXISTING Work Item → Work Order → Execution → Verification
 * → Review lifecycle; the planner does NOT advance it.
 */
import type {
  WorkItemRepository,
  WorkItemDependencyRepository,
} from '@modules/work-items/index.js';
import type {
  ArchitectureVersionRepository,
  ArchitectureRepository,
} from '@modules/architecture/index.js';
import type {
  RequirementRepository,
  AcceptanceCriterionRepository,
} from '@modules/requirements/index.js';
import type { Logger } from '@platform/index.js';

// ---------------------------------------------------------------------------
// Provenance (re-uses the WORK-038 vocabulary — NEVER collapsed).
// ---------------------------------------------------------------------------

/**
 * The provenance vocabulary for a planning signal. This is the SAME vocabulary
 * as WORK-038 (observed | inferred | confirmed | proposed). A planner signal
 * is NEVER `confirmed` — confirmation is a separate authorized path on a
 * baseline observation. The planner passes provenance through verbatim to the
 * created Work Item's metadata.planner.provenance; it NEVER promotes it.
 */
export type PlanningProvenance = 'observed' | 'inferred' | 'proposed';

// ---------------------------------------------------------------------------
// Evidence refs (where a recommendation came from).
// ---------------------------------------------------------------------------

export type PlanningEvidenceKind =
  | 'baseline-observation'
  | 'repository-context'
  | 'architecture-observation'
  | 'requirement'
  | 'criterion'
  | 'dependency-graph'
  | 'existing-work-item'
  | 'benchmark-evidence'
  | 'explicit-user-input';

/**
 * A typed pointer to where a piece of planning evidence came from. The ref is
 * an authority id / locator (e.g. a baseline observation id, a context item
 * locator, a work item id, a requirement id). The planner NEVER dereferences
 * these into authoritative state mutations — it records them as evidence so
 * the recommendation is traceable.
 */
export interface PlanningEvidenceRef {
  readonly kind: PlanningEvidenceKind;
  readonly ref: string;
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// Planning signals (the input — what should be done + why).
// ---------------------------------------------------------------------------

export type PlanningSignalKind =
  | 'developer-request'
  | 'product-goal'
  | 'technical-debt'
  | 'refactor'
  | 'performance-opportunity'
  | 'dependency-observation'
  | 'completed-work'
  | 'architecture-observation'
  | 'requirement-gap'
  | 'benchmark-evidence';

/**
 * A planning signal. The canonicalGoal is the deterministic, canonicalized
 * statement of what should be done (e.g. "Refactor OAuth refresh token logic").
 * Two signals with the same canonicalGoal (+ scope) produce the same dedupKey
 * → the same proposedWorkItemId → convergent Work Item creation. The
 * provenance is NEVER `confirmed` (the planner cannot confirm; it can only
 * observe / infer / propose).
 */
export interface PlanningSignal {
  readonly kind: PlanningSignalKind;
  readonly canonicalGoal: string;
  readonly scope?: string;
  readonly provenance: PlanningProvenance;
  readonly evidenceRefs?: readonly PlanningEvidenceRef[];
  /** Existing work item ids this signal relates to (for dependency-aware explanation). */
  readonly relatedWorkItemIds?: readonly string[];
  /** Optional originator (e.g. the user id for a developer-request). */
  readonly originator?: string;
  /** The revision this signal was observed at (revision-bound evidence). */
  readonly baselineCommitSha?: string;
  /** Optional explicit "blocks N items" declaration (the signal's own assessment). */
  readonly blocksCount?: number;
}

// ---------------------------------------------------------------------------
// Priority (deterministic + explainable — NOT an opaque AI score).
// ---------------------------------------------------------------------------

export type PlanningPriority = 'high' | 'medium' | 'low';

export type PlanningPriorityFactorKind =
  | 'blocks-n-downstream'
  | 'requested-by-developer'
  | 'architecture-risk'
  | 'dependency-chain'
  | 'technical-debt'
  | 'performance-opportunity'
  | 'product-goal'
  | 'completed-work-unblocks'
  | 'requirement-gap'
  | 'benchmark-evidence'
  | 'confidence-evidence-quality';

/**
 * A discrete, explainable priority factor. Each contributes a weight + a
 * human-readable detail. The prioritizer sums the weights → a discrete
 * priority band (high / medium / low). NO opaque AI score — every factor is
 * traceable.
 */
export interface PlanningPriorityFactor {
  readonly kind: PlanningPriorityFactorKind;
  readonly weight: number;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// The candidate (the prioritizer's output — before dedup / creation).
// ---------------------------------------------------------------------------

/**
 * The planning candidate: a prioritized recommendation derived from a signal,
 * BEFORE dedup + authoritative Work Item creation. The proposedWorkItemId is
 * deterministic ("PLAN-" + sha256(canonicalGoal + "|" + scope).slice(0,10)) —
 * the dedup key. The proposedDependencies are EXISTING work item ids the
 * candidate relates to (explanation only — the planner NEVER mutates the
 * dependency graph; authoritative dependency changes go through the existing
 * /work-items/dependencies route).
 */
export interface PlanningCandidate {
  readonly signal: PlanningSignal;
  readonly canonicalGoalHash: string;
  readonly proposedWorkItemId: string;
  readonly title: string;
  readonly objective: string;
  readonly scope: string | null;
  readonly priority: PlanningPriority;
  readonly priorityFactors: readonly PlanningPriorityFactor[];
  readonly rationale: string;
  readonly whyNow: string;
  readonly expectedImpact: string;
  readonly proposedDependencies: readonly string[];
  /** Advisory only — the frozen spec says execution may be native or external per eligibility/policy. The planner does NOT select a provider. */
  readonly executionModeAdvisory: 'native-or-external-per-eligibility';
}

// ---------------------------------------------------------------------------
// The recommendation (the final output — after dedup + creation).
// ---------------------------------------------------------------------------

export type PlanningRecommendationStatus =
  | 'created'
  | 'already-exists'
  | 'evaluation-failed';

/**
 * A planning recommendation: the candidate + the outcome of attempting to turn
 * it into an authoritative Work Item through the existing /work-items create.
 * `status`:
 *   * 'created'          — a NEW authoritative Work Item was created (via the
 *                          existing WorkItemRepository.create).
 *   * 'already-exists'    — an equivalent Work Item (same proposedWorkItemId in
 *                          the same architecture version) already existed
 *                          (convergence — NO duplicate created; NO mutation of
 *                          the existing item).
 *   * 'evaluation-failed'— the candidate could NOT be turned into a Work Item
 *                          (e.g. a persistence error). NO false Work Item was
 *                          created — the create threw, nothing landed.
 */
export interface PlanningRecommendation {
  readonly candidate: PlanningCandidate;
  readonly status: PlanningRecommendationStatus;
  /** The authoritative wfos_work_items.id — present when status is 'created' or 'already-exists'. */
  readonly workItemId?: string;
  /** The authoritative wfos_work_items.work_item_id (e.g. PLAN-a1b2c3d4). */
  readonly workItemHumanId?: string;
  /** Present when status is 'evaluation-failed' — the planner did NOT create a false Work Item. */
  readonly failureReason?: string;
}

/**
 * READ-ONLY summary of a planner-originated Work Item (one whose
 * metadata.planner exists). Returned by listRecommendations. NEVER creates /
 * mutates — the GET route uses this so a read-authorized caller can NEVER
 * trigger a state mutation.
 */
export interface PlanningRecommendationSummary {
  readonly workItemId: string;
  readonly workItemHumanId: string;
  readonly title: string;
  readonly objective: string | null;
  readonly scope: string | null;
  readonly completed: boolean;
  readonly planner: PlanningMetadataPayload;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The planning evidence payload embedded in the authoritative Work Item's
 * `metadata.planner` JSONB field. This is NOT a new column / table — it lives
 * in the existing wfos_work_items.metadata. It records the recommendation's
 * source, provenance, priority, evidence, dedup key, + the revision the
 * signal was bound to (revision-bound evidence). Provenance is NEVER promoted
 * (a frozen architecture authority state ≠ confirmed provenance).
 */
export interface PlanningMetadataPayload {
  readonly source: PlanningSignalKind;
  readonly provenance: PlanningProvenance;
  readonly priority: PlanningPriority;
  readonly priorityFactors: readonly PlanningPriorityFactor[];
  readonly rationale: string;
  readonly whyNow: string;
  readonly expectedImpact: string;
  readonly dedupKey: string;
  readonly canonicalGoalHash: string;
  readonly canonicalGoal: string;
  readonly baselineCommitSha: string | null;
  readonly evaluatedAt: string;
  readonly plannerVersion: string;
}

// ---------------------------------------------------------------------------
// The orchestrator input + result.
// ---------------------------------------------------------------------------

/**
 * The input to evaluate. The architectureVersionId is the TARGET version the
 * created Work Items will belong to (the existing traceability chain:
 * Work Item → ArchitectureVersion → Architecture → Project). The signals are
 * the planning inputs. The baselineCommitSha (optional) is the revision the
 * signals' evidence was bound to (revision-bound evidence — recorded in each
 * created Work Item's metadata.planner.baselineCommitSha). The idempotencyKey
 * (optional) is for the durable job (the planner is convergent regardless —
 * the DB constraint fences concurrent runs — but the key is carried for
 * traceability).
 */
export interface PlanningEvaluateInput {
  readonly projectId: string;
  readonly architectureVersionId: string;
  readonly signals: readonly PlanningSignal[];
  readonly baselineCommitSha?: string;
  readonly idempotencyKey?: string;
}

export interface PlanningEvaluateResult {
  readonly recommendations: readonly PlanningRecommendation[];
  /** The architecture version the created Work Items belong to. */
  readonly architectureVersionId: string;
  /** How many NEW authoritative Work Items were created (status 'created'). */
  readonly createdCount: number;
  /** How many candidates converged onto existing Work Items (status 'already-exists'). */
  readonly alreadyExistsCount: number;
  /** How many candidates could NOT be turned into Work Items (status 'evaluation-failed'). */
  readonly failedCount: number;
}

// ---------------------------------------------------------------------------
// The resolution context (the read-only authority handles).
// ---------------------------------------------------------------------------

/**
 * The read-only authority handles the planner needs. The planner NEVER holds
 * credentials, NEVER imports /github internal/ (the revision is carried in the
 * signal), NEVER imports /workflows / /verification / /reviews internal/
 * (never mutated). The /architecture + /requirements handles are for resolving
 * the target version + citing evidence refs (read-only).
 */
export interface PlanningContext {
  readonly organizationId: string;
  readonly projectId: string;
  readonly workItemRepository: WorkItemRepository;
  readonly workItemDependencyRepository: WorkItemDependencyRepository;
  readonly architectureVersionRepository: ArchitectureVersionRepository;
  readonly architectureRepository: ArchitectureRepository;
  readonly requirementRepository: RequirementRepository;
  readonly acceptanceCriterionRepository: AcceptanceCriterionRepository;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// The prioritizer (deterministic, explainable, NEVER promotes provenance).
// ---------------------------------------------------------------------------

/**
 * The deterministic, explainable prioritizer. Turns a signal into a candidate
 * (priority + priorityFactors + rationale + whyNow + expectedImpact + proposed
 * dependencies). NO opaque AI score — every factor is discrete + traceable. The
 * prioritizer NEVER mutates provenance (it reads it from the signal + passes it
 * to the candidate verbatim). The prioritizer MAY consult the existing
 * dependency graph (read-only) to surface dependency-aware explanation
 * (blockers / prerequisites / chains); it NEVER mutates the graph.
 */
export interface PlanningPrioritizer {
  prioritize(
    signal: PlanningSignal,
    ctx: PlanningContext,
  ): Promise<PlanningCandidate>;
}

// ---------------------------------------------------------------------------
// The orchestrator interface.
// ---------------------------------------------------------------------------

export interface DevelopmentPlannerService {
  /**
   * MUTATION — requires WRITE authority. Evaluate planning signals, dedup
   * against existing Work Items in the target architecture version, create
   * authoritative Work Items for non-duplicate candidates THROUGH the existing
   * /work-items WorkItemRepository.create (embedding planning evidence in
   * metadata.planner), and return the recommendation list. Convergent +
   * idempotent: the same signals re-evaluated produce NO duplicate Work Items
   * (the existing UNIQUE(architecture_version_id, work_item_id) constraint +
   * the deterministic proposedWorkItemId fence concurrent runs — a concurrent
   * duplicate INSERT throws unique-violation → the planner catches + re-queries
   * → converges). The planner NEVER mutates the dependency graph, NEVER mutates
   * workflow / verification / review state, NEVER starts execution, NEVER
   * selects a provider.
   */
  evaluate(
    input: PlanningEvaluateInput,
    ctx: PlanningContext,
  ): Promise<PlanningEvaluateResult>;

  /**
   * READ-ONLY — never creates / mutates. List planner-originated Work Items in
   * the architecture version (those whose metadata.planner exists). The GET
   * route uses this so a read-authorized caller can NEVER trigger a state
   * mutation. The architectureVersionId is verified to belong to the
   * authorized project by the route BEFORE this is called.
   */
  listRecommendations(
    architectureVersionId: string,
    ctx: PlanningContext,
  ): Promise<readonly PlanningRecommendationSummary[]>;
}

// ---------------------------------------------------------------------------
// The orchestrator's dependencies (the constructor input).
// ---------------------------------------------------------------------------

export interface DevelopmentPlannerServiceDeps {
  readonly prioritizer: PlanningPrioritizer;
  readonly logger: Logger;
  /** The wall-clock source (for the evaluatedAt timestamp). Defaults to () => new Date(). Injected by tests for determinism. */
  readonly clock?: () => Date;
}

// ---------------------------------------------------------------------------
// The durable planning.evaluate job (reuses the existing Queue + WorkerHost).
// ---------------------------------------------------------------------------

/**
 * The serializable payload of a `planning.evaluate` durable job. The
 * PlanningContext (runtime authority handles) is NOT serializable — the job
 * handler RE-RESOLVES it from the projectId at processing time (the handler is
 * constructed in app.ts with the authority handles). The handler is idempotent
 * (the planner is convergent via the DB constraint), so durable redelivery is
 * safe.
 */
export interface PlanningEvaluateJobPayload {
  readonly projectId: string;
  readonly organizationId: string;
  readonly architectureVersionId: string;
  readonly signals: readonly PlanningSignal[];
  readonly baselineCommitSha?: string;
  readonly idempotencyKey?: string;
}

/** The durable job type name (registered with the existing WorkerHost). */
export const PLANNING_EVALUATE_JOB_TYPE = 'planning.evaluate';

/** The redelivery policy — the planner is idempotent, so durable redelivery is safe. */
export const PLANNING_EVALUATE_REDELIVERY_POLICY = {
  maxAttempts: 3,
} as const;

/** The planner version (recorded in metadata.planner.plannerVersion for traceability). */
export const PLANNER_VERSION = 'work-040.v1';
