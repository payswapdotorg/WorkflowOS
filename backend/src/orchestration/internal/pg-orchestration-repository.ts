/**
 * WORK-062 — the orchestration substrate repository.
 *
 * Durable orchestration state ONLY (migration 0058): graphs + nodes. Every
 * identity here REFERENCES an existing authority row:
 *
 *   graph.plan_id    → wfos_delegation_plans (the ONE delegation authority)
 *   node.unit_id     → wfos_delegation_units (the stable delegation identity)
 *   node.execution_id → the EXISTING execution identity, via the delegation
 *                      attempt (never a second execution identity)
 *   *_project_id     → wfos_projects (TENANT scope, server-resolved)
 *
 * PERSISTENCE-LAYER IDENTITY/TENANT INTEGRITY (round-1 architect remediation):
 * the writes below carry the full TUPLE (graph, project, plan, unit), and
 * PostgreSQL itself — composite foreign keys + the graph tenant-guard
 * trigger (migration 0058) — makes a structurally impossible
 * graph/plan/unit/project combination unrepresentable, surviving even a
 * buggy application caller. A raw-SQL negative regression proves it
 * without this repository in the path.
 *
 * This repository NEVER writes delegation, workflow, execution, agent-run,
 * verification, or review rows — it is structurally incapable of becoming a
 * second authority (pinned by static invariants). Reading delegation state
 * is OBSERVATION (the delegation tables are the input to ensureGraph and
 * backfill), never mutation.
 *
 * Concurrency (real PostgreSQL semantics — the invariants survive a buggy
 * application caller):
 *
 *   - graph identity: INSERT ... ON CONFLICT (plan_id) DO NOTHING + re-lock
 *     — concurrent same-plan creators converge on ONE graph (one node set).
 *   - node identity: UNIQUE (graph_id, node_key) + UNIQUE (unit_id) with
 *     ON CONFLICT DO NOTHING — no duplicate logical nodes, ever.
 *   - LEASE EXCLUSIVITY: acquisition is ONE conditional UPDATE
 *     (owner free-or-expired) — concurrent acquirers serialize on the row;
 *     exactly ONE wins; losers match ZERO rows (typed, converge).
 *   - FENCING AT THE MUTATION BOUNDARY: every ownership change bumps
 *     `generation`, and EVERY node-state mutation requires
 *     `generation = $expected AND owner_id = $owner` in the UPDATE's WHERE
 *     clause — a stale worker is structurally rejected by PostgreSQL AFTER
 *     a takeover, not by application bookkeeping.
 *   - DURABLE DEPENDENCY ADMISSION: the dispatch-lease acquisition
 *     additionally requires every declared dependency to EXIST in the graph
 *     and have durable outcome 'succeeded' (the NOT EXISTS gate below) — a
 *     dependent node cannot even acquire a dispatch lease until its
 *     dependencies' durable outcomes admit it (never an in-memory-only
 *     check). The migration's trigger re-enforces the same gate for
 *     never-dispatched nodes as defense in depth.
 *   - PROGRESS RECOMPUTE is transactional with the fenced outcome write and
 *     takes the graph row lock first (documented lock order: graph → node)
 *     — the tallies and the explicit partial-completion status are always a
 *     deterministic function of the durable node outcomes.
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  OrchestrationGraph,
  OrchestrationGraphStatus,
  OrchestrationNode,
  OrchestrationNodeOutcome,
} from '../types.js';

/** A transaction-scoped query interface (what `db.transaction(fn)` passes). */
export type OrchestrationTx = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];
interface GraphRow {
  id: string;
  project_id: string;
  work_item_id: string;
  plan_id: string;
  status: OrchestrationGraphStatus;
  total_nodes: number;
  succeeded_count: number;
  failed_count: number;
  unresolved_count: number;
  cancelled_count: number;
  reconciliation_count: number;
  created_at: Date;
  updated_at: Date;
}

interface NodeRow {
  id: string;
  graph_id: string;
  project_id: string;
  unit_id: string;
  node_key: string;
  depends_on: string[];
  owner_id: string | null;
  generation: number;
  lease_expires_at: Date | null;
  execution_id: string | null;
  attempt_no: number | null;
  outcome: OrchestrationNodeOutcome | null;
  created_at: Date;
  updated_at: Date;
}

/** The delegation plan (and its server-resolved tenant scope), read-only. */
export interface DelegationPlanSnapshot {
  readonly planId: string;
  readonly workItemId: string;
  readonly projectId: string;
  readonly planKey: string;
  readonly planStatus: 'active' | 'completed' | 'abandoned';
  readonly units: readonly {
    readonly unitId: string;
    readonly unitKey: string;
    readonly status: string;
    readonly dependsOn: readonly string[];
    readonly latestAttemptNo: number | null;
    readonly latestExecutionId: string | null;
  }[];
}

/** Why a lease acquisition matched zero rows (typed, fail-closed). */
export type LeaseAcquireFailure = 'lease-held' | 'dependency-not-satisfied' | 'not-acquirable';

/** The purpose of a lease — selects the guard set (see the class docs). */
export type LeasePurpose = 'dispatch' | 'redrive' | 'retry';

const GRAPH_COLUMNS =
  'id, project_id, work_item_id, plan_id, status, total_nodes, succeeded_count, ' +
  'failed_count, unresolved_count, cancelled_count, reconciliation_count, created_at, updated_at';
const NODE_COLUMNS =
  'id, graph_id, project_id, unit_id, node_key, depends_on, owner_id, generation, ' +
  'lease_expires_at, execution_id, attempt_no, outcome, created_at, updated_at';

/**
 * The dependency gate shared by dispatch admission: a node is
 * dependency-admitted iff EVERY declared dependency key exists in the SAME
 * graph and has durable outcome 'succeeded'. (Missing keys block — unknown
 * dependencies are never vacuously admitted.)
 */
const DEPENDENCY_GATE = `
  NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(n.depends_on) AS dk(dep_key)
     WHERE NOT EXISTS (
       SELECT 1
         FROM wfos_orchestration_nodes d
        WHERE d.graph_id = n.graph_id
          AND d.node_key = dk.dep_key
          AND d.outcome = 'succeeded'
     )
  )`;

/** The per-purpose guards (the durable admission boundary). */
function purposeGuard(purpose: LeasePurpose): string {
  switch (purpose) {
    case 'dispatch':
      // A FRESH dispatch: never dispatched (no execution reference, no
      // outcome) AND every dependency durably satisfied.
      return `(n.outcome IS NULL AND n.execution_id IS NULL AND n.attempt_no IS NULL) AND ${DEPENDENCY_GATE}`;
    case 'redrive':
      // The crash-recovery re-drive: an attempt is in flight (outcome NULL
      // with a live execution reference) OR the honest limbo
      // ('unresolved' — no provable provider side effect). No dependency
      // gate: the unit already dispatched (its dependencies were satisfied
      // at its original dispatch — WORK-046 semantics preserved).
      return `((n.outcome IS NULL AND n.execution_id IS NOT NULL) OR n.outcome = 'unresolved')`;
    case 'retry':
      // The WORK-046 retry: a failed or unresolved unit may be retried
      // regardless of its dependencies' current state.
      return `(n.outcome IN ('failed', 'unresolved'))`;
  }
}

export class PgOrchestrationRepository {
  constructor(private readonly db: DatabaseClient) {}

  // --- delegation observation (READ ONLY — never a write) -----------------

  /**
   * Read the delegation plan (with units + latest attempts + the
   * server-resolved project scope) — the substrate's observation of the
   * delegation authority. Returns null when no such plan exists.
   */
  async readDelegationPlan(
    workItemId: string,
    planKey: string,
  ): Promise<DelegationPlanSnapshot | null> {
    const plan = await this.db.query<{
      id: string;
      work_item_id: string;
      project_id: string;
      plan_key: string;
      status: 'active' | 'completed' | 'abandoned';
    }>(
      `SELECT p.id, p.work_item_id, a.project_id, p.plan_key, p.status
         FROM wfos_delegation_plans p
         JOIN wfos_work_items wi ON wi.id = p.work_item_id
         JOIN wfos_architecture_versions av ON av.id = wi.architecture_version_id
         JOIN wfos_architectures a ON a.id = av.architecture_id
        WHERE p.work_item_id = $1 AND p.plan_key = $2`,
      [workItemId, planKey],
    );
    if (plan.rows.length === 0) return null;
    const head = plan.rows[0]!;

    const units = await this.db.query<{
      id: string;
      unit_key: string;
      status: string;
      depends_on: string[];
      attempt_no: number | null;
      execution_id: string | null;
    }>(
      `SELECT u.id, u.unit_key, u.status, u.depends_on,
              lat.attempt_no, lat.execution_id
         FROM wfos_delegation_units u
         LEFT JOIN LATERAL (
           SELECT a.attempt_no, a.execution_id
             FROM wfos_delegation_attempts a
            WHERE a.unit_id = u.id
            ORDER BY a.attempt_no DESC
            LIMIT 1
         ) lat ON TRUE
        WHERE u.plan_id = $1
        ORDER BY u.unit_key`,
      [head.id],
    );

    return {
      planId: head.id,
      workItemId: head.work_item_id,
      projectId: head.project_id,
      planKey: head.plan_key,
      planStatus: head.status,
      units: units.rows.map((u) => ({
        unitId: u.id,
        unitKey: u.unit_key,
        status: u.status,
        dependsOn: u.depends_on,
        latestAttemptNo: u.attempt_no,
        latestExecutionId: u.execution_id,
      })),
    };
  }

  // --- graph lifecycle ------------------------------------------------------

  /**
   * Create-or-converge the orchestration graph for a delegation plan
   * (idempotent): ONE graph per plan (UNIQUE (plan_id)); ONE node per unit
   * (UNIQUE (unit_id)); fresh nodes backfill their outcome from the unit's
   * authoritative status. All inside ONE transaction.
   */
  async ensureGraph(
    tx: OrchestrationTx,
    snapshot: DelegationPlanSnapshot,
  ): Promise<GraphRow> {
    const inserted = await tx.query<GraphRow>(
      `INSERT INTO wfos_orchestration_graphs
           (project_id, work_item_id, plan_id, total_nodes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (plan_id) DO NOTHING
         RETURNING ${GRAPH_COLUMNS}`,
      [snapshot.projectId, snapshot.workItemId, snapshot.planId, snapshot.units.length],
    );
    let graph = inserted.rows[0] ?? null;
    if (!graph) {
      // A concurrent winner created the graph — converge on it (the row
      // lock blocks until their transaction commits).
      const existing = await tx.query<GraphRow>(
        `SELECT ${GRAPH_COLUMNS}
           FROM wfos_orchestration_graphs
          WHERE plan_id = $1
          FOR UPDATE`,
        [snapshot.planId],
      );
      if (existing.rows.length === 0) {
        throw new Error(
          `orchestration: graph for plan ${snapshot.planId} vanished under lock — impossible`,
        );
      }
      graph = existing.rows[0]!;
    }

    // ONE node per unit — ON CONFLICT DO NOTHING (a pre-existing node set
    // from a concurrent creator or a prior drive is authoritative; fresh
    // nodes backfill the durable outcome from the unit's status). The full
    // (graph, project, plan, unit) tuple is written so the composite FKs
    // (migration 0058) verify consistency AT the persistence boundary.
    for (const unit of snapshot.units) {
      const backfill = backfillForUnitStatus(unit.status);
      await tx.query(
        `INSERT INTO wfos_orchestration_nodes
             (graph_id, project_id, plan_id, unit_id, node_key, depends_on,
              execution_id, attempt_no, outcome)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
           ON CONFLICT (unit_id) DO NOTHING`,
        [
          graph.id,
          snapshot.projectId,
          snapshot.planId,
          unit.unitId,
          unit.unitKey,
          JSON.stringify(unit.dependsOn),
          unit.latestExecutionId,
          unit.latestAttemptNo,
          backfill.outcome,
        ],
      );
    }

    return (await this.recomputeProgress(tx, graph.id, { bumpReconciliation: false }))!;
  }

  /** Find the graph of a plan (joined through the delegation plan). */
  async findGraph(workItemId: string, planKey: string): Promise<GraphRow | null> {
    const result = await this.db.query<GraphRow>(
      `SELECT g.${GRAPH_COLUMNS.replaceAll(', ', ', g.')}
         FROM wfos_orchestration_graphs g
         JOIN wfos_delegation_plans p ON p.id = g.plan_id
        WHERE p.work_item_id = $1 AND p.plan_key = $2`,
      [workItemId, planKey],
    );
    return result.rows[0] ?? null;
  }

  async listNodesByGraph(graphId: string): Promise<NodeRow[]> {
    const result = await this.db.query<NodeRow>(
      `SELECT ${NODE_COLUMNS}
         FROM wfos_orchestration_nodes
        WHERE graph_id = $1
        ORDER BY node_key`,
      [graphId],
    );
    return result.rows;
  }

  async findNodeByUnit(graphId: string, unitId: string): Promise<NodeRow | null> {
    const result = await this.db.query<NodeRow>(
      `SELECT ${NODE_COLUMNS}
         FROM wfos_orchestration_nodes
        WHERE graph_id = $1 AND unit_id = $2`,
      [graphId, unitId],
    );
    return result.rows[0] ?? null;
  }

  // --- ownership / leases / fencing -----------------------------------------

  /**
   * Acquire (or fail to acquire) the exclusive lease on one node — ONE
   * conditional UPDATE: the row is acquirable only when it is FREE or the
   * lease EXPIRED, and the per-purpose guards hold. On success the fencing
   * `generation` is bumped (the OLD owner's generation is invalid from this
   * moment — the mutation boundary rejects it). Returns the acquired row,
   * or a typed failure reason (never throws for a lost race).
   */
  async acquireLease(
    tx: OrchestrationTx,
    input: {
      nodeId: string;
      ownerId: string;
      leaseExpiresAt: Date;
      purpose: LeasePurpose;
    },
  ): Promise<{ ok: true; node: NodeRow } | { ok: false; reason: LeaseAcquireFailure }> {
    const guards = purposeGuard(input.purpose);
    const acquired = await tx.query<NodeRow>(
      `UPDATE wfos_orchestration_nodes AS n
          SET owner_id = $2,
              generation = n.generation + 1,
              lease_expires_at = $3,
              updated_at = NOW()
        WHERE n.id = $1
          AND (n.owner_id IS NULL OR n.lease_expires_at IS NULL OR n.lease_expires_at <= NOW())
          AND ${guards}
        RETURNING n.${NODE_COLUMNS.replaceAll(', ', ', n.')}`,
      [input.nodeId, input.ownerId, input.leaseExpiresAt],
    );
    if (acquired.rows.length > 0) {
      return { ok: true, node: acquired.rows[0]! };
    }
    // Zero rows: exactly WHY (typed, fail-closed) — re-read WITHOUT the
    // purpose guards to classify the failure.
    const current = await tx.query<NodeRow>(
      `SELECT ${NODE_COLUMNS} FROM wfos_orchestration_nodes WHERE id = $1`,
      [input.nodeId],
    );
    if (current.rows.length === 0) return { ok: false, reason: 'not-acquirable' };
    const node = current.rows[0]!;
    const held =
      node.owner_id !== null &&
      node.lease_expires_at !== null &&
      node.lease_expires_at > new Date();
    if (held) return { ok: false, reason: 'lease-held' };
    if (input.purpose === 'dispatch') {
      // Free but not admitted — the durable dependency gate (or the
      // never-dispatched guard) rejected it.
      return { ok: false, reason: 'dependency-not-satisfied' };
    }
    return { ok: false, reason: 'not-acquirable' };
  }

  /**
   * Record one node's drive result — THE FENCED MUTATION BOUNDARY: the
   * UPDATE fires ONLY when the caller still owns the node at the SAME
   * fencing generation (`generation = $expected AND owner_id = $owner`).
   * A stale worker (superseded by a takeover — the generation moved) is
   * STRUCTURALLY rejected by PostgreSQL: zero rows, typed
   * 'fenced-out'. The lease is released in the SAME statement (owner NULL)
   * and the graph's tallies/status are recomputed transactionally.
   */
  async recordNodeResult(
    input: {
      nodeId: string;
      graphId: string;
      ownerId: string;
      expectedGeneration: number;
      outcome: OrchestrationNodeOutcome | null;
      executionId: string | null;
      attemptNo: number | null;
    },
  ): Promise<{ ok: true; node: NodeRow } | { ok: false; reason: 'fenced-out' }> {
    return this.db.transaction(async (tx) => {
      // Documented lock order: graph row FIRST, then the node row.
      await tx.query(`SELECT id FROM wfos_orchestration_graphs WHERE id = $1 FOR UPDATE`, [
        input.graphId,
      ]);
      const updated = await tx.query<NodeRow>(
        `UPDATE wfos_orchestration_nodes
            SET outcome = $3,
                execution_id = $4,
                attempt_no = $5,
                owner_id = NULL,
                lease_expires_at = NULL,
                updated_at = NOW()
          WHERE id = $1
            AND generation = $2
            AND owner_id = $6
          RETURNING ${NODE_COLUMNS}`,
        [
          input.nodeId,
          input.expectedGeneration,
          input.outcome,
          input.executionId,
          input.attemptNo,
          input.ownerId,
        ],
      );
      if (updated.rows.length === 0) {
        return { ok: false, reason: 'fenced-out' as const };
      }
      await this.recomputeProgress(tx, input.graphId, { bumpReconciliation: false });
      return { ok: true, node: updated.rows[0]! };
    });
  }

  /**
   * Release a lease WITHOUT recording a result (a crashed drive's cleanup):
   * the generation is BUMPED so the dead recorder's later mutation is
   * fenced out structurally. Fenced by (generation, owner) exactly like
   * recordNodeResult.
   */
  async releaseLease(
    tx: OrchestrationTx,
    input: { nodeId: string; ownerId: string; expectedGeneration: number },
  ): Promise<void> {
    await tx.query(
      `UPDATE wfos_orchestration_nodes
          SET owner_id = NULL,
              lease_expires_at = NULL,
              generation = generation + 1,
              updated_at = NOW()
        WHERE id = $1
          AND generation = $2
          AND owner_id = $3`,
      [input.nodeId, input.expectedGeneration, input.ownerId],
    );
  }

  /**
   * Reconcile: release every EXPIRED lease of the graph (each release bumps
   * the fencing generation — the dead owner is fenced out from this moment)
   * and recompute the tallies/status deterministically. Runs inside the
   * caller's transaction.
   */
  async releaseExpiredLeases(tx: OrchestrationTx, graphId: string): Promise<number> {
    const result = await tx.query(
      `UPDATE wfos_orchestration_nodes
          SET owner_id = NULL,
              lease_expires_at = NULL,
              generation = generation + 1,
              updated_at = NOW()
        WHERE graph_id = $1
          AND owner_id IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= NOW()`,
      [graphId],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Abandon the graph (the interruption mirror): CAS the status to
   * 'abandoned', mirror the delegation interruption's cancelled units onto
   * their nodes (outcome 'cancelled' — only for nodes with NO terminal
   * outcome; real outcomes are never overwritten), and release every lease
   * (fencing generations bumped). No durable evidence is erased. Returns
   * the updated graph, or null when the graph does not exist.
   */
  async abandonGraph(workItemId: string, planKey: string): Promise<GraphRow | null> {
    return this.db.transaction(async (tx) => {
      const graph = await this.findGraphTx(tx, workItemId, planKey);
      if (!graph) return null;
      if (graph.status === 'abandoned') return graph;
      const updated = await tx.query<GraphRow>(
        `UPDATE wfos_orchestration_graphs
            SET status = 'abandoned', updated_at = NOW()
          WHERE id = $1 AND status <> 'abandoned'
          RETURNING ${GRAPH_COLUMNS}`,
        [graph.id],
      );
      // Release EVERY lease (fencing generations bumped — stale workers
      // are fenced). Durable node outcomes are NEVER touched.
      await tx.query(
        `UPDATE wfos_orchestration_nodes
            SET owner_id = NULL,
                lease_expires_at = NULL,
                generation = generation + 1,
                updated_at = NOW()
          WHERE graph_id = $1 AND owner_id IS NOT NULL`,
        [graph.id],
      );
      // Mirror the delegation interruption: a unit the DELEGATION authority
      // cancelled (it was pending at interruption) is reflected on its node
      // as the terminal mirror outcome 'cancelled' — only where the node has
      // no outcome of its own (never overwrite a real observed outcome).
      await tx.query(
        `UPDATE wfos_orchestration_nodes n
            SET outcome = 'cancelled', updated_at = NOW()
           FROM wfos_delegation_units u
          WHERE u.id = n.unit_id
            AND n.graph_id = $1
            AND u.status = 'cancelled'
            AND n.outcome IS NULL`,
        [graph.id],
      );
      return updated.rows[0] ?? graph;
    });
  }

  // --- deterministic progress recompute --------------------------------------

  /**
   * Recompute the graph's tallies + status from the durable node outcomes —
   * the DETERMINISTIC explicit-partial-completion rule:
   *
   *   abandoned  — sticky (interruption mirror; evidence preserved)
   *   converged  — every node succeeded
   *   partial    — ≥1 terminal outcome and not every node succeeded
   *   orchestrating — otherwise (no terminal outcome yet)
   *
   * The graph row is locked FIRST (documented lock order: graph → node), so
   * concurrent outcome recorders serialize and every recompute sees all
   * committed outcomes. `reconciliation_count` counts reconcile passes
   * (bumped only by explicit reconcile calls, never by outcome writes).
   */
  async recomputeProgress(
    tx: OrchestrationTx,
    graphId: string,
    options: { bumpReconciliation: boolean },
  ): Promise<GraphRow | null> {
    await tx.query(`SELECT id FROM wfos_orchestration_graphs WHERE id = $1 FOR UPDATE`, [
      graphId,
    ]);
    const counts = await tx.query<{
      total: number;
      succeeded: number;
      failed: number;
      unresolved: number;
      cancelled: number;
    }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE outcome = 'succeeded')::int AS succeeded,
              COUNT(*) FILTER (WHERE outcome = 'failed')::int AS failed,
              COUNT(*) FILTER (WHERE outcome = 'unresolved')::int AS unresolved,
              COUNT(*) FILTER (WHERE outcome = 'cancelled')::int AS cancelled
         FROM wfos_orchestration_nodes
        WHERE graph_id = $1`,
      [graphId],
    );
    const c = counts.rows[0]!;
    const current = await tx.query<{ status: OrchestrationGraphStatus }>(
      `SELECT status FROM wfos_orchestration_graphs WHERE id = $1`,
      [graphId],
    );
    const currentStatus = current.rows[0]?.status ?? 'orchestrating';
    const status =
      currentStatus === 'abandoned'
        ? 'abandoned'
        : c.total > 0 && c.succeeded === c.total
          ? ('converged' as const)
          : c.succeeded + c.failed + c.unresolved + c.cancelled > 0
            ? ('partial' as const)
            : ('orchestrating' as const);
    const updated = await tx.query<GraphRow>(
      `UPDATE wfos_orchestration_graphs
          SET status = $2,
              total_nodes = $3,
              succeeded_count = $4,
              failed_count = $5,
              unresolved_count = $6,
              cancelled_count = $7,
              reconciliation_count = reconciliation_count + $8,
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${GRAPH_COLUMNS}`,
      [
        graphId,
        status,
        c.total,
        c.succeeded,
        c.failed,
        c.unresolved,
        c.cancelled,
        options.bumpReconciliation ? 1 : 0,
      ],
    );
    return updated.rows[0] ?? null;
  }

  async bumpReconciliation(tx: OrchestrationTx, graphId: string): Promise<void> {
    await tx.query(
      `UPDATE wfos_orchestration_graphs
          SET reconciliation_count = reconciliation_count + 1, updated_at = NOW()
        WHERE id = $1`,
      [graphId],
    );
  }

  // --- helpers ----------------------------------------------------------------

  private async findGraphTx(
    tx: OrchestrationTx,
    workItemId: string,
    planKey: string,
  ): Promise<GraphRow | null> {
    const result = await tx.query<GraphRow>(
      `SELECT g.${GRAPH_COLUMNS.replaceAll(', ', ', g.')}
         FROM wfos_orchestration_graphs g
         JOIN wfos_delegation_plans p ON p.id = g.plan_id
        WHERE p.work_item_id = $1 AND p.plan_key = $2`,
      [workItemId, planKey],
    );
    return result.rows[0] ?? null;
  }
}

// --- row mappers ---------------------------------------------------------------

export function mapGraphRow(row: GraphRow): OrchestrationGraph {
  return {
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    planId: row.plan_id,
    status: row.status,
    totalNodes: row.total_nodes,
    succeededCount: row.succeeded_count,
    failedCount: row.failed_count,
    unresolvedCount: row.unresolved_count,
    cancelledCount: row.cancelled_count,
    reconciliationCount: row.reconciliation_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapNodeRow(row: NodeRow): OrchestrationNode {
  return {
    id: row.id,
    graphId: row.graph_id,
    projectId: row.project_id,
    unitId: row.unit_id,
    nodeKey: row.node_key,
    dependsOn: row.depends_on,
    ownerId: row.owner_id,
    generation: row.generation,
    leaseExpiresAt: row.lease_expires_at,
    executionId: row.execution_id,
    attemptNo: row.attempt_no,
    outcome: row.outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Backfill the orchestration outcome from the delegation unit's
 * authoritative status (used ONLY when a node row is first materialized —
 * the delegation unit remains the status authority afterwards).
 */
function backfillForUnitStatus(
  unitStatus: string,
): { outcome: OrchestrationNodeOutcome | null } {
  switch (unitStatus) {
    case 'succeeded':
      return { outcome: 'succeeded' };
    case 'failed':
      return { outcome: 'failed' };
    case 'unresolved':
      return { outcome: 'unresolved' };
    case 'cancelled':
      return { outcome: 'cancelled' };
    default:
      // pending | dispatched — not terminal.
      return { outcome: null };
  }
}
