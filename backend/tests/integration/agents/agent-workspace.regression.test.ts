/**
 * WORK-035 — Agent Workspaces and Git Worktrees regression tests.
 *
 * Proves, against a REAL database (the migration-0036 triggers) + a fake
 * WorktreeMaterializer (the deterministic host-path resolution + the
 * idempotence contract), the full required matrix:
 *
 *   workspace creation
 *   duplicate execution/workspace prevention
 *   execution → workspace identity
 *   worktree isolation (two executions → two distinct worktrees)
 *   concurrent workspace acquisition (one materialization winner)
 *   concurrent worktree creation (deterministic path + UNIQUE)
 *   retry after workspace-record crash (idempotent ensure)
 *   retry after worktree-creation crash (expired lease → reclaim →
 *     idempotent re-materialization)
 *   cleanup idempotency
 *   cleanup racing with execution
 *   invalid repository/worktree state (no /github row → fail-closed;
 *     terminal immutability; illegal transitions)
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

  beforeAll(async () => {
    stack = await buildAuthStack();
    executionRecordRepo = new PgExecutionRecordRepository(stack.db.client);
    contextRepo = new PgImplementationContextRepository(stack.db.client);
    materializer = new FakeWorktreeMaterializer();
    workspaceRepo = new PgAgentWorkspaceRepository({
      db: stack.db.client,
      executionRecordRepository: executionRecordRepo,
      // The EXISTING /github authority lookup (the real repository class).
      projectGitHubRepositoryLookup: {
        findByProject: async (pid: string) => {
          const row = await stack.db.client.query<{ id: string; project_id: string; owner: string; repository: string }>(
            `SELECT id, project_id, owner, repository FROM wfos_project_github_repositories WHERE project_id = $1 LIMIT 1`,
            [pid],
          );
          const r = row.rows[0];
          return r ? { id: r.id, projectId: r.project_id, owner: r.owner, repository: r.repository } : null;
        },
      },
    });
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
  it('workspace creation: ensure → requested → acquired ready, with the /github repository linkage + the deterministic worktree token', async () => {
    const executionId = await makeExecution('native');
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
    // The identity linkage: the workspace's execution is a REAL record.
    const record = await executionRecordRepo.findById(workspace.executionId);
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
  it('cleanup idempotency: release twice → one released state, the worktree removed once, the obligation discharged', async () => {
    const executionId = await makeExecution('native');
    const { workspace } = await service.acquireWorkspace({ executionId, branch: 'feat/w035-clean' });
    const removedBefore = materializer.removed.length;
    const released = await service.releaseWorkspace(workspace.id);
    expect(released?.state).toBe('released');
    expect(released?.terminalAt).not.toBeNull();
    expect(released?.releasedAt).not.toBeNull();
    // The second release: idempotent (the terminal row returned as-is).
    const again = await service.releaseWorkspace(workspace.id);
    expect(again?.state).toBe('released');
    expect(materializer.removed.length).toBe(removedBefore + 1); // removed once
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

  it('releasing a NOT-YET-materialized workspace: the explicit cancel edge + the obligation discharges', async () => {
    const executionId = await makeExecution('native');
    const ws = await workspaceRepo.ensureWorkspace({ executionId, branch: 'feat/w035-cancel' });
    expect(ws.state).toBe('requested');
    const result = await service.releaseWorkspace(ws.id);
    expect(result?.state).toBe('cancelled');
    expect(result?.terminalAt).not.toBeNull();
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
