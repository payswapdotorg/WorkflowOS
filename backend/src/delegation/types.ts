/**
 * WORK-046 — Multi-Agent Delegation: the public coordination contracts.
 *
 * The delegation domain lives at `src/delegation/` (application-layer
 * ORCHESTRATOR outside src/modules/, mirroring the §34 benchmark /
 * execution-policy / execution-routing / agent-roles pattern — NOT the 18th
 * frozen module). The forward dependency slice:
 *
 *   WORK-044 (routing) → WORK-045 Agent Roles → WORK-046 Delegation
 *        → WORK-047 Agent Intelligence
 *
 * THE DELEGATION LAYER IS COORDINATION, NOT AUTHORITY (spec/work-orders/
 * WORK-046.md):
 *
 *   - ONE Work Item: a plan is bound to exactly one existing Work Item; every
 *     delegated execution is built by the EXISTING ExecutionTaskService for
 *     THAT Work Item and submitted through the EXISTING ExecutionService.
 *   - ONE workflow authority: delegation NEVER mutates (or evaluates) Work
 *     Item workflow state — /workflows owns it. There is NO hidden lifecycle
 *     state here (pinned by static invariants): the statuses below are
 *     COORDINATION vocabulary, structurally disjoint from the frozen
 *     WorkflowState set.
 *   - ONE execution identity per delegated execution: every attempt
 *     references exactly one existing `wfos_executions` execution identity;
 *     retries allocate a NEW attempt (a NEW execution identity) while the
 *     unit + role identity stay stable.
 *   - EXISTING role catalog: units pin `(roleId, roleRevision)` resolved
 *     through the WORK-045 `AgentRoleCatalogService` — delegation CONSUMES
 *     roles, never redefines them.
 *   - EXISTING policy/routing/verification/review: delegation performs no
 *     eligibility evaluation, no candidate ranking, no evidence evaluation,
 *     and no review outcomes (pinned by static invariants).
 *
 * Native and external execution remain first-class: a plan may mix native and
 * external units for the same logical Work Item.
 */

import type { AgentRoleId } from '../agent-roles/index.js';

// ============================================================================
// Coordination statuses (NOT a Work Item lifecycle — W046-AC09)
// ============================================================================

/**
 * The plan coordination status. DISJOINT from the frozen WorkflowState set
 * by construction (pinned by static invariants — "no hidden lifecycle
 * state"):
 *
 *   active    — the plan is coordinating (units may dispatch/observe/retry)
 *   completed — every unit has succeeded (the coordination converged)
 *   abandoned — the plan was interrupted (pending units cancelled; in-flight
 *               executions continue under the EXISTING execution authority)
 */
export type DelegationPlanStatus = 'active' | 'completed' | 'abandoned';

/**
 * The unit coordination status:
 *
 *   pending     — not yet dispatched (or waiting on dependencies)
 *   dispatched  — an attempt is in flight (its execution outcome is owned by
 *                 the EXISTING execution flow; observation converges it)
 *   succeeded   — the attempt's execution reached a successful terminal state
 *   failed      — the attempt's execution reached a failed terminal state
 *                 (recoverable: retry allocates a new attempt)
 *   unresolved  — an attempt's outcome could not be determined AND no
 *                 provider side effect provably happened (safe to retry)
 *   cancelled   — the unit was pending when the plan was interrupted
 */
export type DelegationUnitStatus =
  | 'pending'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'unresolved'
  | 'cancelled';

/**
 * The attempt outcome (NULL — not represented in this union — means the
 * attempt is IN FLIGHT; the existing execution flow owns its outcome):
 *
 *   succeeded  — the existing execution record reached 'completed'
 *   failed     — the existing execution record reached a failed terminal
 *                state ('failed' | 'cancelled' | 'expired')
 *   unresolved — outcome undeterminable + no provider side effect provably
 *                happened (record absent on re-drive with an unresolvable
 *                submission, or a limbo record with no native run)
 */
export type DelegationAttemptOutcome = 'succeeded' | 'failed' | 'unresolved';

// ============================================================================
// Plan input (the delegation request)
// ============================================================================

/**
 * One unit specification in a delegation request. `role` MUST be a closed
 * WORK-045 role identity (resolved + pinned at plan creation — unknown roles
 * fail closed). `mode`/`provider`/`model` mirror the existing execution
 * route's request shape (validated at the route against the existing
 * registry — delegation performs no routing of its own).
 */
export interface DelegationUnitSpec {
  /** The stable LOGICAL unit identity within the plan (the caller's key). */
  readonly unitKey: string;
  /** The WORK-045 role identity assigned to this unit. */
  readonly role: AgentRoleId;
  readonly mode: 'native' | 'external';
  readonly provider: string;
  /** Required for native units (the existing execution path requires it). */
  readonly model?: string | null;
  /** Unit KEYS (within the SAME plan) this unit depends on. */
  readonly dependsOn?: readonly string[];
}

/**
 * A delegation request: a bounded multi-agent plan for ONE existing Work
 * Item. The `(workItemId, planKey)` pair is the durable idempotent identity
 * — the SAME request converges on the SAME authoritative plan
 * (W046-AC01); a DIFFERENT plan for the same Work Item uses a different
 * plan key.
 */
export interface DelegationPlanInput {
  readonly workItemId: string;
  /** The logical plan identity within the Work Item (e.g. 'default'). */
  readonly planKey: string;
  readonly units: readonly DelegationUnitSpec[];
}

// ============================================================================
// Durable records (coordination data — structured state for WORK-047)
// ============================================================================

/** The pinned WORK-045 role assignment (W045-AC10 — stable across retries). */
export interface DelegationRoleAssignment {
  readonly roleId: AgentRoleId;
  /** The catalog content digest pinned at plan creation. */
  readonly roleRevision: string;
}

/** A durable delegation unit (the stable logical delegation identity). */
export interface DelegationUnit {
  readonly id: string;
  readonly planId: string;
  /** The owning plan's Work Item (denormalized from the plan — ONE Work Item). */
  readonly workItemId: string;
  readonly unitKey: string;
  readonly role: DelegationRoleAssignment;
  readonly mode: 'native' | 'external';
  readonly provider: string;
  readonly model: string | null;
  readonly dependsOn: readonly string[];
  readonly status: DelegationUnitStatus;
  readonly attemptCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A durable delegation attempt (ONE delegated execution per attempt). */
export interface DelegationAttempt {
  readonly id: string;
  readonly unitId: string;
  readonly attemptNo: number;
  /** The EXISTING execution identity (wfos_executions.execution_id). */
  readonly executionId: string;
  readonly mode: 'native' | 'external';
  readonly provider: string;
  readonly model: string | null;
  /** NULL while the attempt is in flight. */
  readonly outcome: DelegationAttemptOutcome | null;
  readonly outcomeDetail: Record<string, unknown> | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A durable delegation plan (ONE per (work item, plan key)). */
export interface DelegationPlan {
  readonly id: string;
  readonly workItemId: string;
  readonly planKey: string;
  readonly status: DelegationPlanStatus;
  readonly units: readonly DelegationUnit[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ============================================================================
// Service contracts
// ============================================================================

/** The result of a dispatch/observe/retry drive for one unit. */
export interface DelegationUnitDriveResult {
  readonly unitId: string;
  readonly unitKey: string;
  readonly status: DelegationUnitStatus;
  /**
   * The current attempt's execution identity (null when the unit has never
   * been dispatched).
   */
  readonly executionId: string | null;
  readonly outcome: DelegationAttemptOutcome | null;
  /** What the drive did: dispatched | converged | observed-in-flight | skipped. */
  readonly action: 'dispatched' | 'converged' | 'in-flight' | 'skipped';
}

/** The result of driving a whole plan (coordination, never authority). */
export interface DelegationDriveResult {
  readonly planId: string;
  readonly planStatus: DelegationPlanStatus;
  readonly units: readonly DelegationUnitDriveResult[];
}

/**
 * The plan service — creating (idempotently) and reading delegation plans.
 * Role resolution, dependency-graph validation, and structural validation
 * all FAIL CLOSED with typed errors.
 */
export interface DelegationPlanService {
  /**
   * Create-or-converge the delegation plan for `(workItemId, planKey)`
   * (W046-AC01): the same request returns the SAME authoritative plan; a
   * concurrent duplicate creator converges on the winner's plan (one plan,
   * one unit set — never duplicates).
   *
   * Fail-closed validation: the Work Item must exist; every role must
   * resolve in the WORK-045 catalog (pinned with its revision); the plan
   * must contain at least one unit; unit keys must be unique; dependencies
   * must refer to units in the SAME plan and form an ACYCLIC graph; native
   * units require a model.
   */
  createPlan(input: DelegationPlanInput): Promise<DelegationPlan>;

  /** The authoritative plan (with units), or null when none exists. */
  getPlan(workItemId: string, planKey: string): Promise<DelegationPlan | null>;

  /**
   * WORK-050: ALL authoritative plans (with units) for a Work Item, ordered
   * by creation — the READ side for the unified execution UX (where multiple
   * delegated agents exist, the delegated execution units render from these
   * records). A work item with no plans answers [] (a GENUINE empty result,
   * never an error). Pure read: no validation, no writes, no coordination.
   */
  listPlansForWorkItem(workItemId: string): Promise<DelegationPlan[]>;
}

/**
 * The coordination service — dispatch, observe, retry, interrupt. Every
 * delegated execution is submitted through the EXISTING ExecutionService on
 * a task built by the EXISTING ExecutionTaskService for the SAME Work Item;
 * attempt outcomes are OBSERVED from the existing execution record (the
 * outcome authority). The coordinator NEVER mutates workflow state and
 * never drives itself (no scheduler — every drive is an explicit call,
 * W046-AC12).
 */
export interface DelegationCoordinator {
  /**
   * Drive the plan once: dispatch every unit whose dependencies have all
   * succeeded and whose status is 'pending'; re-drive every 'dispatched'
   * unit (observe-or-resubmit — the crash-recovery convergence); complete
   * the plan when every unit has succeeded. Units whose dependencies have
   * not all succeeded stay pending (sequencing is coordination only).
   */
  drivePlan(workItemId: string, planKey: string): Promise<DelegationDriveResult>;

  /**
   * Retry a failed or unresolved unit (W046-AC05): allocate a NEW attempt
   * with a NEW execution identity; the unit identity and its pinned role
   * assignment stay stable. Fails closed for units not in
   * 'failed'/'unresolved' and for plans that are not active.
   */
  retryUnit(workItemId: string, planKey: string, unitKey: string): Promise<DelegationUnitDriveResult>;

  /**
   * Interrupt the plan (W046-AC08): the plan becomes 'abandoned' and its
   * PENDING units become 'cancelled'. In-flight executions are NOT touched —
   * their outcomes remain owned by the EXISTING execution authority
   * (delegation never cancels an execution). Idempotent for an already
   * abandoned plan.
   */
  interruptPlan(workItemId: string, planKey: string): Promise<DelegationPlan>;
}

// ============================================================================
// Typed errors (stable machine-readable codes — never parse message strings)
// ============================================================================

/** The stable machine-readable error codes of the delegation domain. */
export const DELEGATION_ERROR_CODES = [
  'DELEGATION_WORK_ITEM_NOT_FOUND',
  'DELEGATION_UNKNOWN_ROLE',
  'DELEGATION_EMPTY_PLAN',
  'DELEGATION_DUPLICATE_UNIT_KEY',
  'DELEGATION_UNKNOWN_DEPENDENCY',
  'DELEGATION_DEPENDENCY_CYCLE',
  'DELEGATION_NATIVE_MODEL_REQUIRED',
  'DELEGATION_PLAN_NOT_FOUND',
  'DELEGATION_UNIT_NOT_FOUND',
  'DELEGATION_UNIT_NOT_RETRYABLE',
  'DELEGATION_PLAN_NOT_ACTIVE',
] as const;

export type DelegationErrorCode = (typeof DELEGATION_ERROR_CODES)[number];

/** The typed delegation error (discriminated by `code`). */
export class DelegationError extends Error {
  readonly code: DelegationErrorCode;

  constructor(code: DelegationErrorCode, message: string) {
    super(`delegation: ${message}`);
    this.name = 'DelegationError';
    this.code = code;
  }
}
