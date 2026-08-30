import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { createLogger } from '@platform/index.js';

// The EXISTING execution stack.
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
import type { ExecutionService, ExecutionSubmitResult, ExecutionTask } from '../../../src/modules/agents/index.js';

import { DefaultAgentRoleCatalogService } from '../../../src/agent-roles/index.js';
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
  type OrchestrationSubstrate,
} from '../../../src/orchestration/index.js';

/**
 * WORK-062 — the crash/restart reconciliation proofs: every failure window
 * converges deterministically, native AND external, through the EXISTING
 * WORK-046 protocol under the substrate.
 *
 * The modeled windows (a crashed process at each point — simulated with a
 * CrashingExecutionService wrapper around the REAL service, exactly like
 * the WORK-046 crash regressions):
 *
 *   W1  before durable intent   — the executor dies before the attempt
 *                                 allocation (nothing durable happened);
 *   W2  after durable intent /
 *       before execution submit — the attempt row EXISTS (the durable
 *                                 intent), the execution record does NOT;
 *   W3  after execution submit /
 *       before durable outcome  — the record EXISTS (in flight or
 *                                 terminal), the attempt outcome is not
 *                                 yet recorded;
 *   W4  after outcome /
 *       before acknowledgement  — the delegation outcome IS recorded; the
 *                                 substrate's node mirror is not (yet);
 *   W5  during reconciliation   — a reconcile pass is interrupted and
 *                                 re-run (idempotent convergence);
 *   W6  during ownership
 *       takeover                — the takeover commits atomically; the
 *                                 fenced old owner is rejected (proven in
 *                                 the concurrency suite; here end-to-end
 *                                 through the coordinator).
 *
 * NEVER assume `process crashed => operation did not happen`: the external
 * effect may already exist — the re-drive OBSERVES the existing record by
 * its durable identity (or safely resubmits when NOTHING provably
 * happened), never blindly resubmitting an ambiguous operation.
 */
describe('WORK-062 — crash/restart reconciliation (every failure window converges)', () => {
  let stack: TestAuthStack;
  let fakeAgent: FakeAgentAdapter;
  let planService: DelegationPlanService;
  let substrate: OrchestrationSubstrate;
  let realExecutionService: DefaultExecutionService;
  let project: { id: string };
  let fixtureVersionId: string;
  let baseDeps: {
    executionTaskService: DefaultExecutionTaskService;
    executionRecordRepository: PgExecutionRecordRepository;
    agentRunRepository: PgAgentRunRepository;
  };
  const NATIVE_MODEL = 'fake-model';

  /**
   * A crashing ExecutionService wrapper (the WORK-046 crash-window pattern):
   * the REAL submit runs up to the modeled window, then the "process dies".
   */
  class CrashingExecutionService implements ExecutionService {
    constructor(
      private readonly inner: ExecutionService,
      private readonly mode:
        | 'crash-before-submit'
        | 'crash-after-submit'
        | 'crash-after-outcome',
    ) {}
    async submit(task: ExecutionTask): Promise<ExecutionSubmitResult> {
      if (this.mode === 'crash-before-submit') {
        // Process death BEFORE any durable submit step — nothing reached
        // the execution authority (the attempt allocation already happened
        // in the coordinator: that IS the durable intent, W2).
        throw new Error('simulated crash BEFORE the execution submit');
      }
      await this.inner.submit(task);
      if (this.mode === 'crash-after-submit') {
        // The real submit happened (record + provider side effect exist) —
        // the process dies before the coordinator records the outcome (W3).
        throw new Error('simulated crash AFTER the execution submit (before the outcome record)');
      }
      // 'crash-after-outcome': the REAL service persisted everything; the
      // crash is simulated at the substrate acknowledgement boundary by the
      // test (W4) — submit returns normally and the coordinator protocol
      // records the attempt outcome; the throw happens below to kill the
      // drive before the substrate's fenced record.
      throw new Error('simulated crash AFTER the outcome record (before the substrate acknowledgement)');
    }
  }

  const buildCoordinator = (executionService: ExecutionService): DelegationCoordinator =>
    new DefaultDelegationCoordinator({
      db: stack.db.client,
      executionTaskService: baseDeps.executionTaskService,
      executionService,
      executionRecordRepository: baseDeps.executionRecordRepository,
      agentRunRepository: baseDeps.agentRunRepository,
      logger: createLogger({ level: 'silent' }),
      orchestration: substrate,
    });

  beforeAll(async () => {
    stack = await buildAuthStack({});
    const logger = createLogger({ level: 'silent' });

    fakeAgent = new FakeAgentAdapter();
    const agentGateway = new DefaultAgentGateway(stack.db.client, logger, [fakeAgent], 3);
    const agentRunRepo = new PgAgentRunRepository(stack.db.client);
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
    const executionRecordRepo = new PgExecutionRecordRepository(stack.db.client);
    realExecutionService = new DefaultExecutionService({
      executionRecordRepository: executionRecordRepo,
      providers: [
        new NativeExecutionProvider({ agentGateway, agentRunRepository: agentRunRepo, logger }),
        new ExternalExecutionProvider({
          packageTtlMs: 60 * 60 * 1000,
          operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
        }),
      ],
      auditService: new DefaultAuditService(stack.db.client, logger),
      logger,
    });
    baseDeps = {
      executionTaskService: taskService,
      executionRecordRepository: executionRecordRepo,
      agentRunRepository: agentRunRepo,
    };

    planService = new DefaultDelegationPlanService({
      db: stack.db.client,
      workItemRepository: stack.workItemRepository,
      roleCatalog: new DefaultAgentRoleCatalogService(),
    });
    substrate = new DefaultOrchestrationSubstrate({ db: stack.db.client, logger });

    const org = await stack.organizationRepository.create({ name: 'Orch Crash Org' });
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'orch-crash-user', displayName: 'U' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    project = await stack.projectRepository.create({ organizationId: org.id, name: 'Orch Crash Project' });
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Arch-Orch-Crash' });
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
  const externalUnit = (unitKey: string): DelegationUnitSpec => ({
    unitKey,
    role: 'implementer',
    mode: 'external',
    provider: 'zai',
    model: null,
    dependsOn: [],
  });

  const soloPlan = (workItemId: string, planKey = 'default', external = false): DelegationPlanInput => ({
    workItemId,
    planKey,
    units: [external ? externalUnit('solo') : nativeUnit('solo')],
  });

  /** Attempts of a plan's units (the durable evidence). */
  async function attemptsOf(workItemId: string, planKey = 'default') {
    const r = await stack.db.client.query<{ attempt_no: number; execution_id: string; outcome: string | null }>(
      `SELECT a.attempt_no, a.execution_id, a.outcome
         FROM wfos_delegation_attempts a
         JOIN wfos_delegation_units u ON u.id = a.unit_id
         JOIN wfos_delegation_plans p ON p.id = u.plan_id
        WHERE p.work_item_id = $1 AND p.plan_key = $2
        ORDER BY a.attempt_no`,
      [workItemId, planKey],
    );
    return r.rows;
  }

  // --- W2: crash BEFORE the execution submit (the durable intent exists) --------

  it('W2 — crash after durable intent / before execution submit: the re-drive re-submits with the SAME identity → convergence (one attempt, one execution)', async () => {
    const wi = await createWorkItem('WI-CRASH-W2');
    await planService.createPlan(soloPlan(wi));

    const crashing = buildCoordinator(new CrashingExecutionService(realExecutionService, 'crash-before-submit'));
    // The WORK-046 protocol OBSERVES the submission error instead of
    // throwing: nothing durable reached the execution authority, so the
    // honest limbo outcome is 'unresolved' (safe to retry — the same
    // identity, since the record creation is submit's first durable step).
    const crashed = await crashing.drivePlan(wi, 'default');
    expect(crashed.units[0]!.status).toBe('unresolved');

    // The durable intent EXISTS (the attempt row — allocated BEFORE the
    // submit); the execution record does NOT.
    const attempts = await attemptsOf(wi);
    expect(attempts).toHaveLength(1);
    const record = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM wfos_executions WHERE execution_id = $1`,
      [attempts[0]!.execution_id],
    );
    expect(record.rows[0]!.count).toBe(0);

    // The crashed node's lease was released with a generation bump (the
    // dead recorder is fenced) — the next drive (a HEALTHY coordinator)
    // re-drives: observe-or-resubmit with the SAME identity.
    const healthy = buildCoordinator(realExecutionService);
    const r = await healthy.drivePlan(wi, 'default');
    expect(r.units[0]!.status).toBe('succeeded');

    // CONVERGENCE: still ONE attempt, ONE execution — no duplicates.
    const attemptsAfter = await attemptsOf(wi);
    expect(attemptsAfter).toHaveLength(1);
    expect(attemptsAfter[0]!.execution_id).toBe(attempts[0]!.execution_id);
    expect(attemptsAfter[0]!.outcome).toBe('succeeded');
    const node = (await substrate.listNodes(wi, 'default'))[0]!;
    expect(node.outcome).toBe('succeeded');
    expect(node.executionId).toBe(attempts[0]!.execution_id);
    expect(node.ownerId).toBeNull();
    const graph = await substrate.getGraph(wi, 'default');
    expect(graph!.status).toBe('converged');
  });

  // --- W3: crash AFTER the execution submit (before the outcome record) ----------

  it('W3 — crash after execution submit / before durable outcome: the re-drive OBSERVES the existing record → convergence (one execution, one run)', async () => {
    const wi = await createWorkItem('WI-CRASH-W3');
    await planService.createPlan(soloPlan(wi));

    const crashing = buildCoordinator(new CrashingExecutionService(realExecutionService, 'crash-after-submit'));
    // The submit SUCCEEDED durably (record + provider side effect), then
    // the process "died" — the WORK-046 protocol's submission-error path
    // OBSERVES the existing record by its durable identity and converges
    // IN the same drive (NEVER blindly resubmitting an ambiguous op).
    const crashed = await crashing.drivePlan(wi, 'default');
    expect(crashed.units[0]!.status).toBe('succeeded');

    const attempts = await attemptsOf(wi);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe('succeeded');
    const record = await stack.db.client.query<{ status: string }>(
      `SELECT status FROM wfos_executions WHERE execution_id = $1`,
      [attempts[0]!.execution_id],
    );
    expect(record.rows[0]!.status).toBe('completed');

    // The re-drive is IDEMPOTENT on the converged execution.
    const healthy = buildCoordinator(realExecutionService);
    const r = await healthy.drivePlan(wi, 'default');
    expect(r.units[0]!.status).toBe('succeeded');
    const attemptsAfter = await attemptsOf(wi);
    expect(attemptsAfter).toHaveLength(1); // same attempt — no duplicate
    expect(attemptsAfter[0]!.outcome).toBe('succeeded');
    const runs = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM wfos_agent_runs WHERE execution_id = $1`,
      [attempts[0]!.execution_id],
    );
    expect(runs.rows[0]!.count).toBe(1); // one provider operation — never two
  });

  // --- W4: crash after the outcome / before the substrate acknowledgement ---------

  it('W4 — crash after outcome / before the substrate acknowledgement: the node mirror converges from the delegation authority on the next drive (evidence intact)', async () => {
    const wi = await createWorkItem('WI-CRASH-W4');
    await planService.createPlan(soloPlan(wi));

    // The crash window's DURABLE STATE: the DELEGATION outcome IS recorded
    // (the coordinator protocol completed) but the substrate's fenced
    // acknowledgement never happened. Modeled by driving to completion and
    // regressing ONLY the node mirror to the pre-ack state (the exact rows
    // the crash left unwritten).
    const pre = buildCoordinator(realExecutionService);
    await pre.drivePlan(wi, 'default');
    const attempts = await attemptsOf(wi);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe('succeeded');
    await stack.db.client.query(
      `UPDATE wfos_orchestration_nodes SET outcome = NULL, execution_id = NULL, attempt_no = NULL WHERE node_key = 'solo'`,
    );
    const node = (await substrate.listNodes(wi, 'default'))[0]!;
    expect(node.outcome).toBeNull(); // the lagging mirror — honestly in flight

    // The next drive converges the mirror FROM the delegation authority
    // (the unit row is the status authority; the node follows it).
    const healthy = buildCoordinator(realExecutionService);
    await healthy.drivePlan(wi, 'default');
    const nodeAfter = (await substrate.listNodes(wi, 'default'))[0]!;
    expect(nodeAfter.outcome).toBe('succeeded');
    expect(nodeAfter.executionId).toBe(attempts[0]!.execution_id);
    const attemptsAfter = await attemptsOf(wi);
    expect(attemptsAfter).toHaveLength(1); // no duplicate execution
    const graph = await substrate.getGraph(wi, 'default');
    expect(graph!.status).toBe('converged');
  });

  // --- W1 (substrate level): the executor dies before ANY durable step -------------

  it('W1 — crash before durable intent (the executor dies before the attempt allocation): the node is untouched; the re-drive dispatches fresh', async () => {
    const wi = await createWorkItem('WI-CRASH-W1');
    await planService.createPlan(soloPlan(wi));

    // A substrate-level executor that dies IMMEDIATELY — before ANY
    // durable step (no attempt, no execution).
    const dying = {
      execute: async () => {
        throw new Error('simulated executor death before anything durable');
      },
    };
    await expect(
      substrate.driveGraph({ workItemId: wi, planKey: 'default', ownerId: 'doomed' }, dying),
    ).rejects.toThrow(/before anything durable/);

    // NOTHING durable happened — no attempt, no execution.
    expect(await attemptsOf(wi)).toHaveLength(0);
    const node = (await substrate.listNodes(wi, 'default'))[0]!;
    expect(node.outcome).toBeNull();
    expect(node.executionId).toBeNull();
    expect(node.ownerId).toBeNull(); // the lease was released (fenced)

    // The re-drive dispatches FRESH — converges normally.
    const healthy = buildCoordinator(realExecutionService);
    const r = await healthy.drivePlan(wi, 'default');
    expect(r.units[0]!.status).toBe('succeeded');
    const attempts = await attemptsOf(wi);
    expect(attempts).toHaveLength(1);
  });

  // --- W5: interrupted reconciliation (idempotent) ------------------------------------

  it('W5 — interrupted reconciliation: re-running reconcile converges to the SAME state (idempotent; the audit counter moves, nothing else)', async () => {
    const wi = await createWorkItem('WI-CRASH-W5');
    await planService.createPlan(soloPlan(wi));
    const healthy = buildCoordinator(realExecutionService);
    await healthy.drivePlan(wi, 'default');

    const before = await substrate.getGraph(wi, 'default');
    // A "crashed" reconcile is simply re-run (a process restart between
    // passes) — the durable state must be identical.
    await substrate.reconcile(wi, 'default');
    await substrate.reconcile(wi, 'default');
    const after = await substrate.getGraph(wi, 'default');
    expect(after!.status).toBe(before!.status);
    expect(after!.succeededCount).toBe(before!.succeededCount);
    expect(after!.failedCount).toBe(before!.failedCount);
    expect(after!.reconciliationCount).toBeGreaterThan(before!.reconciliationCount);
  });

  // --- W6: ownership takeover after a real crash lease ---------------------------------

  it('W6 — ownership takeover: a coordinator whose lease EXPIRED mid-execution is fenced by the takeover; the new driver converges (end-to-end)', async () => {
    const wi = await createWorkItem('WI-CRASH-W6');
    await planService.createPlan(soloPlan(wi, 'takeover', true)); // external → in flight

    // A coordinator with a TINY lease TTL dispatches the external unit
    // (it goes to handoff — in flight under the execution authority).
    const shortLease = new DefaultDelegationCoordinator({
      db: stack.db.client,
      executionTaskService: baseDeps.executionTaskService,
      executionService: realExecutionService,
      executionRecordRepository: baseDeps.executionRecordRepository,
      agentRunRepository: baseDeps.agentRunRepository,
      logger: createLogger({ level: 'silent' }),
      orchestration: new DefaultOrchestrationSubstrate({
        db: stack.db.client,
        logger: createLogger({ level: 'silent' }),
        defaultLeaseTtlMs: 5,
      }),
    });
    await shortLease.drivePlan(wi, 'takeover');
    const node = (await substrate.listNodes(wi, 'takeover'))[0]!;
    expect(node.outcome).toBeNull(); // in flight (external handoff)
    expect(node.executionId).not.toBeNull();

    // The lease expires (durable time passage).
    await stack.db.client.query(
      `UPDATE wfos_orchestration_nodes SET lease_expires_at = NOW() - interval '1 second' WHERE id = $1`,
      [node.id],
    );

    // A NEW coordinator (a restart) drives: the reconcile takes over the
    // expired lease (fencing the dead owner — generation bump) and
    // re-drives the in-flight node (observe — external handoff stays in
    // flight; NO second execution).
    const restarted = buildCoordinator(realExecutionService);
    const r = await restarted.drivePlan(wi, 'takeover');
    expect(r.units[0]!.action).toBe('in-flight');
    const nodeAfter = (await substrate.listNodes(wi, 'takeover'))[0]!;
    expect(nodeAfter.outcome).toBeNull(); // still honestly in flight
    expect(nodeAfter.ownerId).toBeNull(); // the re-drive released its lease
    expect(nodeAfter.generation).toBeGreaterThan(node.generation); // fenced
    const attempts = await attemptsOf(wi, 'takeover');
    expect(attempts).toHaveLength(1); // still ONE execution — no duplicate
  });

  // --- external execution convergence (the same windows, external mode) ---------------

  it('external execution convergence — the SAME crash windows converge for external executions (never a duplicate logical external execution)', async () => {
    // W2 for external: the durable intent exists, the record does not.
    const wiA = await createWorkItem('WI-CRASH-EXT-A');
    await planService.createPlan(soloPlan(wiA, 'default', true));
    const crashing = buildCoordinator(new CrashingExecutionService(realExecutionService, 'crash-before-submit'));
    const crashed = await crashing.drivePlan(wiA, 'default');
    expect(crashed.units[0]!.status).toBe('unresolved'); // the honest limbo
    const attemptsA = await attemptsOf(wiA);
    expect(attemptsA).toHaveLength(1); // the durable intent exists
    const recordA = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM wfos_executions WHERE execution_id = $1`,
      [attemptsA[0]!.execution_id],
    );
    expect(recordA.rows[0]!.count).toBe(0); // nothing reached the authority

    const healthy = buildCoordinator(realExecutionService);
    await healthy.drivePlan(wiA, 'default');
    const attemptsAfter = await attemptsOf(wiA);
    expect(attemptsAfter).toHaveLength(1); // SAME identity — resubmitted safely
    expect(attemptsAfter[0]!.execution_id).toBe(attemptsA[0]!.execution_id);

    // W3 for external: the record exists (submitted → handoff); the
    // re-drive observes it (never resubmits an ambiguous external op).
    const wiB = await createWorkItem('WI-CRASH-EXT-B');
    await planService.createPlan(soloPlan(wiB, 'default', true));
    const crashingB = buildCoordinator(new CrashingExecutionService(realExecutionService, 'crash-after-submit'));
    // The external package was generated durably; the crash hit before the
    // outcome record — the protocol OBSERVES the existing record.
    const crashedB = await crashingB.drivePlan(wiB, 'default');
    expect(['dispatched', 'unresolved']).toContain(crashedB.units[0]!.status);
    const attemptsB = await attemptsOf(wiB);
    expect(attemptsB).toHaveLength(1);

    const healthyB = buildCoordinator(realExecutionService);
    const r = await healthyB.drivePlan(wiB, 'default');
    expect(r.units[0]!.action).toBe('in-flight'); // observed — NOT resubmitted
    const attemptsBAfter = await attemptsOf(wiB);
    expect(attemptsBAfter).toHaveLength(1); // still one logical execution
    // The external handoff package is generated AT MOST once for the
    // logical execution (the operation ledger + execution identity are the
    // exactly-once boundary — a re-drive never duplicates them).
    const handoffs = await stack.db.client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM wfos_execution_handoffs h
         JOIN wfos_executions e ON e.id = h.execution_record_id
        WHERE e.execution_id = $1`,
      [attemptsB[0]!.execution_id],
    );
    expect(handoffs.rows[0]!.count).toBeLessThanOrEqual(1);
  });

  // --- the multi-wave crash drill (a very-complex shape with crashes) ------------------

  it('a complex DAG with crashes in multiple windows CONVERGES to completion (no duplicate logical executions anywhere)', async () => {
    const wi = await createWorkItem('WI-CRASH-DAG');
    await planService.createPlan({
      workItemId: wi,
      planKey: 'default',
      units: [nativeUnit('a'), nativeUnit('b'), nativeUnit('c', ['a', 'b'])],
    });

    // Crash W2 on the FIRST drive (unit 'a' gets a durable intent, no
    // record — the drive resolves with the honest limbo).
    const crashing = buildCoordinator(new CrashingExecutionService(realExecutionService, 'crash-before-submit'));
    const crashed1 = await crashing.drivePlan(wi, 'default');
    expect(crashed1.units.find((u) => u.unitKey === 'a')!.status).toBe('unresolved');

    // A healthy drive: 'a' re-submits (same identity) and converges; 'b'
    // dispatches fresh (wave semantics).
    const healthy = buildCoordinator(realExecutionService);
    const r1 = await healthy.drivePlan(wi, 'default');
    expect(r1.units.find((u) => u.unitKey === 'a')!.status).toBe('succeeded');
    expect(r1.units.find((u) => u.unitKey === 'b')!.status).toBe('succeeded');

    // Crash W3 on the second wave (unit 'c': submitted durably, then the
    // process died — the protocol observes the existing record).
    const crashingC = buildCoordinator(new CrashingExecutionService(realExecutionService, 'crash-after-submit'));
    const crashed2 = await crashingC.drivePlan(wi, 'default');
    expect(crashed2.units.find((u) => u.unitKey === 'c')!.status).toBe('succeeded');

    // The final healthy drive completes the plan.
    const r2 = await healthy.drivePlan(wi, 'default');
    expect(r2.planStatus).toBe('completed');

    // EXACTLY ONE attempt + ONE execution per unit across ALL the crashes.
    const attempts = await stack.db.client.query<{ unit_key: string; attempts: number }>(
      `SELECT u.unit_key, COUNT(a.id)::int AS attempts
         FROM wfos_delegation_units u
         LEFT JOIN wfos_delegation_attempts a ON a.unit_id = u.id
        WHERE u.plan_id = (SELECT id FROM wfos_delegation_plans WHERE work_item_id = $1 AND plan_key = 'default')
        GROUP BY u.unit_key
        ORDER BY u.unit_key`,
      [wi],
    );
    expect(attempts.rows.map((r) => [r.unit_key, r.attempts])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ]);
    const graph = await substrate.getGraph(wi, 'default');
    expect(graph!.status).toBe('converged');
    expect(graph!.succeededCount).toBe(3);
  });
});
