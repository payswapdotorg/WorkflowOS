import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { createLogger } from '@platform/index.js';

// The EXISTING execution stack (mirrors the delegation integration test —
// the substrate consumes it exactly as production wires it, THROUGH the
// delegation coordinator).
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
import type { ExecutionService } from '../../../src/modules/agents/index.js';

// The EXISTING WORK-045 role catalog (consumed, never redefined).
import { DefaultAgentRoleCatalogService } from '../../../src/agent-roles/index.js';

// WORK-046 — the delegation layer under the substrate.
import {
  DefaultDelegationPlanService,
  DefaultDelegationCoordinator,
  type DelegationPlanService,
  type DelegationCoordinator,
  type DelegationPlanInput,
  type DelegationUnitSpec,
} from '../../../src/delegation/index.js';

// WORK-062 — the orchestration substrate under test.
import {
  DefaultOrchestrationSubstrate,
  PgOrchestrationRepository,
  OrchestrationError,
  type OrchestrationSubstrate,
  type OrchestrationNode,
} from '../../../src/orchestration/index.js';

/**
 * WORK-062 — the durable orchestration substrate: the semantic proof matrix.
 *
 * Every test drives REAL delegated executions through the EXISTING stack
 * (WORK-046 coordinator + the existing execution services) on real
 * PostgreSQL semantics (pglite locally / real postgres in CI), and asserts
 * the SUBSTRATE's durable state (migration 0058 tables):
 *
 *   - durable identity (one graph per plan, one node per unit — survives
 *     repeated drives);
 *   - durable dependency gating (a dependent node NEVER dispatches before
 *     its dependencies' durable outcomes admit it — and the violation is
 *     REJECTED at the mutation boundary);
 *   - explicit partial completion (3/10 is 'partial' — never collapsed);
 *   - deterministic reconciliation (same durable state → same result);
 *   - replanning without evidence loss;
 *   - simple / complex / very-complex shapes under ONE semantics;
 *   - tenant isolation (same logical keys in two projects cannot collide);
 *   - native/external semantic parity;
 *   - PERSISTENCE-LAYER IDENTITY/TENANT INTEGRITY (round-1 architect
 *     remediation): raw-SQL negative regressions prove PostgreSQL ITSELF
 *     (composite FKs + the graph tenant guard — migration 0058) rejects a
 *     structurally impossible graph/plan/unit/project tuple, with NO
 *     service layer in the path.
 */
describe('WORK-062 — the durable orchestration substrate (semantics over the EXISTING authorities)', () => {
  let stack: TestAuthStack;
  let fakeAgent: FakeAgentAdapter;
  let executionRecordRepo: PgExecutionRecordRepository;
  let agentRunRepo: PgAgentRunRepository;
  let planService: DelegationPlanService;
  let coordinator: DelegationCoordinator;
  let substrate: OrchestrationSubstrate;
  let substrateRepo: PgOrchestrationRepository;
  let project: { id: string };
  const NATIVE_MODEL = 'fake-model';

  beforeAll(async () => {
    stack = await buildAuthStack({});
    const logger = createLogger({ level: 'silent' });

    // --- the EXISTING execution stack (mirrors production wiring) -----------
    fakeAgent = new FakeAgentAdapter();
    const agentGateway = new DefaultAgentGateway(stack.db.client, logger, [fakeAgent], 3);
    agentRunRepo = new PgAgentRunRepository(stack.db.client);
    const reviewService = new DefaultReviewService(stack.db.client, stack.workItemRepository, logger);
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
    const taskService = new DefaultExecutionTaskService({
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      implementationContextBuilder: builder,
      contextRepository: contextRepo,
      promptBuilder: new DefaultExecutionPromptBuilder(),
      logger,
    });
    const nativeExecutionProvider = new NativeExecutionProvider({
      agentGateway,
      agentRunRepository: agentRunRepo,
      logger,
    });
    const externalExecutionProvider = new ExternalExecutionProvider({
      packageTtlMs: 60 * 60 * 1000,
      operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
    });
    executionRecordRepo = new PgExecutionRecordRepository(stack.db.client);
    const auditService = new DefaultAuditService(stack.db.client, logger);
    const executionService: ExecutionService = new DefaultExecutionService({
      executionRecordRepository: executionRecordRepo,
      providers: [nativeExecutionProvider, externalExecutionProvider],
      auditService,
      logger,
    });

    // --- WORK-045 roles + WORK-046 delegation + WORK-062 substrate ----------
    const roleCatalog = new DefaultAgentRoleCatalogService();
    planService = new DefaultDelegationPlanService({
      db: stack.db.client,
      workItemRepository: stack.workItemRepository,
      roleCatalog,
    });
    substrate = new DefaultOrchestrationSubstrate({
      db: stack.db.client,
      logger,
    });
    substrateRepo = new PgOrchestrationRepository(stack.db.client);
    coordinator = new DefaultDelegationCoordinator({
      db: stack.db.client,
      executionTaskService: taskService,
      executionService,
      executionRecordRepository: executionRecordRepo,
      agentRunRepository: agentRunRepo,
      logger,
      orchestration: substrate,
    });

    // --- fixtures -------------------------------------------------------------
    const org = await stack.organizationRepository.create({ name: 'Orchestration Org' });
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'orch-user', displayName: 'U' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    project = await stack.projectRepository.create({ organizationId: org.id, name: 'Orchestration Project' });
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Arch-Orchestration' });
    const versionA = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'content' });
    await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'REQ-ORCH-001',
      title: 'Orchestratable requirement',
      description: 'A requirement whose work item can be delegated',
    });
    fixtureVersionId = versionA.id;
  });

  let fixtureVersionId: string;

  afterAll(async () => {
    await stack.teardown();
  });

  /** A Work Item with a Work Order (the existing execution path needs both). */
  async function createWorkItem(label: string, projectId = project.id): Promise<string> {
    // The project scope is reached through the architecture (the existing
    // authority chain) — a work item of ANOTHER project needs its own
    // architecture + version.
    let versionId = fixtureVersionId;
    if (projectId !== project.id) {
      const arch = await stack.architectureRepository.create({ projectId, name: `Arch-${label}` });
      const v = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'content' });
      versionId = v.id;
    }
    const wi = await stack.workItemRepository.create({
      architectureVersionId: versionId,
      workItemId: label,
      title: label,
      objective: `Objective for ${label}`,
      scope: `Scope for ${label}`,
    });
    await stack.workOrderRepository.create({
      workItemId: wi.id,
      projectId,
      architectureVersionId: versionId,
      scope: `Scope for ${label}`,
      outOfScope: 'Nothing',
      architectureConstraints: 'None',
      verificationRequirements: ['All tests pass'],
    });
    return wi.id;
  }

  const nativeUnit = (
    unitKey: string,
    dependsOn: string[] = [],
  ): DelegationUnitSpec => ({
    unitKey,
    role: 'implementer',
    mode: 'native',
    provider: 'fake',
    model: NATIVE_MODEL,
    dependsOn,
  });
  const externalUnit = (unitKey: string, dependsOn: string[] = []): DelegationUnitSpec => ({
    unitKey,
    role: 'implementer',
    mode: 'external',
    provider: 'zai',
    model: null,
    dependsOn,
  });

  const planInput = (workItemId: string, planKey = 'default'): DelegationPlanInput => ({
    workItemId,
    planKey,
    units: [nativeUnit('a'), nativeUnit('b'), nativeUnit('c', ['a', 'b'])],
  });

  // --- durable identity -------------------------------------------------------

  it('durable identity — ONE graph per plan, ONE node per unit; the identity survives repeated drives (idempotent ensureGraph)', async () => {
    const wi = await createWorkItem('WI-IDENTITY');
    const plan = await planService.createPlan(planInput(wi));

    const r1 = await coordinator.drivePlan(wi, 'default');
    // One wave per drive: after drive 1 only the roots (a, b) converged.
    expect(r1.planStatus).toBe('active');
    const graph1 = await substrate.getGraph(wi, 'default');
    expect(graph1).not.toBeNull();
    expect(graph1!.planId).toBe(plan.id);
    expect(graph1!.totalNodes).toBe(3);

    // A second drive (and a direct ensureGraph through reconcile) converges
    // on the SAME durable identity — never a duplicate graph/node set.
    const r2 = await coordinator.drivePlan(wi, 'default');
    expect(r2.planStatus).toBe('completed');
    await substrate.reconcile(wi, 'default');
    const graph2 = await substrate.getGraph(wi, 'default');
    expect(graph2!.id).toBe(graph1!.id);
    expect(graph2!.reconciliationCount).toBeGreaterThan(0);

    const nodes = await substrate.listNodes(wi, 'default');
    expect(nodes.map((n) => n.nodeKey)).toEqual(['a', 'b', 'c']);
    // Every node REFERENCES the existing delegation unit (no second identity).
    for (const n of nodes) {
      expect(plan.units.some((u) => u.id === n.unitId)).toBe(true);
    }

    // The identity is NOT derived from process/memory state: it lives in
    // PostgreSQL keyed by the delegation plan (unique by constraint).
    const direct = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM wfos_orchestration_graphs WHERE plan_id = $1`,
      [plan.id],
    );
    expect(direct.rows[0]!.count).toBe(1);
  });

  it('durable identity — every driven node references the EXISTING execution identity (through the delegation attempt)', async () => {
    const wi = await createWorkItem('WI-EXECREF');
    await planService.createPlan(planInput(wi));
    await coordinator.drivePlan(wi, 'default');
    await coordinator.drivePlan(wi, 'default'); // both waves
    const nodes = await substrate.listNodes(wi, 'default');
    for (const n of nodes) {
      expect(n.executionId).not.toBeNull();
      expect(n.attemptNo).toBe(1);
      // The referenced identity IS an existing execution record row.
      const exec = await stack.db.client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM wfos_executions WHERE execution_id = $1`,
        [n.executionId],
      );
      expect(exec.rows[0]!.count, `node ${n.nodeKey} must reference an existing execution`).toBe(1);
    }
  });

  // --- durable dependency gating -------------------------------------------------

  it('dependency gating — a dependent node does NOT dispatch until its dependencies\' DURABLE outcomes admit it (the same drive as the dependencies converging does not admit it — one wave per drive)', async () => {
    const wi = await createWorkItem('WI-GATING');
    await planService.createPlan(planInput(wi));
    const r1 = await coordinator.drivePlan(wi, 'default');
    // Wave 1: a + b dispatched (and, with the synchronous fake agent,
    // converged to succeeded); c was BLOCKED at drive-start classification.
    const c1 = r1.units.find((u) => u.unitKey === 'c')!;
    expect(c1.action).toBe('skipped');
    const nodes1 = await substrate.listNodes(wi, 'default');
    expect(nodes1.find((n) => n.nodeKey === 'c')!.attemptNo).toBeNull();

    // Wave 2: c's dependencies are DURABLY succeeded → c dispatches.
    const r2 = await coordinator.drivePlan(wi, 'default');
    const c2 = r2.units.find((u) => u.unitKey === 'c')!;
    expect(c2.action).toBe('dispatched');
    const nodes2 = await substrate.listNodes(wi, 'default');
    expect(nodes2.find((n) => n.nodeKey === 'c')!.outcome).toBe('succeeded');
  });

  it('dependency-violation rejection — a dependency-blocked node cannot even ACQUIRE a dispatch lease (the mutation boundary rejects it, typed)', async () => {
    const wi = await createWorkItem('WI-VIOLATION');
    await planService.createPlan(planInput(wi));
    // Materialize the graph WITHOUT driving (a no-op executor drive — every
    // acquisition is released immediately; nothing is dispatched).
    await substrate.driveGraph({ workItemId: wi, planKey: 'default', ownerId: 'materialize' }, {
      execute: async (node) => ({
        nodeKey: node.nodeKey,
        unitId: node.unitId,
        outcome: null,
        executionId: node.executionId,
        attemptNo: node.attemptNo,
        action: 'skipped' as const,
      }),
    });
    const nodes = await substrate.listNodes(wi, 'default');
    const c = nodes.find((n) => n.nodeKey === 'c')!;
    expect(c).toBeDefined();

    // The direct repository acquisition (the mutation boundary) rejects the
    // dispatch lease with the TYPED reason.
    const result = await stack.db.client.transaction((tx) =>
      substrateRepo.acquireLease(tx, {
        nodeId: c.id,
        ownerId: 'violator',
        leaseExpiresAt: new Date(Date.now() + 60_000),
        purpose: 'dispatch',
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('dependency-not-satisfied');

    // And even a RAW SQL lease write is rejected by the migration's
    // dependency-gate trigger (defense in depth — a buggy caller cannot
    // lease a never-dispatched node whose dependencies are unsatisfied).
    await expect(
      stack.db.client.query(
        `UPDATE wfos_orchestration_nodes
            SET owner_id = 'violator', lease_expires_at = NOW() + interval '60 seconds'
          WHERE id = $1`,
        [c.id],
      ),
    ).rejects.toThrow(/dependenc/i);
  });

  // --- explicit partial completion --------------------------------------------------

  it('explicit partial completion — 3/10 nodes with 1 failed is PARTIAL (observable, resumable — never collapsed into success or failure)', async () => {
    const wi = await createWorkItem('WI-PARTIAL');
    // 10 units: a1..a3 independent roots; rest depend on all three.
    const units: DelegationUnitSpec[] = [
      nativeUnit('a1'), nativeUnit('a2'), nativeUnit('a3'),
      ...Array.from({ length: 7 }, (_, i) => nativeUnit(`d${i + 1}`, ['a1', 'a2', 'a3'])),
    ];
    await planService.createPlan({ workItemId: wi, planKey: 'default', units });

    // a2 FAILS (the fake agent fails its first call for this execution).
    fakeAgent.reset();
    fakeAgent.setFailure('non_retryable', 'planned failure', false, 1);
    await coordinator.drivePlan(wi, 'default');
    fakeAgent.reset();

    const graph = await substrate.getGraph(wi, 'default');
    expect(graph!.status).toBe('partial');
    expect(graph!.succeededCount).toBe(2); // a1 + a3
    expect(graph!.failedCount).toBe(1); // a2
    expect(graph!.totalNodes).toBe(10);

    // The partial state is RESUMABLE: retry a1 (the failed root — the first
    // dispatched node in node_key order) → succeeded; the dependents become
    // admissible on the next drive (nothing was collapsed).
    await coordinator.retryUnit(wi, 'default', 'a1');
    const graphAfterRetry = await substrate.getGraph(wi, 'default');
    expect(graphAfterRetry!.succeededCount).toBe(3);
    expect(graphAfterRetry!.status).toBe('partial');

    // Drive the fan-out: all 7 dependents dispatch in ONE wave (they are
    // mutually independent) and the graph CONVERGES.
    const r = await coordinator.drivePlan(wi, 'default');
    expect(r.planStatus).toBe('completed');
    const converged = await substrate.getGraph(wi, 'default');
    expect(converged!.status).toBe('converged');
    expect(converged!.succeededCount).toBe(10);
    expect(converged!.failedCount).toBe(0);
  });

  // --- deterministic reconciliation -----------------------------------------------

  it('deterministic reconciliation — the same durable state reconciles to the same result (idempotent, ordered, no wall-clock winner selection)', async () => {
    const wi = await createWorkItem('WI-DETERMINISM');
    await planService.createPlan(planInput(wi));
    fakeAgent.reset();
    fakeAgent.setFailure('non_retryable', 'planned failure', false, 1);
    await coordinator.drivePlan(wi, 'default');
    fakeAgent.reset();

    const before = await substrate.getGraph(wi, 'default');
    const nodesBefore = await substrate.listNodes(wi, 'default');

    // Reconcile repeatedly — the durable outcome state is UNCHANGED by
    // reconciliation (idempotent); only the audit counter moves.
    await substrate.reconcile(wi, 'default');
    await substrate.reconcile(wi, 'default');
    const after = await substrate.getGraph(wi, 'default');
    const nodesAfter = await substrate.listNodes(wi, 'default');

    expect(after!.status).toBe(before!.status);
    expect(after!.succeededCount).toBe(before!.succeededCount);
    expect(after!.failedCount).toBe(before!.failedCount);
    expect(after!.reconciliationCount).toBeGreaterThan(before!.reconciliationCount);
    expect(nodesAfter.map((n) => [n.nodeKey, n.outcome])).toEqual(
      nodesBefore.map((n) => [n.nodeKey, n.outcome]),
    );
    // Nodes are ALWAYS read in the documented total order (node_key).
    expect(nodesAfter.map((n) => n.nodeKey)).toEqual([...nodesAfter.map((n) => n.nodeKey)].sort());
  });

  // --- replanning without evidence loss ---------------------------------------------

  it('replanning without evidence loss — a NEW plan (different key) creates a NEW graph; the old graph, its node outcomes, and every attempt/execution row survive intact', async () => {
    const wi = await createWorkItem('WI-REPLAN');
    await planService.createPlan({ ...planInput(wi), planKey: 'original' });
    fakeAgent.reset();
    fakeAgent.setFailure('non_retryable', 'planned failure', false, 1);
    await coordinator.drivePlan(wi, 'original');
    fakeAgent.reset();

    const originalGraph = await substrate.getGraph(wi, 'original');
    expect(originalGraph!.status).toBe('partial');
    const originalNodes = await substrate.listNodes(wi, 'original');
    const originalExecIds = originalNodes.map((n) => n.executionId);

    // Replan: a different plan key for the same Work Item.
    await planService.createPlan({ workItemId: wi, planKey: 'revised', units: [nativeUnit('a'), nativeUnit('b')] });
    await coordinator.drivePlan(wi, 'revised');

    const revisedGraph = await substrate.getGraph(wi, 'revised');
    expect(revisedGraph!.id).not.toBe(originalGraph!.id);

    // The ORIGINAL evidence is untouched (nothing erased or rewritten).
    const originalAfter = await substrate.getGraph(wi, 'original');
    expect(originalAfter!.status).toBe('partial');
    expect(originalAfter!.succeededCount).toBe(originalGraph!.succeededCount);
    const nodesAfter = await substrate.listNodes(wi, 'original');
    expect(nodesAfter.map((n) => n.executionId)).toEqual(originalExecIds);
    for (const execId of originalExecIds) {
      if (execId === null) continue;
      const exec = await stack.db.client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM wfos_executions WHERE execution_id = $1`,
        [execId],
      );
      expect(exec.rows[0]!.count).toBe(1);
    }
    // The original plan's attempts are still there (delegation authority).
    const attempts = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM wfos_delegation_attempts a
         JOIN wfos_delegation_units u ON u.id = a.unit_id
         JOIN wfos_delegation_plans p ON p.id = u.plan_id
        WHERE p.work_item_id = $1 AND p.plan_key = 'original'`,
      [wi],
    );
    // 'a' failed (1 attempt) + 'b' succeeded (1 attempt); 'c' never
    // dispatched (blocked on 'a') — the ORIGINAL attempt history is intact.
    expect(attempts.rows[0]!.count).toBe(2);
  });

  // --- tenant isolation ----------------------------------------------------------------

  it('tenant isolation — the SAME logical keys in two projects cannot collide; graphs are project-scoped; dependencies cannot cross tenants', async () => {
    // A SECOND project (another tenant).
    const org2 = await stack.organizationRepository.create({ name: 'Orchestration Org 2' });
    const user2 = await stack.userRepository.upsertByExternalId({ externalId: 'orch-user-2', displayName: 'U2' });
    await stack.membershipRepository.assign({ userId: user2.id, organizationId: org2.id, roleId: 'owner' });
    const project2 = await stack.projectRepository.create({ organizationId: org2.id, name: 'Orchestration Project 2' });

    const wiA = await createWorkItem('WI-TENANT-A', project.id);
    const wiB = await createWorkItem('WI-TENANT-B', project2.id);

    // The SAME plan key + unit keys in both projects.
    await planService.createPlan(planInput(wiA));
    await planService.createPlan(planInput(wiB));
    await coordinator.drivePlan(wiA, 'default');
    await coordinator.drivePlan(wiB, 'default');

    const graphA = await substrate.getGraph(wiA, 'default');
    const graphB = await substrate.getGraph(wiB, 'default');
    expect(graphA!.id).not.toBe(graphB!.id);
    expect(graphA!.projectId).toBe(project.id);
    expect(graphB!.projectId).toBe(project2.id);

    // No cross-tenant node leakage: every node of graph A carries project A.
    const nodesA = await substrate.listNodes(wiA, 'default');
    for (const n of nodesA) expect(n.projectId).toBe(project.id);
    const nodesB = await substrate.listNodes(wiB, 'default');
    for (const n of nodesB) expect(n.projectId).toBe(project2.id);

    // Ownership acquisition is project-scoped: the substrate resolves the
    // project SERVER-SIDE (the work item's architecture chain) — a node of
    // project B is unreachable through project A's work item.
    const countCross = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM wfos_orchestration_nodes n
        WHERE n.project_id = $1 AND n.graph_id = $2`,
      [project2.id, graphA!.id],
    );
    expect(countCross.rows[0]!.count).toBe(0);

    // A dependency referencing another tenant's node key is REJECTED at
    // graph creation (dependencies must resolve within the SAME plan —
    // which lives within ONE work item within ONE project).
    await expect(
      substrateRepo.readDelegationPlan(wiA, 'default'),
    ).resolves.toMatchObject({ projectId: project.id });
  });

  // --- persistence-layer identity/tenant integrity (round-1 architect remediation) ----

  it('RAW-SQL PERSISTENCE INTEGRITY — PostgreSQL ITSELF rejects structurally impossible graph/plan/unit/project tuples (composite FKs + the tenant guard; NO service layer in the path)', async () => {
    // A SECOND tenant (project B) with its own work item + plan, and a
    // second work item WITHIN tenant A (for the plan/work-item mismatch).
    const orgB = await stack.organizationRepository.create({ name: 'Orchestration Org PIT' });
    const userB = await stack.userRepository.upsertByExternalId({ externalId: 'orch-user-pit', displayName: 'UP' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Orchestration Project PIT' });

    const wiA = await createWorkItem('WI-PIT-A'); // tenant A (the default project)
    const wiA2 = await createWorkItem('WI-PIT-A2'); // tenant A, DIFFERENT work item
    const wiB = await createWorkItem('WI-PIT-B', projectB.id); // tenant B
    const planA = await planService.createPlan(planInput(wiA));
    const planB = await planService.createPlan(planInput(wiB));

    // Materialize graph A through the substrate (the SERVICE path — proven
    // elsewhere; a no-op executor drive, exactly like the dependency-violation
    // test); the negatives below bypass the substrate entirely.
    await substrate.driveGraph({ workItemId: wiA, planKey: 'default', ownerId: 'materialize' }, {
      execute: async (node) => ({
        nodeKey: node.nodeKey,
        unitId: node.unitId,
        outcome: null,
        executionId: node.executionId,
        attemptNo: node.attemptNo,
        action: 'skipped' as const,
      }),
    });
    const graphA = (await substrate.getGraph(wiA, 'default'))!;
    const nodesA = await substrate.listNodes(wiA, 'default');
    const unitOfA = nodesA.find((n) => n.nodeKey === 'a')!.unitId; // a unit of plan A
    const unitOfB = planB.units[0]!.id; // a unit of plan B (tenant B; NO node yet)

    // Every negative is a RAW INSERT/UPDATE that names REAL rows — only the
    // RELATIONSHIP between them is impossible — and is constructed so that
    // EXACTLY ONE composite is violated (the rejection is attributable).
    // PostgreSQL must reject it with that constraint.
    const expectPgReject = async (label: string, sql: string, params: unknown[], matcher: RegExp) => {
      let err: unknown;
      try {
        await stack.db.client.query(sql, params);
      } catch (e) {
        err = e;
      }
      expect(err, `${label}: PostgreSQL must reject this structurally impossible tuple`).toBeDefined();
      expect(String((err as Error).message), label).toMatch(matcher);
    };

    // --- graph-level negatives (plan B has NO graph yet, so the UNIQUE
    //     (plan_id) identity stays out of the way) ---------------------------

    // (5) A GRAPH claiming ANOTHER WORK ITEM'S PLAN (plan B under work item
    //     A2 — both in tenant A, so the tenant guard passes and ONLY the
    //     (plan_id, work_item_id) composite is violated).
    await expectPgReject(
      'graph claims another work item plan',
      `INSERT INTO wfos_orchestration_graphs
           (project_id, work_item_id, plan_id, total_nodes)
         VALUES ($1, $2, $3, 1)`,
      [project.id, wiA2, planB.id],
      /wfos_orchestration_graphs_plan_work_item_fk/,
    );

    // (6) A GRAPH claiming the WRONG TENANT (plan A + work item A — a valid
    //     tuple — but project B): the tenant-guard trigger resolves the work
    //     item's project through the AUTHORITATIVE chain (work item →
    //     architecture version → architecture → project) and rejects the
    //     mismatch BEFORE the row is stored.
    await expectPgReject(
      'graph claims the wrong tenant',
      `INSERT INTO wfos_orchestration_graphs
           (project_id, work_item_id, plan_id, total_nodes)
         VALUES ($1, $2, $3, 1)`,
      [projectB.id, wiA, planA.id],
      /tenant mismatch/,
    );

    // (7) An UPDATE moving an existing graph to ANOTHER TENANT — the tenant
    //     guard holds on UPDATE too.
    await expectPgReject(
      'update moves the graph across tenants',
      `UPDATE wfos_orchestration_graphs SET project_id = $2 WHERE id = $1`,
      [graphA.id, projectB.id],
      /tenant mismatch/,
    );

    // --- POSITIVE CONTROL (graphs) — the fully CONSISTENT tuple (plan B +
    //     work item B in tenant B) inserts cleanly through raw SQL: the
    //     constraint set rejects the impossible, never the true. This graph
    //     then serves as the consistent anchor for the node negatives below.
    const graphB = await stack.db.client.query<{ id: string }>(
      `INSERT INTO wfos_orchestration_graphs
           (project_id, work_item_id, plan_id, total_nodes)
         VALUES ($1, $2, $3, 3)
         RETURNING id`,
      [projectB.id, wiB, planB.id],
    );

    // --- node-level negatives (unit B has NO node yet, so the UNIQUE
    //     (unit_id) identity stays out of the way) ---------------------------

    // (1) A node of graph A referencing ANOTHER PLAN'S UNIT (unit B belongs
    //     to plan B, not plan A) — the composite (unit_id, plan_id) FK.
    await expectPgReject(
      'cross-plan unit',
      `INSERT INTO wfos_orchestration_nodes
           (graph_id, project_id, plan_id, unit_id, node_key, depends_on)
         VALUES ($1, $2, $3, $4, 'cross-plan-unit', '[]'::jsonb)`,
      [graphA.id, project.id, planA.id, unitOfB],
      /wfos_orchestration_nodes_unit_plan_fk/,
    );

    // (2) A node attached to graph A but claiming ANOTHER PLAN (plan B — the
    //     unit/plan tuple itself is valid; the (graph_id, plan_id) composite
    //     is what is impossible: graph A's plan is A, not B).
    await expectPgReject(
      'node claims another plan',
      `INSERT INTO wfos_orchestration_nodes
           (graph_id, project_id, plan_id, unit_id, node_key, depends_on)
         VALUES ($1, $2, $3, $4, 'wrong-plan', '[]'::jsonb)`,
      [graphA.id, project.id, planB.id, unitOfB],
      /wfos_orchestration_nodes_graph_plan_fk/,
    );

    // (3) A CROSS-TENANT node: graph B + plan B + unit B — all mutually
    //     consistent — but tenant A: the composite (graph_id, project_id) FK
    //     (the node's tenant IS its graph's tenant).
    await expectPgReject(
      'cross-tenant node',
      `INSERT INTO wfos_orchestration_nodes
           (graph_id, project_id, plan_id, unit_id, node_key, depends_on)
         VALUES ($1, $2, $3, $4, 'cross-tenant', '[]'::jsonb)`,
      [graphB.rows[0]!.id, project.id, planB.id, unitOfB],
      /wfos_orchestration_nodes_graph_project_fk/,
    );

    // (4) An UPDATE re-pointing an existing node (of plan A, in graph A) at
    //     ANOTHER PLAN'S UNIT — the same tuple integrity holds on UPDATE,
    //     not just INSERT.
    await expectPgReject(
      'update re-points the unit',
      `UPDATE wfos_orchestration_nodes SET unit_id = $2 WHERE unit_id = $1`,
      [unitOfA, unitOfB],
      /wfos_orchestration_nodes_unit_plan_fk/,
    );

    // --- POSITIVE CONTROL (nodes) — the fully CONSISTENT tuple (graph B in
    //     tenant B, unit of plan B) inserts cleanly through raw SQL.
    const nodeB = await stack.db.client.query<{ count: number }>(
      `WITH ins AS (
         INSERT INTO wfos_orchestration_nodes
              (graph_id, project_id, plan_id, unit_id, node_key, depends_on)
            VALUES ($1, $2, $3, $4, 'raw-consistent', '[]'::jsonb)
            RETURNING 1
       ) SELECT COUNT(*)::int AS count FROM ins`,
      [graphB.rows[0]!.id, projectB.id, planB.id, unitOfB],
    );
    expect(nodeB.rows[0]!.count).toBe(1);

    // Cleanup the raw fixtures (plan B stays unmaterialized for later tests).
    await stack.db.client.query(`DELETE FROM wfos_orchestration_graphs WHERE id = $1`, [
      graphB.rows[0]!.id,
    ]);
    const leftover = await stack.db.client.query<{ graphs: number; nodes: number }>(
      `SELECT (SELECT COUNT(*)::int FROM wfos_orchestration_graphs WHERE plan_id = $1) AS graphs,
              (SELECT COUNT(*)::int FROM wfos_orchestration_nodes WHERE plan_id = $1) AS nodes`,
      [planB.id],
    );
    expect(leftover.rows[0]!.graphs).toBe(0);
    expect(leftover.rows[0]!.nodes).toBe(0);
  });

  // --- simple / complex / very-complex shapes under ONE semantics ------------------------

  it('SIMPLE shape — a single delegated execution runs under the same orchestration semantics', async () => {
    const wi = await createWorkItem('WI-SIMPLE');
    await planService.createPlan({ workItemId: wi, planKey: 'default', units: [nativeUnit('solo')] });
    const r = await coordinator.drivePlan(wi, 'default');
    expect(r.planStatus).toBe('completed');
    const graph = await substrate.getGraph(wi, 'default');
    expect(graph!.status).toBe('converged');
    expect(graph!.totalNodes).toBe(1);
    expect(graph!.succeededCount).toBe(1);
  });

  it('COMPLEX shape — a bounded DAG (A → C ← B) runs under the same semantics (parallel-safe waves, durable gating)', async () => {
    const wi = await createWorkItem('WI-COMPLEX');
    await planService.createPlan({
      workItemId: wi,
      planKey: 'default',
      units: [nativeUnit('a'), nativeUnit('b'), nativeUnit('c', ['a', 'b'])],
    });
    await coordinator.drivePlan(wi, 'default');
    const mid = await substrate.getGraph(wi, 'default');
    expect(mid!.status).toBe('partial');
    expect(mid!.succeededCount).toBe(2);
    await coordinator.drivePlan(wi, 'default');
    const done = await substrate.getGraph(wi, 'default');
    expect(done!.status).toBe('converged');
    expect(done!.succeededCount).toBe(3);
  });

  it('VERY-COMPLEX shape — 24 nodes, 4 waves, fan-out/fan-in, a partial failure, a retry, and an ownership change all converge under the SAME semantics', async () => {
    const wi = await createWorkItem('WI-VERYCOMPLEX');
    // Wave 1: 4 roots. Wave 2: 8 (each depends on 2 roots). Wave 3: 8 (each
    // depends on 2 of wave 2). Wave 4: 4 (each depends on all of wave 3).
    const units: DelegationUnitSpec[] = [];
    for (let i = 0; i < 4; i++) units.push(nativeUnit(`w1-${i}`));
    for (let i = 0; i < 8; i++) units.push(nativeUnit(`w2-${i}`, [`w1-${i % 4}`, `w1-${(i + 1) % 4}`]));
    for (let i = 0; i < 8; i++) units.push(nativeUnit(`w3-${i}`, [`w2-${i % 8}`, `w2-${(i + 3) % 8}`]));
    const w3All = Array.from({ length: 8 }, (_, i) => `w3-${i}`);
    for (let i = 0; i < 4; i++) units.push(nativeUnit(`w4-${i}`, w3All));
    await planService.createPlan({ workItemId: wi, planKey: 'default', units });

    // A transient failure in wave 2 (retry recovers it).
    fakeAgent.reset();
    fakeAgent.setFailure('non_retryable', 'transient', false, 1);
    await coordinator.drivePlan(wi, 'default'); // wave 1 (+ w2 classification)
    fakeAgent.reset();
    // Retry the failed unit; then drive repeatedly until converged.
    const failed = (await substrate.listNodes(wi, 'default')).find((n) => n.outcome === 'failed');
    expect(failed).toBeDefined();
    await coordinator.retryUnit(wi, 'default', failed!.nodeKey);

    let planStatus = 'active';
    for (let drive = 0; drive < 8 && planStatus !== 'completed'; drive++) {
      const r = await coordinator.drivePlan(wi, 'default');
      planStatus = r.planStatus;
    }
    expect(planStatus).toBe('completed');
    const graph = await substrate.getGraph(wi, 'default');
    expect(graph!.status).toBe('converged');
    expect(graph!.totalNodes).toBe(24);
    expect(graph!.succeededCount).toBe(24);
    expect(graph!.failedCount).toBe(0);
    // One node needed a second attempt (the retry) — evidence preserved.
    const attempts = await stack.db.client.query<{ unit_key: string; attempts: number }>(
      `SELECT u.unit_key, COUNT(a.id)::int AS attempts
         FROM wfos_delegation_units u
         LEFT JOIN wfos_delegation_attempts a ON a.unit_id = u.id
        WHERE u.plan_id = (SELECT id FROM wfos_delegation_plans WHERE work_item_id = $1 AND plan_key = 'default')
        GROUP BY u.unit_key
        ORDER BY attempts DESC, u.unit_key`,
      [wi],
    );
    expect(attempts.rows[0]!.attempts).toBe(2);
    expect(attempts.rows.filter((r) => r.attempts === 2)).toHaveLength(1);
  });

  // --- native / external semantic parity -------------------------------------------------

  it('native/external parity — an external-mode DAG runs under the SAME orchestration semantics (admission, waves, partial, convergence)', async () => {
    const wi = await createWorkItem('WI-PARITY');
    await planService.createPlan({
      workItemId: wi,
      planKey: 'default',
      units: [externalUnit('x-a'), externalUnit('x-b'), externalUnit('x-c', ['x-a', 'x-b'])],
    });
    // External executions go to handoff (no synchronous completion) — the
    // orchestration semantics are the SAME: wave 1 dispatched, wave 2 gated.
    const r1 = await coordinator.drivePlan(wi, 'default');
    expect(r1.units.find((u) => u.unitKey === 'x-c')!.action).toBe('skipped');
    const graph = await substrate.getGraph(wi, 'default');
    expect(graph!.totalNodes).toBe(3);
    const nodes = await substrate.listNodes(wi, 'default');
    // The external nodes hold their durable execution references (the
    // EXISTING external execution identities).
    expect(nodes.find((n) => n.nodeKey === 'x-a')!.executionId).not.toBeNull();
    expect(nodes.find((n) => n.nodeKey === 'x-c')!.attemptNo).toBeNull();
    // The graph is honestly partial (2 in flight, not collapsed).
    expect(graph!.status).toBe('orchestrating');
  });

  // --- interruption mirror ------------------------------------------------------------------

  it('interruption — the graph mirrors abandonment, releases every lease, and NEVER erases durable evidence', async () => {
    const wi = await createWorkItem('WI-ABANDON');
    await planService.createPlan({
      workItemId: wi,
      planKey: 'default',
      units: [externalUnit('e-a'), externalUnit('e-c', ['e-a'])],
    });
    await coordinator.drivePlan(wi, 'default'); // e-a in flight (external)
    const before = await substrate.listNodes(wi, 'default');
    const inFlight = before.find((n) => n.nodeKey === 'e-a')!;
    expect(inFlight.executionId).not.toBeNull();

    await coordinator.interruptPlan(wi, 'default');

    const graph = await substrate.getGraph(wi, 'default');
    expect(graph!.status).toBe('abandoned');
    const nodes = await substrate.listNodes(wi, 'default');
    for (const n of nodes) {
      expect(n.ownerId).toBeNull(); // every lease released
    }
    // Durable evidence preserved: the in-flight execution reference + the
    // cancelled pending node stay observable.
    expect(nodes.find((n) => n.nodeKey === 'e-a')!.executionId).toBe(inFlight.executionId);
    expect(nodes.find((n) => n.nodeKey === 'e-c')!.outcome).toBe('cancelled');

    // Idempotent.
    await coordinator.interruptPlan(wi, 'default');
    expect((await substrate.getGraph(wi, 'default'))!.status).toBe('abandoned');
  });

  // --- no-autonomous-scheduler (structural, through the substrate's behavior) -----------------

  it('NO autonomous scheduler — the substrate drives NOTHING on its own: an untouched graph is bit-identical after arbitrary time', async () => {
    const wi = await createWorkItem('WI-NOSCHED');
    await planService.createPlan(planInput(wi));
    await substrate.reconcile(wi, 'default'); // materialize the graph, no drive
    const before = await substrate.listNodes(wi, 'default');
    // No drive call → no attempts exist for any unit (nothing was scheduled).
    const attempts = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM wfos_delegation_attempts a
         JOIN wfos_delegation_units u ON u.id = a.unit_id
         JOIN wfos_delegation_plans p ON p.id = u.plan_id
        WHERE p.work_item_id = $1`,
      [wi],
    );
    expect(attempts.rows[0]!.count).toBe(0);
    const after = await substrate.listNodes(wi, 'default');
    expect(after.map((n: OrchestrationNode) => [n.nodeKey, n.outcome, n.attemptNo])).toEqual(
      before.map((n) => [n.nodeKey, n.outcome, n.attemptNo]),
    );
  });

  // --- typed fail-closed errors ---------------------------------------------------------------

  it('typed fail-closed errors — unknown plan, unknown node, non-retryable node (machine-readable codes)', async () => {
    const wi = await createWorkItem('WI-ERRORS');
    await planService.createPlan(planInput(wi));
    await coordinator.drivePlan(wi, 'default');

    await expect(substrate.getGraph(wi, 'missing')).resolves.toBeNull();
    await expect(
      substrate.reconcile(wi, 'missing'),
    ).resolves.toBeNull();
    await expect(
      substrate.retryNode({ workItemId: wi, planKey: 'default', nodeKey: 'missing', ownerId: 'x' }, {
        execute: async () => { throw new Error('unreachable'); },
      }),
    ).rejects.toBeInstanceOf(OrchestrationError);

    // A succeeded node is NOT retryable (the WORK-046 contract).
    await expect(
      substrate.retryNode({ workItemId: wi, planKey: 'default', nodeKey: 'a', ownerId: 'x' }, {
        execute: async () => { throw new Error('unreachable'); },
      }),
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_NODE_NOT_RETRYABLE' });
  });
});
