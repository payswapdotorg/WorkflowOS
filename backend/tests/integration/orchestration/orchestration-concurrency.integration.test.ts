import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { createLogger } from '@platform/index.js';

// The EXISTING execution stack (mirrors the delegation integration test).
import { DefaultAgentGateway, FakeAgentAdapter } from '../../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import { DefaultReviewService } from '../../../src/modules/reviews/internal/review-service.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';
import { DefaultExecutionTaskService } from '../../../src/modules/work-items/internal/execution-task-service.js';
import { DefaultExecutionPromptBuilder } from '../../../src/modules/work-items/internal/execution-prompt-builder.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import { NativeExecutionProvider } from '../../../src/modules/agents/internal/native-execution-provider.js';
import { ExternalExecutionProvider } from '../../../src/modules/agents/internal/external-execution-provider.js';
import { DefaultExecutionService } from '../../../src/modules/agents/internal/execution-service.js';
import { PgExecutionRecordRepository } from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { PgExecutionProviderOperationRepository } from '../../../src/modules/agents/internal/pg-execution-provider-operation-repository.js';
import type { DatabaseClient } from '@platform/index.js';

// The EXISTING WORK-045 role catalog.
import { DefaultAgentRoleCatalogService } from '../../../src/agent-roles/index.js';

// WORK-046 + WORK-062.
import {
  DefaultDelegationPlanService,
  DefaultDelegationCoordinator,
  type DelegationPlanService,
  type DelegationCoordinator,
  type DelegationPlanInput,
  type DelegationUnitSpec,
} from '../../../src/delegation/index.js';
import {
  DefaultOrchestrationSubstrate,
  PgOrchestrationRepository,
  type OrchestrationSubstrate,
} from '../../../src/orchestration/index.js';

/**
 * WORK-062 — the two-actor PostgreSQL concurrency proofs (the production
 * worker topology: INDEPENDENT connections, genuine row-lock blocking).
 *
 * Every test in this file runs on TWO INDEPENDENT PostgreSQL connections
 * (`createSecondClient`) and SKIPS on the single-connection pglite path
 * (cross-connection contention is impossible there by construction — the
 * same protocol as the WORK-046 two-actor regressions).
 *
 * The proof matrix (real PostgreSQL only):
 *
 *   1. same-key concurrent ensureGraph → ONE graph, ONE node set;
 *   2. concurrent lease acquisition on one node → exactly ONE owner
 *      (the loser is typed 'lease-held' — never a duplicate drive);
 *   3. STALE-WORKER FENCING — after a takeover (generation bump), the old
 *      owner's mutation is rejected BY POSTGRESQL at the mutation boundary
 *      (0 rows, typed 'fenced-out') — not by application bookkeeping;
 *   4. lease expiry → takeover → the fenced owner cannot reclaim;
 *   5. concurrent coordinator drives of the SAME plan → every unit has
 *      EXACTLY ONE attempt and ONE execution (same-key convergence at the
 *      orchestration level — no duplicate logical executions);
 *   6. idempotent retry convergence — re-driving a completed logical
 *      execution converges on the existing outcome (never duplicates).
 */
describe('WORK-062 — two-actor PostgreSQL concurrency proofs (independent connections)', () => {
  let stack: TestAuthStack;
  let planService: DelegationPlanService;
  let substrate: OrchestrationSubstrate;
  let repo: PgOrchestrationRepository;
  let project: { id: string };
  let fixtureVersionId: string;
  let taskService: DefaultExecutionTaskService;
  const NATIVE_MODEL = 'fake-model';

  /** Build a full coordinator stack over a GIVEN database client. */
  const buildCoordinator = (db: DatabaseClient): DelegationCoordinator => {
    const logger = createLogger({ level: 'silent' });
    const fakeAgent = sharedFakeAgent;
    const agentGateway = new DefaultAgentGateway(db, logger, [fakeAgent], 3);
    const agentRunRepo = new PgAgentRunRepository(db);
    const reviewService = new DefaultReviewService(db, stack.workItemRepository, logger);
    const contextRepo = new PgImplementationContextRepository(db);
    const builder = new DefaultImplementationContextBuilder(
      stack.workItemRepository,
      stack.workOrderRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      stack.workItemDependencyRepository,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.architectureRepository,
      contextRepo,
      undefined,
      undefined,
      undefined,
      async (workItemId: string) => {
        const reviews = await reviewService.listReviewsForWorkItem(workItemId);
        return Promise.all(
          reviews
            .filter((r) => r.status === 'completed' && r.outcome !== null)
            .map(async (r) => {
              const findings = await reviewService.listFindingsForReview(r.id);
              return {
                reviewId: r.id,
                verdict: r.outcome ?? '',
                summary: r.summary ?? '',
                findings: findings.map((f) => f.description),
                createdAt: r.createdAt.toISOString(),
              };
            }),
        );
      },
    );
    const localTaskService = new DefaultExecutionTaskService({
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      implementationContextBuilder: builder,
      contextRepository: contextRepo,
      promptBuilder: new DefaultExecutionPromptBuilder(),
      logger,
    });
    const executionService = new DefaultExecutionService({
      executionRecordRepository: new PgExecutionRecordRepository(db),
      providers: [
        new NativeExecutionProvider({ agentGateway, agentRunRepository: agentRunRepo, logger }),
        new ExternalExecutionProvider({
          packageTtlMs: 60 * 60 * 1000,
          operationStore: new PgExecutionProviderOperationRepository(db),
        }),
      ],
      auditService: new DefaultAuditService(db, logger),
      logger,
    });
    return new DefaultDelegationCoordinator({
      db,
      executionTaskService: localTaskService,
      executionService,
      executionRecordRepository: new PgExecutionRecordRepository(db),
      agentRunRepository: agentRunRepo,
      logger,
      orchestration: new DefaultOrchestrationSubstrate({ db, logger }),
    });
  };

  let sharedFakeAgent: FakeAgentAdapter;

  beforeAll(async () => {
    stack = await buildAuthStack({});
    const logger = createLogger({ level: 'silent' });
    sharedFakeAgent = new FakeAgentAdapter();

    const roleCatalog = new DefaultAgentRoleCatalogService();
    planService = new DefaultDelegationPlanService({
      db: stack.db.client,
      workItemRepository: stack.workItemRepository,
      roleCatalog,
    });
    substrate = new DefaultOrchestrationSubstrate({ db: stack.db.client, logger });
    repo = new PgOrchestrationRepository(stack.db.client);
    // A task service over the primary client (used by fixtures).
    const contextRepo = new PgImplementationContextRepository(stack.db.client);
    const builder = new DefaultImplementationContextBuilder(
      stack.workItemRepository,
      stack.workOrderRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      stack.workItemDependencyRepository,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.architectureRepository,
      contextRepo,
      undefined,
      undefined,
      undefined,
      async () => [],
    );
    taskService = new DefaultExecutionTaskService({
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      implementationContextBuilder: builder,
      contextRepository: contextRepo,
      promptBuilder: new DefaultExecutionPromptBuilder(),
      logger,
    });
    buildCoordinator; // referenced for the linter; constructed per-test

    const org = await stack.organizationRepository.create({ name: 'Orch Concurrency Org' });
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'orch-c-user', displayName: 'U' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    project = await stack.projectRepository.create({ organizationId: org.id, name: 'Orch Concurrency Project' });
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Arch-Orch-C' });
    const versionA = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'content' });
    fixtureVersionId = versionA.id;
  });

  afterAll(async () => {
    await stack.teardown();
  });

  async function createWorkItem(label: string): Promise<string> {
    const wi = await stack.workItemRepository.create({
      architectureVersionId: fixtureVersionId,
      workItemId: label,
      title: label,
      objective: `Objective for ${label}`,
      scope: `Scope for ${label}`,
    });
    await stack.workOrderRepository.create({
      workItemId: wi.id,
      projectId: project.id,
      architectureVersionId: fixtureVersionId,
      scope: `Scope for ${label}`,
      outOfScope: 'Nothing',
      architectureConstraints: 'None',
      verificationRequirements: ['All tests pass'],
    });
    return wi.id;
  }

  const nativeUnit = (unitKey: string, dependsOn: string[] = []): DelegationUnitSpec => ({
    unitKey,
    role: 'implementer',
    mode: 'native',
    provider: 'fake',
    model: NATIVE_MODEL,
    dependsOn,
  });

  const planInput = (workItemId: string, planKey = 'default'): DelegationPlanInput => ({
    workItemId,
    planKey,
    units: [nativeUnit('a'), nativeUnit('b'), nativeUnit('c', ['a', 'b'])],
  });

  /** Materialize the orchestration graph for a plan WITHOUT driving units. */
  async function materializeGraph(workItemId: string, planKey = 'default'): Promise<void> {
    await substrate.driveGraph({ workItemId, planKey, ownerId: 'materialize' }, {
      execute: async (node) => ({
        nodeKey: node.nodeKey,
        unitId: node.unitId,
        outcome: null,
        executionId: node.executionId,
        attemptNo: node.attemptNo,
        action: 'skipped' as const,
      }),
    });
  }

  // --- 1. same-key concurrent ensureGraph --------------------------------------

  it('TWO-ACTOR #1 — concurrent same-plan ensureGraph on independent connections converges on ONE graph + ONE node set', async () => {
    const second = stack.db.createSecondClient;
    if (!second) return; // pglite: single-connection — the race is unrepresentable

    const wi = await createWorkItem('WI-C-ENSURE');
    await planService.createPlan(planInput(wi));

    const c2 = await second();
    const repo2 = new PgOrchestrationRepository(c2.client);
    const snapshot1 = await repo.readDelegationPlan(wi, 'default');
    const snapshot2 = await repo2.readDelegationPlan(wi, 'default');
    expect(snapshot1).not.toBeNull();
    expect(snapshot2).not.toBeNull();

    // BOTH connections ensure the graph for the SAME plan CONCURRENTLY.
    const [g1, g2] = await Promise.all([
      stack.db.client.transaction((tx) => repo.ensureGraph(tx, snapshot1!)),
      c2.client.transaction((tx) => repo2.ensureGraph(tx, snapshot2!)),
    ]);
    expect(g1.id).toBe(g2.id); // ONE durable graph identity
    const count = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM wfos_orchestration_graphs g
         JOIN wfos_delegation_plans p ON p.id = g.plan_id
        WHERE p.work_item_id = $1`,
      [wi],
    );
    expect(count.rows[0]!.count).toBe(1);
    const nodes = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM wfos_orchestration_nodes n
         JOIN wfos_orchestration_graphs g ON g.id = n.graph_id
         JOIN wfos_delegation_plans p ON p.id = g.plan_id
        WHERE p.work_item_id = $1`,
      [wi],
    );
    expect(nodes.rows[0]!.count).toBe(3); // ONE node per unit — no duplicates
    await c2.close();
  });

  // --- 2. concurrent lease acquisition ------------------------------------------

  it('TWO-ACTOR #2 — concurrent lease acquisition on ONE node: exactly ONE owner (the loser is typed lease-held — never a duplicate drive)', async () => {
    const second = stack.db.createSecondClient;
    if (!second) return;

    const wi = await createWorkItem('WI-C-LEASE');
    await planService.createPlan(planInput(wi));
    await materializeGraph(wi);
    const node = (await substrate.listNodes(wi, 'default')).find((n) => n.nodeKey === 'a')!;
    const generationBefore = node.generation; // materializeGraph already leased + released once
    const expiry = new Date(Date.now() + 60_000);

    const c2 = await second();
    const repo2 = new PgOrchestrationRepository(c2.client);
    // Genuinely concurrent acquisition on independent connections — the
    // loser's conditional UPDATE blocks on the winner's row lock and then
    // matches ZERO rows (owner set, lease unexpired).
    const [r1, r2] = await Promise.all([
      stack.db.client.transaction((tx) =>
        repo.acquireLease(tx, { nodeId: node.id, ownerId: 'driver-1', leaseExpiresAt: expiry, purpose: 'dispatch' }),
      ),
      c2.client.transaction((tx) =>
        repo2.acquireLease(tx, { nodeId: node.id, ownerId: 'driver-2', leaseExpiresAt: expiry, purpose: 'dispatch' }),
      ),
    ]);
    const winners = [r1, r2].filter((r) => r.ok);
    const losers = [r1, r2].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { reason: string }).reason).toBe('lease-held');

    // The durable row has exactly ONE owner with exactly ONE more fencing
    // generation than before the race (the loser bumped nothing).
    const row = await stack.db.client.query<{ owner_id: string; generation: number }>(
      `SELECT owner_id, generation FROM wfos_orchestration_nodes WHERE id = $1`,
      [node.id],
    );
    expect(row.rows[0]!.generation).toBe(generationBefore + 1);
    expect((winners[0] as { node: { owner_id: string } }).node.owner_id).toBe(row.rows[0]!.owner_id);
    await c2.close();
  });

  // --- 3. stale-worker fencing (THE fencing proof) ---------------------------------

  it('TWO-ACTOR #3 — STALE-WORKER FENCING: after a takeover, the OLD owner\'s mutation is rejected BY POSTGRESQL at the mutation boundary (typed fenced-out)', async () => {
    const second = stack.db.createSecondClient;
    if (!second) return;

    const wi = await createWorkItem('WI-C-FENCE');
    await planService.createPlan(planInput(wi));
    await materializeGraph(wi);
    const node = (await substrate.listNodes(wi, 'default')).find((n) => n.nodeKey === 'a')!;
    const graph = await substrate.getGraph(wi, 'default')!;

    // T1 (connection 1) acquires the lease: generation G.
    const t1 = await stack.db.client.transaction((tx) =>
      repo.acquireLease(tx, {
        nodeId: node.id, ownerId: 'worker-1',
        leaseExpiresAt: new Date(Date.now() + 60_000), purpose: 'dispatch',
      }),
    );
    expect(t1.ok).toBe(true);
    const staleGeneration = (t1 as { node: { generation: number } }).node.generation;

    // The lease EXPIRES (durable time passage — the row's own deadline).
    await stack.db.client.query(
      `UPDATE wfos_orchestration_nodes SET lease_expires_at = NOW() - interval '1 second' WHERE id = $1`,
      [node.id],
    );

    // T2 (connection 2) takes over: generation G+1, a NEW owner.
    const c2 = await second();
    const repo2 = new PgOrchestrationRepository(c2.client);
    const t2 = await c2.client.transaction((tx) =>
      repo2.acquireLease(tx, {
        nodeId: node.id, ownerId: 'worker-2',
        leaseExpiresAt: new Date(Date.now() + 60_000), purpose: 'dispatch',
      }),
    );
    expect(t2.ok).toBe(true);
    const freshGeneration = (t2 as { node: { generation: number } }).node.generation;
    expect(freshGeneration).toBe(staleGeneration + 1);

    // THE PROOF: the STALE worker (T1, generation G) attempts its mutation
    // ON ITS OWN CONNECTION — PostgreSQL rejects it at the mutation
    // boundary (WHERE generation = $expected matches ZERO rows — the fence
    // is IN THE UPDATE, not in application code).
    const staleRecord = await repo.recordNodeResult({
      nodeId: node.id,
      graphId: graph!.id,
      ownerId: 'worker-1',
      expectedGeneration: staleGeneration,
      outcome: 'succeeded',
      executionId: 'wf_stalefence01',
      attemptNo: 1,
    });
    expect(staleRecord.ok).toBe(false);
    expect((staleRecord as { reason: string }).reason).toBe('fenced-out');

    // And the equivalent RAW SQL (the same mutation without the service)
    // is rejected identically — the invariant is at the PERSISTENCE layer.
    const raw = await stack.db.client.query<{ count: number }>(
      `UPDATE wfos_orchestration_nodes
          SET outcome = 'succeeded', execution_id = 'wf_stalefence02', attempt_no = 1
        WHERE id = $1 AND generation = $2 AND owner_id = 'worker-1'
        RETURNING 1 AS one`,
      [node.id, staleGeneration],
    );
    expect(raw.rows).toHaveLength(0);

    // The stale worker's LEASE RELEASE is equally fenced (it cannot even
    // release what it no longer owns).
    await stack.db.client.transaction((tx) =>
      repo.releaseLease(tx, { nodeId: node.id, ownerId: 'worker-1', expectedGeneration: staleGeneration }),
    );
    const afterRelease = await stack.db.client.query<{ owner_id: string | null; generation: number }>(
      `SELECT owner_id, generation FROM wfos_orchestration_nodes WHERE id = $1`,
      [node.id],
    );
    expect(afterRelease.rows[0]!.owner_id).toBe('worker-2'); // untouched
    expect(afterRelease.rows[0]!.generation).toBe(freshGeneration);

    // The CURRENT owner (T2, generation G+1) still mutates freely.
    const freshRecord = await repo2.recordNodeResult({
      nodeId: node.id,
      graphId: graph!.id,
      ownerId: 'worker-2',
      expectedGeneration: freshGeneration,
      outcome: 'succeeded',
      executionId: 'wf_freshok01',
      attemptNo: 1,
    });
    expect(freshRecord.ok).toBe(true);
    await c2.close();
  });

  // --- 4. lease expiry + takeover semantics -----------------------------------------

  it('TWO-ACTOR #4 — lease expiry: an EXPIRED lease is takeable (the new owner is fenced-in, the old fenced-out); an UNEXPIRED lease is NOT', async () => {
    const second = stack.db.createSecondClient;
    if (!second) return;

    const wi = await createWorkItem('WI-C-TAKEOVER');
    await planService.createPlan(planInput(wi));
    await materializeGraph(wi);
    const node = (await substrate.listNodes(wi, 'default')).find((n) => n.nodeKey === 'b')!;

    // An unexpired lease is NOT takeable.
    const alive = await stack.db.client.transaction((tx) =>
      repo.acquireLease(tx, {
        nodeId: node.id, ownerId: 'alive-worker',
        leaseExpiresAt: new Date(Date.now() + 60_000), purpose: 'dispatch',
      }),
    );
    expect(alive.ok).toBe(true);
    const aliveGeneration = (alive as { node: { generation: number } }).node.generation;
    const c2 = await second();
    const repo2 = new PgOrchestrationRepository(c2.client);
    const blocked = await c2.client.transaction((tx) =>
      repo2.acquireLease(tx, {
        nodeId: node.id, ownerId: 'usurper',
        leaseExpiresAt: new Date(Date.now() + 60_000), purpose: 'dispatch',
      }),
    );
    expect(blocked.ok).toBe(false);
    expect((blocked as { reason: string }).reason).toBe('lease-held');

    // After expiry the takeover succeeds (generation bumped → the dead
    // owner is fenced out from this moment).
    await stack.db.client.query(
      `UPDATE wfos_orchestration_nodes SET lease_expires_at = NOW() - interval '1 second' WHERE id = $1`,
      [node.id],
    );
    const takeover = await c2.client.transaction((tx) =>
      repo2.acquireLease(tx, {
        nodeId: node.id, ownerId: 'usurper',
        leaseExpiresAt: new Date(Date.now() + 60_000), purpose: 'dispatch',
      }),
    );
    expect(takeover.ok).toBe(true);
    // The takeover bumped the fencing generation exactly once past the
    // live owner's — fencing the dead owner from this moment.
    expect((takeover as { node: { generation: number } }).node.generation).toBe(aliveGeneration + 1);
    await c2.close();
  });

  // --- 5. concurrent coordinator drives (same-key convergence) ------------------------

  it('TWO-ACTOR #5 — concurrent coordinator drives of the SAME plan: every unit gets EXACTLY ONE attempt + ONE execution (no duplicate logical executions)', async () => {
    const second = stack.db.createSecondClient;
    if (!second) return;

    const wi = await createWorkItem('WI-C-DRIVES');
    await planService.createPlan(planInput(wi));

    const c2 = await second();
    const coordinatorA = buildCoordinator(stack.db.client);
    const coordinatorB = buildCoordinator(c2.client);

    // Genuinely concurrent drives of the SAME plan on independent
    // connections (the production multi-coordinator topology).
    const [rA, rB] = await Promise.all([
      coordinatorA.drivePlan(wi, 'default'),
      coordinatorB.drivePlan(wi, 'default'),
    ]);
    // Both drives return honest coordination results — neither throws.
    expect(['active', 'completed']).toContain(rA.planStatus);
    expect(['active', 'completed']).toContain(rB.planStatus);

    // Drive to completion (sequentially — the convergence phase).
    let status = rA.planStatus;
    for (let i = 0; i < 4 && status !== 'completed'; i++) {
      const r = await coordinatorA.drivePlan(wi, 'default');
      status = r.planStatus;
    }
    expect(status).toBe('completed');

    // THE CONVERGENCE PROOF: exactly ONE attempt per unit, exactly ONE
    // execution per attempt — the concurrent drives produced NO duplicate
    // logical executions.
    const attempts = await stack.db.client.query<{ unit_key: string; attempts: number; executions: number }>(
      `SELECT u.unit_key,
              COUNT(DISTINCT a.id)::int AS attempts,
              COUNT(DISTINCT a.execution_id)::int AS executions
         FROM wfos_delegation_units u
         LEFT JOIN wfos_delegation_attempts a ON a.unit_id = u.id
        WHERE u.plan_id = (SELECT id FROM wfos_delegation_plans WHERE work_item_id = $1 AND plan_key = 'default')
        GROUP BY u.unit_key
        ORDER BY u.unit_key`,
      [wi],
    );
    expect(attempts.rows.map((r) => [r.unit_key, r.attempts, r.executions])).toEqual([
      ['a', 1, 1],
      ['b', 1, 1],
      ['c', 1, 1],
    ]);
    // Every attempt's execution identity references an EXISTING execution.
    const execRefs = await stack.db.client.query<{ execution_id: string }>(
      `SELECT a.execution_id
         FROM wfos_delegation_attempts a
         JOIN wfos_delegation_units u ON u.id = a.unit_id
         JOIN wfos_delegation_plans p ON p.id = u.plan_id
        WHERE p.work_item_id = $1`,
      [wi],
    );
    for (const ref of execRefs.rows) {
      const exec = await stack.db.client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM wfos_executions WHERE execution_id = $1`,
        [ref.execution_id],
      );
      expect(exec.rows[0]!.count).toBe(1);
    }
    const graph = await substrate.getGraph(wi, 'default');
    expect(graph!.status).toBe('converged');
    expect(graph!.succeededCount).toBe(3);
    await c2.close();
  });

  // --- 6. idempotent retry convergence -------------------------------------------------

  it('TWO-ACTOR #6 — idempotent retry: re-driving an in-flight/completed logical execution CONVERGES on the existing outcome (the same execution identity — never a duplicate)', async () => {
    const second = stack.db.createSecondClient;
    if (!second) return;

    const wi = await createWorkItem('WI-C-IDEMPOTENT');
    await planService.createPlan({ workItemId: wi, planKey: 'default', units: [nativeUnit('solo')] });
    const coordinatorA = buildCoordinator(stack.db.client);
    await coordinatorA.drivePlan(wi, 'default');
    const planAfter = await planService.getPlan(wi, 'default');
    expect(planAfter!.status).toBe('completed');

    // A CONCURRENT second coordinator re-drives the COMPLETED plan while
    // the first re-drives too — the completed logical execution converges
    // (skipped; no new attempts, no new executions).
    const c2 = await second();
    const coordinatorB = buildCoordinator(c2.client);
    const [again1, again2] = await Promise.all([
      coordinatorA.drivePlan(wi, 'default'),
      coordinatorB.drivePlan(wi, 'default'),
    ]);
    expect(again1.planStatus).toBe('completed');
    expect(again2.planStatus).toBe('completed');

    const attempts = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM wfos_delegation_attempts a
         JOIN wfos_delegation_units u ON u.id = a.unit_id
         JOIN wfos_delegation_plans p ON p.id = u.plan_id
        WHERE p.work_item_id = $1`,
      [wi],
    );
    expect(attempts.rows[0]!.count).toBe(1); // still exactly ONE attempt
    await c2.close();
  });

  // --- structural: the taskService fixture reference (kept for future proofs) -----------
  it('fixture sanity — the shared stack built a real execution task service', () => {
    expect(taskService).toBeDefined();
  });
});
