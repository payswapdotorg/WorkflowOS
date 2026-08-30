/**
 * WORK-062 — the durable orchestration substrate service.
 *
 * DURABLE ORCHESTRATION UNDERNEATH WORK-046 DELEGATION, never authority:
 *
 *   - the substrate decides WHETHER a delegated execution may be driven
 *     (durable dependency admission, exclusive lease, fencing) and
 *     reconciles durable state after crashes/restarts/ownership loss;
 *   - the EXISTING delegation protocol (injected as the
 *     {@link OrchestrationExecutor} port) decides HOW a unit is driven —
 *     dispatch, observe-or-resubmit re-drive, retry — with its exactly-one
 *     ExecutionService.submit() call site;
 *   - PostgreSQL is authoritative for ALL orchestration state; Redis is
 *     never used;
 *   - NO autonomous scheduling: every drive/reconcile/retry is an explicit
 *     call (the WORK-046 W046-AC12 discipline, unchanged).
 *
 * THE DRIVE PROTOCOL (one drive = one pass; multi-wave shapes drive again):
 *
 *   1. OBSERVE the delegation authority: read the plan snapshot (units,
 *      latest attempts, the server-resolved project scope) and validate the
 *      dependency graph (fail closed).
 *   2. ENSURE the durable graph (idempotent — ONE graph per plan, ONE node
 *      per unit; fresh nodes backfill from the units' authoritative status).
 *   3. RECONCILE deterministically: release every EXPIRED lease (each
 *      release bumps the fencing generation — the dead owner is fenced out
 *      from that moment) and recompute tallies/status from durable outcomes.
 *   4. CLASSIFY the nodes from DURABLE state (nodes are processed in
 *      node_key order — the documented total order):
 *        terminal        → skipped
 *        fresh + admitted → dispatch candidate (dependencies durably
 *                           satisfied)
 *        fresh + blocked  → blocked (a dependent node NEVER starts before
 *                           its dependencies' durable outcomes admit it)
 *        in-flight/limbo → re-drive candidate (observe-or-resubmit — the
 *                           external execution convergence)
 *   5. DRIVE the candidates with BOUNDED CONCURRENCY (safe
 *      dependency-aware parallelism — independent nodes may run in
 *      parallel; dependent nodes are never in the same candidate set):
 *        acquire the exclusive lease (one conditional UPDATE — at most one
 *        active owner per node across concurrent coordinators; the fencing
 *        generation is bumped on acquisition);
 *        execute through the port;
 *        record the result at the FENCED MUTATION BOUNDARY (generation +
 *        owner in the UPDATE's WHERE clause — a stale worker is rejected by
 *        PostgreSQL after any takeover).
 *      Executor errors PROPAGATE (a crashed drive is the honest result);
 *      the crashed node's lease is released with a generation bump so the
 *      dead recorder can never mutate later. Real process death leaves the
 *      lease to expire — the next reconcile takes over (fencing the dead
 *      owner) and converges.
 *
 * DETERMINISTIC RECONCILIATION — the ordering rules (documented, total):
 *   - nodes are read and processed in node_key ASC order everywhere;
 *   - expired-lease release is a set operation over the graph's nodes (no
 *     per-node winner selection — release is not assignment);
 *   - lease acquisition is exclusive BY CONSTRAINT (one conditional UPDATE;
 *     concurrent acquirers serialize on the row; exactly one wins);
 *   - outcome acceptance is fenced BY GENERATION (never wall-clock);
 *   - the graph status/tallies are a PURE function of the durable node
 *     outcomes (see the repository's recompute rule).
 *   The same durable state always reconciles to the same result; lease
 *   expiry is evaluated against the durable lease_expires_at (monotone —
 *   once expired, always expired).
 */
import type { DatabaseClient, Logger } from '@platform/index.js';
import type {
  OrchestrationDriveOptions,
  OrchestrationDriveResult,
  OrchestrationExecutor,
  OrchestrationGraph,
  OrchestrationNode,
  OrchestrationNodeContext,
  OrchestrationNodeDriveResult,
  OrchestrationNodeOutcome,
} from '../types.js';
import { OrchestrationError } from '../types.js';
import {
  PgOrchestrationRepository,
  mapGraphRow,
  mapNodeRow,
  type DelegationPlanSnapshot,
} from './pg-orchestration-repository.js';

export interface DefaultOrchestrationSubstrateDeps {
  readonly db: DatabaseClient;
  readonly logger: Logger;
  /** Default 60_000 ms. */
  readonly defaultLeaseTtlMs?: number;
  /** Default 1 (sequential — bit-identical to the pre-WORK-062 drive). */
  readonly defaultMaxParallel?: number;
}

/** A classified drive candidate. */
interface DriveCandidate {
  readonly node: OrchestrationNode;
  readonly purpose: 'dispatch' | 'redrive';
}

export class DefaultOrchestrationSubstrate {
  private readonly repo: PgOrchestrationRepository;
  private readonly defaultLeaseTtlMs: number;
  private readonly defaultMaxParallel: number;

  constructor(private readonly deps: DefaultOrchestrationSubstrateDeps) {
    this.repo = new PgOrchestrationRepository(deps.db);
    this.defaultLeaseTtlMs = deps.defaultLeaseTtlMs ?? 60_000;
    this.defaultMaxParallel = deps.defaultMaxParallel ?? 1;
  }

  async driveGraph(
    options: OrchestrationDriveOptions,
    executor: OrchestrationExecutor,
  ): Promise<OrchestrationDriveResult> {
    const snapshot = await this.observePlan(options.workItemId, options.planKey);
    const graph = await this.ensureGraphRow(snapshot);

    // An interrupted plan is never driven (the delegation authority already
    // abandoned it; the mirror records the abandonment durably and the
    // durable evidence is preserved — never erased).
    if (snapshot.planStatus === 'abandoned') {
      const abandoned = await this.repo.abandonGraph(options.workItemId, options.planKey);
      const effective = abandoned ? mapGraphRow(abandoned) : graph;
      const nodes = await this.listNodesByGraphRow(effective.id);
      return {
        graphId: effective.id,
        graphStatus: effective.status,
        reconciliationCount: effective.reconciliationCount,
        nodes: nodes.map(skippedResult),
      };
    }

    // Reconcile (release expired leases — fencing the dead owners — and
    // recompute the durable tallies/status deterministically).
    await this.reconcileGraphRow(graph.id);

    // Classify from DURABLE state (the candidate set is computed once per
    // drive — a node that converges mid-drive admits its dependents on the
    // NEXT drive, exactly the pre-WORK-062 sequencing semantics).
    const nodes = await this.listNodesByGraphRow(graph.id);
    const byKey = new Map(nodes.map((n) => [n.nodeKey, n]));
    const candidates: DriveCandidate[] = [];
    const results = new Map<string, OrchestrationNodeDriveResult>();
    for (const node of nodes) {
      if (node.outcome === 'succeeded' || node.outcome === 'failed' || node.outcome === 'cancelled') {
        results.set(node.nodeKey, skippedResult(node));
        continue;
      }
      if (node.outcome === 'unresolved' || (node.outcome === null && node.executionId !== null)) {
        candidates.push({ node, purpose: 'redrive' });
        continue;
      }
      // Fresh (never dispatched): durable dependency admission.
      const admitted = node.dependsOn.every(
        (dep) => byKey.get(dep)?.outcome === 'succeeded',
      );
      if (admitted) {
        candidates.push({ node, purpose: 'dispatch' });
      } else {
        results.set(
          node.nodeKey,
          result(node, { action: 'blocked' }),
        );
      }
    }

    // Drive with bounded concurrency. Errors propagate (crash honesty).
    const maxParallel = Math.max(1, options.maxParallel ?? this.defaultMaxParallel);
    const leaseTtlMs = options.leaseTtlMs ?? this.defaultLeaseTtlMs;
    for (let i = 0; i < candidates.length; i += maxParallel) {
      const chunk = candidates.slice(i, i + maxParallel);
      const driven = await Promise.all(
        chunk.map((c) => this.driveOne(c, options.ownerId, leaseTtlMs, executor)),
      );
      for (const r of driven) results.set(r.nodeKey, r);
    }

    const freshRow = await this.repo.findGraph(options.workItemId, options.planKey);
    const fresh = freshRow ? mapGraphRow(freshRow) : graph;
    const ordered = nodes.map(
      (n) =>
        results.get(n.nodeKey) ??
        skippedResult(n),
    );
    return {
      graphId: fresh.id,
      graphStatus: fresh.status,
      reconciliationCount: fresh.reconciliationCount,
      nodes: ordered,
    };
  }

  async retryNode(
    input: {
      readonly workItemId: string;
      readonly planKey: string;
      readonly nodeKey: string;
      readonly ownerId: string;
      readonly leaseTtlMs?: number;
    },
    executor: OrchestrationExecutor,
  ): Promise<OrchestrationNodeDriveResult> {
    const snapshot = await this.observePlan(input.workItemId, input.planKey);
    const graph = await this.ensureGraphRow(snapshot);
    const nodes = await this.listNodesByGraphRow(graph.id);
    const node = nodes.find((n) => n.nodeKey === input.nodeKey);
    if (!node) {
      throw new OrchestrationError(
        'ORCHESTRATION_NODE_NOT_FOUND',
        `node '${input.nodeKey}' is not part of the orchestration graph of plan '${input.planKey}'`,
      );
    }
    // The WORK-046 retry contract: only failed or unresolved units retry.
    if (node.outcome !== 'failed' && node.outcome !== 'unresolved') {
      throw new OrchestrationError(
        'ORCHESTRATION_NODE_NOT_RETRYABLE',
        `node '${input.nodeKey}' has outcome ${node.outcome ?? 'in-flight'} — only failed or unresolved nodes can be retried`,
      );
    }
    if (snapshot.planStatus !== 'active') {
      throw new OrchestrationError(
        'ORCHESTRATION_GRAPH_NOT_ACTIVE',
        `plan '${input.planKey}' is ${snapshot.planStatus} — only an active plan can retry nodes`,
      );
    }
    const leaseTtlMs = input.leaseTtlMs ?? this.defaultLeaseTtlMs;
    const driven = await this.driveOne(
      { node, purpose: 'retry' },
      input.ownerId,
      leaseTtlMs,
      executor,
    );
    return driven;
  }

  async abandonGraph(workItemId: string, planKey: string): Promise<OrchestrationGraph | null> {
    const row = await this.repo.abandonGraph(workItemId, planKey);
    return row ? mapGraphRow(row) : null;
  }

  async reconcile(workItemId: string, planKey: string): Promise<OrchestrationGraph | null> {
    const graph = await this.repo.findGraph(workItemId, planKey);
    if (!graph) return null;
    await this.reconcileGraphRow(graph.id);
    const fresh = await this.repo.findGraph(workItemId, planKey);
    return fresh ? mapGraphRow(fresh) : null;
  }

  async getGraph(workItemId: string, planKey: string): Promise<OrchestrationGraph | null> {
    const row = await this.repo.findGraph(workItemId, planKey);
    return row ? mapGraphRow(row) : null;
  }

  async listNodes(workItemId: string, planKey: string): Promise<OrchestrationNode[]> {
    const graph = await this.repo.findGraph(workItemId, planKey);
    if (!graph) return [];
    return (await this.repo.listNodesByGraph(graph.id)).map(mapNodeRow);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Observe the delegation authority + fail-closed graph validation. */
  private async observePlan(workItemId: string, planKey: string): Promise<DelegationPlanSnapshot> {
    const snapshot = await this.repo.readDelegationPlan(workItemId, planKey);
    if (!snapshot) {
      throw new OrchestrationError(
        'ORCHESTRATION_PLAN_NOT_FOUND',
        `no delegation plan '${planKey}' exists for work item ${workItemId}`,
      );
    }
    validateDependencyGraph(snapshot);
    return snapshot;
  }

  private async ensureGraphRow(snapshot: DelegationPlanSnapshot) {
    const row = await this.deps.db.transaction((tx) => this.repo.ensureGraph(tx, snapshot));
    return mapGraphRow(row);
  }

  private async reconcileGraphRow(graphId: string): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      await this.repo.releaseExpiredLeases(tx, graphId);
      await this.repo.recomputeProgress(tx, graphId, { bumpReconciliation: true });
    });
  }

  private async listNodesByGraphRow(graphId: string): Promise<OrchestrationNode[]> {
    return (await this.repo.listNodesByGraph(graphId)).map(mapNodeRow);
  }

  /** Drive ONE candidate: acquire → execute → record (all fenced). */
  private async driveOne(
    candidate: DriveCandidate | { node: OrchestrationNode; purpose: 'retry' },
    ownerId: string,
    leaseTtlMs: number,
    executor: OrchestrationExecutor,
  ): Promise<OrchestrationNodeDriveResult> {
    const { node, purpose } = candidate;
    const leaseExpiresAt = new Date(Date.now() + leaseTtlMs);

    // (1) ACQUIRE — one conditional UPDATE; at most one active owner.
    const acquisition = await this.deps.db.transaction((tx) =>
      this.repo.acquireLease(tx, {
        nodeId: node.id,
        ownerId,
        leaseExpiresAt,
        purpose,
      }),
    );
    if (!acquisition.ok) {
      // Typed convergence — never a silent duplicate drive.
      if (acquisition.reason === 'lease-held') return result(node, { action: 'lease-held' });
      if (acquisition.reason === 'dependency-not-satisfied') {
        return result(node, { action: 'blocked' });
      }
      return result(node, { action: 'skipped' });
    }
    const leased = acquisition.node;
    const generation = leased.generation;

    const context: OrchestrationNodeContext = {
      nodeId: node.id,
      nodeKey: node.nodeKey,
      unitId: node.unitId,
      graphId: node.graphId,
      generation,
      ownerId,
      purpose,
      executionId: leased.execution_id,
      attemptNo: leased.attempt_no,
    };

    // (2) EXECUTE through the EXISTING delegation protocol (outside any DB
    // transaction — never hold a transaction across external calls).
    let executed;
    try {
      executed = await executor.execute(context);
    } catch (err) {
      // A crashed drive: release the lease WITH a generation bump — the
      // dead recorder is fenced out structurally; the durable intent
      // (delegation attempt) + the next drive converge. The error
      // PROPAGATES (crash honesty).
      this.deps.logger.warn('orchestration.node.executor_error', {
        nodeId: node.id,
        nodeKey: node.nodeKey,
        generation,
        error: (err as Error).message,
      });
      await this.deps.db.transaction((tx) =>
        this.repo.releaseLease(tx, { nodeId: node.id, ownerId, expectedGeneration: generation }),
      );
      throw err;
    }

    // (3) RECORD at the fenced mutation boundary (generation + owner in the
    // UPDATE's WHERE clause). A takeover during the execution fences THIS
    // recorder out — converge on the durable truth instead of failing.
    const recorded = await this.repo.recordNodeResult({
      nodeId: node.id,
      graphId: node.graphId,
      ownerId,
      expectedGeneration: generation,
      outcome: executed.outcome,
      executionId: executed.executionId,
      attemptNo: executed.attemptNo,
    });
    if (!recorded.ok) {
      this.deps.logger.warn('orchestration.node.fenced_out', {
        nodeId: node.id,
        nodeKey: node.nodeKey,
        generation,
      });
      const fresh = await this.repo.findNodeByUnit(node.graphId, node.unitId);
      return fresh
        ? result(mapNodeRow(fresh), { action: 'converged' })
        : result(node, { action: 'converged' });
    }
    return {
      nodeKey: node.nodeKey,
      unitId: node.unitId,
      outcome: recorded.node.outcome,
      executionId: recorded.node.execution_id,
      attemptNo: recorded.node.attempt_no,
      action: executed.action,
    };
  }
}

// --- helpers --------------------------------------------------------------------

function result(
  node: OrchestrationNode,
  overrides: Partial<Pick<OrchestrationNodeDriveResult, 'action'>>,
): OrchestrationNodeDriveResult {
  return {
    nodeKey: node.nodeKey,
    unitId: node.unitId,
    outcome: node.outcome,
    executionId: node.executionId,
    attemptNo: node.attemptNo,
    action: overrides.action ?? 'skipped',
  };
}

function skippedResult(node: OrchestrationNode): OrchestrationNodeDriveResult {
  return result(node, { action: 'skipped' });
}

/**
 * Fail-closed dependency-graph validation (defense in depth — WORK-046
 * already validated the plan at creation; the substrate re-validates the
 * OBSERVED state): every dependency key must be a unit of the SAME plan,
 * and the graph must be acyclic.
 */
function validateDependencyGraph(snapshot: DelegationPlanSnapshot): void {
  const keys = new Set(snapshot.units.map((u) => u.unitKey));
  for (const unit of snapshot.units) {
    for (const dep of unit.dependsOn) {
      if (!keys.has(dep)) {
        throw new OrchestrationError(
          'ORCHESTRATION_UNKNOWN_DEPENDENCY',
          `node '${unit.unitKey}' depends on '${dep}', which is not a node in the same plan (dependencies cannot cross plans — and therefore cannot cross tenants)`,
        );
      }
    }
  }
  // Kahn's algorithm.
  const indegree = new Map<string, number>();
  for (const u of snapshot.units) indegree.set(u.unitKey, 0);
  for (const u of snapshot.units) {
    for (const _dep of u.dependsOn) {
      indegree.set(u.unitKey, (indegree.get(u.unitKey) ?? 0) + 1);
    }
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  const order: string[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    order.push(key);
    for (const u of snapshot.units) {
      if (u.dependsOn.includes(key)) {
        const next = (indegree.get(u.unitKey) ?? 0) - 1;
        indegree.set(u.unitKey, next);
        if (next === 0) queue.push(u.unitKey);
      }
    }
  }
  if (order.length !== snapshot.units.length) {
    const cycle = snapshot.units
      .filter((u) => (indegree.get(u.unitKey) ?? 0) > 0)
      .map((u) => u.unitKey);
    throw new OrchestrationError(
      'ORCHESTRATION_DEPENDENCY_CYCLE',
      `the orchestration dependency graph contains a cycle among nodes [${cycle.join(', ')}]`,
    );
  }
}

/**
 * Map a delegation unit's post-drive status to the orchestration node
 * outcome (the unit/attempt rows remain the authorities — the node outcome
 * is their observed mirror).
 */
export function nodeOutcomeFromUnitStatus(status: string): OrchestrationNodeOutcome | null {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'unresolved':
      return 'unresolved';
    default:
      // pending | dispatched | cancelled — not terminal for the node
      // (cancelled mirrors only at interruption).
      return null;
  }
}
