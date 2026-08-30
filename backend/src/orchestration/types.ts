/**
 * WORK-062 — Durable Multi-Agent Orchestration Substrate: the public
 * contracts.
 *
 * The substrate lives at `src/orchestration/` (application-layer capability
 * OUTSIDE src/modules/, mirroring the §34 benchmark / execution-policy /
 * execution-routing / agent-roles / delegation pattern — NOT the 18th frozen
 * module). It is the durable orchestration layer UNDERNEATH WORK-046
 * delegation:
 *
 *   WORK-047 recommendation
 *       ↓
 *   WORK-046 governed delegation (the ONE delegation authority — unchanged)
 *       ↓
 *   WORK-062 durable orchestration (THIS layer)
 *       ↓
 *   the EXISTING Execution Authority (ExecutionService.submit — unchanged)
 *       ↓
 *   Verification → Review (unchanged)
 *
 * THE SUBSTRATE IS ORCHESTRATION, NOT AUTHORITY (spec/work-orders/
 * WORK-062.md):
 *
 *   - ONE delegation authority: every graph/node row REFERENCES an existing
 *     delegation plan/unit; delegation semantics stay in WORK-046.
 *   - ONE execution identity: a node references the EXISTING execution
 *     identity (through the delegation attempt); the substrate never
 *     invents a second one and never submits executions itself — the
 *     {@link OrchestrationExecutor} port is implemented by the delegation
 *     layer (the existing dispatch protocol with its exactly-one
 *     ExecutionService.submit() call site).
 *   - NO workflow states: the vocabulary below is ORCHESTRATION vocabulary,
 *     structurally disjoint from the frozen WorkflowState set AND from the
 *     WORK-046 coordination vocabulary (pinned by static invariants).
 *   - NO scheduler: every drive is an EXPLICIT call (the WORK-046 W046-AC12
 *     discipline, unchanged — no timers, no queues, no autonomous loops).
 *   - NO Redis: PostgreSQL is authoritative for ALL orchestration state.
 */

// ============================================================================
// Orchestration statuses (NOT a Work Item lifecycle, NOT delegation status)
// ============================================================================

/**
 * The graph orchestration status — the explicit partial-completion record:
 *
 *   orchestrating — no terminal node outcome yet (nothing to resume beyond
 *                   driving)
 *   partial       — ≥1 terminal outcome and not every node succeeded: the
 *                   honest, durable, OBSERVABLE and RESUMABLE state (3/10 is
 *                   PARTIAL — never collapsed into success or failure)
 *   converged     — every node's durable outcome is 'succeeded'
 *   abandoned     — the underlying delegation plan was interrupted (the
 *                   mirror; durable evidence is NEVER erased)
 */
export type OrchestrationGraphStatus =
  | 'orchestrating'
  | 'partial'
  | 'converged'
  | 'abandoned';

/**
 * The node orchestration outcome (OBSERVED from the delegation attempt
 * outcome, which observes the existing execution record — never derived
 * from substrate-internal state):
 *
 *   null        — not terminal (pending / in flight)
 *   succeeded   — the current attempt's execution succeeded
 *   failed      — the current attempt's execution failed
 *   unresolved  — honest limbo (no provable provider side effect)
 *   cancelled   — the unit was pending at interruption (mirror only)
 */
export type OrchestrationNodeOutcome = 'succeeded' | 'failed' | 'unresolved' | 'cancelled';

// ============================================================================
// Durable records
// ============================================================================

/** A durable orchestration graph (ONE per delegation plan). */
export interface OrchestrationGraph {
  readonly id: string;
  /** TENANT scope — the project owning everything below (server-resolved). */
  readonly projectId: string;
  readonly workItemId: string;
  /** The EXISTING delegation plan this graph orchestrates. */
  readonly planId: string;
  readonly status: OrchestrationGraphStatus;
  readonly totalNodes: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly unresolvedCount: number;
  readonly cancelledCount: number;
  readonly reconciliationCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A durable orchestration node (ONE per delegation unit). */
export interface OrchestrationNode {
  readonly id: string;
  readonly graphId: string;
  readonly projectId: string;
  readonly unitId: string;
  readonly nodeKey: string;
  readonly dependsOn: readonly string[];
  readonly ownerId: string | null;
  /** The fencing token — bumped on EVERY ownership change. */
  readonly generation: number;
  readonly leaseExpiresAt: Date | null;
  /** The CURRENT delegated execution reference (the EXISTING identity). */
  readonly executionId: string | null;
  readonly attemptNo: number | null;
  readonly outcome: OrchestrationNodeOutcome | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ============================================================================
// The executor port (implemented by the delegation layer)
// ============================================================================

/**
 * The node context handed to the executor for one drive — the durable
 * orchestration view of the unit to drive.
 */
export interface OrchestrationNodeContext {
  readonly nodeId: string;
  readonly nodeKey: string;
  readonly unitId: string;
  readonly graphId: string;
  /** The fencing generation of THIS drive's lease. */
  readonly generation: number;
  readonly ownerId: string;
  /**
   * WHY this node is being driven — the executor (the WORK-046 protocol)
   * uses it to pick the existing drive shape exactly as before:
   *   dispatch — a pending unit dispatches (fresh attempt)
   *   redrive  — a dispatched/unresolved unit re-drives (observe-or-resubmit)
   *   retry    — a failed/unresolved unit retries (a NEW attempt)
   */
  readonly purpose: 'dispatch' | 'redrive' | 'retry';
  readonly executionId: string | null;
  readonly attemptNo: number | null;
}

/**
 * The result of driving one node through the EXISTING delegation protocol.
 * `outcome` mirrors the unit's post-drive status (the delegation layer's
 * authority); the substrate records it (fenced) as the node's outcome.
 */
export interface OrchestrationExecutorResult {
  readonly nodeKey: string;
  readonly unitId: string;
  readonly outcome: OrchestrationNodeOutcome | null;
  readonly executionId: string | null;
  readonly attemptNo: number | null;
  /** What the drive did (dispatched | converged | in-flight | skipped). */
  readonly action: 'dispatched' | 'converged' | 'in-flight' | 'skipped';
}

/**
 * The execution boundary of the substrate — implemented by the WORK-046
 * delegation coordinator (the EXISTING dispatch/observe/retry protocol).
 * The substrate NEVER touches ExecutionService itself: exactly one submit
 * call site exists, and it stays in the delegation layer (pinned by static
 * invariants).
 */
export interface OrchestrationExecutor {
  /**
   * Drive ONE node's unit through the EXISTING delegation protocol. The
   * implementation decides HOW (dispatch, re-drive observe-or-resubmit, or
   * skip for terminal units) from the unit's authoritative status — the
   * substrate decides WHETHER the drive is admissible (durable admission,
   * lease, fencing).
   */
  execute(node: OrchestrationNodeContext): Promise<OrchestrationExecutorResult>;
}

// ============================================================================
// Drive results
// ============================================================================

/** The per-node result of one substrate drive. */
export interface OrchestrationNodeDriveResult {
  readonly nodeKey: string;
  readonly unitId: string;
  readonly outcome: OrchestrationNodeOutcome | null;
  readonly executionId: string | null;
  readonly attemptNo: number | null;
  readonly action: 'dispatched' | 'converged' | 'in-flight' | 'skipped' | 'lease-held' | 'blocked';
}

/** The result of driving one graph (durable orchestration, never authority). */
export interface OrchestrationDriveResult {
  readonly graphId: string;
  readonly graphStatus: OrchestrationGraphStatus;
  readonly reconciliationCount: number;
  readonly nodes: readonly OrchestrationNodeDriveResult[];
}

/** Options of one substrate drive. */
export interface OrchestrationDriveOptions {
  readonly workItemId: string;
  readonly planKey: string;
  /** The driving owner identity (a coordinator/drive instance id). */
  readonly ownerId: string;
  /** The lease time-to-live in milliseconds (default 60s). */
  readonly leaseTtlMs?: number;
  /**
   * The maximum number of nodes driven CONCURRENTLY (safe
   * dependency-aware parallelism — independent nodes only; default 1 =
   * sequential, bit-identical to the pre-WORK-062 drive behavior).
   */
  readonly maxParallel?: number;
}

// ============================================================================
// The substrate contract
// ============================================================================

/**
 * The durable orchestration substrate — coordination machinery only:
 * durable identity, leases/ownership, fencing, durable dependency-aware
 * scheduling, crash/restart reconciliation, external execution convergence
 * (observe-or-resubmit THROUGH the executor), explicit partial completion,
 * deterministic reconciliation, and safe dependency-aware parallelism.
 */
export interface OrchestrationSubstrate {
  /**
   * Drive the graph of `(workItemId, planKey)` once (EXPLICIT — no
   * scheduler): ensure the graph (idempotent), reconcile (release expired
   * leases, deterministic state recompute), then drive every admissible
   * node through the executor — fresh dispatches gated by DURABLE
   * dependency admission, in-flight/unresolved nodes re-driven
   * (observe-or-resubmit convergence). Independent nodes may run
   * concurrently up to `maxParallel`; dependent nodes never do.
   *
   * Errors from the executor PROPAGATE (a crashed drive is the honest
   * result — the durable intent + lease expiry make the next drive
   * converge); the failed node's lease is released (fencing generation
   * bumped) so a dead recorder can never mutate later.
   */
  driveGraph(
    options: OrchestrationDriveOptions,
    executor: OrchestrationExecutor,
  ): Promise<OrchestrationDriveResult>;

  /**
   * Retry one node (the WORK-046 retry semantics preserved: a failed or
   * unresolved unit may be retried regardless of its dependencies' current
   * state — the unit already ran; its dependencies were satisfied at its
   * original dispatch). Acquires an exclusive lease (no dependency gate),
   * drives through the executor, records the outcome fenced.
   */
  retryNode(
    input: {
      readonly workItemId: string;
      readonly planKey: string;
      readonly nodeKey: string;
      readonly ownerId: string;
      readonly leaseTtlMs?: number;
    },
    executor: OrchestrationExecutor,
  ): Promise<OrchestrationNodeDriveResult>;

  /**
   * Mirror a delegation interruption: the graph becomes 'abandoned', all
   * leases are released (fencing generations bumped — stale workers are
   * fenced), and NO durable evidence is erased. Idempotent. The delegation
   * plan's own abandonment (WORK-046) remains the authority; this mirror
   * happens after it.
   */
  abandonGraph(workItemId: string, planKey: string): Promise<OrchestrationGraph | null>;

  /**
   * Deterministic reconciliation: release expired leases (fencing
   * generation bumped on each), recompute the graph's tallies and status
   * from the durable node outcomes, bump the reconciliation counter. The
   * same durable state always reconciles to the same result (a total,
   * documented order — nodes are processed in node_key order; concurrent
   * actors are serialized by row locks and unique constraints, never by
   * wall-clock winner selection).
   */
  reconcile(workItemId: string, planKey: string): Promise<OrchestrationGraph | null>;

  /** The graph of a plan (project-scoped read), or null when none exists. */
  getGraph(workItemId: string, planKey: string): Promise<OrchestrationGraph | null>;

  /** The nodes of a graph in stable node_key order (project-scoped read). */
  listNodes(workItemId: string, planKey: string): Promise<OrchestrationNode[]>;
}

// ============================================================================
// Typed errors (stable machine-readable codes — never parse message strings)
// ============================================================================

/** The stable machine-readable error codes of the orchestration substrate. */
export const ORCHESTRATION_ERROR_CODES = [
  'ORCHESTRATION_PLAN_NOT_FOUND',
  'ORCHESTRATION_NODE_NOT_FOUND',
  'ORCHESTRATION_DEPENDENCY_NOT_SATISFIED',
  'ORCHESTRATION_LEASE_HELD',
  'ORCHESTRATION_NODE_NOT_RETRYABLE',
  'ORCHESTRATION_FENCED_OUT',
  'ORCHESTRATION_GRAPH_NOT_ACTIVE',
  'ORCHESTRATION_UNKNOWN_DEPENDENCY',
  'ORCHESTRATION_DEPENDENCY_CYCLE',
] as const;

export type OrchestrationErrorCode = (typeof ORCHESTRATION_ERROR_CODES)[number];

/** The typed orchestration error (discriminated by `code`). */
export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode;

  constructor(code: OrchestrationErrorCode, message: string) {
    super(`orchestration: ${message}`);
    this.name = 'OrchestrationError';
    this.code = code;
  }
}
