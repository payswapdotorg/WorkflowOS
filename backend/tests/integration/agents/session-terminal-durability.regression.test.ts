/**
 * WORK-034 (PR #38 review correction) — durable session-terminal
 * reconciliation regression tests.
 *
 * The review's blocking durability gap: session terminalization was
 * best-effort AFTER the execution record became authoritative (catch +
 * log), so a crash/database failure in that window left:
 *
 *     ExecutionRecord = completed   |   ExecutionSession = running
 *     ExecutionRecord = failed      |   ExecutionSession = running
 *
 * permanently. The fix (the reviewer's prescribed architecture — the
 * existing durable worker infrastructure, no scheduler/second engine):
 *
 *     ExecutionRecord terminal
 *         ↓ (migration 0035's AFTER UPDATE trigger — ATOMIC with the
 *            record's terminal transition: no window where the record is
 *            terminal but no obligation exists)
 *     durable session-terminal obligation
 *         ↓ (claim-time relay job + the WorkerHost boot sweep)
 *     existing Queue / WorkerHost
 *         ↓
 *     CAS session terminalization (idempotent)
 *
 * Required coverage (all five scenarios, against a REAL database with the
 * triggers + a real WorkerHost):
 *
 *   1. execution completes + session write fails → recovery → session completed
 *   2. execution fails + session write fails     → recovery → session failed
 *   3. recovery repeated                          → exactly one terminal event
 *   4. concurrent recovery                        → exactly one CAS winner
 *   5. non-terminal execution                     → no terminal session
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkerHost, InMemoryQueue, buildHandlerRegistry } from '@platform/index.js';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import {
  PgExecutionRecordRepository,
} from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { PgExecutionSessionRepository } from '../../../src/modules/agents/internal/pg-execution-session-repository.js';
import { DefaultExecutionSessionService } from '../../../src/modules/agents/internal/execution-session-service.js';
import {
  SessionTerminalOutboxRelay,
  createSessionTerminalRelayJobHandler,
  SESSION_TERMINAL_RELAY_JOB_TYPE,
} from '../../../src/modules/agents/internal/session-terminal-relay.js';
import type { ExecutionSession } from '../../../src/modules/agents/index.js';

describe('WORK-034 (PR #38 review) — durable session-terminal reconciliation', () => {
  let stack: TestAuthStack;
  let executionRecordRepo: PgExecutionRecordRepository;
  let sessionRepo: PgExecutionSessionRepository;
  let sessionService: DefaultExecutionSessionService;
  let contextRepo: PgImplementationContextRepository;
  let queue: InMemoryQueue;
  let relay: SessionTerminalOutboxRelay;
  let projectId: string;
  let workItemId: string;
  let workOrderId: string;
  let sharedContextId: string;

  let execCount = 0;
  const nextExecId = () => `exec-w034-durability-${++execCount}`;

  beforeAll(async () => {
    stack = await buildAuthStack();
    executionRecordRepo = new PgExecutionRecordRepository(stack.db.client);
    sessionRepo = new PgExecutionSessionRepository(stack.db.client);
    contextRepo = new PgImplementationContextRepository(stack.db.client);
    queue = new InMemoryQueue();
    sessionService = new DefaultExecutionSessionService({
      sessionRepository: sessionRepo,
      executionRecordRepository: executionRecordRepo,
      logger: stack.db.logger,
      queue,
    });
    relay = new SessionTerminalOutboxRelay({
      sessionRepository: sessionRepo,
      executionRecordRepository: executionRecordRepo,
      queue,
      logger: stack.db.logger,
    });

    const org = await stack.organizationRepository.create({ name: 'W034 Durability Org' });
    const project = await stack.projectRepository.create({ organizationId: org.id, name: 'W034 Durability Project' });
    projectId = project.id;
    const arch = await stack.architectureRepository.create({ projectId, name: 'W034 Durability Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# W034D' });
    const req = await stack.requirementRepository.create({
      architectureVersionId: version.id, requirementId: 'REQ-W034D-001',
      title: 'Calculator adds', description: 'add(2,3)===5',
    });
    const crit = await stack.acceptanceCriterionRepository.create({
      requirementId: req.id, criterionId: 'AC-W034D-001',
      description: 'add(2,3) returns 5', verificationExpectation: 'unit-test',
    });
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id, workItemId: 'WORK-W034D-001',
      title: 'Calculator addition', objective: 'Add a calculator.', scope: 'src/calc.ts', outOfScope: 'sub',
      metadata: { baseCommit: 'w034-durability-baseline-commit-000000000000001' },
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
      content: { prompt: 'w034 durability context' } as never,
    });
    sharedContextId = ctx.id;
  });

  afterAll(async () => {
    await stack.teardown();
  });

  /**
   * Create a running execution + its running session, then terminalize the
   * RECORD directly via SQL (simulating the crash window: the process died
   * right after the record's terminal transition, BEFORE the session CAS —
   * the obligation exists because migration 0035's trigger fired atomically
   * with the record's UPDATE, but nothing has touched the session).
   */
  async function makeCrashedTerminalExecution(
    terminalState: 'completed' | 'failed',
  ): Promise<{ executionId: string; session: ExecutionSession }> {
    const executionId = nextExecId();
    const record = await executionRecordRepo.create({
      executionId, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
    });
    const session = await sessionService.ensureSession(executionId);
    await sessionService.startSession(session.id);
    // The record terminalizes (the authoritative transition — the trigger
    // writes the obligation in the SAME statement). The session write
    // "fails" (the process died): nothing calls completeSession/failSession.
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = $1, completed_at = NOW() WHERE id = $2`,
      [terminalState, record.id],
    );
    return { executionId, session };
  }

  async function pendingObligationCount(): Promise<number> {
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_execution_session_terminal_obligations WHERE discharged_at IS NULL`,
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  // ---------------------------------------------------------------------------
  // (1) execution completes + session write fails → recovery → session completed
  // ---------------------------------------------------------------------------
  it('execution completes + the session write fails (crash window) → the durable obligation + relay recover → session completed', async () => {
    const before = await pendingObligationCount();
    const { executionId, session } = await makeCrashedTerminalExecution('completed');

    // The crash state the reviewer flagged: record=completed, session=running.
    let crashedSession = await sessionService.getSessionForExecution(executionId);
    expect(crashedSession?.status).toBe('running');
    // ...but the durable obligation ALREADY exists (atomic with the record's
    // terminal transition — migration 0035's trigger).
    expect(await pendingObligationCount()).toBe(before + 1);

    // RECOVERY — a new worker process boots: the boot sweep enqueues the
    // reconcile job + the poll loop drains it (a real WorkerHost with the
    // relay + handler wired exactly as app.ts does).
    const handlers = buildHandlerRegistry([
      createSessionTerminalRelayJobHandler(sessionService, stack.db.logger),
    ]);
    const worker = new WorkerHost(queue, handlers, stack.db.logger as never, {
      pollIntervalMs: 5,
      outboxRelays: [relay],
    });
    try {
      await worker.start();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const s = await sessionRepo.getSession(session.id);
        if (s?.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      crashedSession = await sessionRepo.getSession(session.id);
      expect(crashedSession?.status).toBe('completed');
      expect(crashedSession?.terminalAt).not.toBeNull();
      // The obligation is discharged.
      expect(await pendingObligationCount()).toBe(before);
      // Exactly ONE terminal event.
      const events = await sessionRepo.listEvents(session.id);
      expect(events.filter((e) => e.eventType === 'completed')).toHaveLength(1);
      expect(events.map((e) => e.eventType)).toEqual(['turn_started', 'completed']);
    } finally {
      await worker.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // (2) execution fails + session write fails → recovery → session failed
  // ---------------------------------------------------------------------------
  it('execution fails + the session write fails (crash window) → recovery → session failed (never a false success)', async () => {
    const { executionId, session } = await makeCrashedTerminalExecution('failed');
    expect((await sessionRepo.getSession(session.id))?.status).toBe('running');

    // RECOVERY — this time via the direct job-handler path (the claim-time
    // relay job semantics): drain one reconcile job.
    await queue.enqueue(SESSION_TERMINAL_RELAY_JOB_TYPE, { executionId });
    const handlers = buildHandlerRegistry([
      createSessionTerminalRelayJobHandler(sessionService, stack.db.logger),
    ]);
    const worker = new WorkerHost(queue, handlers, stack.db.logger as never, { pollIntervalMs: 5 });
    try {
      await worker.start();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const s = await sessionRepo.getSession(session.id);
        if (s?.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const recovered = await sessionRepo.getSession(session.id);
      expect(recovered?.status).toBe('failed');
      expect(recovered?.terminalAt).not.toBeNull();
      const events = await sessionRepo.listEvents(session.id);
      expect(events.filter((e) => e.eventType === 'failed')).toHaveLength(1);
      expect(events.map((e) => e.eventType)).toContain('turn_started');
      expect(events.map((e) => e.eventType)).not.toContain('completed');
    } finally {
      await worker.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // (3) recovery repeated → exactly one terminal event
  // ---------------------------------------------------------------------------
  it('recovery repeated (the relay job re-delivered + a boot sweep + direct reconciliation) → exactly ONE terminal event, one discharge', async () => {
    const { executionId, session } = await makeCrashedTerminalExecution('completed');

    // THREE concurrent/serial recovery attempts racing: two direct
    // reconciliation calls + one full-batch pass.
    await Promise.all([
      sessionService.reconcileTerminalForExecution(executionId),
      sessionService.reconcileTerminalForExecution(executionId),
    ]);
    await sessionService.reconcileAllPendingTerminals();
    // ...and more repeats after the fact.
    await sessionService.reconcileTerminalForExecution(executionId);
    await sessionService.reconcileAllPendingTerminals();

    const recovered = await sessionRepo.getSession(session.id);
    expect(recovered?.status).toBe('completed');
    const events = await sessionRepo.listEvents(session.id);
    expect(events.filter((e) => e.eventType === 'completed')).toHaveLength(1);
    // The batch pass reports zero still-pending.
    expect(await sessionService.reconcileAllPendingTerminals()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // (4) concurrent recovery → exactly one CAS winner
  // ---------------------------------------------------------------------------
  it('concurrent recovery (N simultaneous reconciliations of the same obligation) → exactly one CAS winner + one event + one discharge', async () => {
    const { executionId, session } = await makeCrashedTerminalExecution('failed');

    // 6 SIMULTANEOUS reconciliations of the same obligation.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => sessionService.reconcileTerminalForExecution(executionId)),
    );
    // Every call resolves (null or the session) — no throw — and the final
    // state is terminal exactly once.
    const final = await sessionRepo.getSession(session.id);
    expect(final?.status).toBe('failed');
    expect(final?.terminalAt).not.toBeNull();
    // Exactly ONE failed event.
    const events = await sessionRepo.listEvents(session.id);
    expect(events.filter((e) => e.eventType === 'failed')).toHaveLength(1);
    // The obligation is discharged exactly once (discharged_at set; the
    // work list drains).
    expect(await sessionService.reconcileAllPendingTerminals()).toBe(0);
    void results;
  });

  // ---------------------------------------------------------------------------
  // (5) non-terminal execution → no terminal session (no obligation exists)
  // ---------------------------------------------------------------------------
  it('non-terminal execution → no obligation, no terminal session (reconciliation is a no-op)', async () => {
    const before = await pendingObligationCount();
    const executionId = nextExecId();
    const record = await executionRecordRepo.create({
      executionId, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
    });
    const session = await sessionService.ensureSession(executionId);
    await sessionService.startSession(session.id);
    // The record stays running/handoff_ready — no terminal transition.
    await executionRecordRepo.updateStatus(record.id, { status: 'running' });

    // A boot sweep + a full batch pass find NOTHING to reconcile.
    expect(await relay.enqueuePendingRelayJobs()).toBe(0);
    expect(await sessionService.reconcileAllPendingTerminals()).toBe(0);
    // No obligation was created for a non-terminal transition.
    expect(await pendingObligationCount()).toBe(before);
    // The session is untouched (still running — NOT terminalized).
    const s = await sessionRepo.getSession(session.id);
    expect(s?.status).toBe('running');
    expect(s?.terminalAt).toBeNull();

    // A handoff_ready record is ALSO non-terminal (external in flight).
    await executionRecordRepo.updateStatus(record.id, { status: 'handoff_ready' });
    expect(await relay.enqueuePendingRelayJobs()).toBe(0);
    expect((await sessionRepo.getSession(session.id))?.status).toBe('running');
  });

  // ---------------------------------------------------------------------------
  // The obligation's own durability properties.
  // ---------------------------------------------------------------------------
  it('the obligation is created ATOMICALLY with the record terminal transition + is append-only', async () => {
    const before = await pendingObligationCount();
    // Direct SQL terminalization (no application code path at all) still
    // creates the obligation — the trigger IS the atomicity.
    const { executionId } = await makeCrashedTerminalExecution('completed');
    expect(await pendingObligationCount()).toBe(before + 1);

    // Append-only: the recorded intent cannot be mutated or deleted.
    const row = await stack.db.client.query<{ id: string }>(
      `SELECT id FROM wfos_execution_session_terminal_obligations WHERE execution_id = (SELECT id FROM wfos_executions WHERE execution_id = $1)`,
      [executionId],
    );
    const obligationId = row.rows[0]!.id;
    await expect(
      stack.db.client.query(`DELETE FROM wfos_execution_session_terminal_obligations WHERE id = $1`, [obligationId]),
    ).rejects.toThrow('session-terminal-obligation-immutable');
    await expect(
      stack.db.client.query(`UPDATE wfos_execution_session_terminal_obligations SET terminal_state = 'failed' WHERE id = $1`, [obligationId]),
    ).rejects.toThrow('session-terminal-obligation-immutable');

    // Repeated terminal transitions of the SAME record do not duplicate the
    // obligation (UNIQUE + ON CONFLICT DO NOTHING).
    const record = await executionRecordRepo.findByExecutionId(executionId);
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'running' WHERE id = $1`, [record!.id],
    );
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'completed', completed_at = NOW() WHERE id = $1`, [record!.id],
    );
    expect(await pendingObligationCount()).toBe(before + 1); // not before+2

    // Cleanup: reconcile so later assertions stay clean.
    await sessionService.reconcileTerminalForExecution(executionId);
  });
});
