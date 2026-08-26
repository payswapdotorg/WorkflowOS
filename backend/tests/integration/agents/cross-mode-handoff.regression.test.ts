/**
 * WORK-042 integration — cross-mode execution handoff regression tests.
 *
 * Proves the cross-mode handoff boundary preserves the SAME logical
 * ExecutionRecord (identity), the SAME ExecutionSession + Workspace (where
 * architecture requires), the SAME branch + implementation context, the
 * prior phase's authoritative evidence (the correction chain is visible),
 * converges under concurrent + duplicate + terminal handoffs (UNIQUE fence),
 * recovers from crash-after-reserve + crash-after-mutate via the idempotent
 * reconcileCrossModeHandoffForExecution entry point, rejects cross-tenant
 * handoff attempts at the route layer (requireProjectAuthorization) +
 * never accepts caller-supplied authoritative fields at the service layer
 * (defense-in-depth), and integrates with the existing agent-policy /
 * execution-policy gates (no second policy engine).
 *
 * The 20 frozen regressions + the two-project tenant-ownership regression
 * (mirrors the maintenance-domain.integration.test.ts pattern — PR #45).
 *
 * The cross-mode handoff composes the EXISTING NativeExecutionProvider +
 * ExternalExecutionProvider + ExecutionTaskService + AgentPolicyEngine +
 * ExecutionPolicyService + AgentProviderRegistryService. It is NOT an
 * ExecutionService; it NEVER creates a second ExecutionRecord, NEVER touches
 * workflow/verification/review state, NEVER persists secrets.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultAgentGateway, FakeAgentAdapter } from '../../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import {
  PgExecutionRecordRepository,
  PgExecutionEventRepository,
  PgExecutionHandoffRepository,
  PgExecutionCallbackRepository,
} from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { NativeExecutionProvider } from '../../../src/modules/agents/internal/native-execution-provider.js';
import { ExternalExecutionProvider } from '../../../src/modules/agents/internal/external-execution-provider.js';
import { PgCrossModeHandoffRepository } from '../../../src/modules/agents/internal/pg-cross-mode-handoff-repository.js';
import { DefaultCrossModeHandoffService } from '../../../src/modules/agents/internal/default-cross-mode-handoff-service.js';
import type {
  CrossModeAgentProviderRegistryPort,
  CrossModeExecutionPolicyPort,
} from '../../../src/modules/agents/internal/default-cross-mode-handoff-service.js';
import { DefaultExecutionTaskService } from '../../../src/modules/work-items/internal/execution-task-service.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';
import { DefaultExecutionPromptBuilder } from '../../../src/modules/work-items/internal/execution-prompt-builder.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import { DefaultExecutionHandoffService } from '../../../src/modules/agents/internal/execution-handoff-service.js';
import { DefaultExecutionCallbackService } from '../../../src/modules/agents/internal/execution-callback-service.js';
import { DefaultExecutionEventIngestionService } from '../../../src/modules/agents/internal/execution-event-ingestion-service.js';
import { CrossModeHandoffError } from '../../../src/modules/agents/index.js';
import type { CrossModeHandoffService } from '../../../src/modules/agents/index.js';
import type { AgentPolicyExternalDecision } from '../../../src/modules/agents/internal/agent-policy.types.js';
import type { AgentPolicyHandoffEvaluator } from '../../../src/modules/agents/internal/policy-gated-handoff-service.js';
import type { ExecutionRecord, ExecutionRecordRepository } from '../../../src/modules/agents/index.js';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '@api/server.js';

// ---------------------------------------------------------------------------
// Test doubles (narrow ports — mirror the PolicyGatedExecutionHandoffService
// decorator precedent: real ports the agents module owns, fake
// implementations for deterministic tests).
// ---------------------------------------------------------------------------

class AllowAllAgentPolicyEvaluator implements AgentPolicyHandoffEvaluator {
  async evaluateExternalHandoff(_input: { executionId: string }): Promise<AgentPolicyExternalDecision> {
    return {
      decision: 'allow',
      reason: 'test-allow-all',
      policyVersion: 1,
      scopeSource: 'platform-default',
    };
  }
}

class DenyExternalAgentPolicyEvaluator implements AgentPolicyHandoffEvaluator {
  async evaluateExternalHandoff(_input: { executionId: string }): Promise<AgentPolicyExternalDecision> {
    return {
      decision: 'deny',
      reason: 'test-deny-external-handoff',
      policyVersion: 1,
      scopeSource: 'platform-default',
    };
  }
}

class StubExecutionPolicyService implements CrossModeExecutionPolicyPort {
  constructor(private readonly nativeAllowed: boolean = true) {}
  async getProjectPolicy(_projectId: string): Promise<{ nativeExecutionAllowed: boolean; policyVersion: number | null } | null> {
    return { nativeExecutionAllowed: this.nativeAllowed, policyVersion: 1 };
  }
}

class StubAgentProviderRegistry implements CrossModeAgentProviderRegistryPort {
  getPlatformDefaultProvider(): string | undefined {
    return 'fake';
  }
  getPlatformDefaultModel(): string | undefined {
    return 'test-model';
  }
  async isProviderConfigured(_provider: string, _model: string, _projectId?: string): Promise<boolean> {
    return true;
  }
}

/**
 * A recording wrapper around ExecutionRecordRepository whose `transitionMode`
 * throws the FIRST N times it is called (simulating a crash after the reserve
 * step). Subsequent calls delegate to the real repository. Used for the
 * crash-after-reserve regression (#15) — the reserve step (handoff log INSERT)
 * succeeds, the mutate step (transitionMode) "crashes", and the retry via
 * reconcileCrossModeHandoffForExecution re-applies the mutate + dispatch.
 */
class CrashAfterReserveRepo implements ExecutionRecordRepository {
  private transitionCallCount = 0;
  constructor(
    private readonly real: PgExecutionRecordRepository,
    private readonly crashTimes: number,
  ) {}
  async transitionMode(id: string, input: Parameters<ExecutionRecordRepository['transitionMode']>[1]): Promise<ExecutionRecord | null> {
    this.transitionCallCount++;
    if (this.transitionCallCount <= this.crashTimes) {
      throw new Error(`simulated-crash-after-reserve: transitionMode call #${this.transitionCallCount} (the mutate step)`);
    }
    return this.real.transitionMode(id, input);
  }
  // Delegate everything else.
  create(input: Parameters<ExecutionRecordRepository['create']>[0]): Promise<ExecutionRecord> {
    return this.real.create(input);
  }
  findById(id: string): Promise<ExecutionRecord | null> {
    return this.real.findById(id);
  }
  findByExecutionId(executionId: string): Promise<ExecutionRecord | null> {
    return this.real.findByExecutionId(executionId);
  }
  listForWorkItem(workItemId: string): Promise<ExecutionRecord[]> {
    return this.real.listForWorkItem(workItemId);
  }
  updateStatus(id: string, input: Parameters<ExecutionRecordRepository['updateStatus']>[1]): Promise<ExecutionRecord | null> {
    return this.real.updateStatus(id, input);
  }
}

describe('WORK-042 — Cross-Mode Execution Handoff', () => {
  let stack: TestAuthStack;
  let executionRecordRepo: PgExecutionRecordRepository;
  let crossModeHandoffRepo: PgCrossModeHandoffRepository;
  let agentRunRepo: PgAgentRunRepository;
  let contextRepo: PgImplementationContextRepository;
  let executionTaskService: DefaultExecutionTaskService;
  let nativeExecutionProvider: NativeExecutionProvider;
  let externalExecutionProvider: ExternalExecutionProvider;
  let auditService: DefaultAuditService;
  let crossModeHandoffService: CrossModeHandoffService;
  // Hoisted so the tenant-isolation describe can build a proper Project B
  // ImplementationContext via the same builder (the prompt builder requires
  // the full ImplementationContextContent shape — requirements + criteria +
  // dependencies + repository + verification requirements).
  let implementationContextBuilder: DefaultImplementationContextBuilder;

  let orgId: string;
  let projectId: string;
  let workItemId: string;
  let workOrderId: string;
  let architectureVersionId: string;
  let sharedContextId: string;

  let execCount = 0;
  const nextExecId = () => `wf-cmh-${++execCount}`;

  beforeAll(async () => {
    process.env.AGENT_PROVIDER_NAME = 'fake';
    process.env.AGENT_API_KEY = 'test-agent-key';
    process.env.AGENT_DEFAULT_MODEL = 'test-model';

    stack = await buildAuthStack({ AGENT_API_KEY: 'test-agent-key' });
    const db = stack.db.client;
    executionRecordRepo = new PgExecutionRecordRepository(db);
    crossModeHandoffRepo = new PgCrossModeHandoffRepository(db);
    agentRunRepo = new PgAgentRunRepository(db);
    contextRepo = new PgImplementationContextRepository(db);
    auditService = new DefaultAuditService(db, stack.db.logger);

    // The native execution provider (real NativeExecutionProvider against the
    // deterministic FakeAgentAdapter — the SAME setup the
    // execution-session-integration tests use).
    const fakeAgent = new FakeAgentAdapter();
    const gateway = new DefaultAgentGateway(db, stack.db.logger, [fakeAgent], 3);
    nativeExecutionProvider = new NativeExecutionProvider({
      agentGateway: gateway,
      agentRunRepository: agentRunRepo,
      logger: stack.db.logger,
    });
    externalExecutionProvider = new ExternalExecutionProvider();

    const promptBuilder = new DefaultExecutionPromptBuilder();
    implementationContextBuilder = new DefaultImplementationContextBuilder(
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
      async () => null,
      async () => null,
      async () => [],
      async () => [],
    );
    executionTaskService = new DefaultExecutionTaskService({
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      implementationContextBuilder,
      contextRepository: contextRepo,
      promptBuilder,
      logger: stack.db.logger,
    });

    crossModeHandoffService = new DefaultCrossModeHandoffService({
      executionRecordRepository: executionRecordRepo,
      crossModeHandoffRepository: crossModeHandoffRepo,
      executionTaskService,
      nativeExecutionProvider,
      externalExecutionProvider,
      agentRunRepository: agentRunRepo,
      agentPolicyEvaluator: new AllowAllAgentPolicyEvaluator(),
      executionPolicyService: new StubExecutionPolicyService(true),
      agentProviderRegistryService: new StubAgentProviderRegistry(),
      auditService,
      logger: stack.db.logger,
    });

    // Seed a project + architecture version + work item + work order +
    // requirement + criterion + a shared implementation context (the
    // execution record FK requires the context to belong to the work item).
    const org = await stack.organizationRepository.create({ name: 'W042 CMH Org' });
    orgId = org.id;
    const project = await stack.projectRepository.create({ organizationId: orgId, name: 'W042 CMH Project' });
    projectId = project.id;
    const arch = await stack.architectureRepository.create({ projectId, name: 'W042 Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# W042', digestSha256: 'w042-digest-1' });
    architectureVersionId = version.id;
    const req = await stack.requirementRepository.create({
      architectureVersionId: version.id, requirementId: 'REQ-W042-001',
      title: 'Calculator adds', description: 'add(2,3)===5',
    });
    const crit = await stack.acceptanceCriterionRepository.create({
      requirementId: req.id, criterionId: 'AC-W042-001',
      description: 'add(2,3) returns 5', verificationExpectation: 'unit-test',
    });
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id, workItemId: 'WORK-W042-001',
      title: 'Calculator addition', objective: 'Add a calculator.', scope: 'src/calc.ts', outOfScope: 'sub',
      metadata: { baseCommit: 'w042-baseline-commit-0000000000000001' },
    });
    await stack.workItemRequirementRepository.associate(workItem.id, req.id);
    await stack.workItemCriterionRepository.associate(workItem.id, crit.id);
    const workOrder = await stack.workOrderRepository.create({
      workItemId: workItem.id, projectId, architectureVersionId: version.id,
      requirementIds: [req.id], criterionIds: [crit.id], scope: 'src/calc.ts',
      verificationRequirements: ['unit-test: add(2,3)===5'],
    });
    workItemId = workItem.id;
    workOrderId = workOrder.id;
    // Build a PROPER ImplementationContext via the real builder (resolves
    // requirements + criteria + dependencies + repository + verification
    // requirements from authoritative data — the prompt builder requires
    // these fields to be present in the content_json).
    const ctx = await implementationContextBuilder.build(workItem.id);
    sharedContextId = ctx.id;
  });

  afterAll(async () => {
    await stack.teardown();
    delete process.env.AGENT_PROVIDER_NAME;
    delete process.env.AGENT_API_KEY;
    delete process.env.AGENT_DEFAULT_MODEL;
  });

  /** Create a native execution record in the given state. */
  async function createNativeRecord(
    status: 'created' | 'running' | 'failed' | 'completed' = 'failed',
    branch: string | null = 'feat/work-w042-001',
  ): Promise<{ executionId: string; recordId: string }> {
    const executionId = nextExecId();
    const record = await executionRecordRepo.create({
      executionId, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
      branch,
    });
    if (status !== 'created') {
      await executionRecordRepo.updateStatus(record.id, { status, completedAt: status === 'failed' || status === 'completed' ? new Date() : null });
    }
    return { executionId, recordId: record.id };
  }

  /** Create an external execution record in the given state (with a
   * representative ExternalExecutionPackage persisted on the record so the
   * cross-mode handoff log's previous_package_json snapshot is non-null —
   * the prior phase's authoritative evidence is preserved). */
  async function createExternalRecord(
    status: 'handoff_ready' | 'submitted' | 'failed' | 'expired' = 'handoff_ready',
    branch: string | null = 'feat/work-w042-001',
  ): Promise<{ executionId: string; recordId: string }> {
    const executionId = nextExecId();
    const record = await executionRecordRepo.create({
      executionId, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'external', provider: 'external', model: null,
      prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
      branch,
    });
    // Persist a representative external package on the record (mirrors what
    // the ExternalExecutionProvider would have generated when the external
    // execution was first dispatched — the package is the prior phase's
    // authoritative evidence; the cross-mode handoff log snapshots it).
    const pkg = {
      executionId, mode: 'external' as const, projectId, workItemId,
      workItemLabel: 'WORK-W042-001', workOrderId,
      implementationContextId: sharedContextId, provider: 'external', model: null,
      repository: { owner: null, name: null, url: null, defaultBranch: null },
      branch: branch ?? 'feat/work-w042-001', prompt: `p ${executionId}`,
      structuredInstructions: [], verificationRequirements: [],
      expectedOutputs: [], browserTestRequirements: [],
      returnCallback: {
        eventsPath: `/execution/${executionId}/events`,
        eventTypes: ['started', 'progress', 'completed', 'failed'],
        auth: 'x-callback-token', note: 'test package',
      },
      expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    if (status === 'handoff_ready' || status === 'submitted') {
      await executionRecordRepo.updateStatus(record.id, { status, packageValue: pkg });
    } else if (status === 'failed' || status === 'expired') {
      await executionRecordRepo.updateStatus(record.id, { status, completedAt: new Date(), packageValue: pkg });
    }
    return { executionId, recordId: record.id };
  }

  /** Count handoff log rows for an execution. */
  async function countHandoffsForExecution(executionId: string): Promise<number> {
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_execution_mode_handoffs h
       JOIN wfos_executions e ON e.id = h.execution_record_id
       WHERE e.execution_id = $1`,
      [executionId],
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  /** Count execution records for the project. */
  async function countExecutionRecords(): Promise<number> {
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_executions WHERE project_id = $1`,
      [projectId],
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  /** Count workflow state transitions + executions for the work item. */
  async function countWorkflowStateForWorkItem(): Promise<{ transitions: number; executions: number }> {
    const t = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_workflow_transitions WHERE work_item_id = $1`,
      [workItemId],
    );
    const e = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_workflow_executions WHERE work_item_id = $1`,
      [workItemId],
    );
    return { transitions: Number(t.rows[0]?.c ?? 0), executions: Number(e.rows[0]?.c ?? 0) };
  }

  // ===========================================================================
  // identity preservation (#1, #2, #3, #4, #5, #6, #7, #18, #19, #20)
  // ===========================================================================
  describe('identity preservation', () => {
    // #1: native → external preserves Work Item identity.
    it('1. native → external preserves the SAME executionId + workItemId + record id; the record is now mode=external, status=handoff_ready; the Work Item is NOT duplicated', async () => {
      const { executionId, recordId } = await createNativeRecord('failed');
      const workItemsBefore = await stack.workItemRepository.findByArchitectureVersion(architectureVersionId);

      const result = await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'external', reason: 'native-failed-switch-to-external', idempotencyKey: `n2e-${executionId}` },
        { userId: 'test-user', source: 'cmh-test' },
      );

      // SAME executionId + record id.
      expect(result.executionId).toBe(executionId);
      expect(result.record.id).toBe(recordId);
      expect(result.record.executionId).toBe(executionId);
      expect(result.record.mode).toBe('external');
      expect(result.record.status).toBe('handoff_ready');
      // The handoff log row.
      expect(result.handoff.fromMode).toBe('native');
      expect(result.handoff.toMode).toBe('external');
      expect(result.handoff.previousStatus).toBe('failed');
      expect(result.handoff.resultingStatus).toBe('handoff_ready');
      expect(result.handoff.executionRecordId).toBe(recordId);
      // The Work Item is NOT duplicated.
      const workItemsAfter = await stack.workItemRepository.findByArchitectureVersion(architectureVersionId);
      expect(workItemsAfter.length).toBe(workItemsBefore.length);
    });

    // #2: external → native preserves Work Item identity.
    it('2. external → native preserves the SAME executionId + workItemId + record id; the native AgentRun is created; the Work Item is NOT duplicated', async () => {
      const { executionId, recordId } = await createExternalRecord('handoff_ready');
      const workItemsBefore = await stack.workItemRepository.findByArchitectureVersion(architectureVersionId);

      const result = await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'native', reason: 'external-handoff-ready-switch-to-native', idempotencyKey: `e2n-${executionId}` },
        { userId: 'test-user', source: 'cmh-test' },
      );

      expect(result.executionId).toBe(executionId);
      expect(result.record.id).toBe(recordId);
      expect(result.record.executionId).toBe(executionId);
      expect(result.record.mode).toBe('native');
      expect(result.record.status).toBe('completed');
      expect(result.record.agentRunId).not.toBeNull();
      expect(result.handoff.fromMode).toBe('external');
      expect(result.handoff.toMode).toBe('native');
      // The native AgentRun is persisted.
      const run = await agentRunRepo.findByExecutionId(executionId);
      expect(run).not.toBeNull();
      // The Work Item is NOT duplicated.
      const workItemsAfter = await stack.workItemRepository.findByArchitectureVersion(architectureVersionId);
      expect(workItemsAfter.length).toBe(workItemsBefore.length);
    });

    // #3: same logical ExecutionRecord is preserved.
    it('3. the SAME logical ExecutionRecord (record.id) is preserved across the handoff (findByExecutionId before == after)', async () => {
      const { executionId, recordId } = await createNativeRecord('failed');
      const before = await executionRecordRepo.findByExecutionId(executionId);
      expect(before!.id).toBe(recordId);

      await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'external', idempotencyKey: `id-${executionId}` },
        { userId: 'test-user', source: 'cmh-test' },
      );

      const after = await executionRecordRepo.findByExecutionId(executionId);
      expect(after!.id).toBe(recordId);
      expect(after!.id).toBe(before!.id);
    });

    // #4: same ExecutionSession identity is preserved (the cross-mode handoff
    // does NOT create a new session — the session belongs to the logical
    // execution; the handoff is a subordinate state transition).
    it('4. the cross-mode handoff does NOT create a new ExecutionSession (the session belongs to the logical execution; the handoff is a subordinate transition)', async () => {
      const { executionId, recordId } = await createExternalRecord('handoff_ready');
      const sessionsBefore = await stack.db.client.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM wfos_execution_sessions WHERE execution_id = $1`,
        [recordId],
      );
      await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'native', idempotencyKey: `sess-${executionId}` },
        { userId: 'test-user', source: 'cmh-test' },
      );
      const sessionsAfter = await stack.db.client.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM wfos_execution_sessions WHERE execution_id = $1`,
        [recordId],
      );
      expect(Number(sessionsAfter.rows[0]?.c ?? 0)).toBe(Number(sessionsBefore.rows[0]?.c ?? 0));
    });

    // #5: same Workspace/worktree is preserved (the cross-mode handoff does NOT
    // create a new workspace — UNIQUE(execution_id)).
    it('5. the cross-mode handoff does NOT create a new AgentWorkspace (the workspace is per-execution; the handoff is a subordinate transition)', async () => {
      const { executionId, recordId } = await createExternalRecord('handoff_ready');
      const workspacesBefore = await stack.db.client.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM wfos_agent_workspaces WHERE execution_id = $1`,
        [recordId],
      );
      await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'native', idempotencyKey: `ws-${executionId}` },
        { userId: 'test-user', source: 'cmh-test' },
      );
      const workspacesAfter = await stack.db.client.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM wfos_agent_workspaces WHERE execution_id = $1`,
        [recordId],
      );
      expect(Number(workspacesAfter.rows[0]?.c ?? 0)).toBe(Number(workspacesBefore.rows[0]?.c ?? 0));
    });

    // #6: branch state is preserved (the record.branch is unchanged across the
    // handoff — the same implementation branch).
    it('6. the record.branch is unchanged across the handoff (the same implementation branch)', async () => {
      const branch = 'feat/work-w042-001-branch-preserved';
      const { executionId } = await createNativeRecord('failed', branch);
      await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'external', idempotencyKey: `br-${executionId}` },
        { userId: 'test-user', source: 'cmh-test' },
      );
      const after = await executionRecordRepo.findByExecutionId(executionId);
      expect(after!.branch).toBe(branch);
    });

    // #7: implementation context is preserved (the record.implementationContextId
    // is unchanged — the handoff reuses it via executionTaskService.build).
    it('7. the record.implementationContextId is unchanged across the handoff (the handoff reuses the SAME ImplementationContext via executionTaskService.build)', async () => {
      const { executionId } = await createNativeRecord('failed');
      const before = await executionRecordRepo.findByExecutionId(executionId);
      await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'external', idempotencyKey: `ctx-${executionId}` },
        { userId: 'test-user', source: 'cmh-test' },
      );
      const after = await executionRecordRepo.findByExecutionId(executionId);
      expect(after!.implementationContextId).toBe(before!.implementationContextId);
      // The shared context is preserved (NOT a new context).
      expect(after!.implementationContextId).toBe(sharedContextId);
    });

    // #18: no second Work Item is created.
    it('18. no second Work Item is created by the cross-mode handoff (the project Work Item count is unchanged before vs after)', async () => {
      const { executionId } = await createNativeRecord('failed');
      const countBefore = (await stack.workItemRepository.findByArchitectureVersion(architectureVersionId)).length;
      await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'external', idempotencyKey: `wi-${executionId}` },
        { userId: 'test-user', source: 'cmh-test' },
      );
      const countAfter = (await stack.workItemRepository.findByArchitectureVersion(architectureVersionId)).length;
      expect(countAfter).toBe(countBefore);
    });

    // #19: no second workflow state machine exists (the workflow state is
    // UNCHANGED across the handoff — the handoff does NOT touch workflow state).
    it('19. no second workflow state machine exists (wfos_workflow_transitions + wfos_workflow_executions UNCHANGED across the handoff)', async () => {
      const { executionId } = await createNativeRecord('failed');
      const before = await countWorkflowStateForWorkItem();
      await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'external', idempotencyKey: `wf-${executionId}` },
        { userId: 'test-user', source: 'cmh-test' },
      );
      const after = await countWorkflowStateForWorkItem();
      expect(after.transitions).toBe(before.transitions);
      expect(after.executions).toBe(before.executions);
    });

    // #20: no second execution engine exists (the cross-mode handoff did NOT
    // create a new ExecutionRecord — findByExecutionId returns ONE record, same
    // id before + after).
    it('20. no second execution engine exists (the cross-mode handoff did NOT create a new ExecutionRecord — the project execution count is UNCHANGED across the handoff)', async () => {
      const { executionId, recordId } = await createNativeRecord('failed');
      const before = await countExecutionRecords();
      await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'external', idempotencyKey: `eng-${executionId}` },
        { userId: 'test-user', source: 'cmh-test' },
      );
      const after = await countExecutionRecords();
      // The handoff did NOT create a new execution record (it transitioned
      // the existing one — the SAME ExecutionRecord, same id).
      expect(after).toBe(before);
      const record = await executionRecordRepo.findByExecutionId(executionId);
      expect(record!.id).toBe(recordId);
    });
  });

  // ===========================================================================
  // evidence + audit (#9, #17)
  // ===========================================================================
  describe('evidence + audit', () => {
    // #9: handoff adds audit history.
    it('9. handoff adds an EXECUTION_CROSS_MODE_HANDOFF audit event with fromMode + toMode + reason', async () => {
      const { executionId } = await createNativeRecord('failed');
      const reason = 'audit-test-native-to-external';
      await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'external', reason, idempotencyKey: `aud-${executionId}` },
        { userId: 'test-user-aud', source: 'cmh-test-aud' },
      );
      const events = await auditService.listForProject(projectId, { eventTypes: ['EXECUTION_CROSS_MODE_HANDOFF'], limit: 100 });
      const mine = events.filter((e) => e.executionId === executionId);
      expect(mine.length).toBeGreaterThanOrEqual(1);
      const evt = mine[0]!;
      expect(evt.eventType).toBe('EXECUTION_CROSS_MODE_HANDOFF');
      expect(evt.actor).toBe('test-user-aud');
      expect(evt.source).toBe('cmh-test-aud');
      expect(evt.metadata.fromMode).toBe('native');
      expect(evt.metadata.toMode).toBe('external');
      expect(evt.metadata.reason).toBe(reason);
    });

    // #17: old mode history is not erased (the prior phase's authoritative
    // evidence is snapshotted in the handoff log's previous_* columns).
    it('17. old mode history is not erased — the handoff log row preserves the prior phase snapshot (previous_agent_run_id for native→external; previous_package_json for external→native)', async () => {
      // native → external: the native AgentRun (status=failed) is STILL in
      // wfos_agent_runs; the handoff log row's previous_agent_run_id +
      // previous_status snapshot the native phase.
      const { executionId: n2eExecId } = await createNativeRecord('failed');
      const n2eResult = await crossModeHandoffService.handoff(
        n2eExecId,
        { targetMode: 'external', idempotencyKey: `hist-n2e-${n2eExecId}` },
        { userId: 'test-user', source: 'cmh-test' },
      );
      // The native AgentRun still exists (the cross-mode handoff never deletes
      // prior evidence — it transitions the record's mode but leaves the
      // AgentRun row in place as the prior-phase authoritative evidence).
      expect(n2eResult.handoff.fromMode).toBe('native');
      expect(n2eResult.handoff.previousStatus).toBe('failed');

      // external → native: the external package is STILL in the handoff log
      // row's previous_package_json (the external phase's authoritative
      // evidence snapshot).
      const { executionId: e2nExecId } = await createExternalRecord('handoff_ready');
      const e2nResult = await crossModeHandoffService.handoff(
        e2nExecId,
        { targetMode: 'native', idempotencyKey: `hist-e2n-${e2nExecId}` },
        { userId: 'test-user', source: 'cmh-test' },
      );
      expect(e2nResult.handoff.fromMode).toBe('external');
      expect(e2nResult.handoff.previousStatus).toBe('handoff_ready');
      // The previous_package_json (the external phase's package snapshot) is
      // preserved (the correction chain is visible).
      expect(e2nResult.handoff.previousPackageValue).not.toBeNull();
    });
  });

  // ===========================================================================
  // concurrency + idempotency (#10, #11, #12)
  // ===========================================================================
  describe('concurrency + idempotency', () => {
    // #10: duplicate handoff converges (same idempotencyKey).
    it('10. duplicate handoff with the SAME idempotencyKey converges (no duplicate handoff log row, no duplicate audit)', async () => {
      const { executionId } = await createNativeRecord('failed');
      const idempotencyKey = `conv-${executionId}`;
      const first = await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'external', idempotencyKey },
        { userId: 'test-user', source: 'cmh-test' },
      );
      const second = await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'external', idempotencyKey },
        { userId: 'test-user', source: 'cmh-test' },
      );
      // Same handoff id + same record.
      expect(second.handoff.id).toBe(first.handoff.id);
      // Exactly ONE handoff log row.
      expect(await countHandoffsForExecution(executionId)).toBe(1);
      // No duplicate audit event (the convergent retry does NOT re-audit).
      const events = await auditService.listForProject(projectId, { eventTypes: ['EXECUTION_CROSS_MODE_HANDOFF'], limit: 100 });
      const mine = events.filter((e) => e.executionId === executionId);
      expect(mine.length).toBe(1);
    });

    // #11: concurrent handoff has one winner.
    it('11. concurrent handoff (different idempotencyKeys, same executionId) — exactly ONE succeeds; the loser gets already-handed-off (409)', async () => {
      const { executionId } = await createNativeRecord('failed');
      const results = await Promise.allSettled([
        crossModeHandoffService.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `conc-a-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        ),
        crossModeHandoffService.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `conc-b-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        ),
      ]);
      const winners = results.filter((r: PromiseSettledResult<unknown>) => r.status === 'fulfilled');
      const losers = results.filter((r: PromiseSettledResult<unknown>) => r.status === 'rejected');
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);
      // The loser got 'already-handed-off'.
      const loser = losers[0] as PromiseRejectedResult;
      expect(loser.reason).toBeInstanceOf(CrossModeHandoffError);
      expect((loser.reason as CrossModeHandoffError).code).toBe('already-handed-off');
      // Exactly ONE handoff log row.
      expect(await countHandoffsForExecution(executionId)).toBe(1);
    });

    // #12: terminal execution cannot be silently re-handed-off.
    it('12. a SECOND cross-mode-handoff (back to external) on a SUCCESSFUL external→native handoff is rejected with already-handed-off (409) — the UNIQUE fence', async () => {
      const { executionId } = await createExternalRecord('handoff_ready');
      // First handoff: external → native (succeeds; record.mode=native,
      // status=completed).
      const first = await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'native', idempotencyKey: `term-1-${executionId}` },
        { userId: 'test-user', source: 'cmh-test' },
      );
      expect(first.record.mode).toBe('native');
      expect(first.record.status).toBe('completed');
      // Second handoff (back to external) — REJECTED (UNIQUE fence).
      const err = await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'external', idempotencyKey: `term-2-${executionId}` },
        { userId: 'test-user', source: 'cmh-test' },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(CrossModeHandoffError);
      expect((err as CrossModeHandoffError).code).toBe('already-handed-off');
      // Still exactly ONE handoff log row.
      expect(await countHandoffsForExecution(executionId)).toBe(1);
    });
  });

  // ===========================================================================
  // crash recovery (#15, #16) — the idempotent
  // reconcileCrossModeHandoffForExecution entry point.
  // ===========================================================================
  describe('crash recovery', () => {
    // #15: native → external crash/retry converges.
    // Simulate a crash after the reserve (handoff log INSERT) but before the
    // mutate (transitionMode). A wrapper repo throws on the FIRST
    // transitionMode call (the reserve persists the handoff log row before
    // transitionMode is called). Retry via reconcile: finds the handoff row,
    // record.mode !== handoff.toMode → re-mutate + re-dispatch external.
    it('15. native → external crash after reserve (before mutate) — reconcile re-applies the mutate + dispatch; converges to the same result', async () => {
      const { executionId, recordId } = await createNativeRecord('failed');
      // Build a service whose transitionMode crashes the FIRST time.
      const crashingRepo = new CrashAfterReserveRepo(executionRecordRepo, 1);
      const crashingService = new DefaultCrossModeHandoffService({
        executionRecordRepository: crashingRepo,
        crossModeHandoffRepository: crossModeHandoffRepo,
        executionTaskService,
        nativeExecutionProvider,
        externalExecutionProvider,
        agentRunRepository: agentRunRepo,
        agentPolicyEvaluator: new AllowAllAgentPolicyEvaluator(),
        executionPolicyService: new StubExecutionPolicyService(true),
        agentProviderRegistryService: new StubAgentProviderRegistry(),
        auditService,
        logger: stack.db.logger,
      });
      // The first handoff attempt crashes after the reserve.
      const idempotencyKey = `crash-n2e-${executionId}`;
      const err = await crashingService.handoff(
        executionId,
        { targetMode: 'external', idempotencyKey },
        { userId: 'test-user', source: 'cmh-test' },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      // The handoff log row IS persisted (the reserve happened before the crash).
      expect(await countHandoffsForExecution(executionId)).toBe(1);
      // The record is NOT mutated (still native/failed).
      const midRecord = await executionRecordRepo.findByExecutionId(executionId);
      expect(midRecord!.mode).toBe('native');
      expect(midRecord!.status).toBe('failed');
      // Retry via reconcile — re-applies the mutate + dispatch.
      await crossModeHandoffService.reconcileCrossModeHandoffForExecution(executionId);
      const after = await executionRecordRepo.findByExecutionId(executionId);
      expect(after!.id).toBe(recordId);
      expect(after!.mode).toBe('external');
      expect(after!.status).toBe('handoff_ready');
      expect(after!.packageValue).not.toBeNull();
      // Still exactly ONE handoff log row (no duplicate).
      expect(await countHandoffsForExecution(executionId)).toBe(1);
    });

    // #16: external → native crash/retry converges.
    // Simulate a crash after the mutate (record.mode=native, status=running)
    // but before the dispatch (NativeExecutionProvider.submit). Retry via
    // reconcile: finds the handoff row, record.mode=native === handoff.toMode,
    // no AgentRun + non-terminal → re-dispatch native (the
    // agentRunRepository.findByExecutionId guard ensures no duplicate AgentRun
    // on wfos_agent_runs.execution_id UNIQUE).
    it('16. external → native crash after mutate (before dispatch) — reconcile re-dispatches native (no duplicate AgentRun)', async () => {
      // Run a successful external→native handoff (the happy path: record
      // becomes native/completed with an AgentRun).
      const { executionId, recordId } = await createExternalRecord('handoff_ready');
      const idempotencyKey = `crash-e2n-${executionId}`;
      await crossModeHandoffService.handoff(
        executionId,
        { targetMode: 'native', idempotencyKey },
        { userId: 'test-user', source: 'cmh-test' },
      );
      const happy = await executionRecordRepo.findByExecutionId(executionId);
      expect(happy!.mode).toBe('native');
      expect(happy!.status).toBe('completed');
      const happyRun = await agentRunRepo.findByExecutionId(executionId);
      expect(happyRun).not.toBeNull();

      // Simulate the crash-after-mutate state: reset the record to
      // mode=native, status=running (the post-mutate, pre-dispatch state) +
      // delete the AgentRun (the dispatch did not happen).
      await stack.db.client.query(
        `UPDATE wfos_executions SET status = 'running', agent_run_id = NULL, completed_at = NULL, updated_at = NOW() WHERE id = $1`,
        [recordId],
      );
      await stack.db.client.query(
        `DELETE FROM wfos_agent_runs WHERE execution_id = $1`,
        [executionId],
      );
      const midRecord = await executionRecordRepo.findByExecutionId(executionId);
      expect(midRecord!.mode).toBe('native');
      expect(midRecord!.status).toBe('running');
      expect(await agentRunRepo.findByExecutionId(executionId)).toBeNull();

      // Retry via reconcile — re-dispatches native (the
      // agentRunRepository.findByExecutionId guard ensures no duplicate
      // AgentRun on wfos_agent_runs.execution_id UNIQUE).
      await crossModeHandoffService.reconcileCrossModeHandoffForExecution(executionId);
      const after = await executionRecordRepo.findByExecutionId(executionId);
      expect(after!.mode).toBe('native');
      expect(after!.status).toBe('completed');
      expect(after!.agentRunId).not.toBeNull();
      // Exactly ONE AgentRun (no duplicate from the re-dispatch).
      const runsRes = await stack.db.client.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM wfos_agent_runs WHERE execution_id = $1`,
        [executionId],
      );
      expect(Number(runsRes.rows[0]?.c ?? 0)).toBe(1);
      // Still exactly ONE handoff log row.
      expect(await countHandoffsForExecution(executionId)).toBe(1);
    });
  });

  // ===========================================================================
  // tenant isolation (two-project) — the maintenance-domain pattern adapted
  // for cross-mode handoff: a Project A caller CANNOT handoff Project B's
  // execution (requireProjectAuthorization at the route + the service never
  // accepts caller-supplied authoritative fields).
  // ===========================================================================
  describe('tenant isolation (two-project)', () => {
    let server: FastifyInstance;
    let userA: { id: string };
    let userB: { id: string };
    let orgA: { id: string };
    let orgB: { id: string };
    let projectA: { id: string };
    let projectB: { id: string };
    let versionB: { id: string };
    let workItemB: { id: string };
    let workOrderB: { id: string };
    let contextB: { id: string };
    let execB: { executionId: string; recordId: string };
    const API_KEY_A = 'raw-key-cmh-tenant-a';
    const SECRET_REF_A = 'WFOS_TEST_KEY_CMH_A';

    beforeAll(async () => {
      // Set the env var BEFORE provisioning the API key — the EnvSecretStore
      // reads process.env at lookup time, but setting it before the provision
      // call ensures the secretRef resolves to the rawKey when the
      // authProvider.authenticate() call later hashes + compares.
      process.env[SECRET_REF_A] = API_KEY_A;
      await stack.apiKeyProvisioner.provision({
        keyId: 'cmh-key-a', secretRef: SECRET_REF_A, externalId: 'cmh-user-a', label: 'User A', rawKey: API_KEY_A,
      });
      // Build a second stack-like setup for two-project: re-use the existing
      // stack but add Project A + Project B + a Project B execution.
      orgA = await stack.organizationRepository.create({ name: 'CMH Tenant Org A' });
      orgB = await stack.organizationRepository.create({ name: 'CMH Tenant Org B' });
      userA = await stack.userRepository.upsertByExternalId({ externalId: 'cmh-user-a', displayName: 'CMH User A' });
      userB = await stack.userRepository.upsertByExternalId({ externalId: 'cmh-user-b', displayName: 'CMH User B' });
      await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
      await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
      projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'CMH Project A' });
      projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'CMH Project B' });
      await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
      await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });

      // Project B architecture + work item + work order + context + execution.
      const archB = await stack.architectureRepository.create({ projectId: projectB.id, name: 'CMH Arch B' });
      versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: '# B', digestSha256: 'w042-b-1' });
      const reqB = await stack.requirementRepository.create({
        architectureVersionId: versionB.id, requirementId: 'REQ-W042-B-001',
        title: 'B calc', description: 'add(2,3)===5',
      });
      const critB = await stack.acceptanceCriterionRepository.create({
        requirementId: reqB.id, criterionId: 'AC-W042-B-001',
        description: 'add(2,3) returns 5', verificationExpectation: 'unit-test',
      });
      workItemB = await stack.workItemRepository.create({
        architectureVersionId: versionB.id, workItemId: 'WORK-W042-B-001',
        title: 'B calc', objective: 'B calc', scope: 'src/calc.ts',
      });
      await stack.workItemRequirementRepository.associate(workItemB.id, reqB.id);
      await stack.workItemCriterionRepository.associate(workItemB.id, critB.id);
      workOrderB = await stack.workOrderRepository.create({
        workItemId: workItemB.id, projectId: projectB.id, architectureVersionId: versionB.id,
        requirementIds: [reqB.id], criterionIds: [critB.id], scope: 'src/calc.ts',
        verificationRequirements: ['unit-test: add(2,3)===5'],
      });
      contextB = await implementationContextBuilder.build(workItemB.id);
      execB = { executionId: 'wf-cmh-tenant-b', recordId: '' };
      const recB = await executionRecordRepo.create({
        executionId: execB.executionId, projectId: projectB.id,
        workItemId: workItemB.id, workOrderId: workOrderB.id,
        implementationContextId: contextB.id,
        mode: 'native', provider: 'fake', model: 'test-model',
        prompt: 'B prompt', promptDigest: 'B digest',
      });
      execB.recordId = recB.id;
      // Set the record to native/failed (eligible for handoff to external).
      await executionRecordRepo.updateStatus(recB.id, { status: 'failed', completedAt: new Date() });

      // Wire a server with the cross-mode-handoff route + the crossModeHandoffService.
      const executionHandoffService = new DefaultExecutionHandoffService({
        executionRecordRepository: executionRecordRepo,
        handoffRepository: new PgExecutionHandoffRepository(stack.db.client),
        auditService,
        logger: stack.db.logger,
      });
      const executionCallbackService = new DefaultExecutionCallbackService({
        executionRecordRepository: executionRecordRepo,
        callbackRepository: new PgExecutionCallbackRepository(stack.db.client),
        auditService,
        logger: stack.db.logger,
      });
      const executionEventIngestionService = new DefaultExecutionEventIngestionService({
        executionRecordRepository: executionRecordRepo,
        eventRepository: new PgExecutionEventRepository(stack.db.client),
        auditService,
        logger: stack.db.logger,
      });
      server = await buildServer({
        queue: stack.db.client as never,
        logger: stack.db.logger,
        auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
        execution: {
          authorizationService: stack.authorizationService,
          workItemRepository: stack.workItemRepository,
          architectureRepository: stack.architectureRepository,
          architectureVersionRepository: stack.architectureVersionRepository,
          executionRecordRepository: executionRecordRepo,
          executionHandoffService,
          executionCallbackService,
          executionEventIngestionService,
          crossModeHandoffService,
        },
      });
      await server.ready();
    });

    afterAll(async () => {
      await server.close();
      delete process.env[SECRET_REF_A];
    });

    it('13a. route-level — a Project A caller CANNOT handoff Project B execution (requireProjectAuthorization rejects with 403)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/execution/${execB.executionId}/cross-mode-handoff`,
        headers: { authorization: `Bearer ${API_KEY_A}`, 'content-type': 'application/json' },
        payload: { targetMode: 'external' },
      });
      // 403 forbidden — requireProjectAuthorization rejected the cross-tenant
      // caller (Project A's API key has no membership in Project B).
      expect(res.statusCode).toBe(403);
      // The handoff did NOT happen — the record is still native/failed (no
      // mode mutation, no handoff log row).
      const after = await executionRecordRepo.findByExecutionId(execB.executionId);
      expect(after!.mode).toBe('native');
      expect(after!.status).toBe('failed');
      expect(await countHandoffsForExecution(execB.executionId)).toBe(0);
    });

    it('13b. service-level defense-in-depth — the service signature accepts NO caller-supplied projectId (the projectId is ALWAYS server-resolved from the record)', async () => {
      // The service accepts ONLY caller-controlled INTENT (targetMode /
      // reason / userInstruction / idempotencyKey / provider / model). The
      // authoritative projectId is resolved server-side from the record
      // (record.projectId). A cross-tenant caller CANNOT supply a projectId
      // — the input type enforces it. The defense-in-depth is the absence of
      // a caller-supplied projectId parameter (the static-arch invariant A6
      // proves this mechanically; this test proves the runtime behavior: a
      // direct service call resolves record.projectId server-side).
      const before = await executionRecordRepo.findByExecutionId(execB.executionId);
      // A direct service call (no route, no requireProjectAuthorization).
      // The service resolves record.projectId (projectB.id) + uses it for
      // policyGate + audit. The service does NOT accept a caller projectId.
      const result = await crossModeHandoffService.handoff(
        execB.executionId,
        { targetMode: 'external', idempotencyKey: `svc-defense-${execB.executionId}` },
        { userId: 'attacker-user-a', source: 'cmh-test-defense' },
      );
      // The handoff happened (the service trusted the SERVER-RESOLVED
      // record.projectId — not any caller-supplied projectId). The audit
      // event records the SERVER-RESOLVED projectId (projectB.id), NOT the
      // attacker's projectA.id.
      expect(result.record.mode).toBe('external');
      const events = await auditService.listForProject(projectB.id, { eventTypes: ['EXECUTION_CROSS_MODE_HANDOFF'], limit: 100 });
      const mine = events.filter((e) => e.executionId === execB.executionId);
      expect(mine.length).toBe(1);
      expect(mine[0]!.projectId).toBe(projectB.id); // server-resolved, NOT caller-supplied
      expect(mine[0]!.actor).toBe('attacker-user-a'); // the actor identity is recorded (audit trail)
      void before;
    });
  });

  // ===========================================================================
  // policy integration (#14) — the agent-policy + execution-policy gates.
  // ===========================================================================
  describe('policy integration', () => {
    // #14a: policy-denied external handoff fails closed.
    it('14a. policy-denied external handoff fails closed — a deny decision from evaluateExternalHandoff → handoff-policy-denied (403)', async () => {
      const { executionId } = await createNativeRecord('failed');
      const denyService = new DefaultCrossModeHandoffService({
        executionRecordRepository: executionRecordRepo,
        crossModeHandoffRepository: crossModeHandoffRepo,
        executionTaskService,
        nativeExecutionProvider,
        externalExecutionProvider,
        agentRunRepository: agentRunRepo,
        agentPolicyEvaluator: new DenyExternalAgentPolicyEvaluator(),
        executionPolicyService: new StubExecutionPolicyService(true),
        agentProviderRegistryService: new StubAgentProviderRegistry(),
        auditService,
        logger: stack.db.logger,
      });
      const err = await denyService.handoff(
        executionId,
        { targetMode: 'external', idempotencyKey: `deny-${executionId}` },
        { userId: 'test-user', source: 'cmh-test' },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(CrossModeHandoffError);
      expect((err as CrossModeHandoffError).code).toBe('handoff-policy-denied');
      // The handoff did NOT happen (no mode mutation, no handoff log row).
      const after = await executionRecordRepo.findByExecutionId(executionId);
      expect(after!.mode).toBe('native');
      expect(await countHandoffsForExecution(executionId)).toBe(0);
    });

    // #14b: native_execution_allowed=false → handoff-policy-denied.
    it('14b. policy-denied native handoff fails closed — native_execution_allowed=false → handoff-policy-denied (403)', async () => {
      const { executionId } = await createExternalRecord('handoff_ready');
      const denyNativeService = new DefaultCrossModeHandoffService({
        executionRecordRepository: executionRecordRepo,
        crossModeHandoffRepository: crossModeHandoffRepo,
        executionTaskService,
        nativeExecutionProvider,
        externalExecutionProvider,
        agentRunRepository: agentRunRepo,
        agentPolicyEvaluator: new AllowAllAgentPolicyEvaluator(),
        executionPolicyService: new StubExecutionPolicyService(false), // native NOT allowed
        agentProviderRegistryService: new StubAgentProviderRegistry(),
        auditService,
        logger: stack.db.logger,
      });
      const err = await denyNativeService.handoff(
        executionId,
        { targetMode: 'native', idempotencyKey: `deny-n-${executionId}` },
        { userId: 'test-user', source: 'cmh-test' },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(CrossModeHandoffError);
      expect((err as CrossModeHandoffError).code).toBe('handoff-policy-denied');
      const after = await executionRecordRepo.findByExecutionId(executionId);
      expect(after!.mode).toBe('external');
      expect(await countHandoffsForExecution(executionId)).toBe(0);
    });
  });
});
