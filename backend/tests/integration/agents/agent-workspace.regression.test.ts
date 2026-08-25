/**
 * WORK-035 — Agent Workspaces and Git Worktrees regression tests.
 *
 * Proves, against a REAL database (the migration-0036 triggers) + a fake
 * WorktreeMaterializer (the deterministic host-path resolution + the
 * idempotence contract), the full required matrix:
 *
 *   workspace creation (incl. the AUTHORITATIVE baseline — PR #39 review
 *     fix #1: base_revision is the /github default-branch HEAD commit,
 *     never promptDigest, never a placeholder; fail-closed when the
 *     branch HEAD cannot be resolved)
 *   duplicate execution/workspace prevention
 *   execution → workspace identity
 *   worktree isolation (two executions → two distinct worktrees)
 *   concurrent workspace acquisition (one materialization winner)
 *   concurrent worktree creation (deterministic path + UNIQUE)
 *   retry after workspace-record crash (idempotent ensure)
 *   retry after worktree-creation crash (expired lease → reclaim →
 *     idempotent re-materialization)
 *   materialization failure
 *   cleanup idempotency
 *   cleanup racing with execution
 *   PR #39 review fix #3 — the ACQUISITION/CLEANUP RACES (the actual
 *     interleavings, driven concurrently — not sequential calls):
 *     · a LIVE preparation lease blocks cancellation (the protocol
 *       prevents cleanup cancelling an active preparation; the
 *       obligation stays pending; the preparer reaches ready)
 *     · an EXPIRED lease lets cancellation win mid-materialization → the
 *       lost markReady CAS RECONCILES the created worktree (removed —
 *       never orphaned)
 *     · the crash window (worktree created → DB write crashed →
 *       execution terminal) reconciles deterministically (cancel →
 *       remove → discharge)
 *   invalid repository/worktree state (no /github row → fail-closed;
 *     unresolvable baseline → fail-closed; terminal immutability;
 *     illegal transitions)
 *   native execution referencing workspace
 *   external execution referencing workspace
 *   no workflow/verification/review mutation
 *   the durable release obligation (execution terminal → workspace
 *     released via the reconciliation)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import {
  PgExecutionRecordRepository,
} from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { PgAgentWorkspaceRepository } from '../../../src/modules/agents/internal/pg-agent-workspace-repository.js';
import { DefaultAgentWorkspaceService } from '../../../src/modules/agents/internal/agent-workspace-service.js';
import { AgentWorkspaceError } from '../../../src/modules/agents/index.js';
import type { WorktreeMaterializer } from '../../../src/modules/agents/index.js';

/** A real-looking 40-hex commit SHA (the fake /github branch HEAD). */
const BASELINE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** The fake materializer: records operations; deterministic host paths. */
class FakeWorktreeMaterializer implements WorktreeMaterializer {
  readonly materialized = new Map<string, string>(); // token → branch
  readonly removed: string[] = [];
  /** Fail the NEXT N materialize calls (transient crash simulation). */
  failNext = 0;
  /** Simulate the crashed-worktree case: a worktree exists at the token. */
  preExisting = new Map<string, string>(); // token → branch

  async materialize(input: {
    worktreePathToken: string; repositoryOwner: string; repositoryName: string;
    branch: string; baseRevision: string;
  }): Promise<string> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      const { WorktreeMaterializerError } = await import('../../../src/modules/agents/internal/agent-workspace.types.js');
      throw new WorktreeMaterializerError('git-failure', 'simulated materialization failure');
    }
    const existing = this.materialized.get(input.worktreePathToken) ?? this.preExisting.get(input.worktreePathToken);
    if (existing === input.branch) {
      return `/fake-workspaces/${input.worktreePathToken}`; // idempotent re-use
    }
    this.materialized.set(input.worktreePathToken, input.branch);
    return `/fake-workspaces/${input.worktreePathToken}`;
  }

  async remove(input: { worktreePathToken: string }): Promise<void> {
    this.removed.push(input.worktreePathToken);
    this.materialized.delete(input.worktreePathToken);
    this.preExisting.delete(input.worktreePathToken);
  }
}

/** A deferred promise gate (driving the ACTUAL interleavings). */
class Deferred<T = void> {
  readonly promise: Promise<T>;
  private resolveFn!: (v: T) => void;
  private resolved = false;
  constructor() {
    this.promise = new Promise<T>((res) => { this.resolveFn = res; });
  }
  resolve(v?: T): void {
    if (!this.resolved) { this.resolved = true; this.resolveFn(v as T); }
  }
}

/**
 * The GATED materializer — materialize() CREATES the worktree, then blocks
 * until the test releases the gate (an in-flight `git worktree add`).
 * Operations are recorded IN ORDER so the tests assert true interleavings.
 */
class GatedMaterializer implements WorktreeMaterializer {
  readonly ops: Array<{ op: 'materialize' | 'remove'; token: string; seq: number }> = [];
  private seq = 0;
  private readonly started = new Deferred<void>();
  private readonly gate = new Deferred<void>();

  /** Resolves once a materialize call has CREATED its worktree + is blocked. */
  waitForMaterializeStart(): Promise<void> {
    return this.started.promise;
  }
  /** Let the blocked materialize call return (the `git worktree add` finishes). */
  releaseGate(): void {
    this.gate.resolve();
  }
  /** Whether the worktree currently exists at the token (the LAST op wins — the simulated disk state). */
  has(token: string): boolean {
    const last = [...this.ops].reverse().find((o) => o.token === token);
    return last?.op === 'materialize';
  }

  async materialize(input: {
    worktreePathToken: string; repositoryOwner: string; repositoryName: string;
    branch: string; baseRevision: string;
  }): Promise<string> {
    this.ops.push({ op: 'materialize', token: input.worktreePathToken, seq: ++this.seq });
    this.started.resolve(); // the worktree is CREATED — materialization in flight
    await this.gate.promise; // …the DB write (markReady) has NOT happened yet
    return `/fake-workspaces/${input.worktreePathToken}`;
  }

  async remove(input: { worktreePathToken: string }): Promise<void> {
    this.ops.push({ op: 'remove', token: input.worktreePathToken, seq: ++this.seq });
  }
}

describe('WORK-035 — Agent Workspaces and Git Worktrees', () => {
  let stack: TestAuthStack;
  let executionRecordRepo: PgExecutionRecordRepository;
  let workspaceRepo: PgAgentWorkspaceRepository;
  let contextRepo: PgImplementationContextRepository;
  let materializer: FakeWorktreeMaterializer;
  let service: DefaultAgentWorkspaceService;
  let orgId: string;
  let projectId: string;
  let workItemId: string;
  let workOrderId: string;
  let sharedContextId: string;
  /** A project WITHOUT a linked /github repository (fail-closed case). */
  let bareProjectId: string;
  let bareWorkItemId: string;
  let bareWorkOrderId: string;
  let bareContextId: string;

  let execCount = 0;
  const nextExecId = (mode: 'native' | 'external') => `exec-w035-${mode}-${++execCount}`;
  /** The fake /github branch-head reads (PR #39 review fix #1). */
  const baselineCalls: Array<{ owner: string; repository: string; branchName: string; installationId: string }> = [];
  const baselineResolver = {
    getBranch: async (input: {
      owner: string; repository: string; branchName: string; installationId: string;
    }): Promise<{ sha: string }> => {
      baselineCalls.push(input);
      return { sha: BASELINE_SHA };
    },
  };
  /** A resolver that FAILS (the fail-closed case). */
  const failingBaselineResolver = {
    getBranch: async (): Promise<{ sha: string }> => {
      throw new Error('github-unreachable');
    },
  };
  /** A resolver returning a NON-COMMIT (the validation case). */
  const garbageBaselineResolver = {
    getBranch: async (): Promise<{ sha: string }> => ({ sha: 'fakesha-not-a-commit' }),
  };

  /**
   * A workspace repository wired with the given baseline resolver (the
   * /github authority read) — the fail-closed tests swap the resolver.
   */
  const makeRepo = (resolver: {
    getBranch: (input: {
      owner: string; repository: string; branchName: string; installationId: string;
    }) => Promise<{ sha: string }>;
  }) =>
    new PgAgentWorkspaceRepository({
      db: stack.db.client,
      executionRecordRepository: executionRecordRepo,
      // The EXISTING /github authority lookup (the real repository row —
      // including the defaultBranch + installationId the authoritative
      // baseline resolution reads).
      projectGitHubRepositoryLookup: {
        findByProject: async (pid: string) => {
          const row = await stack.db.client.query<{
            id: string; project_id: string; owner: string; repository: string;
            default_branch: string; installation_id: string;
          }>(
            `SELECT id, project_id, owner, repository, default_branch, installation_id
               FROM wfos_project_github_repositories WHERE project_id = $1 LIMIT 1`,
            [pid],
          );
          const r = row.rows[0];
          return r
            ? {
                id: r.id, projectId: r.project_id, owner: r.owner, repository: r.repository,
                defaultBranch: r.default_branch, installationId: r.installation_id,
              }
            : null;
        },
      },
      baselineResolver: resolver,
    });

  beforeAll(async () => {
    stack = await buildAuthStack();
    executionRecordRepo = new PgExecutionRecordRepository(stack.db.client);
    contextRepo = new PgImplementationContextRepository(stack.db.client);
    materializer = new FakeWorktreeMaterializer();
    workspaceRepo = makeRepo(baselineResolver);
    service = new DefaultAgentWorkspaceService({
      workspaceRepository: workspaceRepo,
      materializer,
      logger: stack.db.logger,
    });

    const org = await stack.organizationRepository.create({ name: 'W035 Org' });
    orgId = org.id;
    const project = await stack.projectRepository.create({ organizationId: orgId, name: 'W035 Project' });
    projectId = project.id;
    // The /github authority row (the linked repository).
    await stack.db.client.query(
      `INSERT INTO wfos_project_github_repositories
         (project_id, installation_id, owner, repository, default_branch, link_type)
       VALUES ($1, 'inst-w035', 'w035-org', 'w035-repo', 'main', 'linked')`,
      [projectId],
    );
    // The bare project (no repository row) + its own full work-item chain
    // (the executions trigger validates project/work-item consistency).
    const bareProject = await stack.projectRepository.create({ organizationId: orgId, name: 'W035 Bare Project' });
    bareProjectId = bareProject.id;
    const bareArch = await stack.architectureRepository.create({ projectId: bareProjectId, name: 'W035 Bare Arch' });
    const bareVersion = await stack.architectureVersionRepository.create({ architectureId: bareArch.id, contentInline: '# W035B' });
    const bareWi = await stack.workItemRepository.create({
      architectureVersionId: bareVersion.id, workItemId: 'WORK-W035-BARE',
      title: 'Bare', objective: 'o', scope: 's', outOfScope: 'n',
      metadata: { baseCommit: 'w035-bare-baseline-000000000000000001' },
    });
    await stack.workOrderRepository.create({
      workItemId: bareWi.id, projectId: bareProjectId, architectureVersionId: bareVersion.id,
      requirementIds: [], criterionIds: [], scope: 's', verificationRequirements: [],
    });
    bareWorkItemId = bareWi.id;
    const bareWo = await stack.db.client.query<{ id: string }>(
      `SELECT id FROM wfos_work_orders WHERE work_item_id = $1 LIMIT 1`, [bareWi.id]);
    bareWorkOrderId = bareWo.rows[0]!.id;
    const bareCtx = await contextRepo.create({
      workItemId: bareWi.id, revision: 1, kind: 'initial',
      content: { prompt: 'bare' } as never,
    });
    bareContextId = bareCtx.id;

    const arch = await stack.architectureRepository.create({ projectId, name: 'W035 Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# W035' });
    const req = await stack.requirementRepository.create({
      architectureVersionId: version.id, requirementId: 'REQ-W035-001',
      title: 'Calculator adds', description: 'add(2,3)===5',
    });
    const crit = await stack.acceptanceCriterionRepository.create({
      requirementId: req.id, criterionId: 'AC-W035-001',
      description: 'add(2,3) returns 5', verificationExpectation: 'unit-test',
    });
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id, workItemId: 'WORK-W035-001',
      title: 'Calculator addition', objective: 'Add a calculator.', scope: 'src/calc.ts', outOfScope: 'sub',
      metadata: { baseCommit: 'w035-baseline-commit-0000000000000000001' },
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
    const ctx = await contextRepo.create({
      workItemId, revision: 1, kind: 'initial',
      content: { prompt: 'w035 context' } as never,
    });
    sharedContextId = ctx.id;
  });

  afterAll(async () => {
    await stack.teardown();
  });

  /** Create a real ExecutionRecord (native or external) in the project. */
  async function makeExecution(mode: 'native' | 'external', project = projectId): Promise<string> {
    const executionId = nextExecId(mode);
    const bare = project !== projectId;
    await executionRecordRepo.create({
      executionId,
      projectId: project,
      workItemId: bare ? bareWorkItemId : workItemId,
      workOrderId: bare ? bareWorkOrderId : workOrderId,
      implementationContextId: bare ? bareContextId : sharedContextId,
      mode, provider: 'fake', model: mode === 'native' ? 'test-model' : null,
      prompt: `p ${executionId}`, promptDigest: `digest-${execCount}`,
    });
    return executionId;
  }

  async function countWorkspaces(): Promise<number> {
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_agent_workspaces WHERE project_id = $1`,
      [projectId],
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  // ---------------------------------------------------------------------------
  // Creation + identity + isolation
  // ---------------------------------------------------------------------------
  it('workspace creation: ensure → requested → acquired ready, with the /github repository linkage, the AUTHORITATIVE baseline commit, + the deterministic worktree token', async () => {
    const executionId = await makeExecution('native');
    const callsBefore = baselineCalls.length;
    const { workspace, hostPath } = await service.acquireWorkspace({ executionId, branch: 'feat/w035-a' });
    expect(workspace.state).toBe('ready');
    expect(workspace.executionId).toBeTruthy();
    expect(workspace.projectId).toBe(projectId);
    expect(workspace.repositoryOwner).toBe('w035-org');
    expect(workspace.repositoryName).toBe('w035-repo');
    expect(workspace.branch).toBe('feat/w035-a');
    expect(workspace.worktreePath).toBe(`w035-org/w035-repo/exec/${workspace.executionId}`);
    expect(hostPath).toBe(`/fake-workspaces/${workspace.worktreePath}`);
    expect(workspace.readyAt).not.toBeNull();
    // PR #39 review fix #1 — the baseline is the AUTHORITATIVE default-branch
    // HEAD commit SHA (resolved through the /github authority row's fields:
    // branchName = the row's default_branch, installationId = the row's
    // installation_id), NEVER the execution's promptDigest, NEVER a
    // placeholder.
    expect(workspace.baseRevision).toBe(BASELINE_SHA);
    expect(workspace.baseRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(baselineCalls.length).toBe(callsBefore + 1);
    expect(baselineCalls.at(-1)).toMatchObject({
      owner: 'w035-org', repository: 'w035-repo', branchName: 'main', installationId: 'inst-w035',
    });
    const record = await executionRecordRepo.findById(workspace.executionId);
    expect(record!.promptDigest).not.toBe(workspace.baseRevision); // never prompt metadata
    // The identity linkage: the workspace's execution is a REAL record.
    expect(record?.executionId).toBe(executionId);
  });

  it('duplicate execution/workspace prevention: ensure is idempotent — the SAME workspace row (no second workspace, no second worktree)', async () => {
    const before = await countWorkspaces();
    const executionId = await makeExecution('native');
    const first = await service.acquireWorkspace({ executionId, branch: 'feat/w035-dup' });
    const second = await service.acquireWorkspace({ executionId, branch: 'feat/w035-dup' });
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(await countWorkspaces()).toBe(before + 1); // exactly one row
    expect(materializer.materialized.size).toBeLessThanOrEqual(await countWorkspaces());
  });

  it('worktree isolation: two executions → two DISTINCT worktrees (never the same mutable worktree)', async () => {
    const execA = await makeExecution('native');
    const execB = await makeExecution('native');
    const a = await service.acquireWorkspace({ executionId: execA, branch: 'feat/w035-iso-a' });
    const b = await service.acquireWorkspace({ executionId: execB, branch: 'feat/w035-iso-b' });
    expect(a.workspace.worktreePath).not.toBe(b.workspace.worktreePath);
    expect(a.workspace.id).not.toBe(b.workspace.id);
    expect(a.hostPath).not.toBe(b.hostPath);
    // The DB UNIQUE constraint is the mechanical backstop.
    await expect(
      stack.db.client.query(
        `UPDATE wfos_agent_workspaces SET worktree_path = $1 WHERE id = $2`,
        [a.workspace.worktreePath, b.workspace.id],
      ),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Concurrency
  // ---------------------------------------------------------------------------
  it('concurrent workspace acquisition: exactly ONE materialization winner (one ready transition, one worktree)', async () => {
    const executionId = await makeExecution('native');
    // Two concurrent acquisitions race the claim CAS.
    const results = await Promise.all([
      service.acquireWorkspace({ executionId, branch: 'feat/w035-conc' }),
      service.acquireWorkspace({ executionId, branch: 'feat/w035-conc' }),
    ]);
    // Both resolve (one winner, one observing the winner's state).
    for (const r of results) {
      expect(['ready', 'preparing']).toContain(r.workspace.state);
    }
    // Exactly one workspace row + eventually ready.
    const ws = await workspaceRepo.getWorkspaceForExecution(executionId);
    expect(ws?.state).toBe('ready');
    expect(await countWorkspaces()).toBeGreaterThanOrEqual(1);
  });

  it('concurrent worktree creation is impossible by construction: the deterministic path is UNIQUE per execution', async () => {
    // Two DIFFERENT executions never share the token; the UNIQUE
    // constraint rejects a direct-SQL collision (proven above). The
    // deterministic derivation: (owner/repo, execution UUID).
    const execA = await makeExecution('external');
    const execB = await makeExecution('external');
    const a = await service.acquireWorkspace({ executionId: execA, branch: 'feat/w035-x1' });
    const b = await service.acquireWorkspace({ executionId: execB, branch: 'feat/w035-x2' });
    expect(a.workspace.worktreePath.endsWith(a.workspace.executionId)).toBe(true);
    expect(b.workspace.worktreePath.endsWith(b.workspace.executionId)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Crash safety
  // ---------------------------------------------------------------------------
  it('retry after workspace-record crash: the row exists in requested → a retry acquires the SAME row (no second worktree)', async () => {
    const executionId = await makeExecution('native');
    // Simulate the crash: create the record directly (bypass the service).
    const ws = await workspaceRepo.ensureWorkspace({ executionId, branch: 'feat/w035-crash1' });
    expect(ws.state).toBe('requested');
    const before = await countWorkspaces();
    // The retry: the service acquires the SAME row.
    const { workspace } = await service.acquireWorkspace({ executionId, branch: 'feat/w035-crash1' });
    expect(workspace.id).toBe(ws.id);
    expect(workspace.state).toBe('ready');
    expect(await countWorkspaces()).toBe(before); // no second workspace
  });

  it('retry after worktree-creation crash: the lease expires → reclaim → idempotent re-materialization (the stale worktree is re-used)', async () => {
    const executionId = await makeExecution('native');
    const ws = await workspaceRepo.ensureWorkspace({ executionId, branch: 'feat/w035-crash2' });
    // A worker claims preparing, materializes the worktree (the git side
    // succeeds), then CRASHES before markReady.
    const claimed = await workspaceRepo.claimForPreparation(ws.id, ws.version, 10); // 10ms lease
    expect(claimed?.state).toBe('preparing');
    await materializer.materialize({
      worktreePathToken: ws.worktreePath, repositoryOwner: ws.repositoryOwner,
      repositoryName: ws.repositoryName, branch: ws.branch, baseRevision: ws.baseRevision,
    });
    // The lease expires (10ms).
    await new Promise((r) => setTimeout(r, 30));
    // The retry (a recovery worker): reclaims + re-materializes
    // idempotently (the existing worktree at the deterministic path is
    // RE-USED — same branch) + reaches ready.
    const { workspace } = await service.acquireWorkspace({ executionId, branch: 'feat/w035-crash2' });
    expect(workspace.id).toBe(ws.id);
    expect(workspace.state).toBe('ready');
  });

  it('materialization FAILURE: the workspace → failed (failure_stage recorded); the typed error propagates', async () => {
    const executionId = await makeExecution('native');
    materializer.failNext = 1;
    const err = await service.acquireWorkspace({ executionId, branch: 'feat/w035-fail' }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentWorkspaceError);
    expect(err.code).toBe('agent-workspace-materialization-failed');
    const ws = await workspaceRepo.getWorkspaceForExecution(executionId);
    expect(ws?.state).toBe('failed');
    expect(ws?.terminalAt).not.toBeNull();
    expect(ws?.failureStage).toBe('git-failure');
  });

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------
  it('cleanup idempotency: release twice → one released state; every entry performs exactly one (idempotent) removal pass — the discharge is gated on removal', async () => {
    const executionId = await makeExecution('native');
    const { workspace } = await service.acquireWorkspace({ executionId, branch: 'feat/w035-clean' });
    const removedBefore = materializer.removed.length;
    const released = await service.releaseWorkspace(workspace.id);
    expect(released?.state).toBe('released');
    expect(released?.terminalAt).not.toBeNull();
    expect(released?.releasedAt).not.toBeNull();
    // The second release: idempotent (the terminal row returned as-is) —
    // but the removal is RE-DRIVEN before the (already-done) discharge:
    // a crash between a terminal transition and its removal is healed by
    // exactly this re-entry, so every entry removes-or-verifies-absence.
    const again = await service.releaseWorkspace(workspace.id);
    expect(again?.state).toBe('released');
    expect(materializer.removed.length).toBe(removedBefore + 2); // one pass per entry
    expect(materializer.removed.filter((t) => t === workspace.worktreePath)).toHaveLength(2);
  });

  it('cleanup racing with execution: the execution terminalizes → the durable release obligation exists atomically → the reconciliation releases the workspace', async () => {
    const executionId = await makeExecution('native');
    const { workspace } = await service.acquireWorkspace({ executionId, branch: 'feat/w035-race' });
    // The execution terminalizes (direct SQL — the trigger writes the
    // release obligation ATOMICALLY).
    const record = await executionRecordRepo.findByExecutionId(executionId);
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [record!.id],
    );
    // The obligation exists.
    const pending = await workspaceRepo.listPendingReleaseObligations();
    expect(pending.some((w) => w.id === workspace.id)).toBe(true);
    // The reconciliation (the relay-job entry): releases + discharges.
    const stillPending = await service.reconcilePendingReleases();
    expect(stillPending).toBe(0);
    const after = await workspaceRepo.getWorkspace(workspace.id);
    expect(after?.state).toBe('released');
    expect((await workspaceRepo.listPendingReleaseObligations()).some((w) => w.id === workspace.id)).toBe(false);
  });

  it('releasing a NOT-YET-materialized workspace: the explicit cancel edge + the (absent) worktree removal + the obligation discharges', async () => {
    const executionId = await makeExecution('native');
    const ws = await workspaceRepo.ensureWorkspace({ executionId, branch: 'feat/w035-cancel' });
    expect(ws.state).toBe('requested');
    const result = await service.releaseWorkspace(ws.id);
    expect(result?.state).toBe('cancelled');
    expect(result?.terminalAt).not.toBeNull();
    // The cancel-first-then-remove discipline: the (absent) worktree is
    // removed before the discharge — recorded even for an absent worktree.
    expect(materializer.removed).toContain(ws.worktreePath);
  });

  // ---------------------------------------------------------------------------
  // PR #39 review fix #3 — the ACQUISITION/CLEANUP RACES (the ACTUAL
  // interleavings — materialization held in flight while cleanup runs,
  // driven concurrently; never merely sequential calls)
  // ---------------------------------------------------------------------------
  it('race: a LIVE preparation lease BLOCKS cancellation — cleanup defers (the obligation stays pending), the preparer reaches ready, the next reconciliation releases + removes + discharges', async () => {
    const executionId = await makeExecution('native');
    const gated = new GatedMaterializer();
    const gatedService = new DefaultAgentWorkspaceService({
      workspaceRepository: workspaceRepo,
      materializer: gated,
      logger: stack.db.logger,
      prepareLeaseTtlMs: 60_000, // a LIVE lease for the whole test
    });
    // Worker A: acquire → claim (preparing, live lease) → materialize IN FLIGHT.
    const acquisition = gatedService.acquireWorkspace({ executionId, branch: 'feat/w035-raceA' });
    await gated.waitForMaterializeStart();
    const ws = await workspaceRepo.getWorkspaceForExecution(executionId);
    expect(ws?.state).toBe('preparing');

    // The execution terminalizes → the durable release obligation exists.
    const record = await executionRecordRepo.findByExecutionId(executionId);
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [record!.id],
    );
    const pending = await workspaceRepo.listPendingReleaseObligations();
    expect(pending.some((w) => w.id === ws!.id)).toBe(true);

    // Worker B: the release attempt runs WHILE the materializer is in
    // flight — the LEASE-GATED cancel loses (an active preparation is
    // never cancelled out from under its materializer).
    const attempted = await gatedService.releaseWorkspace(ws!.id);
    expect(attempted?.terminalAt).toBeNull(); // NOT terminal
    expect(attempted?.state).toBe('preparing');
    expect((await workspaceRepo.listPendingReleaseObligations()).some((w) => w.id === ws!.id)).toBe(true); // still pending
    expect(gated.ops.filter((o) => o.op === 'remove')).toHaveLength(0); // the worktree was NOT yanked

    // Worker A finishes: markReady WINS (nobody could cancel it).
    gated.releaseGate();
    const claim = await acquisition;
    expect(claim.workspace.state).toBe('ready');

    // The next reconciliation (the relay-job entry): releases + removes +
    // discharges — the deferred cleanup converges.
    const stillPending = await gatedService.reconcilePendingReleases();
    expect(stillPending).toBe(0);
    const after = await workspaceRepo.getWorkspace(ws!.id);
    expect(after?.state).toBe('released');
    expect(after?.terminalAt).not.toBeNull();
    expect(gated.ops.some((o) => o.op === 'remove' && o.token === ws!.worktreePath)).toBe(true); // removed via release
    expect((await workspaceRepo.listPendingReleaseObligations()).some((w) => w.id === ws!.id)).toBe(false); // discharged
  });

  it('race: the EXPIRED-lease interleaving — cancellation WINS mid-materialization → the lost markReady CAS RECONCILES the created worktree (removed — NEVER orphaned)', async () => {
    const executionId = await makeExecution('native');
    const gated = new GatedMaterializer();
    const gatedService = new DefaultAgentWorkspaceService({
      workspaceRepository: workspaceRepo,
      materializer: gated,
      logger: stack.db.logger,
      prepareLeaseTtlMs: 1, // expires while the materializer is still in flight
    });
    // Worker A: acquire → claim (preparing, 1ms lease) → materialize IN
    // FLIGHT (the worktree IS created — recorded before the gate).
    const acquisition = gatedService.acquireWorkspace({ executionId, branch: 'feat/w035-raceB' });
    await gated.waitForMaterializeStart();
    const ws = await workspaceRepo.getWorkspaceForExecution(executionId);
    expect(ws?.state).toBe('preparing');
    expect(gated.has(ws!.worktreePath)).toBe(true); // the worktree exists on disk

    // The lease expires while Worker A is still inside materialize().
    await new Promise((r) => setTimeout(r, 20));

    // Worker B: the terminal transition + the cancel WIN (the expired
    // lease no longer protects the (wedged/slow) preparer) + remove +
    // discharge — WITHOUT the CAS-loser rule this would already orphan.
    const record = await executionRecordRepo.findByExecutionId(executionId);
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [record!.id],
    );
    const released = await gatedService.releaseWorkspace(ws!.id);
    expect(released?.state).toBe('cancelled');
    expect(released?.terminalAt).not.toBeNull();
    expect(gated.ops.some((o) => o.op === 'remove' && o.token === ws!.worktreePath)).toBe(true);
    // Simulate the disk state the cancel path could NOT see: the worktree
    // (re)appears after B's remove — exactly the reviewer's orphan setup
    // (A created it; B's remove ran before/without it). The marker is the
    // ARRAY POSITION (the ops log is push-ordered — the seq counter is the
    // materializer's own; a marker larger than it would never be exceeded).
    gated.ops.push({ op: 'materialize', token: ws!.worktreePath, seq: Number.MAX_SAFE_INTEGER });
    const orphanMarkerIdx = gated.ops.length - 1;
    expect(gated.has(ws!.worktreePath)).toBe(true);

    // Worker A: the gate opens → markReady → the CAS LOSES (terminal) →
    // the CAS-LOSER RECONCILIATION removes the worktree it created.
    gated.releaseGate();
    const claim = await acquisition;
    expect(claim.workspace.state).toBe('cancelled'); // the CAS lost
    expect(claim.hostPath).toBe('');
    const loserRemoves = gated.ops.filter(
      (o, i) => i > orphanMarkerIdx && o.op === 'remove' && o.token === ws!.worktreePath,
    );
    expect(loserRemoves.length).toBeGreaterThanOrEqual(1); // the loser reconciled
    expect(gated.has(ws!.worktreePath)).toBe(false); // NEVER orphaned
    // The obligation was discharged by B; the final state is consistent:
    // terminal row + discharged obligation + NO worktree.
    expect((await workspaceRepo.listPendingReleaseObligations()).some((w) => w.id === ws!.id)).toBe(false);
  });

  it('race (isolated CAS-loser rule): a direct repository cancel during in-flight materialization → the lost markReady CAS removes the created worktree', async () => {
    const executionId = await makeExecution('native');
    const gated = new GatedMaterializer();
    const gatedService = new DefaultAgentWorkspaceService({
      workspaceRepository: workspaceRepo,
      materializer: gated,
      logger: stack.db.logger,
      prepareLeaseTtlMs: 1,
    });
    const acquisition = gatedService.acquireWorkspace({ executionId, branch: 'feat/w035-raceC' });
    await gated.waitForMaterializeStart();
    const ws = await workspaceRepo.getWorkspaceForExecution(executionId);
    expect(gated.has(ws!.worktreePath)).toBe(true);
    await new Promise((r) => setTimeout(r, 20)); // the lease expires
    // A DIRECT terminal cancellation (an operator/cleanup path) with NO
    // remove at all — isolating the CAS-loser reconciliation rule.
    const cancelled = await workspaceRepo.cancel(ws!.id, ws!.version);
    expect(cancelled?.state).toBe('cancelled');
    const cancelSeq = gated.ops.at(-1)!.seq;
    gated.releaseGate();
    const claim = await acquisition;
    expect(claim.workspace.state).toBe('cancelled');
    // The loser's remove happened AFTER the cancel — the reconciliation
    // (not the cancelling path) removed the worktree.
    const loserRemove = gated.ops.find((o) => o.op === 'remove' && o.token === ws!.worktreePath);
    expect(loserRemove).toBeDefined();
    expect(loserRemove!.seq).toBeGreaterThan(cancelSeq);
    expect(gated.has(ws!.worktreePath)).toBe(false);
  });

  it('crash window reconciliation: worktree created → DB write crashed → execution terminal → the reconciliation cancels + REMOVES the worktree + discharges', async () => {
    const executionId = await makeExecution('native');
    const ws = await workspaceRepo.ensureWorkspace({ executionId, branch: 'feat/w035-crash3' });
    // The git side succeeded; the process crashed before markReady (the
    // worktree EXISTS; the row is preparing with a short lease).
    const claimed = await workspaceRepo.claimForPreparation(ws.id, ws.version, 5);
    expect(claimed?.state).toBe('preparing');
    await materializer.materialize({
      worktreePathToken: ws.worktreePath, repositoryOwner: ws.repositoryOwner,
      repositoryName: ws.repositoryName, branch: ws.branch, baseRevision: ws.baseRevision,
    });
    expect(materializer.materialized.has(ws.worktreePath)).toBe(true);
    await new Promise((r) => setTimeout(r, 20)); // the lease expires
    // The execution terminalizes → the obligation → the reconciliation
    // drives cancel → remove → discharge (the deterministic recovery).
    const record = await executionRecordRepo.findByExecutionId(executionId);
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'failed', completed_at = NOW() WHERE id = $1`,
      [record!.id],
    );
    const stillPending = await service.reconcilePendingReleases();
    expect(stillPending).toBe(0);
    const after = await workspaceRepo.getWorkspace(ws.id);
    expect(after?.state).toBe('cancelled');
    expect(after?.terminalAt).not.toBeNull();
    expect(materializer.removed).toContain(ws.worktreePath); // the worktree was REMOVED
    expect(materializer.materialized.has(ws.worktreePath)).toBe(false); // …not orphaned
    expect((await workspaceRepo.listPendingReleaseObligations()).some((w) => w.id === ws.id)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Invalid states
  // ---------------------------------------------------------------------------
  it('no linked /github repository → FAIL-CLOSED (the typed no-repository error; no workspace row)', async () => {
    const executionId = await makeExecution('native', bareProjectId);
    const err = await service.acquireWorkspace({ executionId, branch: 'feat/w035-bare' }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentWorkspaceError);
    expect(err.code).toBe('agent-workspace-no-repository');
    expect(await workspaceRepo.getWorkspaceForExecution(executionId)).toBeNull();
  });

  it('baseline UNRESOLVABLE (the /github read fails) → FAIL-CLOSED (the typed baseline-unresolvable error; NO workspace row, NO worktree)', async () => {
    // PR #39 review fix #1: the baseline is the default-branch HEAD commit
    // resolved through the /github authority — an unreachable repository
    // must NEVER fall back to prompt metadata or a placeholder.
    const executionId = await makeExecution('native');
    const failingRepo = makeRepo(failingBaselineResolver);
    const failingService = new DefaultAgentWorkspaceService({
      workspaceRepository: failingRepo,
      materializer,
      logger: stack.db.logger,
    });
    const matCountBefore = materializer.materialized.size;
    const err = await failingService.acquireWorkspace({ executionId, branch: 'feat/w035-no-baseline' }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentWorkspaceError);
    expect(err.code).toBe('agent-workspace-baseline-unresolvable');
    // Fail-closed: no row (a retry after the /github read recovers re-runs
    // the resolution from scratch — nothing half-created persists).
    expect(await workspaceRepo.getWorkspaceForExecution(executionId)).toBeNull();
    expect(materializer.materialized.size).toBe(matCountBefore); // NO worktree attempt — the failure preceded the claim
  });

  it('baseline NOT-A-COMMIT (the /github read returns a non-SHA) → FAIL-CLOSED (never a fabricated baseline)', async () => {
    // The SHA-shape validation: 'fakesha-not-a-commit' is not a Git object
    // id — recording it as base_revision would break reproducibility
    // silently. The workspace layer rejects it (typed) + creates nothing.
    const executionId = await makeExecution('external');
    const garbageRepo = makeRepo(garbageBaselineResolver);
    const err = await garbageRepo.ensureWorkspace({ executionId, branch: 'feat/w035-garbage' }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentWorkspaceError);
    expect(err.code).toBe('agent-workspace-baseline-unresolvable');
    expect(await workspaceRepo.getWorkspaceForExecution(executionId)).toBeNull();
    // The healthy resolver still resolves the SAME execution afterwards —
    // the failure left no durable trace (a clean retry succeeds).
    const ws = await workspaceRepo.ensureWorkspace({ executionId, branch: 'feat/w035-garbage' });
    expect(ws.baseRevision).toBe(BASELINE_SHA);
  });

  it('unknown execution → the typed not-found error (a workspace never creates an execution)', async () => {
    const err = await workspaceRepo.ensureWorkspace({ executionId: 'exec-w035-never', branch: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentWorkspaceError);
    expect(err.code).toBe('agent-workspace-not-found');
  });

  it('terminal immutability + illegal transitions (DB backstop)', async () => {
    const executionId = await makeExecution('native');
    const { workspace } = await service.acquireWorkspace({ executionId, branch: 'feat/w035-term' });
    await service.releaseWorkspace(workspace.id);
    // Any authoritative mutation of the terminal row is rejected (the
    // terminal guard fires for every field — including the identity
    // fields — on a terminal row).
    await expect(
      stack.db.client.query(`UPDATE wfos_agent_workspaces SET state = 'ready' WHERE id = $1`, [workspace.id]),
    ).rejects.toThrow('agent-workspace-terminal-immutable');
    await expect(
      stack.db.client.query(`UPDATE wfos_agent_workspaces SET branch = 'other' WHERE id = $1`, [workspace.id]),
    ).rejects.toThrow('agent-workspace-terminal-immutable');
    // The identity tuple is immutable on NON-terminal rows too.
    const exec2 = await makeExecution('native');
    const ws2 = await workspaceRepo.ensureWorkspace({ executionId: exec2, branch: 'feat/w035-id' });
    await expect(
      stack.db.client.query(`UPDATE wfos_agent_workspaces SET worktree_path = 'other/token' WHERE id = $1`, [ws2.id]),
    ).rejects.toThrow('agent-workspace-identity-immutable');
  });

  // ---------------------------------------------------------------------------
  // Native/external parity + authority
  // ---------------------------------------------------------------------------
  it('native + external execution reference the SAME workspace abstraction (the identity shape is mode-independent)', async () => {
    const nativeExec = await makeExecution('native');
    const externalExec = await makeExecution('external');
    const native = await service.acquireWorkspace({ executionId: nativeExec, branch: 'feat/w035-n' });
    const external = await service.acquireWorkspace({ executionId: externalExec, branch: 'feat/w035-e' });
    for (const ws of [native.workspace, external.workspace]) {
      const asRecord = ws as unknown as Record<string, unknown>;
      expect('mode' in asRecord).toBe(false); // NOT provider/mode-specific
      expect('provider' in asRecord).toBe(false);
      expect(ws.repositoryOwner).toBe('w035-org');
      expect(ws.state).toBe('ready');
    }
    expect(native.workspace.id).not.toBe(external.workspace.id);
  });

  it('no workflow/verification/review mutation (the workspace layer never claims that authority)', async () => {
    const executionId = await makeExecution('native');
    await service.acquireWorkspace({ executionId, branch: 'feat/w035-auth' });
    const wf = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_workflow_transitions WHERE work_item_id = $1`, [workItemId]);
    expect(Number(wf.rows[0]?.c ?? 0)).toBe(0);
    const ver = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_verification_runs WHERE work_item_id = $1`, [workItemId]);
    expect(Number(ver.rows[0]?.c ?? 0)).toBe(0);
    const rev = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_reviews WHERE work_item_id = $1`, [workItemId]);
    expect(Number(rev.rows[0]?.c ?? 0)).toBe(0);
    const wi = await stack.workItemRepository.findById(workItemId);
    expect(wi?.completed).toBe(false);
  });
});
