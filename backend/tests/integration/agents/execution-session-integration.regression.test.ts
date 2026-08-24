/**
 * WORK-034 integration — session-aware execution regression tests.
 *
 * Proves the persistent ExecutionSession core is integrated with the
 * existing ExecutionService lifecycle (the smallest architecture-consistent
 * change: the service takes an OPTIONAL session service; providers are
 * untouched), against a REAL database:
 *
 *   1.  execution creates exactly one session
 *   2.  duplicate session creation is rejected
 *   3.  native execution uses the same session identity
 *   4.  external execution uses the same session identity
 *   5.  session start is CAS-protected
 *   6.  concurrent session start has one winner
 *   7.  interrupted → resumed uses the same executionId
 *   8.  concurrent resume has one winner
 *   9.  no second ExecutionRecord is created on resume
 *   10. session terminal state does not mutate workflow/verification/review state
 *   11. session events are emitted through the existing session event store
 *   12. retry after interruption does not create duplicate sessions
 *   13. provider failure produces session failure rather than false success
 *   14. session identity remains stable across native/external execution paths
 *
 * Authority invariants proven alongside: the session integration never
 * mutates workflow/verification/review state; the providers stay
 * session-unaware (the session service is wired at the ExecutionService
 * boundary only); the identity chain WorkItem → WorkOrder →
 * ExecutionRecord → ExecutionSession is preserved on every path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultAgentGateway, FakeAgentAdapter } from '../../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import {
  PgExecutionRecordRepository,
} from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { NativeExecutionProvider } from '../../../src/modules/agents/internal/native-execution-provider.js';
import { ExternalExecutionProvider } from '../../../src/modules/agents/internal/external-execution-provider.js';
import { DefaultExecutionService } from '../../../src/modules/agents/internal/execution-service.js';
import { PgExecutionSessionRepository } from '../../../src/modules/agents/internal/pg-execution-session-repository.js';
import { DefaultExecutionSessionService } from '../../../src/modules/agents/internal/execution-session-service.js';
import { ExecutionSessionError } from '../../../src/modules/agents/index.js';
import type { ExecutionTask } from '../../../src/modules/agents/index.js';
import type { ExecutionSession } from '../../../src/modules/agents/index.js';

/** A failing provider (for test 13 — provider failure → session failed). */
class FailingExecutionProvider {
  readonly name = 'failing';
  readonly mode = 'native' as const;
  async submit(_task: ExecutionTask): Promise<never> {
    throw new Error('failing-provider: simulated provider crash');
  }
}

describe('WORK-034 — session-aware execution integration', () => {
  let stack: TestAuthStack;
  let executionRecordRepo: PgExecutionRecordRepository;
  let sessionRepo: PgExecutionSessionRepository;
  let sessionService: DefaultExecutionSessionService;
  let contextRepo: PgImplementationContextRepository;
  let orgId: string;
  let projectId: string;
  let workItemId: string;
  let workOrderId: string;
  let architectureVersionId: string;

  let execCount = 0;
  const nextExecId = () => `exec-w034-integration-${++execCount}`;
  let sharedContextId = '';

  beforeAll(async () => {
    process.env.AGENT_PROVIDER_NAME = 'fake';
    process.env.AGENT_API_KEY = 'test-agent-key';
    process.env.AGENT_DEFAULT_MODEL = 'test-model';

    stack = await buildAuthStack({ AGENT_API_KEY: 'test-agent-key' });
    executionRecordRepo = new PgExecutionRecordRepository(stack.db.client);
    sessionRepo = new PgExecutionSessionRepository(stack.db.client);
    contextRepo = new PgImplementationContextRepository(stack.db.client);
    sessionService = new DefaultExecutionSessionService({
      sessionRepository: sessionRepo,
      executionRecordRepository: executionRecordRepo,
      logger: stack.db.logger,
    });

    const org = await stack.organizationRepository.create({ name: 'W034 Integration Org' });
    orgId = org.id;
    const project = await stack.projectRepository.create({ organizationId: orgId, name: 'W034 Integration Project' });
    projectId = project.id;
    const arch = await stack.architectureRepository.create({ projectId, name: 'W034 Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# W034' });
    architectureVersionId = version.id;
    const req = await stack.requirementRepository.create({
      architectureVersionId: version.id, requirementId: 'REQ-W034-001',
      title: 'Calculator adds', description: 'add(2,3)===5',
    });
    const crit = await stack.acceptanceCriterionRepository.create({
      requirementId: req.id, criterionId: 'AC-W034-001',
      description: 'add(2,3) returns 5', verificationExpectation: 'unit-test',
    });
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id, workItemId: 'WORK-W034-001',
      title: 'Calculator addition', objective: 'Add a calculator.', scope: 'src/calc.ts', outOfScope: 'sub',
      metadata: { baseCommit: 'w034-integration-baseline-commit-0000000000000001' },
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

    // One shared implementation context (the executions trigger requires the
    // context to belong to the work item).
    const ctx = await contextRepo.create({
      workItemId, revision: 1, kind: 'initial',
      content: { prompt: 'w034 integration context' } as never,
    });
    sharedContextId = ctx.id;
  });

  afterAll(async () => {
    await stack.teardown();
  });

  /** The execution task shape (mirrors the execution-domain tests). */
  function makeTask(n: number, mode: 'native' | 'external'): ExecutionTask {
    return {
      executionId: `exec-w034-integration-${n}`,
      projectId,
      workItemId,
      workOrderId,
      implementationContextId: sharedContextId,
      mode,
      provider: 'fake',
      model: 'test-model',
      workItemLabel: 'WORK-W034',
      prompt: `prompt ${n}`,
      promptDigest: `digest-${n}`,
      contextPayload: { prompt: `context ${n}` },
      instructions: ['Follow the implementation plan.'],
      expectedOutputs: [],
      verificationRequirements: [],
      repositoryOwner: null,
      repositoryName: null,
      repositoryDefaultBranch: null,
      implementationContextKind: 'initial',
      implementationContextRevision: 1,
      architectureVersionId,
    } as unknown as ExecutionTask;
  }

  /** Build a session-aware ExecutionService with the given providers. */
  function makeExecutionService(providers: readonly object[]): DefaultExecutionService {
    return new DefaultExecutionService({
      executionRecordRepository: executionRecordRepo,
      providers: providers as never,
      auditService: {
        write: async () => ({ id: 'audit-stub' }),
      } as never,
      logger: stack.db.logger,
      sessionService,
    });
  }

  /** A passing native provider (the real one, against the FakeAgentAdapter). */
  function nativeProvider(): NativeExecutionProvider {
    const fakeAgent = new FakeAgentAdapter();
    const gateway = new DefaultAgentGateway(stack.db.client, stack.db.logger, [fakeAgent], 3);
    return new NativeExecutionProvider({
      agentGateway: gateway,
      agentRunRepository: new PgAgentRunRepository(stack.db.client),
      logger: stack.db.logger,
    });
  }

  async function countSessionsFor(recordUuid: string): Promise<number> {
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_execution_sessions WHERE execution_id = $1`,
      [recordUuid],
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  async function countExecutionRecords(): Promise<number> {
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_executions WHERE project_id = $1`,
      [projectId],
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  // ---------------------------------------------------------------------------
  // 1 + 3 + 11 (native path): one session, same identity, events emitted.
  // ---------------------------------------------------------------------------
  it('native execution creates exactly ONE session bound to the SAME execution identity, with lifecycle events', async () => {
    const service = makeExecutionService([nativeProvider(), new ExternalExecutionProvider()]);
    const task = makeTask(100, 'native');
    const result = await service.submit(task);
    expect(result.status).toBe('completed');

    // (1) exactly one session for this execution record.
    const record = await executionRecordRepo.findByExecutionId(task.executionId);
    expect(record).not.toBeNull();
    expect(await countSessionsFor(record!.id)).toBe(1);

    // (3) the session continues THE SAME execution identity: the record's
    // UUID + the full WorkItem/WorkOrder linkage.
    const session = await sessionService.getSessionForExecution(task.executionId);
    expect(session).not.toBeNull();
    expect(session!.executionId).toBe(record!.id);
    expect(session!.projectId).toBe(projectId);
    expect(session!.workItemId).toBe(workItemId);
    expect(session!.workOrderId).toBe(workOrderId);

    // (11) lifecycle events through the EXISTING session event store:
    // turn_started (the CAS start) + completed (the native outcome).
    expect(session!.status).toBe('completed');
    expect(session!.terminalAt).not.toBeNull();
    const events = await sessionService.listSessionEvents(session!.id);
    const types = events.map((e) => e.eventType);
    expect(types).toContain('turn_started');
    expect(types).toContain('completed');
    // Sequences are unique + ordered.
    const seqs = events.map((e) => e.sequenceNumber);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  // ---------------------------------------------------------------------------
  // 2: duplicate session creation rejected.
  // ---------------------------------------------------------------------------
  it('duplicate session creation for the same execution is rejected (one session per ExecutionRecord)', async () => {
    const service = makeExecutionService([nativeProvider(), new ExternalExecutionProvider()]);
    const task = makeTask(101, 'native');
    await service.submit(task);

    const record = await executionRecordRepo.findByExecutionId(task.executionId);
    await expect(
      sessionRepo.createSession({
        executionId: record!.id, projectId, workItemId, workOrderId,
      }),
    ).rejects.toThrow('execution-session-duplicate-execution');
    expect(await countSessionsFor(record!.id)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 4 + 14 (external path): the same session identity shape; the session
  // stays running while the handoff is in flight.
  // ---------------------------------------------------------------------------
  it('external execution uses the SAME session identity (created + started; running while the handoff is in flight)', async () => {
    const service = makeExecutionService([nativeProvider(), new ExternalExecutionProvider()]);
    const task = makeTask(102, 'external');
    const result = await service.submit(task);
    expect(result.status).toBe('handoff_ready');

    const record = await executionRecordRepo.findByExecutionId(task.executionId);
    const session = await sessionService.getSessionForExecution(task.executionId);
    expect(session).not.toBeNull();
    expect(session!.executionId).toBe(record!.id);
    expect(session!.projectId).toBe(projectId);
    expect(session!.workItemId).toBe(workItemId);
    expect(session!.workOrderId).toBe(workOrderId);
    // The external execution is in flight — the session stays running and
    // observable through the same identity (the ingestion terminal hook
    // completes it when the execution record terminalizes).
    expect(session!.status).toBe('running');
    expect(session!.terminalAt).toBeNull();
    const events = await sessionService.listSessionEvents(session!.id);
    expect(events.map((e) => e.eventType)).toContain('turn_started');

    // (14) the session identity is mode-independent: NO provider/mode/model
    // fields exist on the session — the session belongs to the LOGICAL
    // execution, so a future cross-mode handoff cannot be blocked by it.
    const sessionRecord = session as unknown as Record<string, unknown>;
    expect('mode' in sessionRecord).toBe(false);
    expect('provider' in sessionRecord).toBe(false);
    expect('model' in sessionRecord).toBe(false);
  });

  it('external terminal ingestion hook completes the session through the same identity (composition-root wiring, as in app.ts)', async () => {
    // Simulate the app.ts onExecutionTerminal wiring: the hook that fires
    // when the external event boundary terminalizes the execution record.
    const service = makeExecutionService([nativeProvider(), new ExternalExecutionProvider()]);
    const task = makeTask(103, 'external');
    await service.submit(task);
    const record = await executionRecordRepo.findByExecutionId(task.executionId);

    // The external 'completed' event arrives → the record terminalizes →
    // the hook (the exact closure app.ts wires) completes the session.
    await executionRecordRepo.updateStatus(record!.id, { status: 'completed', completedAt: new Date() });
    const onExecutionTerminal = async (execId: string, state: string) => {
      if (state === 'completed') await sessionService.completeSession(execId);
      else if (state === 'failed') await sessionService.failSession(execId, 'external-execution-failed');
    };
    await onExecutionTerminal(task.executionId, 'completed');

    const session = await sessionService.getSessionForExecution(task.executionId);
    expect(session!.status).toBe('completed');
    expect(session!.terminalAt).not.toBeNull();
    const events = await sessionService.listSessionEvents(session!.id);
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['turn_started', 'completed']),
    );

    // Idempotent: the hook firing again (a duplicate terminal event) does
    // NOT duplicate side effects.
    await onExecutionTerminal(task.executionId, 'completed');
    const eventsAfter = await sessionService.listSessionEvents(session!.id);
    expect(eventsAfter.filter((e) => e.eventType === 'completed')).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 5 + 6: CAS-protected start; concurrent start has one winner.
  // ---------------------------------------------------------------------------
  it('session start is CAS-protected — a stale version/status loses with NO side effects; illegal edges are typed errors', async () => {
    // A session in 'created' (the crash window between record creation and
    // the start CAS). A stale-version CAS loses to null WITHOUT writing
    // anything (no event, no state change)...
    const execId = nextExecId();
    const ctx = await contextRepo.create({
      workItemId, revision: 1, kind: 'initial',
      content: { prompt: `ctx ${execId}` } as never,
    });
    await executionRecordRepo.create({
      executionId: execId, projectId, workItemId, workOrderId,
      implementationContextId: ctx.id,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${execId}`, promptDigest: `d ${execId}`,
    });
    const session = await sessionService.ensureSession(execId);
    expect(session.status).toBe('created');

    // Stale version (0 is correct; claim 99): loses → null.
    expect(await sessionRepo.transitionWithEvent(session.id, 99, 'created', 'running', 'turn_started')).toBeNull();
    // Stale status ('running' is wrong; the session is 'created'): loses → null.
    expect(await sessionRepo.transitionWithEvent(session.id, 0, 'running', 'interrupted', 'interrupted')).toBeNull();
    // Nothing was written.
    expect((await sessionRepo.getSession(session.id))?.status).toBe('created');
    expect(await sessionRepo.listEvents(session.id)).toHaveLength(0);

    // An ILLEGAL EDGE is a typed error (never a silent transition).
    const err = await sessionRepo.transitionWithEvent(session.id, 0, 'created', 'completed', 'completed').catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionSessionError);
    expect(err.code).toBe('execution-session-illegal-transition');
    // Still nothing written.
    expect((await sessionRepo.getSession(session.id))?.status).toBe('created');
    expect(await sessionRepo.listEvents(session.id)).toHaveLength(0);

    // The CORRECT CAS wins: created → running + turn_started.
    const won = await sessionRepo.transitionWithEvent(session.id, 0, 'created', 'running', 'turn_started');
    expect(won?.session.status).toBe('running');
    expect(won?.event.eventType).toBe('turn_started');
    // A REPLAY of the same CAS (the retry window) now loses → null with no
    // duplicate event.
    expect(await sessionRepo.transitionWithEvent(session.id, 0, 'created', 'running', 'turn_started')).toBeNull();
    expect(await sessionRepo.listEvents(session.id)).toHaveLength(1);
  });

  it('concurrent session start has exactly ONE winner (one turn_started event)', async () => {
    // A session that has NOT started yet: create the execution + session
    // directly (simulating a crash between record creation and start).
    const execId = nextExecId();
    const task = { ...makeTask(106, 'native'), executionId: execId };
    const svc = makeExecutionService([nativeProvider(), new ExternalExecutionProvider()]);
    // Create the record WITHOUT submitting (bypass dispatch): use the
    // repository directly so the session stays 'created'.
    const ctx = await contextRepo.create({
      workItemId, revision: 1, kind: 'initial',
      content: { prompt: `ctx ${execId}` } as never,
    });
    await executionRecordRepo.create({
      executionId: execId, projectId, workItemId, workOrderId,
      implementationContextId: ctx.id,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${execId}`, promptDigest: `d ${execId}`,
    });
    const session = await sessionService.ensureSession(execId);
    expect(session.status).toBe('created');
    void task; void svc;

    // TWO CONCURRENT starts: exactly one wins the CAS (the loser gets null
    // with NO side effects — exactly ONE turn_started event).
    const starts = await Promise.all([
      sessionService.startSession(session.id),
      sessionService.startSession(session.id),
    ]);
    const winners = starts.filter((s) => s !== null);
    expect(winners).toHaveLength(1);
    const after = await sessionRepo.getSession(session.id);
    expect(after!.status).toBe('running');
    const events = await sessionRepo.listEvents(session.id);
    expect(events.filter((e) => e.eventType === 'turn_started')).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 7 + 8 + 9 + 12: interrupt → resume (same identity; one winner; no new
  // records; retries don't duplicate sessions).
  // ---------------------------------------------------------------------------
  it('interrupt → resume preserves the SAME executionId/session/identity; concurrent resume has ONE winner; no second ExecutionRecord', async () => {
    const recordsBefore = await countExecutionRecords();

    const execId = nextExecId();
    const ctx = await contextRepo.create({
      workItemId, revision: 1, kind: 'initial',
      content: { prompt: `ctx ${execId}` } as never,
    });
    await executionRecordRepo.create({
      executionId: execId, projectId, workItemId, workOrderId,
      implementationContextId: ctx.id,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${execId}`, promptDigest: `d ${execId}`,
    });
    const session = await sessionService.ensureSession(execId);
    await sessionService.startSession(session.id);
    const running = await sessionRepo.getSession(session.id);

    // INTERRUPT (running → interrupted): a first-class resumable state —
    // NOT a disguised success (no terminal_at).
    const interrupted = await sessionService.interruptSession(session.id, running!.version);
    expect(interrupted?.session.status).toBe('interrupted');
    expect(interrupted?.session.terminalAt).toBeNull();
    expect(interrupted?.event.eventType).toBe('interrupted');

    // (7) the identity is preserved through the interruption.
    const intSession = interrupted!.session;
    expect(intSession.executionId).toBe(session.executionId);
    expect(intSession.id).toBe(session.id);
    expect(intSession.projectId).toBe(projectId);
    expect(intSession.workItemId).toBe(workItemId);
    expect(intSession.workOrderId).toBe(workOrderId);

    // (12) a RETRY of the establishment after the interruption (the
    // crash/retry window) does NOT create a duplicate session.
    const retried = await sessionService.ensureSession(execId);
    expect(retried.id).toBe(session.id);
    const record = await executionRecordRepo.findByExecutionId(execId);
    expect(await countSessionsFor(record!.id)).toBe(1);

    // (8) TWO CONCURRENT resumes: exactly ONE winner (one resumed event).
    const resumes = await Promise.all([
      sessionService.resumeSession(session.id, intSession.version),
      sessionService.resumeSession(session.id, intSession.version),
    ]);
    const resumeWinners = resumes.filter((r) => r !== null);
    expect(resumeWinners).toHaveLength(1);
    expect(resumeWinners[0]?.session.status).toBe('running');
    expect(resumeWinners[0]?.event.eventType).toBe('resumed');

    // (9) NO second ExecutionRecord was created by the interrupt/resume
    // cycle — the session continued the same logical execution.
    expect(await countExecutionRecords()).toBe(recordsBefore + 1);
    const after = await sessionRepo.getSession(session.id);
    expect(after!.executionId).toBe(session.executionId);

    // Events: turn_started, interrupted, resumed — all through the
    // existing store, unique sequences.
    const events = await sessionRepo.listEvents(session.id);
    expect(events.map((e) => e.eventType)).toEqual(['turn_started', 'interrupted', 'resumed']);
    expect(new Set(events.map((e) => e.sequenceNumber)).size).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // 10: session terminal state does NOT mutate workflow/verification/review.
  // ---------------------------------------------------------------------------
  it('session terminal state does NOT mutate workflow / verification / review state', async () => {
    const service = makeExecutionService([nativeProvider(), new ExternalExecutionProvider()]);
    const task = makeTask(107, 'native');
    await service.submit(task);
    const session = await sessionService.getSessionForExecution(task.executionId);
    expect(session!.status).toBe('completed');

    // No workflow transitions were created for the work item by the
    // session-aware execution (the session's 'completed' is NOT the Work
    // Item's VERIFIED — that is /verification's authority, driven by
    // observed GitHub/CI state, never by the session).
    const wf = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_workflow_transitions WHERE work_item_id = $1`,
      [workItemId],
    );
    expect(Number(wf.rows[0]?.c ?? 0)).toBe(0);
    const wfExec = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_workflow_executions WHERE work_item_id = $1`,
      [workItemId],
    );
    expect(Number(wfExec.rows[0]?.c ?? 0)).toBe(0);
    // No verification runs / reviews were created either.
    const ver = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_verification_runs WHERE work_item_id = $1`,
      [workItemId],
    );
    expect(Number(ver.rows[0]?.c ?? 0)).toBe(0);
    const rev = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_reviews WHERE work_item_id = $1`,
      [workItemId],
    );
    expect(Number(rev.rows[0]?.c ?? 0)).toBe(0);
    // And the work item is NOT completed/verified (its workflow + completion
    // state is untouched — the session's terminal state is not a workflow
    // authority).
    const wi = await stack.workItemRepository.findById(workItemId);
    expect(wi?.completed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 13: provider failure → session failure (never false success).
  // ---------------------------------------------------------------------------
  it('provider failure produces session FAILURE (running → failed + failed event) — never a false success', async () => {
    const service = makeExecutionService([new FailingExecutionProvider(), new ExternalExecutionProvider()]);
    const task = makeTask(108, 'native');
    await expect(service.submit(task)).rejects.toThrow('failing-provider');

    // The execution record failed...
    const record = await executionRecordRepo.findByExecutionId(task.executionId);
    expect(record!.status).toBe('failed');
    // ...AND the session failed — not completed, not left running.
    const session = await sessionService.getSessionForExecution(task.executionId);
    expect(session!.status).toBe('failed');
    expect(session!.terminalAt).not.toBeNull();
    const events = await sessionService.listSessionEvents(session!.id);
    const types = events.map((e) => e.eventType);
    expect(types).toContain('turn_started');
    expect(types).toContain('failed');
    expect(types).not.toContain('completed');
    // The failure event carries the reason.
    const failedEvent = events.find((e) => e.eventType === 'failed');
    expect(String(failedEvent!.payload.reason)).toContain('failing-provider');
  });

  // ---------------------------------------------------------------------------
  // 14: session identity is stable across native/external paths — the SAME
  // structural identity + no mode/provider coupling.
  // ---------------------------------------------------------------------------
  it('session identity remains stable across native/external execution paths (the session belongs to the LOGICAL execution)', async () => {
    const service = makeExecutionService([nativeProvider(), new ExternalExecutionProvider()]);
    const nativeTask = makeTask(109, 'native');
    const externalTask = makeTask(110, 'external');
    await service.submit(nativeTask);
    await service.submit(externalTask);

    const nativeSession = await sessionService.getSessionForExecution(nativeTask.executionId);
    const externalSession = await sessionService.getSessionForExecution(externalTask.executionId);

    // Both sessions carry the SAME identity STRUCTURE (the full chain) and
    // neither carries mode/provider/model — the session identity is the
    // logical execution, so the future cross-mode handoff (WORK-042) is not
    // blocked: the same session shape continues the execution regardless of
    // which mode executes it.
    for (const s of [nativeSession!, externalSession!] as ExecutionSession[]) {
      const rec = await executionRecordRepo.findById(s.executionId);
      expect(rec).not.toBeNull();
      expect(s.projectId).toBe(rec!.projectId);
      expect(s.workItemId).toBe(rec!.workItemId);
      expect(s.workOrderId).toBe(rec!.workOrderId);
      const asRecord = s as unknown as Record<string, unknown>;
      expect('mode' in asRecord).toBe(false);
      expect('provider' in asRecord).toBe(false);
      expect('model' in asRecord).toBe(false);
    }
    // Two DIFFERENT executions → two different sessions (never shared or
    // re-targeted).
    expect(nativeSession!.id).not.toBe(externalSession!.id);
    expect(nativeSession!.executionId).not.toBe(externalSession!.executionId);
  });

  // ---------------------------------------------------------------------------
  // Typed-error surface of the integrated service.
  // ---------------------------------------------------------------------------
  it('ensureSession throws the TYPED not-found error for an unknown execution (the session never creates an execution)', async () => {
    const err = await sessionService.ensureSession('exec-w034-never-created').catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionSessionError);
    expect(err.code).toBe('execution-session-not-found');
    expect(err.context.executionId).toBe('exec-w034-never-created');
  });
});
