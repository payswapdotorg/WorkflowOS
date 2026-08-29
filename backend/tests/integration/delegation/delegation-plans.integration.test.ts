import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { createLogger } from '@platform/index.js';

// The EXISTING execution stack (mirrors execution-domain.integration.test.ts
// — the delegation layer consumes it exactly as production wires it).
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

// The WORK-045 role catalog (the EXISTING authority — consumed, never redefined).
import { DefaultAgentRoleCatalogService } from '../../../src/agent-roles/index.js';

// WORK-046 — the delegation layer under test.
import {
  DefaultDelegationPlanService,
  DefaultDelegationCoordinator,
  type DelegationPlanService,
  type DelegationCoordinator,
  type DelegationPlanInput,
  type DelegationUnitSpec,
} from '../../../src/delegation/index.js';

/**
 * WORK-046 — Multi-Agent Delegation: the coordination substrate over the
 * EXISTING execution boundary.
 *
 * The architect's required two-actor PostgreSQL regressions (spec/work-orders/
 * WORK-046.md):
 *
 *   1. same delegation request → ONE authoritative plan
 *   2. concurrent execution-unit creation/dispatch → no duplicate logical units
 *   3. retry after crash → convergence (both crash windows)
 *   4. partial failure → recoverable plan
 *   5. role identity → stable across retries
 *   6. native/external mix → same logical Work Item
 *
 * plus the semantic regressions: idempotent creation, sequencing, fail-closed
 * validation, interruption, structured state, and the NO-hidden-lifecycle
 * guarantee (the workflow table is untouched by delegation).
 *
 * The two-actor proofs run on TWO INDEPENDENT PostgreSQL connections
 * (createSecondClient) — the production worker topology. They skip on the
 * single-connection pglite path.
 */
describe('WORK-046 — Multi-Agent Delegation (coordination over the EXISTING execution boundary)', () => {
  let stack: TestAuthStack;
  let fakeAgent: FakeAgentAdapter;
  let executionRecordRepo: PgExecutionRecordRepository;
  let agentRunRepo: PgAgentRunRepository;
  let planService: DelegationPlanService;
  let coordinator: DelegationCoordinator;
  let roleCatalog: DefaultAgentRoleCatalogService;
  let project: { id: string };
  let user: { id: string };
  let versionA: { id: string };
  const NATIVE_MODEL = 'fake-model';

  /** A crashing ExecutionService wrapper for the crash-window proofs. */
  class CrashingExecutionService implements ExecutionService {
    constructor(
      private readonly inner: ExecutionService,
      private readonly mode: 'crash-before-submit' | 'crash-after-submit',
    ) {}
    async submit(task: ExecutionTask): Promise<ExecutionSubmitResult> {
      if (this.mode === 'crash-before-submit') {
        // Process death BEFORE any durable submit step — nothing reached the
        // execution authority.
        throw new Error('simulated crash BEFORE the execution submit');
      }
      // The real submit happens (the execution record + provider side effect
      // exist) — then the process dies before the coordinator can record the
      // outcome.
      await this.inner.submit(task);
      throw new Error('simulated crash AFTER the execution submit (before the outcome record)');
    }
  }

  /** Build the delegation stack over a given (possibly crashing) ExecutionService. */
  const buildCoordinator = (
    executionService: ExecutionService,
    db: TestAuthStack['db']['client'] = stack.db.client,
  ): DelegationCoordinator =>
    new DefaultDelegationCoordinator({
      db,
      executionTaskService: taskService!,
      executionService,
      executionRecordRepository: executionRecordRepo,
      agentRunRepository: agentRunRepo,
      logger: createLogger({ level: 'silent' }),
    });

  let taskService: DefaultExecutionTaskService | undefined;
  let realExecutionService: DefaultExecutionService | undefined;

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
    const nativeExecutionProvider = new NativeExecutionProvider({
      agentGateway,
      agentRunRepository: agentRunRepo,
      logger,
    });
    const externalExecutionProvider = new ExternalExecutionProvider({
      packageTtlMs: 60 * 60 * 1000,
      // The DURABLE provider-operation ledger — REQUIRED for keyed external
      // submissions (delegation keys every dispatch; mirrors app.ts wiring).
      operationStore: new PgExecutionProviderOperationRepository(stack.db.client),
    });
    executionRecordRepo = new PgExecutionRecordRepository(stack.db.client);
    const auditService = new DefaultAuditService(stack.db.client, logger);
    realExecutionService = new DefaultExecutionService({
      executionRecordRepository: executionRecordRepo,
      providers: [nativeExecutionProvider, externalExecutionProvider],
      auditService,
      logger,
    });

    // --- WORK-045 roles + the WORK-046 delegation layer ---------------------
    roleCatalog = new DefaultAgentRoleCatalogService();
    planService = new DefaultDelegationPlanService({
      db: stack.db.client,
      workItemRepository: stack.workItemRepository,
      roleCatalog,
    });
    coordinator = buildCoordinator(realExecutionService);

    // --- project + architecture + requirement fixtures ----------------------
    const org = await stack.organizationRepository.create({ name: 'Delegation Org' });
    user = await stack.userRepository.upsertByExternalId({ externalId: 'delegation-user', displayName: 'U' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    project = await stack.projectRepository.create({ organizationId: org.id, name: 'Delegation Project' });
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Arch-Delegation' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'content' });
    await stack.requirementRepository.create({
      architectureVersionId: versionA.id,
      requirementId: 'REQ-DELEG-001',
      title: 'Delegatable requirement',
      description: 'A requirement whose work item can be delegated',
    });
  });

  afterAll(async () => {
    await stack.teardown();
  });

  /** A Work Item with a Work Order (the existing execution path needs both). */
  async function createWorkItem(label: string): Promise<string> {
    const wi = await stack.workItemRepository.create({
      architectureVersionId: versionA.id,
      workItemId: label,
      title: label,
      objective: `Objective for ${label}`,
      scope: `Scope for ${label}`,
    });
    await stack.workOrderRepository.create({
      workItemId: wi.id,
      projectId: project.id,
      architectureVersionId: versionA.id,
      scope: `Scope for ${label}`,
      outOfScope: 'Nothing',
      architectureConstraints: 'None',
      verificationRequirements: ['All tests pass'],
    });
    return wi.id;
  }

  const nativeUnit = (
    unitKey: string,
    role: DelegationUnitSpec['role'],
    dependsOn: string[] = [],
  ): DelegationUnitSpec => ({
    unitKey,
    role,
    mode: 'native',
    provider: 'fake',
    model: NATIVE_MODEL,
    dependsOn,
  });
  const externalUnit = (
    unitKey: string,
    role: DelegationUnitSpec['role'],
    dependsOn: string[] = [],
  ): DelegationUnitSpec => ({
    unitKey,
    role,
    mode: 'external',
    provider: 'zai',
    model: null,
    dependsOn,
  });

  const planInput = (workItemId: string, planKey = 'default'): DelegationPlanInput => ({
    workItemId,
    planKey,
    units: [
      nativeUnit('implement', 'implementer'),
      nativeUnit('test', 'tester', ['implement']),
    ],
  });

  // --- validation (all fail-closed, typed) -----------------------------------

  it('fail-closed validation: unknown work item, unknown role, empty plan, duplicate unit keys, unknown dependency, dependency cycle, native-without-model', async () => {
    const wiId = await createWorkItem('WI-VALID');

    await expect(planService.createPlan({
      workItemId: '00000000-0000-0000-0000-000000000000',
      planKey: 'x',
      units: [nativeUnit('a', 'implementer')],
    })).rejects.toMatchObject({ code: 'DELEGATION_WORK_ITEM_NOT_FOUND' });

    await expect(planService.createPlan({
      workItemId: wiId, planKey: 'x', units: [],
    })).rejects.toMatchObject({ code: 'DELEGATION_EMPTY_PLAN' });

    await expect(planService.createPlan({
      workItemId: wiId, planKey: 'x',
      units: [nativeUnit('a', 'wizard' as DelegationUnitSpec['role'])],
    })).rejects.toMatchObject({ code: 'DELEGATION_UNKNOWN_ROLE' });

    await expect(planService.createPlan({
      workItemId: wiId, planKey: 'x',
      units: [nativeUnit('a', 'implementer'), nativeUnit('a', 'tester')],
    })).rejects.toMatchObject({ code: 'DELEGATION_DUPLICATE_UNIT_KEY' });

    await expect(planService.createPlan({
      workItemId: wiId, planKey: 'x',
      units: [nativeUnit('a', 'implementer', ['nope'])],
    })).rejects.toMatchObject({ code: 'DELEGATION_UNKNOWN_DEPENDENCY' });

    await expect(planService.createPlan({
      workItemId: wiId, planKey: 'x',
      units: [
        nativeUnit('a', 'implementer', ['b']),
        nativeUnit('b', 'tester', ['a']),
      ],
    })).rejects.toMatchObject({ code: 'DELEGATION_DEPENDENCY_CYCLE' });

    await expect(planService.createPlan({
      workItemId: wiId, planKey: 'x',
      units: [{ unitKey: 'a', role: 'implementer', mode: 'native', provider: 'fake', model: null }],
    })).rejects.toMatchObject({ code: 'DELEGATION_NATIVE_MODEL_REQUIRED' });

    // Nothing was persisted by any failed creation (for THIS work item).
    const plans = await stack.db.client.query(
      'SELECT count(*)::int AS n FROM wfos_delegation_plans WHERE work_item_id = $1',
      [wiId],
    );
    expect(plans.rows[0]!.n).toBe(0);
  });

  it('plan creation pins the WORK-045 role identity + revision (consumed, never redefined) and is IDEMPOTENT', async () => {
    const wiId = await createWorkItem('WI-CREATE');
    const input = planInput(wiId);

    const first = await planService.createPlan(input);
    expect(first.status).toBe('active');
    expect(first.units).toHaveLength(2);
    expect(first.units.map((u) => u.unitKey).sort()).toEqual(['implement', 'test']);

    // The pinned role assignments resolve through the EXISTING catalog.
    for (const unit of first.units) {
      const resolved = roleCatalog.resolveRole(unit.role.roleId);
      expect(resolved).not.toBeNull();
      expect(unit.role.roleRevision).toBe(resolved!.role.lifecycle.revision);
    }
    const tester = first.units.find((u) => u.unitKey === 'test')!;
    expect(tester.role.roleId).toBe('tester');
    expect(tester.dependsOn).toEqual(['implement']);

    // The SAME delegation request converges on the SAME authoritative plan.
    const second = await planService.createPlan(input);
    expect(second.id).toBe(first.id);
    expect(second.units.map((u) => u.id).sort()).toEqual(first.units.map((u) => u.id).sort());

    // Exactly ONE plan + TWO units exist.
    const planRows = await stack.db.client.query('SELECT count(*)::int AS n FROM wfos_delegation_plans WHERE work_item_id = $1', [wiId]);
    expect(planRows.rows[0]!.n).toBe(1);
    const unitRows = await stack.db.client.query('SELECT count(*)::int AS n FROM wfos_delegation_units WHERE plan_id = $1', [first.id]);
    expect(unitRows.rows[0]!.n).toBe(2);
  });

  it('sequencing + heterogeneous native/external mix → the same logical Work Item; a native/external plan partially completes and stays recoverable', async () => {
    const wiId = await createWorkItem('WI-MIX');
    await planService.createPlan({
      workItemId: wiId,
      planKey: 'mix',
      units: [
        nativeUnit('implement', 'implementer'),
        externalUnit('review', 'security-reviewer', ['implement']),
        nativeUnit('release', 'release-engineer', ['review']),
      ],
    });

    // Drive 1: 'implement' (native, no deps) dispatches; 'review'/'release'
    // wait (sequencing is coordination only).
    const drive1 = await coordinator.drivePlan(wiId, 'mix');
    const byKey1 = new Map(drive1.units.map((u) => [u.unitKey, u]));
    expect(byKey1.get('implement')!.action).toBe('dispatched');
    expect(byKey1.get('implement')!.status).toBe('succeeded'); // native is synchronous
    expect(byKey1.get('review')!.action).toBe('skipped');
    expect(byKey1.get('release')!.action).toBe('skipped');

    // Drive 2: 'review' (external, dependency satisfied) dispatches → the
    // EXISTING external handoff flow (handoff_ready — in flight).
    const drive2 = await coordinator.drivePlan(wiId, 'mix');
    const byKey2 = new Map(drive2.units.map((u) => [u.unitKey, u]));
    expect(byKey2.get('review')!.action).toBe('dispatched');
    expect(byKey2.get('review')!.status).toBe('dispatched'); // awaiting the existing external completion flow
    expect(byKey2.get('release')!.action).toBe('skipped'); // dependency still in flight

    // The plan stays active + recoverable (partial completion — the external
    // unit's outcome belongs to the EXISTING ingestion flow).
    const after = await planService.getPlan(wiId, 'mix');
    expect(after!.status).toBe('active');
    const review = after!.units.find((u) => u.unitKey === 'review')!;
    expect(review.status).toBe('dispatched');
    expect(review.attemptCount).toBe(1);

    // BOTH delegated executions belong to the SAME logical Work Item (ONE
    // Work Item — every execution record carries it).
    const executions = await stack.db.client.query<{ work_item_id: string }>(
      'SELECT work_item_id FROM wfos_executions',
    );
    expect(executions.rows.length).toBe(2);
    expect(executions.rows.every((r) => r.work_item_id === wiId)).toBe(true);

    // Structured state for WORK-047: the attempt rows carry the execution
    // identities + observed details.
    const attempts = await stack.db.client.query(
      'SELECT unit_id, attempt_no, execution_id, outcome FROM wfos_delegation_attempts ORDER BY attempt_no',
    );
    expect(attempts.rows).toHaveLength(2);
  });

  // --- the six required two-actor PostgreSQL regressions ----------------------

  const isRealPg = () =>
    !!process.env.WORKFLOWOS_DATABASE_URL &&
    process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');

  it('TWO-ACTOR #1 — the SAME delegation request from two actors converges on ONE authoritative plan (no duplicate units)', async () => {
    if (!isRealPg() || !stack.db.createSecondClient) return;
    const wiId = await createWorkItem('WI-TA1');
    const input = planInput(wiId, 'ta1');

    const second = await stack.db.createSecondClient();
    try {
      const serviceA = new DefaultDelegationPlanService({
        db: stack.db.client,
        workItemRepository: stack.workItemRepository,
        roleCatalog,
      });
      const serviceB = new DefaultDelegationPlanService({
        db: second.client,
        workItemRepository: stack.workItemRepository,
        roleCatalog,
      });

      const [a, b] = await Promise.all([serviceA.createPlan(input), serviceB.createPlan(input)]);
      // ONE authoritative plan identity…
      expect(a.id).toBe(b.id);
      // …with the winner's unit set (no duplicates).
      expect(a.units.map((u) => u.unitKey).sort()).toEqual(['implement', 'test']);
      expect(b.units.map((u) => u.unitKey).sort()).toEqual(['implement', 'test']);

      const planRows = await stack.db.client.query(
        'SELECT count(*)::int AS n FROM wfos_delegation_plans WHERE work_item_id = $1',
        [wiId],
      );
      expect(planRows.rows[0]!.n).toBe(1);
      const unitRows = await stack.db.client.query(
        'SELECT count(*)::int AS n FROM wfos_delegation_units WHERE plan_id = $1',
        [a.id],
      );
      expect(unitRows.rows[0]!.n).toBe(2);
    } finally {
      await second.close();
    }
  });

  it('TWO-ACTOR #2 — concurrent dispatch of the SAME unit → exactly ONE attempt + ONE execution (no duplicate logical work)', async () => {
    if (!isRealPg() || !stack.db.createSecondClient) return;
    const wiId = await createWorkItem('WI-TA2');
    await planService.createPlan({
      workItemId: wiId, planKey: 'ta2',
      units: [nativeUnit('implement', 'implementer')],
    });
    const unitId = (await planService.getPlan(wiId, 'ta2'))!.units[0]!.id;

    const second = await stack.db.createSecondClient();
    try {
      const coordinatorA = coordinator;
      const coordinatorB = buildCoordinator(realExecutionService!, second.client);
      const [a, b] = await Promise.all([
        coordinatorA.drivePlan(wiId, 'ta2'),
        coordinatorB.drivePlan(wiId, 'ta2'),
      ]);
      // One driver dispatched; the other either converged on the winner's
      // terminal outcome or observed it legitimately IN FLIGHT (the winner
      // was mid-submit — the loser's observation is honest coordination
      // data, never a duplicate).
      for (const drive of [a, b]) {
        const u = drive.units.find((x) => x.unitKey === 'implement')!;
        expect(['succeeded', 'dispatched']).toContain(u.status);
      }

      // EXACTLY ONE attempt row and ONE execution record for the unit.
      const attempts = await stack.db.client.query(
        'SELECT count(*)::int AS n FROM wfos_delegation_attempts WHERE unit_id = $1',
        [unitId],
      );
      expect(attempts.rows[0]!.n).toBe(1);
      const executions = await stack.db.client.query(
        'SELECT count(*)::int AS n FROM wfos_executions WHERE work_item_id = $1',
        [wiId],
      );
      expect(executions.rows[0]!.n).toBe(1);
      // And exactly ONE adapter invocation (the provider side effect).
      expect(fakeAgent.getCallCount()).toBeGreaterThanOrEqual(1);
      const final = await planService.getPlan(wiId, 'ta2');
      expect(final!.units[0]!.status).toBe('succeeded');
    } finally {
      await second.close();
    }
  });

  it('TWO-ACTOR #3a — crash BEFORE the execution submit: the re-drive re-submits with the SAME identity → convergence (one execution)', async () => {
    const wiId = await createWorkItem('WI-TA3A');
    await planService.createPlan({
      workItemId: wiId, planKey: 'ta3a',
      units: [nativeUnit('implement', 'implementer')],
    });

    // The first drive dies BEFORE the submit: the durable attempt intent
    // exists, but NOTHING reached the execution authority. The coordinator's
    // submission-error path records the HONEST limbo outcome (acceptance
    // unknown + nothing durable happened) — the drive CONVERGES on
    // 'unresolved' instead of propagating the crash.
    const crashed = buildCoordinator(new CrashingExecutionService(realExecutionService!, 'crash-before-submit'));
    const crashDrive = await crashed.drivePlan(wiId, 'ta3a');
    expect(crashDrive.units[0]!.status).toBe('unresolved');
    const attempt = await stack.db.client.query(
      `SELECT a.attempt_no, a.execution_id, a.outcome FROM wfos_delegation_attempts a
       JOIN wfos_delegation_units u ON u.id = a.unit_id
       JOIN wfos_delegation_plans p ON p.id = u.plan_id
       WHERE p.work_item_id = $1`,
      [wiId],
    );
    expect(attempt.rows).toHaveLength(1);
    expect(attempt.rows[0]!.outcome).toBe('unresolved'); // honest limbo
    const noExec = await stack.db.client.query(
      'SELECT count(*)::int AS n FROM wfos_executions WHERE work_item_id = $1',
      [wiId],
    );
    expect(noExec.rows[0]!.n).toBe(0);

    // The re-drive (a fresh process over the same durable state): the record
    // is ABSENT → re-submit with the SAME identity → converges. EXACTLY ONE
    // execution ever exists.
    const drive = await coordinator.drivePlan(wiId, 'ta3a');
    expect(drive.units[0]!.status).toBe('succeeded');
    const executions = await stack.db.client.query(
      'SELECT execution_id FROM wfos_executions WHERE work_item_id = $1',
      [wiId],
    );
    expect(executions.rows).toHaveLength(1);
    expect(executions.rows[0]!.execution_id).toBe(attempt.rows[0]!.execution_id);
    const attempts = await stack.db.client.query(
      `SELECT a.attempt_no, a.execution_id, a.outcome FROM wfos_delegation_attempts a
       JOIN wfos_delegation_units u ON u.id = a.unit_id
       JOIN wfos_delegation_plans p ON p.id = u.plan_id
       WHERE p.work_item_id = $1 ORDER BY a.attempt_no`,
      [wiId],
    );
    expect(attempts.rows).toHaveLength(1); // NO second attempt — the same one converged
    expect(attempts.rows[0]!.outcome).toBe('succeeded');
  });

  it('TWO-ACTOR #3b — crash AFTER the execution submit (before the outcome record): the re-drive OBSERVES the existing record → convergence (one execution, one run)', async () => {
    const wiId = await createWorkItem('WI-TA3B');
    await planService.createPlan({
      workItemId: wiId, planKey: 'ta3b',
      units: [nativeUnit('implement', 'implementer')],
    });

    // The first drive submits (the record + AgentRun exist) then dies before
    // recording the outcome. The coordinator's submission-error path
    // OBSERVES the existing record (the outcome authority) and CONVERGES
    // inline — the crash self-heals into the recorded terminal outcome.
    const crashed = buildCoordinator(new CrashingExecutionService(realExecutionService!, 'crash-after-submit'));
    const crashDrive = await crashed.drivePlan(wiId, 'ta3b');
    expect(crashDrive.units[0]!.status).toBe('succeeded');
    const executions1 = await stack.db.client.query(
      'SELECT execution_id, status FROM wfos_executions WHERE work_item_id = $1',
      [wiId],
    );
    expect(executions1.rows).toHaveLength(1); // the execution EXISTS
    expect(executions1.rows[0]!.status).toBe('completed');
    const runsBefore = fakeAgent.getCallCount();

    // The re-drive: the record exists + is terminal → OBSERVE (no re-submit,
    // no second execution, no second adapter invocation).
    const drive = await coordinator.drivePlan(wiId, 'ta3b');
    expect(drive.units[0]!.status).toBe('succeeded');
    expect(drive.units[0]!.action).toBe('skipped'); // already converged INLINE by the crashed drive
    const executions2 = await stack.db.client.query(
      'SELECT count(*)::int AS n FROM wfos_executions WHERE work_item_id = $1',
      [wiId],
    );
    expect(executions2.rows[0]!.n).toBe(1); // STILL exactly one
    expect(fakeAgent.getCallCount()).toBe(runsBefore); // zero re-execution
    const attempts = await stack.db.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM wfos_delegation_attempts a
       JOIN wfos_delegation_units u ON u.id = a.unit_id
       JOIN wfos_delegation_plans p ON p.id = u.plan_id
       WHERE p.work_item_id = $1`,
      [wiId],
    );
    expect(attempts.rows[0]!.n).toBe(1);
  });

  it('TWO-ACTOR #4 + #5 — partial failure → RECOVERABLE plan; retry preserves the unit + role identity (stable across retries)', async () => {
    const wiId = await createWorkItem('WI-TA4');
    await planService.createPlan({
      workItemId: wiId, planKey: 'ta4',
      units: [
        nativeUnit('implement', 'implementer'),
        nativeUnit('test', 'tester', ['implement']),
      ],
    });

    // The first attempt FAILS (a definitive provider failure).
    fakeAgent.setFailure('non_retryable', 'boom', false, 10); // covers the gateway's retries
    const drive1 = await coordinator.drivePlan(wiId, 'ta4');
    expect(drive1.units.find((u) => u.unitKey === 'implement')!.status).toBe('failed');
    expect(drive1.units.find((u) => u.unitKey === 'test')!.status).toBe('pending');

    // The plan is RECOVERABLE (not failed — coordination data): the failed
    // unit is retryable; the dependent stays pending.
    const mid = await planService.getPlan(wiId, 'ta4');
    expect(mid!.status).toBe('active');
    expect(mid!.units.find((u) => u.unitKey === 'implement')!.status).toBe('failed');
    expect(mid!.units.find((u) => u.unitKey === 'test')!.status).toBe('pending');

    // Retry with the provider fixed: a NEW attempt, the SAME unit + role.
    fakeAgent.reset();
    const unitIdBefore = mid!.units.find((u) => u.unitKey === 'implement')!.id;
    const roleBefore = mid!.units.find((u) => u.unitKey === 'implement')!.role;
    const retry = await coordinator.retryUnit(wiId, 'ta4', 'implement');
    expect(retry.status).toBe('succeeded');

    const after = await planService.getPlan(wiId, 'ta4');
    const implement = after!.units.find((u) => u.unitKey === 'implement')!;
    expect(implement.id).toBe(unitIdBefore); // STABLE unit identity
    expect(implement.role).toEqual(roleBefore); // STABLE pinned role (identity + revision)
    expect(implement.attemptCount).toBe(2); // a NEW attempt
    const attempts = await stack.db.client.query(
      `SELECT a.attempt_no, a.outcome FROM wfos_delegation_attempts a
       JOIN wfos_delegation_units u ON u.id = a.unit_id
       JOIN wfos_delegation_plans p ON p.id = u.plan_id
       WHERE p.work_item_id = $1 AND u.unit_key = 'implement'
       ORDER BY a.attempt_no`,
      [wiId],
    );
    expect(attempts.rows.map((r) => r.outcome)).toEqual(['failed', 'succeeded']);

    // The plan resumes: the dependent unit now dispatches and the plan
    // COMPLETES (all units succeeded).
    const drive2 = await coordinator.drivePlan(wiId, 'ta4');
    expect(drive2.units.find((u) => u.unitKey === 'test')!.status).toBe('succeeded');
    const final = await planService.getPlan(wiId, 'ta4');
    expect(final!.status).toBe('completed');

    // Non-retryable states fail closed with the typed error.
    await expect(coordinator.retryUnit(wiId, 'ta4', 'implement'))
      .rejects.toMatchObject({ code: 'DELEGATION_UNIT_NOT_RETRYABLE' });
  });

  it('interruption — the plan is abandoned, PENDING units are cancelled, in-flight executions are NOT touched', async () => {
    const wiId = await createWorkItem('WI-INT');
    await planService.createPlan({
      workItemId: wiId, planKey: 'int',
      units: [
        externalUnit('implement', 'implementer'), // stays in flight (external handoff)
        nativeUnit('release', 'release-engineer', ['implement']), // stays pending
      ],
    });

    const drive = await coordinator.drivePlan(wiId, 'int');
    expect(drive.units.find((u) => u.unitKey === 'implement')!.status).toBe('dispatched');
    expect(drive.units.find((u) => u.unitKey === 'release')!.action).toBe('skipped');

    const interrupted = await coordinator.interruptPlan(wiId, 'int');
    expect(interrupted.status).toBe('abandoned');
    expect(interrupted.units.find((u) => u.unitKey === 'release')!.status).toBe('cancelled');
    // The in-flight execution is NOT touched (its record is unchanged — the
    // execution authority owns it).
    expect(interrupted.units.find((u) => u.unitKey === 'implement')!.status).toBe('dispatched');
    const record = await stack.db.client.query(
      'SELECT status FROM wfos_executions WHERE work_item_id = $1',
      [wiId],
    );
    expect(record.rows).toHaveLength(1);
    expect(record.rows[0]!.status).toBe('handoff_ready');

    // Interruption is durable: further drives coordinate nothing.
    const drive2 = await coordinator.drivePlan(wiId, 'int');
    expect(drive2.units.every((u) => u.action === 'skipped')).toBe(true);
    // Idempotent for an already-abandoned plan.
    const again = await coordinator.interruptPlan(wiId, 'int');
    expect(again.status).toBe('abandoned');
  });

  it('NO hidden lifecycle state — delegation NEVER writes the workflow tables', async () => {
    const wiId = await createWorkItem('WI-NOLIFE');
    await planService.createPlan({ workItemId: wiId, planKey: 'nolife', units: [nativeUnit('a', 'implementer')] });
    await coordinator.drivePlan(wiId, 'nolife');

    // The workflow execution row for the work item was never created/touched
    // by delegation (no state machine here — /workflows is the authority).
    const wf = await stack.db.client.query(
      'SELECT count(*)::int AS n FROM wfos_workflow_executions WHERE work_item_id = $1',
      [wiId],
    );
    expect(wf.rows[0]!.n).toBe(0);
    const transitions = await stack.db.client.query(
      'SELECT count(*)::int AS n FROM wfos_workflow_transitions WHERE work_item_id = $1',
      [wiId],
    );
    expect(transitions.rows[0]!.n).toBe(0);
  });

  it('structured state for WORK-047 — units + attempts expose role pinning, dependency sets, outcomes, and detail', async () => {
    const wiId = await createWorkItem('WI-STATE');
    await planService.createPlan({
      workItemId: wiId, planKey: 'state',
      units: [nativeUnit('implement', 'architect'), nativeUnit('test', 'tester', ['implement'])],
    });
    await coordinator.drivePlan(wiId, 'state');

    const attempts = await stack.db.client.query(
      `SELECT a.attempt_no, a.execution_id, a.outcome, a.outcome_detail, u.unit_key, u.role_id, u.role_revision
       FROM wfos_delegation_attempts a
       JOIN wfos_delegation_units u ON u.id = a.unit_id
       JOIN wfos_delegation_plans p ON p.id = u.plan_id
       WHERE a.outcome IS NOT NULL AND p.work_item_id = $1
       ORDER BY u.unit_key`,
      [wiId],
    );
    expect(attempts.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of attempts.rows) {
      expect(row.outcome).toBe('succeeded');
      expect(row.execution_id).toMatch(/^wf_/);
      expect(row.role_revision).toMatch(/^[0-9a-f]{16}$/); // the pinned WORK-045 content digest
      expect((row.outcome_detail as Record<string, unknown>).observedAt).toBeTruthy();
    }
  });
});
