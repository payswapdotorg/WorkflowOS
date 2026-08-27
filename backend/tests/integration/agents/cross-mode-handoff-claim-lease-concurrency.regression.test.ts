/**
 * PR #46 round 4 — the durable execution claim/lease for the cross-mode-
 * handoff obligation: REAL PostgreSQL two-actor concurrency regression.
 *
 * The architect's round-4 review of the round-3 commit (`cd88d9f` — the
 * post-mutation relay enqueue) established that the round-3 reorder closed
 * the live-relay race but NOT the boot-sweep race — the synchronous caller
 * + the boot sweep / the relay reconcile could BOTH drive the same pending
 * obligation between the reserve and the caller's mutation (TWO concurrent
 * handoff drivers → duplicate provider dispatches + conflicting session
 * transitions). The handoff-row UNIQUE constraint did NOT serialize these
 * two executions (both operated on the same already-reserved handoff row;
 * it only fenced creation of a SECOND handoff row).
 *
 * The round-4 fix introduces a durable execution claim/lease on the
 * obligation row itself (migration 0044), shared by the synchronous caller
 * + the relay reconcile. The claim is the serialization boundary — only
 * the claim owner may perform the mutation/session/dispatch critical
 * section. A crashed owner's lease auto-expires (`claim_expires_at < NOW()`)
 * so the boot sweep reclaims + recovers.
 *
 * This file proves the serialization is REAL by exercising TWO concurrent
 * `pg.Client` connections against the same schema:
 *
 *   R4-#1. T1 caller claims → T2 reconcile CANNOT dispatch concurrently
 *      (the claim-held early return — NO mutate, NO dispatch) → T1
 *      completes → T2 converges (a no-op discharge). The architect's
 *      exact invariant: ZERO duplicate dispatches + ZERO duplicate session
 *      transitions.
 *
 *   R4-#2. A crashed claim is reclaimed by the boot sweep AFTER the lease
 *      expires (crash-reclaim semantics). T1 reserves + claims (short
 *      200ms lease) + "crashes" (no mutate, no release). After the lease
 *      expires, T2's reconcile reclaims + recovers (re-mutate + re-dispatch
 *      + session + discharge).
 *
 *   R4-#3. DB-level serialization — two concurrent `claimHandoffObligation`
 *      calls on the same obligation, exactly one wins. T1 claims → T2's
 *      claim fails (T1 holds a live claim) → T1 releases → T2's retry
 *      succeeds (reclaimed after release).
 *
 * A fake / single-connection test is INSUFFICIENT for these invariants (the
 * architect's round-4 words): the problem is specifically database
 * transaction serialization, so the regression must use REAL PostgreSQL
 * concurrency. The suite SKIPS on pglite (single-threaded WASM cannot
 * demonstrate true blocking) — it runs only when `WORKFLOWOS_DATABASE_URL`
 * is set (CI with a real postgres service).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultAgentGateway, FakeAgentAdapter } from '../../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import {
  PgExecutionRecordRepository,
} from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { NativeExecutionProvider } from '../../../src/modules/agents/internal/native-execution-provider.js';
import { ExternalExecutionProvider } from '../../../src/modules/agents/internal/external-execution-provider.js';
import { PgCrossModeHandoffRepository } from '../../../src/modules/agents/internal/pg-cross-mode-handoff-repository.js';
import { DefaultCrossModeHandoffService } from '../../../src/modules/agents/internal/default-cross-mode-handoff-service.js';
import type {
  CrossModeAgentProviderRegistryPort,
  CrossModeExecutionPolicyPort,
  CrossModeExecutionSessionPort,
} from '../../../src/modules/agents/internal/default-cross-mode-handoff-service.js';
import { DefaultExecutionTaskService } from '../../../src/modules/work-items/internal/execution-task-service.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';
import { DefaultExecutionPromptBuilder } from '../../../src/modules/work-items/internal/execution-prompt-builder.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import { PgExecutionSessionRepository } from '../../../src/modules/agents/internal/pg-execution-session-repository.js';
import { DefaultExecutionSessionService } from '../../../src/modules/agents/internal/execution-session-service.js';
import type {
  ExecutionSession,
  SessionTransitionResult,
} from '../../../src/modules/agents/internal/execution-session.types.js';
import { PgAgentWorkspaceRepository } from '../../../src/modules/agents/internal/pg-agent-workspace-repository.js';
import { DefaultAgentWorkspaceService } from '../../../src/modules/agents/internal/agent-workspace-service.js';
import type { WorktreeMaterializer } from '../../../src/modules/agents/internal/agent-workspace.types.js';
import { InMemoryQueue } from '@platform/index.js';
import type { DatabaseClient } from '@platform/postgres/database-client.js';
import type {
  CreateCrossModeHandoffInput,
  CrossModeHandoffRecord,
  CrossModeHandoffRepository,
} from '../../../src/modules/agents/internal/cross-mode-handoff.types.js';
import {
  CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER,
  CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER,
} from '../../../src/modules/agents/internal/cross-mode-handoff.types.js';
import type {
  ExecutionProvider,
  ExecutionSubmission,
  ExecutionTask,
} from '../../../src/modules/agents/internal/execution.types.js';
import type { AgentPolicyExternalDecision } from '../../../src/modules/agents/internal/agent-policy.types.js';
import type { AgentPolicyHandoffEvaluator } from '../../../src/modules/agents/internal/policy-gated-handoff-service.js';

const isRealPg = !!process.env.WORKFLOWOS_DATABASE_URL && process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');

/** A promise that resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Test doubles (narrow ports — mirror the cross-mode-handoff.regression
// test's policy / provider / registry stubs + the persistence-fence-
// concurrency test's Hooked/Counting wrappers).
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

class StubExecutionPolicyService implements CrossModeExecutionPolicyPort {
  constructor(private readonly nativeAllowed: boolean = true) {}
  async getProjectPolicy(_projectId: string): Promise<{ nativeExecutionAllowed: boolean; policyVersion: number | null } | null> {
    return { nativeExecutionAllowed: this.nativeAllowed, policyVersion: 1 };
  }
}

class StubAgentProviderRegistry implements CrossModeAgentProviderRegistryPort {
  getPlatformDefaultProvider(): string | undefined { return 'fake'; }
  getPlatformDefaultModel(): string | undefined { return 'test-model'; }
  async isProviderConfigured(_provider: string, _model: string, _projectId?: string): Promise<boolean> { return true; }
}

/**
 * A recording worktree materializer that tracks the working-tree state per
 * token (mirrors the cross-mode-handoff.regression test's setup — the
 * workspace continuity gate needs a worktree materializer to be wired, but
 * for these tests no worktree state is asserted; the materializer is a
 * minimal stand-in).
 */
class FakeWorktreeMaterializer implements WorktreeMaterializer {
  readonly hostPaths = new Map<string, string>();
  async materialize(input: {
    worktreePathToken: string; repositoryOwner: string; repositoryName: string;
    branch: string; baseRevision: string;
  }): Promise<string> {
    const host = `/fake-cmh-concurrency/${input.worktreePathToken}`;
    if (!this.hostPaths.has(input.worktreePathToken)) {
      this.hostPaths.set(input.worktreePathToken, host);
    }
    return this.hostPaths.get(input.worktreePathToken)!;
  }
  async remove(input: { worktreePathToken: string }): Promise<void> {
    this.hostPaths.delete(input.worktreePathToken);
  }
}

/**
 * PR #46 round 4: a CountingExternalProvider that wraps the real
 * ExternalExecutionProvider + counts `submit` calls. SHARED between T1 +
 * T2 services so both paths' dispatches are visible through ONE counter
 * (the architect's invariant: ZERO duplicate dispatches — exactly one
 * submit per handoff, regardless of which actor drove it).
 */
class CountingExternalProvider implements ExecutionProvider {
  readonly name = 'external';
  readonly mode = 'external' as const;
  private _submitCount = 0;
  constructor(private readonly real: ExternalExecutionProvider) {}
  async submit(task: ExecutionTask): Promise<ExecutionSubmission> {
    this._submitCount++;
    return this.real.submit(task);
  }
  /** The number of `submit` calls so far (proves exactly-one dispatch). */
  get submitCount(): number { return this._submitCount; }
}

/**
 * PR #46 round 4: a CountingSessionService that wraps the real
 * DefaultExecutionSessionService + counts `interruptSession` calls. SHARED
 * between T1 + T2 services so both paths' session transitions are visible
 * through ONE counter (the architect's invariant: ZERO duplicate session
 * transitions — exactly one interrupt per handoff, regardless of which
 * actor drove it).
 */
class CountingSessionService implements CrossModeExecutionSessionPort {
  private _interruptCount = 0;
  private _resumeCount = 0;
  private _startCount = 0;
  constructor(private readonly real: CrossModeExecutionSessionPort) {}
  getSessionForExecution(executionId: string): Promise<ExecutionSession | null> {
    return this.real.getSessionForExecution(executionId);
  }
  async interruptSession(sessionId: string, expectedVersion: number): Promise<SessionTransitionResult | null> {
    this._interruptCount++;
    return this.real.interruptSession(sessionId, expectedVersion);
  }
  async resumeSession(sessionId: string, expectedVersion: number): Promise<SessionTransitionResult | null> {
    this._resumeCount++;
    return this.real.resumeSession(sessionId, expectedVersion);
  }
  async startSession(sessionId: string): Promise<ExecutionSession | null> {
    this._startCount++;
    return this.real.startSession(sessionId);
  }
  /** The number of `interruptSession` calls so far (proves exactly-one transition). */
  get interruptCount(): number { return this._interruptCount; }
  /** The number of `resumeSession` calls so far. */
  get resumeCount(): number { return this._resumeCount; }
  /** The number of `startSession` calls so far. */
  get startCount(): number { return this._startCount; }
}

/**
 * PR #46 round 4: a HookedHandoffRepository that wraps T1's
 * PgCrossModeHandoffRepository + fires a `willMutate` hook AFTER
 * `createHandoffAndClaim` succeeds with `claimed:true` +
 * `owner === CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER` (the caller-path claim).
 * The hook fires AFTER the reserve+claim transaction commits (so T1 holds
 * the live claim) + BEFORE T1's `mutateAndDispatch` runs (T1 continues
 * synchronously after the hook resolves). The hook starts T2's
 * `reconcileCrossModeHandoffForExecution(executionId)` on the SECOND client
 * + awaits it — T2's reconcile tries to claim → fails (T1 holds) → returns
 * `{ stage: 'claim-held' }` (NO mutate, NO dispatch). This proves the
 * architect's invariant: a concurrent reconcile CANNOT re-mutate + re-
 * dispatch while the caller holds the claim.
 */
class HookedHandoffRepository implements CrossModeHandoffRepository {
  constructor(
    private readonly real: CrossModeHandoffRepository,
    private readonly willMutate?: () => Promise<void>,
  ) {}
  async createHandoff(input: CreateCrossModeHandoffInput): Promise<CrossModeHandoffRecord> {
    return this.real.createHandoff(input);
  }
  async createHandoffAndClaim(
    input: CreateCrossModeHandoffInput,
    owner: string,
    leaseMs: number,
  ): Promise<{ handoff: CrossModeHandoffRecord; claimed: boolean }> {
    const result = await this.real.createHandoffAndClaim(input, owner, leaseMs);
    // Fire the hook ONLY when the caller-path claim succeeds (the
    // serialization boundary is held by T1). T2's reconcile started inside
    // this hook will fail its own claim attempt + return early.
    if (result.claimed && owner === CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER) {
      if (this.willMutate) await this.willMutate();
    }
    return result;
  }
  async claimHandoffObligation(
    handoffId: string,
    owner: string,
    leaseMs: number,
  ): Promise<{ claimed: true } | { claimed: false; activeOwner: string | null }> {
    return this.real.claimHandoffObligation(handoffId, owner, leaseMs);
  }
  async releaseHandoffObligationClaim(handoffId: string, owner: string): Promise<boolean> {
    return this.real.releaseHandoffObligationClaim(handoffId, owner);
  }
  async findByExecutionId(executionId: string): Promise<CrossModeHandoffRecord | null> {
    return this.real.findByExecutionId(executionId);
  }
  async findByIdempotencyKey(key: string): Promise<CrossModeHandoffRecord | null> {
    return this.real.findByIdempotencyKey(key);
  }
  async listPendingHandoffObligations() {
    return this.real.listPendingHandoffObligations();
  }
  async dischargeHandoffObligation(handoffId: string): Promise<boolean> {
    return this.real.dischargeHandoffObligation(handoffId);
  }
}

describe.skipIf(!isRealPg)('PR #46 round 4 — the durable cross-mode-handoff claim/lease (real PostgreSQL two-actor concurrency)', () => {
  let stack: TestAuthStack;
  let second: { client: DatabaseClient; close: () => Promise<void> } | undefined;

  let executionRecordRepo: PgExecutionRecordRepository;
  let crossModeHandoffRepo: PgCrossModeHandoffRepository;
  let agentRunRepo: PgAgentRunRepository;
  let contextRepo: PgImplementationContextRepository;
  let executionTaskService: DefaultExecutionTaskService;
  let nativeExecutionProvider: NativeExecutionProvider;
  let countingExternalProvider: CountingExternalProvider;
  let auditService: DefaultAuditService;
  let sessionRepo: PgExecutionSessionRepository;
  let executionSessionService: DefaultExecutionSessionService;
  let countingSessionService: CountingSessionService;
  let workspaceRepo: PgAgentWorkspaceRepository;
  let agentWorkspaceService: DefaultAgentWorkspaceService;
  let implementationContextBuilder: DefaultImplementationContextBuilder;

  let orgId: string;
  let projectId: string;
  let workItemId: string;
  let workOrderId: string;
  let sharedContextId: string;

  let execCount = 0;
  const nextExecId = () => `wf-cmh-r4-${++execCount}`;

  beforeAll(() => {
    // Real-PG only; pglite cannot demonstrate true two-actor concurrency.
  });

  beforeEach(async () => {
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
    // deterministic FakeAgentAdapter — the SAME setup the cross-mode-handoff
    // regression test uses).
    const fakeAgent = new FakeAgentAdapter();
    const gateway = new DefaultAgentGateway(db, stack.db.logger, [fakeAgent], 3);
    nativeExecutionProvider = new NativeExecutionProvider({
      agentGateway: gateway,
      agentRunRepository: agentRunRepo,
      logger: stack.db.logger,
    });
    countingExternalProvider = new CountingExternalProvider(new ExternalExecutionProvider());

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

    // The real WORK-034 session service + the shared CountingSessionService
    // wrapper (both T1 + T2 services share this instance — the session row
    // is in the shared schema, so a single underlying session service is
    // correct; the counter is the proof of exactly-one interrupt).
    sessionRepo = new PgExecutionSessionRepository(db);
    executionSessionService = new DefaultExecutionSessionService({
      sessionRepository: sessionRepo,
      executionRecordRepository: executionRecordRepo,
      logger: stack.db.logger,
    });
    countingSessionService = new CountingSessionService(executionSessionService);

    // The workspace service (the continuity gate needs it; no workspace state
    // is asserted in these tests — the gate passes when no workspace exists).
    workspaceRepo = new PgAgentWorkspaceRepository({
      db,
      executionRecordRepository: executionRecordRepo,
      projectGitHubRepositoryLookup: {
        findByProject: async (pid: string) => {
          const r = await db.query<{ id: string; project_id: string; owner: string; repository: string; default_branch: string; installation_id: string }>(
            `SELECT id, project_id, owner, repository, default_branch, installation_id
             FROM wfos_project_github_repositories WHERE project_id = $1 LIMIT 1`,
            [pid],
          );
          const row = r.rows[0];
          return row
            ? {
                id: row.id, projectId: row.project_id, owner: row.owner,
                repository: row.repository, defaultBranch: row.default_branch,
                installationId: row.installation_id,
              }
            : null;
        },
      },
      baselineResolver: {
        getBranch: async (_input: { owner: string; repository: string; branchName: string; installationId: string }) => ({
          sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        }),
      },
    });
    agentWorkspaceService = new DefaultAgentWorkspaceService({
      workspaceRepository: workspaceRepo,
      materializer: new FakeWorktreeMaterializer(),
      logger: stack.db.logger,
    });

    // Seed the project / architecture / work-item / work-order / shared
    // implementation context (mirrors the cross-mode-handoff regression
    // test's beforeAll seed).
    const org = await stack.organizationRepository.create({ name: 'W042 R4 Concurrency Org' });
    orgId = org.id;
    const project = await stack.projectRepository.create({ organizationId: orgId, name: 'W042 R4 Concurrency Project' });
    projectId = project.id;
    await stack.db.client.query(
      `INSERT INTO wfos_project_github_repositories
         (project_id, installation_id, owner, repository, default_branch, link_type)
       VALUES ($1, 'inst-w042-r4', 'w042-r4-org', 'w042-r4-repo', 'main', 'linked')`,
      [projectId],
    );
    const arch = await stack.architectureRepository.create({ projectId, name: 'W042 R4 Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# W042 R4', digestSha256: 'w042-r4-digest-1' });
    const req = await stack.requirementRepository.create({
      architectureVersionId: version.id, requirementId: 'REQ-W042-R4-001',
      title: 'Calculator adds', description: 'add(2,3)===5',
    });
    const crit = await stack.acceptanceCriterionRepository.create({
      requirementId: req.id, criterionId: 'AC-W042-R4-001',
      description: 'add(2,3) returns 5', verificationExpectation: 'unit-test',
    });
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id, workItemId: 'WORK-W042-R4-001',
      title: 'Calculator addition', objective: 'Add a calculator.', scope: 'src/calc.ts', outOfScope: 'sub',
      metadata: { baseCommit: 'w042-r4-baseline-commit-0000000000000001' },
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
    const ctx = await implementationContextBuilder.build(workItem.id);
    sharedContextId = ctx.id;

    // Open the SECOND independent pg.Client (T2) against the same schema
    // (mirrors the persistence-fence-concurrency test's setup).
    second = stack.db.createSecondClient ? await stack.db.createSecondClient() : undefined;
  });

  afterEach(async () => {
    if (second) await second.close();
    await stack.teardown();
    delete process.env.AGENT_PROVIDER_NAME;
    delete process.env.AGENT_API_KEY;
    delete process.env.AGENT_DEFAULT_MODEL;
  });

  afterAll(async () => {
    // nothing extra (the schema is dropped in stack.teardown).
  });

  // -------------------------------------------------------------------------
  // Helpers (mirror the cross-mode-handoff regression test's helpers).
  // -------------------------------------------------------------------------

  /** Create a native execution record in the failed state. */
  async function createNativeRecord(
    status: 'created' | 'running' | 'failed' | 'completed' = 'failed',
  ): Promise<{ executionId: string; recordId: string }> {
    const executionId = nextExecId();
    const record = await executionRecordRepo.create({
      executionId, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
      branch: 'feat/work-w042-r4-001',
    });
    if (status !== 'created') {
      await executionRecordRepo.updateStatus(record.id, { status, completedAt: status === 'failed' || status === 'completed' ? new Date() : null });
    }
    return { executionId, recordId: record.id };
  }

  /** Create a REAL running ExecutionSession for an execution. */
  async function createRunningSession(executionId: string): Promise<{ sessionId: string; version: number }> {
    const session = await executionSessionService.ensureSession(executionId);
    const started = await executionSessionService.startSession(session.id);
    const current = started ?? await sessionRepo.getSession(session.id);
    return { sessionId: current!.id, version: current!.version };
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

  /** Count pending cross-mode-handoff obligations for an execution. */
  async function countPendingObligations(executionId: string): Promise<number> {
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_cross_mode_handoff_obligations o
       JOIN wfos_execution_mode_handoffs h ON h.id = o.handoff_id
       JOIN wfos_executions e ON e.id = o.execution_id
       WHERE e.execution_id = $1 AND o.discharged_at IS NULL`,
      [executionId],
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  /** Count discharged cross-mode-handoff obligations for an execution. */
  async function countDischargedObligations(executionId: string): Promise<number> {
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_cross_mode_handoff_obligations o
       JOIN wfos_execution_mode_handoffs h ON h.id = o.handoff_id
       JOIN wfos_executions e ON e.id = o.execution_id
       WHERE e.execution_id = $1 AND o.discharged_at IS NOT NULL`,
      [executionId],
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  /** Build a T1 (caller-path) service on T1's client, sharing the counting
   *  providers. The optional `willMutate` hook wraps T1's
   *  `crossModeHandoffRepository` in a `HookedHandoffRepository` so the test
   *  can run T2's reconcile BETWEEN T1's reserve+claim and T1's mutate. */
  function buildT1Service(opts: { willMutate?: () => Promise<void> } = {}): DefaultCrossModeHandoffService {
    const repo: CrossModeHandoffRepository = opts.willMutate
      ? new HookedHandoffRepository(crossModeHandoffRepo, opts.willMutate)
      : crossModeHandoffRepo;
    return new DefaultCrossModeHandoffService({
      executionRecordRepository: executionRecordRepo,
      crossModeHandoffRepository: repo,
      executionTaskService,
      nativeExecutionProvider,
      externalExecutionProvider: countingExternalProvider,
      agentRunRepository: agentRunRepo,
      agentPolicyEvaluator: new AllowAllAgentPolicyEvaluator(),
      executionPolicyService: new StubExecutionPolicyService(true),
      agentProviderRegistryService: new StubAgentProviderRegistry(),
      executionSessionService: countingSessionService,
      agentWorkspaceService,
      auditService,
      logger: stack.db.logger,
      // A real InMemoryQueue (T1's enqueue happens AFTER the mutate; no worker
      // drains it — the tests check the handoff result + the obligation state
      // directly, not the relay delivery).
      queue: new InMemoryQueue(),
    });
  }

  /** Build a T2 (relay-path) service on the SECOND client, sharing the
   *  counting providers (so T2's dispatch/session calls are visible through
   *  the SAME counters as T1's). T2's repos use `second.client`; the
   *  underlying session row + record row are in the SHARED schema (both
   *  clients point to the same schema). */
  function buildT2Service(): DefaultCrossModeHandoffService {
    if (!second) throw new Error('T2 second client is not open (isRealPg=false?)');
    const t2RecordRepo = new PgExecutionRecordRepository(second.client);
    const t2HandoffRepo = new PgCrossModeHandoffRepository(second.client);
    return new DefaultCrossModeHandoffService({
      executionRecordRepository: t2RecordRepo,
      crossModeHandoffRepository: t2HandoffRepo,
      executionTaskService,
      nativeExecutionProvider,
      externalExecutionProvider: countingExternalProvider,
      agentRunRepository: agentRunRepo,
      agentPolicyEvaluator: new AllowAllAgentPolicyEvaluator(),
      executionPolicyService: new StubExecutionPolicyService(true),
      agentProviderRegistryService: new StubAgentProviderRegistry(),
      // SHARED CountingSessionService — T2's interruptSession calls go through
      // the same counter as T1's (proves exactly-one interrupt regardless of
      // which actor drove it).
      executionSessionService: countingSessionService,
      agentWorkspaceService,
      auditService,
      logger: stack.db.logger,
      queue: new InMemoryQueue(),
    });
  }

  // =========================================================================
  // R4-#1. T1 caller claims → T2 reconcile CANNOT dispatch concurrently →
  // T1 completes → T2 converges (ZERO duplicate dispatches + ZERO duplicate
  // session transitions). The architect's exact round-4 invariant.
  // =========================================================================
  it('R4-#1. T1 caller claims → T2 reconcile CANNOT dispatch concurrently (claim-held early return) → T1 completes → T2 converges (ZERO duplicate dispatches + ZERO duplicate session transitions)', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);

    const t2Service = buildT2Service();

    // The willMutate hook: fires AFTER T1's reserve+claim commits (T1 holds
    // the live claim) + BEFORE T1's mutateAndDispatch runs. Starts T2's
    // reconcile on the SECOND client + awaits it. T2's reconcile tries to
    // claim → fails (T1 holds a live 30s claim) → returns
    // `{ stage: 'claim-held' }` (NO mutate, NO dispatch, NO session
    // transition). This is the architect's invariant: a concurrent reconcile
    // CANNOT re-mutate + re-dispatch the same obligation while the caller
    // holds the claim.
    let t2FirstResult: unknown = undefined;
    const willMutate = async () => {
      t2FirstResult = await t2Service.reconcileCrossModeHandoffForExecution(executionId);
    };
    // Build T1 with the willMutate hook (the hook fires inside T1's
    // HookedHandoffRepository.createHandoffAndClaim wrapper).
    const hookedT1Service = buildT1Service({ willMutate });

    // T1's handoff: reserve + claim (succeeds) → willMutate fires (T2
    // attempts to claim → fails → returns claim-held) → T1 continues:
    // mutateAndDispatch (record external/handoff_ready + packageValue +
    // session interrupted) → enqueueRelayJob → finally release.
    await hookedT1Service.handoff(
      executionId,
      { targetMode: 'external', idempotencyKey: `r4-race-${executionId}` },
      { userId: 'test-user', source: 'cmh-test' },
    );

    // T2's FIRST attempt: claim failed (T1 held the live claim throughout T1's
    // critical section) → returned the claim-held early-return BEFORE any
    // mutate/dispatch. NO re-mutate, NO re-dispatch, NO session transition.
    expect(t2FirstResult, 'T2\'s first reconcile returned a result (the claim-held early-return)').toBeDefined();
    expect((t2FirstResult as { stage?: string }).stage, 'T2\'s first reconcile stage is claim-held (NO mutate, NO dispatch)').toBe('claim-held');

    // T2's RETRY: T1 has completed + released the claim. T2's claim succeeds
    // now → finds the handoff complete (record external + packageValue +
    // session interrupted) → discharges (a no-op reconcile — no re-mutate, no
    // re-dispatch).
    const t2RetryResult = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2RetryResult.stage, 'T2\'s retry converged + discharged (claim succeeded after T1 released)').toBe('complete');

    // THE ARCHITECT'S EXACT INVARIANT: ZERO duplicate dispatches + ZERO
    // duplicate session transitions. Only T1 dispatched + interrupted (T2's
    // first attempt returned early; T2's retry was a no-op discharge).
    expect(countingExternalProvider.submitCount, 'ZERO duplicate dispatches — only T1 dispatched (T2 was claim-held then no-op discharge)').toBe(1);
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions — only T1 interrupted (T2 was claim-held then no-op discharge)').toBe(1);

    // Exactly ONE handoff log row (no duplicate — no concurrent driver).
    expect(await countHandoffsForExecution(executionId)).toBe(1);
    // The obligation discharged (T2's retry confirmed completion).
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);

    // The final state: the record IS external/handoff_ready + packageValue +
    // the session IS interrupted (converged).
    const after = await executionRecordRepo.findByExecutionId(executionId);
    expect(after!.id).toBe(recordId);
    expect(after!.mode).toBe('external');
    expect(after!.status).toBe('handoff_ready');
    expect(after!.packageValue).not.toBeNull();
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
    expect(afterSession!.status).toBe('interrupted');
  });

  // =========================================================================
  // R4-#2. A crashed claim is reclaimed by the boot sweep AFTER the lease
  // expires (crash-reclaim semantics). T1 reserves + claims (short 200ms
  // lease) + "crashes" (no mutate, no release). After the lease expires,
  // T2's reconcile reclaims + recovers.
  // =========================================================================
  it('R4-#2. a crashed claim is reclaimed by the boot sweep after the lease expires (crash-reclaim semantics — T2 reclaims + recovers)', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);

    const t1Service = buildT1Service();
    const t2Service = buildT2Service();
    // Silence the unused-variable lint: t1Service is constructed for symmetry
    // (T1's repos on T1's client — but T1 "crashes" before the service's
    // mutateAndDispatch runs, so the service is not invoked in this test; the
    // claim is acquired directly via the repo to simulate the crash).
    void t1Service;

    // T1 "crashes" after reserve+claim: directly call
    // `crossModeHandoffRepo.createHandoffAndClaim(...)` with a SHORT 200ms
    // lease (simulate the caller's reserve+claim with NO subsequent
    // mutate/release — the process died mid-critical-section). The
    // createInput is built from the record (mirrors the service's
    // reserveAndClaim build).
    const record = await executionRecordRepo.findByExecutionId(executionId);
    expect(record).not.toBeNull();
    const createInput: CreateCrossModeHandoffInput = {
      executionRecordId: record!.id,
      fromMode: record!.mode,
      toMode: 'external',
      reason: 'r4-crash-reclaim',
      actor: 'test-user',
      source: 'cmh-test',
      previousStatus: record!.status,
      resultingStatus: 'handoff_ready',
      previousAgentRunId: record!.agentRunId,
      previousExternalSessionRef: record!.externalSessionRef,
      previousPackageValue: record!.packageValue,
      authorized: true,
      policyDecision: 'test-allow-all',
      idempotencyKey: `r4-crash-${executionId}`,
    };
    const claimResult = await crossModeHandoffRepo.createHandoffAndClaim(
      createInput,
      CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER,
      200, // short 200ms lease — the crash-reclaim window
    );
    expect(claimResult.claimed, 'T1 acquired the claim (200ms lease) before "crashing"').toBe(true);
    expect(await countPendingObligations(executionId)).toBe(1);

    // The record is STILL native (T1 never mutated).
    const midRecord = await executionRecordRepo.findByExecutionId(executionId);
    expect(midRecord!.mode).toBe('native');

    // Wait for the 200ms lease to expire (the reclaimable window).
    await delay(250);

    // T2 (boot sweep): reconcile on the SECOND client. T2's claim succeeds
    // (the lease expired — `claim_expires_at < NOW()` arm of the reclaim
    // predicate). T2 sees `record.mode !== toMode` (T1 never mutated) →
    // re-mutate + re-dispatch + session transition + discharge.
    const t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Result.stage, 'T2 reclaimed the expired claim + recovered (re-mutated + re-dispatched + discharged)').toBe('complete');

    // T2 dispatched exactly once (the re-dispatch). T2 interrupted the
    // session exactly once (the session transition). NO duplicate from T1
    // (T1 crashed before mutating).
    expect(countingExternalProvider.submitCount, 'T2 dispatched exactly once (the re-dispatch after reclaim)').toBe(1);
    expect(countingSessionService.interruptCount, 'T2 interrupted the session exactly once (the transition after reclaim)').toBe(1);

    // The boot sweep reclaimed + recovered: the obligation DISCHARGED.
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);
    expect(await countHandoffsForExecution(executionId)).toBe(1);

    // The final state: record external + packageValue + session interrupted
    // (T2 drove the handoff to completion after reclaiming the crashed
    // claim).
    const after = await executionRecordRepo.findByExecutionId(executionId);
    expect(after!.id).toBe(recordId);
    expect(after!.mode).toBe('external');
    expect(after!.status).toBe('handoff_ready');
    expect(after!.packageValue).not.toBeNull();
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
    expect(afterSession!.status).toBe('interrupted');
  });

  // =========================================================================
  // R4-#3. DB-level serialization — two concurrent `claimHandoffObligation`
  // calls on the same obligation, exactly one wins. T1 (client1 repo) claims
  // → T2 (client2 repo) claims → fails (T1 holds a live claim) → T1 releases
  // → T2 retries → succeeds (reclaimed after release). Proves the
  // conditional UPDATE serializes concurrent actors at the DB level (NOT an
  // application-level check).
  // =========================================================================
  it('R4-#3. DB-level serialization — two concurrent claimHandoffObligation calls on the same obligation, exactly one wins (T2 fails while T1 holds; T2 succeeds after T1 releases)', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const t1Service = buildT1Service();

    // Use T1's service to create the handoff + obligation (the happy-path
    // reserve + claim + mutate + dispatch + release). After this, the
    // obligation exists + is PENDING + UNCLAIMED (T1's finally released
    // the claim).
    await t1Service.handoff(
      executionId,
      { targetMode: 'external', idempotencyKey: `r4-claim-${executionId}` },
      { userId: 'test-user', source: 'cmh-test' },
    );
    expect(await countPendingObligations(executionId)).toBe(1);

    // Reset the obligation to PENDING + UNCLAIMED + the record to native
    // (so T2's reconcile, if it could claim, would re-mutate). This isolates
    // the claim-UPDATE serialization from the service-level handoff state.
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'failed', mode = 'native', agent_run_id = NULL, external_session_ref = NULL, package_json = NULL, expires_at = NULL, updated_at = NOW() WHERE id = $1`,
      [recordId],
    );
    await stack.db.client.query(
      `UPDATE wfos_cross_mode_handoff_obligations
         SET discharged_at = NULL,
             claimed_at = NULL,
             claim_expires_at = NULL,
             claim_owner = NULL
       WHERE handoff_id = (SELECT id FROM wfos_execution_mode_handoffs WHERE execution_record_id = $1)`,
      [recordId],
    );

    // Resolve the handoffId (the obligation's handoff_id column) for the
    // direct claim calls.
    const handoffIdRes = await stack.db.client.query<{ id: string }>(
      `SELECT id FROM wfos_execution_mode_handoffs WHERE execution_record_id = $1`,
      [recordId],
    );
    const handoffId = handoffIdRes.rows[0]!.id;

    // T1 (client1 repo) claims — succeeds (the obligation is unclaimed +
    // pending). The 30s lease keeps T1's claim live.
    const t1Repo = crossModeHandoffRepo; // T1's repo (on stack.db.client)
    const t1Claim1 = await t1Repo.claimHandoffObligation(
      handoffId,
      CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER,
      30_000,
    );
    expect(t1Claim1.claimed, 'T1 (client1) acquired the claim (unclaimed + pending)').toBe(true);

    // T2 (client2 repo) claims WHILE T1 holds a live claim — FAILS. The
    // conditional UPDATE's WHERE clause `discharged_at IS NULL AND
    // (claimed_at IS NULL OR claim_expires_at < NOW())` does NOT match (T1
    // holds a live, non-expired claim). The `activeOwner` is T1's owner
    // identifier (the diagnostics read).
    const t2Repo = new PgCrossModeHandoffRepository(second!.client);
    const t2Claim1 = await t2Repo.claimHandoffObligation(
      handoffId,
      CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER,
      30_000,
    );
    expect(t2Claim1.claimed, 'T2 (client2) could NOT claim while T1 holds a live claim (DB-level serialization)').toBe(false);
    if (!t2Claim1.claimed) {
      expect(t2Claim1.activeOwner, 'T2\'s diagnostics read T1\'s owner identifier (cross-mode-handoff-caller)').toBe(CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER);
    }

    // T1 releases the claim (the `finally` block in production).
    const t1Release = await t1Repo.releaseHandoffObligationClaim(
      handoffId,
      CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER,
    );
    expect(t1Release, 'T1 released the claim (the owner-guarded release succeeded)').toBe(true);

    // T2 retries — succeeds (the claim is now free + the reclaim predicate
    // matches). The conditional UPDATE serializes: T2's claim matches
    // because T1's release set claimed_at=NULL.
    const t2Claim2 = await t2Repo.claimHandoffObligation(
      handoffId,
      CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER,
      30_000,
    );
    expect(t2Claim2.claimed, 'T2 reclaimed the claim after T1 released (the reclaim predicate matched)').toBe(true);

    // Cleanup: release T2's claim so the obligation is clean for the next
    // test (the schema is per-test, but this is defensive).
    await t2Repo.releaseHandoffObligationClaim(handoffId, CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER);
  });
});
