/**
 * PR #46 round 4 + round 5 — the durable execution claim/lease for the
 * cross-mode-handoff obligation: REAL PostgreSQL two-actor concurrency
 * regression.
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
 * The round-4 fix introduced a durable execution claim/lease on the
 * obligation row itself (migration 0044), shared by the synchronous caller
 * + the relay reconcile. The claim is the serialization boundary — only
 * the claim owner may perform the mutation/session/dispatch critical
 * section. A crashed owner's lease auto-expires (`claim_expires_at < NOW()`)
 * so the boot sweep reclaims + recovers.
 *
 * PR #46 round 5 (the lease-ownership + lease-expiry fixes): the round-5
 * review found two lease-correctness holes in the round-4 implementation:
 * (1) the claim owner was a FIXED per-role string shared by every
 * invocation of that role — an old invocation's `finally` release could
 * clear a NEW owner's live claim after an expiry+reclaim under the same
 * owner string; (2) the fixed 30s lease had NO renewal/fencing — a critical
 * section longer than the lease let a second actor reclaim while the first
 * was still executing. The round-5 fix: unique per-invocation owners
 * (`<role-prefix>:<uuid>`), the claim_epoch fencing token (migration 0045),
 * the heartbeat renewal covering the whole critical section, phase-boundary
 * fence checks, and the epoch-fenced discharge.
 *
 * This file proves the serialization + the lease semantics are REAL by
 * exercising TWO concurrent `pg.Client` connections against the same
 * schema:
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
 *   R5-#1. The architect's EXACT round-5 five-step regression: T1 claims
 *      with owner A (unique, caller role) → the lease expires → T2 (the
 *      SAME role) reclaims with owner B → T1's LATE release CANNOT clear
 *      T2's claim → a THIRD actor cannot acquire the still-live T2 claim.
 *      Also proves T1's stale renewal fails (the fence check) while T2's
 *      live renewal succeeds.
 *
 *   R5-#2. The heartbeat renewal covers the ENTIRE critical section: T1's
 *      critical section outlives the lease (a slow dispatch — parked
 *      mid-section) with the heartbeat active → T2's mid-flight reclaim
 *      FAILS (the lease never expired under the live heartbeating owner) →
 *      T1 completes → ZERO duplicate dispatches / session transitions.
 *
 *   R5-#3. The stalled-owner abort: T1's heartbeat is SUPPRESSED + its
 *      short lease expires while it is parked mid-critical-section → T2
 *      reclaims + completes + discharges → T1 resumes → its next fence
 *      check FAILS (owner/epoch mismatch) → T1 aborts with
 *      'claim-fence-lost' BEFORE any mutation/dispatch → ZERO duplicate
 *      dispatches / session transitions under the exact
 *      stall-then-reclaim interleaving.
 *
 *   R5-#4. The discharge is epoch-fenced: after T2 reclaims (a new epoch),
 *      T1's stale-epoch discharge is REJECTED (0 rows — the obligation
 *      stays pending) while T2's live-epoch discharge succeeds.
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
import { CrossModeHandoffError } from '../../../src/modules/agents/internal/cross-mode-handoff.types.js';
import {
  CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX,
  CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX,
  newCrossModeHandoffClaimOwner,
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

/** Poll `predicate` every 10ms until it holds (throws after `timeoutMs`). */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: the condition was not met before the timeout');
    }
    await delay(10);
  }
}

/**
 * PR #46 round 5: narrow a claim result to the claimed branch + return its
 * fencing epoch (the test FAILS if the claim did not succeed — vitest's
 * expect() does not narrow TypeScript unions).
 */
function assertClaimed(
  claim: { claimed: true; claimEpoch: number } | { claimed: false; activeOwner: string | null },
): number {
  if (!claim.claimed) {
    throw new Error(`assertClaimed: the claim did not succeed (activeOwner=${claim.activeOwner})`);
  }
  return claim.claimEpoch;
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
 * PR #46 round 4 + round 5: a HookedHandoffRepository that wraps T1's
 * PgCrossModeHandoffRepository + fires hooks for the two-actor tests:
 *
 *   - `willMutate`: fires AFTER `createHandoffAndClaim` succeeds with
 *     `claimed:true` + a caller-role owner (the unique round-5 owner string
 *     starts with the caller role PREFIX) + BEFORE T1's mutateAndDispatch
 *     runs. Used by R4-#1 (T2's claim-held early return) + R5-#3 (the
 *     stalled-owner abort: T1 parks at the hook with its heartbeat
 *     SUPPRESSED while T2 reclaims).
 *   - `onFirstRenew`: fires ONCE after the FIRST successful
 *     `renewHandoffObligationClaim` (the first phase-boundary fence check —
 *     i.e. T1 is INSIDE the critical section with its heartbeat alive).
 *     Used by R5-#2 (the heartbeat liveness: T1 parks mid-section; the
 *     heartbeat keeps renewing; T2's reclaim fails).
 *
 * All other calls (including the round-5 `renewHandoffObligationClaim`
 * heartbeat renewals) forward to the real repository.
 */
class HookedHandoffRepository implements CrossModeHandoffRepository {
  private renewHookFired = false;
  constructor(
    private readonly real: CrossModeHandoffRepository,
    private readonly willMutate?: () => Promise<void>,
    private readonly onFirstRenew?: () => Promise<void>,
  ) {}
  async createHandoff(input: CreateCrossModeHandoffInput): Promise<CrossModeHandoffRecord> {
    return this.real.createHandoff(input);
  }
  async createHandoffAndClaim(
    input: CreateCrossModeHandoffInput,
    owner: string,
    leaseMs: number,
  ): Promise<
    | { handoff: CrossModeHandoffRecord; claimed: true; claimEpoch: number }
    | { handoff: CrossModeHandoffRecord; claimed: false; claimEpoch: null }
  > {
    const result = await this.real.createHandoffAndClaim(input, owner, leaseMs);
    // Fire the hook ONLY when the caller-path claim succeeds (the
    // serialization boundary is held by T1). The owner is now a UNIQUE
    // per-invocation string — match by the caller role PREFIX.
    if (
      result.claimed &&
      owner.startsWith(`${CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX}:`)
    ) {
      if (this.willMutate) await this.willMutate();
    }
    return result;
  }
  async claimHandoffObligation(
    handoffId: string,
    owner: string,
    leaseMs: number,
  ): Promise<
    | { claimed: true; claimEpoch: number }
    | { claimed: false; activeOwner: string | null }
  > {
    return this.real.claimHandoffObligation(handoffId, owner, leaseMs);
  }
  async renewHandoffObligationClaim(
    handoffId: string,
    owner: string,
    claimEpoch: number,
    leaseMs: number,
  ): Promise<boolean> {
    const renewed = await this.real.renewHandoffObligationClaim(
      handoffId,
      owner,
      claimEpoch,
      leaseMs,
    );
    // Fire the renew hook ONCE after the first successful renewal (T1 is
    // inside the critical section — the heartbeat is alive). The hook must
    // NOT fire on subsequent heartbeat renewals (it would park on every
    // beat) — the `renewHookFired` guard makes it a one-shot.
    if (renewed && !this.renewHookFired) {
      this.renewHookFired = true;
      if (this.onFirstRenew) await this.onFirstRenew();
    }
    return renewed;
  }
  async releaseHandoffObligationClaim(
    handoffId: string,
    owner: string,
    claimEpoch: number,
  ): Promise<boolean> {
    return this.real.releaseHandoffObligationClaim(handoffId, owner, claimEpoch);
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
  async dischargeHandoffObligation(
    handoffId: string,
    owner: string,
    claimEpoch: number,
  ): Promise<boolean> {
    return this.real.dischargeHandoffObligation(handoffId, owner, claimEpoch);
  }
}

describe.skipIf(!isRealPg)('PR #46 round 4 + round 5 — the durable cross-mode-handoff claim/lease + the unique-owner/heartbeat/epoch-fence lease semantics (real PostgreSQL two-actor concurrency)', () => {
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
   *  providers. The optional `willMutate` / `onFirstRenew` hooks wrap T1's
   *  `crossModeHandoffRepository` in a `HookedHandoffRepository` so the test
   *  can run T2 BETWEEN T1's reserve+claim and T1's mutate (willMutate) or
   *  park T1 INSIDE the critical section after the first fence check
   *  (onFirstRenew). The optional `leaseMs` / `heartbeatMs` configure the
   *  round-5 lease + heartbeat (a huge heartbeatMs SUPPRESSES the heartbeat
   *  — simulating a stalled owner whose renewals stopped). */
  function buildT1Service(opts: {
    willMutate?: () => Promise<void>;
    onFirstRenew?: () => Promise<void>;
    leaseMs?: number;
    heartbeatMs?: number;
  } = {}): DefaultCrossModeHandoffService {
    const repo: CrossModeHandoffRepository =
      opts.willMutate || opts.onFirstRenew
        ? new HookedHandoffRepository(crossModeHandoffRepo, opts.willMutate, opts.onFirstRenew)
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
      // PR #46 round 5: configurable lease + heartbeat for the lease-semantics
      // regressions (R5-#2 uses a short lease with the DEFAULT heartbeat to
      // prove liveness; R5-#3 uses a short lease with a SUPPRESSED heartbeat
      // to prove the fence abort).
      ...(opts.leaseMs !== undefined ? { handoffClaimLeaseMs: opts.leaseMs } : {}),
      ...(opts.heartbeatMs !== undefined ? { handoffClaimHeartbeatMs: opts.heartbeatMs } : {}),
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
    // mutate/release — the process died mid-critical-section). PR #46 round
    // 5: the owner is a UNIQUE per-invocation identity (the caller role
    // prefix + a UUID — the same composition the service uses). The
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
      newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX),
      200, // short 200ms lease — the crash-reclaim window
    );
    expect(claimResult.claimed, 'T1 acquired the claim (200ms lease) before "crashing"').toBe(true);
    // PR #46 round 5: the claim also minted the fencing epoch (migration
    // 0045) — a positive token identifying THIS lease.
    expect(claimResult.claimEpoch, 'the crashed claim minted a fencing epoch (claim_epoch)').toBeGreaterThan(0);
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
    // PR #46 round 5: also reset claim_epoch to 0 (a fresh fencing-token
    // baseline for the direct claim calls below).
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'failed', mode = 'native', agent_run_id = NULL, external_session_ref = NULL, package_json = NULL, expires_at = NULL, updated_at = NOW() WHERE id = $1`,
      [recordId],
    );
    await stack.db.client.query(
      `UPDATE wfos_cross_mode_handoff_obligations
         SET discharged_at = NULL,
             claimed_at = NULL,
             claim_expires_at = NULL,
             claim_owner = NULL,
             claim_epoch = 0
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
    // pending). PR #46 round 5: T1's owner is a UNIQUE per-invocation
    // identity (caller role prefix + UUID) + the claim mints the fencing
    // epoch. The 30s lease keeps T1's claim live.
    const t1Repo = crossModeHandoffRepo; // T1's repo (on stack.db.client)
    const t1Owner = newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX);
    const t1Claim1 = await t1Repo.claimHandoffObligation(
      handoffId,
      t1Owner,
      30_000,
    );
    expect(t1Claim1.claimed, 'T1 (client1) acquired the claim (unclaimed + pending)').toBe(true);
    const t1Epoch = assertClaimed(t1Claim1);
    expect(t1Epoch, 'T1\'s claim minted a fencing epoch').toBeGreaterThan(0);

    // T2 (client2 repo) claims WHILE T1 holds a live claim — FAILS. The
    // conditional UPDATE's WHERE clause `discharged_at IS NULL AND
    // (claimed_at IS NULL OR claim_expires_at < NOW())` does NOT match (T1
    // holds a live, non-expired claim). PR #46 round 5: the `activeOwner`
    // diagnostics read is T1's EXACT unique owner string (the caller role
    // prefix + T1's invocation UUID).
    const t2Repo = new PgCrossModeHandoffRepository(second!.client);
    const t2Owner = newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX);
    const t2Claim1 = await t2Repo.claimHandoffObligation(
      handoffId,
      t2Owner,
      30_000,
    );
    expect(t2Claim1.claimed, 'T2 (client2) could NOT claim while T1 holds a live claim (DB-level serialization)').toBe(false);
    if (!t2Claim1.claimed) {
      expect(t2Claim1.activeOwner, 'T2\'s diagnostics read T1\'s EXACT unique owner (the caller prefix + T1\'s invocation UUID)').toBe(t1Owner);
      expect(t2Claim1.activeOwner, 'the active owner is a unique per-invocation identity (round 5), NOT the bare role constant').toMatch(new RegExp(`^${CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX}:[0-9a-f-]{36}$`));
    }

    // T1 releases the claim (the `finally` block in production). PR #46
    // round 5: the release is guarded by the EXACT lease identity (owner +
    // epoch) — T1 captured both at claim time.
    const t1Release = await t1Repo.releaseHandoffObligationClaim(
      handoffId,
      t1Owner,
      t1Epoch,
    );
    expect(t1Release, 'T1 released the claim (the owner+epoch-guarded release succeeded)').toBe(true);

    // T2 retries — succeeds (the claim is now free + the reclaim predicate
    // matches). The conditional UPDATE serializes: T2's claim matches
    // because T1's release set claimed_at=NULL. PR #46 round 5: T2's claim
    // mints the NEXT fencing epoch (strictly greater than T1's — tokens
    // are never reused across leases).
    const t2Claim2 = await t2Repo.claimHandoffObligation(
      handoffId,
      t2Owner,
      30_000,
    );
    expect(t2Claim2.claimed, 'T2 reclaimed the claim after T1 released (the reclaim predicate matched)').toBe(true);
    const t2Epoch = assertClaimed(t2Claim2);
    expect(t2Epoch, 'T2\'s reclaim minted a strictly-greater fencing epoch (monotonic tokens)').toBe(t1Epoch + 1);

    // Cleanup: release T2's claim so the obligation is clean for the next
    // test (the schema is per-test, but this is defensive).
    await t2Repo.releaseHandoffObligationClaim(handoffId, t2Owner, t2Epoch);
  });

  // =========================================================================
  // Shared round-5 helper: drive ONE complete caller-path handoff, then reset
  // the record + the obligation to PENDING + UNCLAIMED + native (mirrors the
  // R4-#3 reset) so the direct claim/release/renew/discharge calls below
  // operate on a fresh, controllable obligation.
  // =========================================================================
  async function setupPendingUnclaimedObligation(
    idempotencyPrefix: string,
  ): Promise<{ executionId: string; recordId: string; handoffId: string }> {
    const { executionId, recordId } = await createNativeRecord('failed');
    const t1Service = buildT1Service();
    await t1Service.handoff(
      executionId,
      { targetMode: 'external', idempotencyKey: `${idempotencyPrefix}-${executionId}` },
      { userId: 'test-user', source: 'cmh-test' },
    );
    // Reset: the record back to native/failed + the obligation back to
    // pending + unclaimed + epoch 0 (the fresh fencing-token baseline).
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'failed', mode = 'native', agent_run_id = NULL, external_session_ref = NULL, package_json = NULL, expires_at = NULL, updated_at = NOW() WHERE id = $1`,
      [recordId],
    );
    await stack.db.client.query(
      `UPDATE wfos_cross_mode_handoff_obligations
         SET discharged_at = NULL,
             claimed_at = NULL,
             claim_expires_at = NULL,
             claim_owner = NULL,
             claim_epoch = 0
       WHERE handoff_id = (SELECT id FROM wfos_execution_mode_handoffs WHERE execution_record_id = $1)`,
      [recordId],
    );
    const handoffIdRes = await stack.db.client.query<{ id: string }>(
      `SELECT id FROM wfos_execution_mode_handoffs WHERE execution_record_id = $1`,
      [recordId],
    );
    return { executionId, recordId, handoffId: handoffIdRes.rows[0]!.id };
  }

  // =========================================================================
  // R5-#1. The architect's EXACT round-5 five-step regression: T1 claims with
  // owner A → the lease expires → T2 (the SAME role) reclaims with owner B →
  // T1's LATE release CANNOT clear T2's claim → a THIRD actor cannot acquire
  // the still-live T2 claim. Plus: T1's stale renewal FAILS (the fence
  // check) while T2's live renewal succeeds.
  // =========================================================================
  it('R5-#1. unique lease owners — T1\'s late release CANNOT clear T2\'s same-role reclaimed claim; a third actor cannot acquire the live claim; the stale owner cannot renew', async () => {
    const { executionId, handoffId } = await setupPendingUnclaimedObligation('r5-owner');
    const t2Repo = new PgCrossModeHandoffRepository(second!.client);

    // STEP 1 — T1 claims with owner A (a UNIQUE per-invocation identity of
    // the CALLER role; a SHORT 150ms lease so the test can expire it).
    const ownerA = newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX);
    const claimA = await crossModeHandoffRepo.claimHandoffObligation(handoffId, ownerA, 150);
    expect(claimA.claimed, 'step 1: T1 claimed with owner A (unique, caller role)').toBe(true);
    const epochA = assertClaimed(claimA);
    expect(epochA, 'step 1: T1\'s claim minted fencing epoch N').toBeGreaterThan(0);

    // STEP 2 — the lease expires.
    await delay(200);

    // STEP 3 — T2 (the SAME role — the caller role, NOT the relay role)
    // reclaims the expired lease with owner B. Under the round-4 shared
    // per-role owner string this reclaim would leave claim_owner UNCHANGED
    // (owner A === owner B) — the exact hole the round-5 review identified.
    const ownerB = newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX);
    const claimB = await t2Repo.claimHandoffObligation(handoffId, ownerB, 30_000);
    expect(claimB.claimed, 'step 3: T2 (the SAME role) reclaimed the expired lease with owner B').toBe(true);
    const epochB = assertClaimed(claimB);
    expect(epochB, 'step 3: T2\'s reclaim minted the NEXT fencing epoch (N + 1)').toBe(epochA + 1);

    // STEP 4 — T1's LATE release (its `finally` finally ran after the stall)
    // CANNOT clear T2's claim: the release is guarded by the EXACT lease
    // identity (owner A + epoch N ≠ owner B + epoch N+1).
    const lateRelease = await crossModeHandoffRepo.releaseHandoffObligationClaim(
      handoffId,
      ownerA,
      epochA,
    );
    expect(lateRelease, 'step 4: T1\'s late release was a NO-OP (could not clear T2\'s claim)').toBe(false);
    const claimState = await stack.db.client.query<{ claim_owner: string | null; claim_epoch: string | number }>(
      `SELECT claim_owner, claim_epoch FROM wfos_cross_mode_handoff_obligations WHERE handoff_id = $1`,
      [handoffId],
    );
    expect(claimState.rows[0]!.claim_owner, 'step 4: T2\'s claim is INTACT (owner B still holds it)').toBe(ownerB);
    expect(Number(claimState.rows[0]!.claim_epoch), 'step 4: T2\'s fencing epoch is INTACT').toBe(epochB);

    // STEP 5 — a THIRD actor cannot acquire the still-live T2 claim.
    const ownerC = newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX);
    const claimC = await crossModeHandoffRepo.claimHandoffObligation(handoffId, ownerC, 30_000);
    expect(claimC.claimed, 'step 5: the third actor could NOT acquire T2\'s live claim').toBe(false);
    if (!claimC.claimed) {
      expect(claimC.activeOwner, 'step 5: the diagnostics read T2\'s exact unique owner').toBe(ownerB);
    }

    // The STALE owner cannot renew (its phase-boundary fence check fails —
    // the conditional renewal matches 0 rows under owner A + epoch N) while
    // the LIVE owner's renewal succeeds.
    const staleRenew = await crossModeHandoffRepo.renewHandoffObligationClaim(
      handoffId,
      ownerA,
      epochA,
      30_000,
    );
    expect(staleRenew, 'the stale owner (T1/owner A/epoch N) cannot renew — the fence check fails').toBe(false);
    const liveRenew = await t2Repo.renewHandoffObligationClaim(
      handoffId,
      ownerB,
      epochB,
      30_000,
    );
    expect(liveRenew, 'the live owner (T2/owner B/epoch N+1) renews successfully').toBe(true);

    // Cleanup: release T2's claim (defensive — the schema is per-test).
    await t2Repo.releaseHandoffObligationClaim(handoffId, ownerB, epochB);
    expect(await countPendingObligations(executionId)).toBe(1);
  });

  // =========================================================================
  // R5-#2. The heartbeat renewal covers the ENTIRE critical section: T1's
  // critical section outlives the lease (parked mid-section after the first
  // fence check — the "slow provider dispatch") with the heartbeat ACTIVE →
  // T2's mid-flight reclaim FAILS (a live owner's lease never expires) → T1
  // completes → ZERO duplicate dispatches / session transitions. This is the
  // round-5 second blocker's fix: the lease no longer relies on being longer
  // than the critical section.
  // =========================================================================
  it('R5-#2. the heartbeat keeps a LIVE owner\'s lease alive across a critical section LONGER than the lease (T2\'s mid-flight reclaim fails)', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    const t2Service = buildT2Service();

    let firstRenewSeen = false;
    let t2MidFlight: { stage?: string } | undefined;
    const onFirstRenew = async () => {
      firstRenewSeen = true;
      // T1 is INSIDE the critical section (the first phase-boundary fence
      // check just renewed the lease) + the heartbeat timer is ALIVE. Park
      // for 3x the lease — WITHOUT the heartbeat this park would forfeit
      // the claim (the round-5 second blocker); WITH the heartbeat
      // (lease/3) the lease is renewed continuously.
      await delay(900);
      // T2 (the boot sweep / a live relay) tries to reclaim mid-flight —
      // MUST FAIL: the heartbeat renewed the lease (claim_expires_at is in
      // the future).
      t2MidFlight = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
      // Park again (the total critical section ≈ 3.4x the lease).
      await delay(900);
    };
    // A SHORT 600ms lease with the DEFAULT heartbeat (600/3 = 200ms): the
    // critical section (~1.8s+) legitimately outlives the lease.
    const t1Service = buildT1Service({ onFirstRenew, leaseMs: 600 });

    await t1Service.handoff(
      executionId,
      { targetMode: 'external', idempotencyKey: `r5-heartbeat-${executionId}` },
      { userId: 'test-user', source: 'cmh-test' },
    );

    // T1 reached the mid-critical-section fence check.
    expect(firstRenewSeen, 'T1 parked INSIDE the critical section (the first fence check ran)').toBe(true);
    // T2's mid-flight reclaim FAILED — the heartbeat kept the lease live.
    expect(t2MidFlight, 'T2\'s mid-flight reconcile returned a result').toBeDefined();
    expect(t2MidFlight!.stage, 'T2\'s mid-flight reclaim FAILED (claim-held — the heartbeat kept the lease live)').toBe('claim-held');

    // ZERO duplicate dispatches / session transitions: only T1's.
    expect(countingExternalProvider.submitCount, 'ZERO duplicate dispatches — only T1 dispatched (T2 was claim-held mid-flight)').toBe(1);
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions — only T1 interrupted').toBe(1);

    // T1 COMPLETED the handoff (the lease survived the whole critical
    // section): the record is external + packaged + the session interrupted.
    const after = await executionRecordRepo.findByExecutionId(executionId);
    expect(after!.id).toBe(recordId);
    expect(after!.mode).toBe('external');
    expect(after!.status).toBe('handoff_ready');
    expect(after!.packageValue).not.toBeNull();
    const afterSession = await executionSessionService.getSessionForExecution(executionId);
    expect(afterSession!.id).toBe(sessionId);
    expect(afterSession!.status).toBe('interrupted');

    // T2's retry (T1 completed + released) converges + discharges.
    const t2Retry = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Retry.stage, 'T2\'s retry converged + discharged after T1 released').toBe('complete');
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);
  });

  // =========================================================================
  // R5-#3. The stalled-owner abort: T1's heartbeat is SUPPRESSED + its short
  // lease expires while it is parked mid-critical-section (the exact
  // round-5 second-blocker interleaving: T1 owns lease → critical section >
  // lease → T2 reclaims → T1 still executing) → T2 reclaims + completes +
  // discharges → T1 resumes → its next fence check FAILS (owner/epoch
  // mismatch) → T1 aborts with 'claim-fence-lost' BEFORE any mutation or
  // dispatch → ZERO duplicate dispatches / session transitions + T2's
  // completed state is INTACT despite T1's late release (a no-op).
  // =========================================================================
  it('R5-#3. a STALLED owner (heartbeat suppressed) loses the fence — T2 reclaims + completes; T1\'s resume ABORTS at the fence check (zero duplicate side effects)', async () => {
    const { executionId, recordId } = await createNativeRecord('failed');
    const { sessionId } = await createRunningSession(executionId);
    // T2 uses the DEFAULT lease/heartbeat — its reclaim + its whole critical
    // section run normally.
    const t2Service = buildT2Service();

    // T1: a SHORT 150ms lease + a SUPPRESSED heartbeat (a 60s interval — no
    // renewal fires during the test: the "stalled owner" whose heartbeat
    // died). T1 parks at the willMutate hook (AFTER its reserve+claim,
    // BEFORE its mutate) on a gate the test controls.
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => { resolveGate = r; });
    let t1AtGate = false;
    const willMutate = async () => {
      t1AtGate = true;
      await gate;
    };
    const t1Service = buildT1Service({ willMutate, leaseMs: 150, heartbeatMs: 60_000 });

    // T1 starts its handoff asynchronously + parks at the gate.
    let t1Error: unknown;
    const t1Promise = (async () => {
      try {
        await t1Service.handoff(
          executionId,
          { targetMode: 'external', idempotencyKey: `r5-stall-${executionId}` },
          { userId: 'test-user', source: 'cmh-test' },
        );
      } catch (err) {
        t1Error = err;
      }
    })();

    // Wait until T1 is parked at the gate (after its reserve+claim), then
    // let the 150ms lease expire while T1 is stalled (no heartbeat renews).
    await waitFor(() => t1AtGate, 5000);
    await delay(250);

    // T2 (the boot sweep) reclaims the expired lease + drives the handoff
    // to completion (re-mutate + re-dispatch + session + discharge).
    const t2Result = await t2Service.reconcileCrossModeHandoffForExecution(executionId) as { stage?: string };
    expect(t2Result.stage, 'T2 reclaimed the expired lease + completed the handoff').toBe('complete');

    // T1 resumes: its first phase-boundary fence check (before the record
    // mutate) FAILS — the renewal's owner+epoch predicate matches 0 rows
    // (T2 reclaimed under a new unique owner + epoch). T1 aborts with
    // 'claim-fence-lost' BEFORE any mutation or dispatch.
    resolveGate();
    await t1Promise;
    expect(t1Error, 'T1\'s resumed handoff FAILED with the fence-lost error').toBeInstanceOf(CrossModeHandoffError);
    expect((t1Error as CrossModeHandoffError).code, 'T1 aborted with claim-fence-lost (the stale-owner fence)').toBe('claim-fence-lost');

    // THE ARCHITECT'S INVARIANT: ZERO duplicate dispatches + ZERO duplicate
    // session transitions under the stall-then-reclaim interleaving — only
    // T2 dispatched + interrupted (T1 aborted at the fence BEFORE its
    // mutate).
    expect(countingExternalProvider.submitCount, 'ZERO duplicate dispatches — only T2 dispatched (T1 aborted at the fence check)').toBe(1);
    expect(countingSessionService.interruptCount, 'ZERO duplicate session transitions — only T2 interrupted (T1 aborted at the fence check)').toBe(1);

    // T2's completed state is INTACT despite T1's late critical-section
    // attempt + its `finally` release (the owner+epoch-guarded release was
    // a NO-OP — it could not disturb the discharged obligation).
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);
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
  // R5-#4. The discharge is epoch-fenced at the DB: after T2 reclaims (a new
  // epoch), T1's stale-epoch discharge is REJECTED (0 rows — the obligation
  // stays pending; the stale actor cannot complete the authoritative
  // obligation transition) while T2's live-epoch discharge succeeds.
  // =========================================================================
  it('R5-#4. the discharge is epoch-fenced — the STALE owner\'s discharge is rejected (the obligation stays pending); the LIVE owner\'s discharge succeeds', async () => {
    const { executionId, handoffId } = await setupPendingUnclaimedObligation('r5-discharge');
    const t2Repo = new PgCrossModeHandoffRepository(second!.client);

    // T1 claims (a SHORT 150ms lease) — fencing epoch N.
    const ownerA = newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_CALLER_CLAIM_OWNER_PREFIX);
    const claimA = await crossModeHandoffRepo.claimHandoffObligation(handoffId, ownerA, 150);
    expect(claimA.claimed, 'T1 claimed (epoch N)').toBe(true);
    const epochA = assertClaimed(claimA);

    // The lease expires; T2 reclaims — fencing epoch N+1.
    await delay(200);
    const ownerB = newCrossModeHandoffClaimOwner(CROSS_MODE_HANDOFF_RELAY_CLAIM_OWNER_PREFIX);
    const claimB = await t2Repo.claimHandoffObligation(handoffId, ownerB, 30_000);
    expect(claimB.claimed, 'T2 reclaimed the expired lease (epoch N+1)').toBe(true);
    const epochB = assertClaimed(claimB);
    expect(epochB).toBe(epochA + 1);

    // T1 (the STALE owner) attempts the epoch-fenced discharge — REJECTED
    // (0 rows: the WHERE clause requires T1's exact owner+epoch, which the
    // reclaim replaced). Even if T1's phase-boundary fence check raced, the
    // DB-level fence still rejects the authoritative transition.
    const staleDischarge = await crossModeHandoffRepo.dischargeHandoffObligation(
      handoffId,
      ownerA,
      epochA,
    );
    expect(staleDischarge, 'the STALE owner\'s discharge was REJECTED (epoch-fenced)').toBe(false);
    // The obligation is STILL pending — the stale actor did NOT complete it.
    expect(await countPendingObligations(executionId), 'the obligation is STILL pending (the stale actor could not discharge)').toBe(1);
    expect(await countDischargedObligations(executionId)).toBe(0);

    // T2 (the LIVE lease holder) discharges — succeeds.
    const liveDischarge = await t2Repo.dischargeHandoffObligation(
      handoffId,
      ownerB,
      epochB,
    );
    expect(liveDischarge, 'the LIVE owner\'s discharge succeeded (the exact owner+epoch matched)').toBe(true);
    expect(await countDischargedObligations(executionId)).toBe(1);
    expect(await countPendingObligations(executionId)).toBe(0);
  });
});
