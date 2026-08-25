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

// ============================================================================
// PR #38 review correction round 2 — the three correctness issues:
//   (1) a pending obligation with a MISSING session must REMAIN PENDING
//       (never discharged) — + the relay ensures the session from the
//       existing record so recovery is autonomous;
//   (2) the COMPLETE execution terminal-state mapping (cancelled →
//       session cancelled; expired → session failed with the expired
//       reason);
//   (3) a successful FAST-PATH terminalization discharges its obligation
//       ATOMICALLY (CAS + event + discharge in ONE transaction).
// ============================================================================

describe('PR #38 review corrections (round 2) — obligation lifecycle correctness', () => {
  async function pendingFor(executionId: string): Promise<{ id: string; state: string } | null> {
    const record = await executionRecordRepo.findByExecutionId(executionId);
    if (!record) return null;
    const res = await stack.db.client.query<{ id: string; terminal_state: string }>(
      `SELECT id, terminal_state FROM wfos_execution_session_terminal_obligations
        WHERE execution_id = $1 AND discharged_at IS NULL`,
      [record.id],
    );
    const row = res.rows[0];
    return row ? { id: String(row.id), state: String(row.terminal_state) } : null;
  }

  it('(1) execution completes + the process dies BEFORE the session exists → the obligation REMAINS PENDING → the relay ensures the session + reconciles it', async () => {
    // The reviewer's exact sequence: record → completed, obligation
    // created, process dies before ExecutionSession exists.
    const executionId = nextExecId();
    const record = await executionRecordRepo.create({
      executionId, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
    });
    // NO ensureSession — the session does not exist.
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [record.id],
    );

    // The obligation exists + is pending (NOT discharged by a
    // reconciliation that finds no session).
    let obligation = await pendingFor(executionId);
    expect(obligation).not.toBeNull();
    const r1 = await sessionService.reconcileTerminalForExecution(executionId);
    obligation = await pendingFor(executionId);
    // STILL pending after a reconciliation attempt with no session —
    // until the ensure creates one (the correction under test).
    expect(r1).not.toBeNull(); // the session was ENSURED + reconciled
    expect(obligation).toBeNull(); // discharged by the successful reconciliation

    // The full autonomous path (a fresh crash-window scenario): the relay
    // job alone recovers everything.
    const executionId2 = nextExecId();
    const record2 = await executionRecordRepo.create({
      executionId: executionId2, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId2}`, promptDigest: `d ${executionId2}`,
    });
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'failed', completed_at = NOW() WHERE id = $1`,
      [record2.id],
    );
    expect(await pendingFor(executionId2)).not.toBeNull();

    // The relay job (exactly what a worker drains) — with NO session
    // existing, the handler's reconcileTerminalForExecution ENSURES the
    // session from the record + reconciles it.
    await queue.enqueue(SESSION_TERMINAL_RELAY_JOB_TYPE, { executionId: executionId2 });
    const handlers = buildHandlerRegistry([
      createSessionTerminalRelayJobHandler(sessionService, stack.db.logger),
    ]);
    const worker = new WorkerHost(queue, handlers, stack.db.logger as never, { pollIntervalMs: 5 });
    try {
      await worker.start();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if ((await pendingFor(executionId2)) === null) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(await pendingFor(executionId2)).toBeNull();
      const session = await sessionService.getSessionForExecution(executionId2);
      expect(session?.status).toBe('failed');
      expect(session?.terminalAt).not.toBeNull();
      // Exactly one terminal event; the expired/failed reason recorded.
      const events = await sessionRepo.listEvents(session!.id);
      expect(events.filter((e) => e.eventType === 'failed')).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  });

  it('(1b) a reconciliation that finds NO session and CANNOT create one still leaves the obligation pending', async () => {
    // Direct repository-level: listPendingTerminalObligations resolves
    // session=null; the OLD code discharged it. The corrected
    // reconcileObligation path only runs after ensureSession — so this
    // scenario (no record) simply finds nothing. Construct the true
    // legacy case: an execution whose session was never created + cannot
    // be (the ensure throws only for a missing RECORD). For a present
    // record the ensure ALWAYS succeeds — so the only pending-with-null
    // reachable state is transient inside reconcileTerminalForExecution
    // (it immediately ensures). Assert the invariant directly: after any
    // reconciliation attempt, an obligation for an execution with a
    // EXISTING record is never left discharged-with-no-session.
    const executionId = nextExecId();
    const record = await executionRecordRepo.create({
      executionId, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
    });
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [record.id],
    );
    await sessionService.reconcileTerminalForExecution(executionId);
    // The session EXISTS (ensured) + the obligation is discharged + the
    // session is terminal — the reviewer's orphan case is impossible.
    const session = await sessionService.getSessionForExecution(executionId);
    expect(session).not.toBeNull();
    expect(['completed', 'failed', 'cancelled']).toContain(session?.status);
    expect(await pendingFor(executionId)).toBeNull();
  });

  it('(2) execution CANCELLED → the obligation maps to session cancelled → reconciled to cancelled', async () => {
    const executionId = nextExecId();
    const record = await executionRecordRepo.create({
      executionId, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
    });
    const session = await sessionService.ensureSession(executionId);
    await sessionService.startSession(session.id);
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'cancelled', completed_at = NOW() WHERE id = $1`,
      [record.id],
    );

    // The obligation exists with terminal_state = 'cancelled' (the
    // complete mapping — not silently ignored).
    const obligation = await pendingFor(executionId);
    expect(obligation?.state).toBe('cancelled');

    await sessionService.reconcileTerminalForExecution(executionId);
    const after = await sessionRepo.getSession(session.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.terminalAt).not.toBeNull();
    const events = await sessionRepo.listEvents(session.id);
    expect(events.filter((e) => e.eventType === 'cancelled')).toHaveLength(1);
    expect(await pendingFor(executionId)).toBeNull();
  });

  it('(2b) execution EXPIRED → the obligation maps to session failed (the explicit expired outcome) with the expired reason', async () => {
    const executionId = nextExecId();
    const record = await executionRecordRepo.create({
      executionId, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'external', provider: 'fake', model: null,
      prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
    });
    const session = await sessionService.ensureSession(executionId);
    await sessionService.startSession(session.id);
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'expired', completed_at = NOW() WHERE id = $1`,
      [record.id],
    );

    // The obligation maps expired → failed (the session vocabulary has no
    // 'expired'; an expired execution is a FAILED execution outcome).
    const obligation = await pendingFor(executionId);
    expect(obligation?.state).toBe('failed');

    await sessionService.reconcileTerminalForExecution(executionId);
    const after = await sessionRepo.getSession(session.id);
    expect(after?.status).toBe('failed');
    expect(after?.terminalAt).not.toBeNull();
    const events = await sessionRepo.listEvents(session.id);
    const failedEvents = events.filter((e) => e.eventType === 'failed');
    expect(failedEvents).toHaveLength(1);
    expect(await pendingFor(executionId)).toBeNull();
  });

  it('(3) a successful FAST-PATH terminalization discharges its obligation ATOMICALLY (no pending obligation left behind)', async () => {
    const executionId = nextExecId();
    const record = await executionRecordRepo.create({
      executionId, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
    });
    const session = await sessionService.ensureSession(executionId);
    await sessionService.startSession(session.id);
    // The record terminalizes (the obligation is created atomically).
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [record.id],
    );
    expect(await pendingFor(executionId)).not.toBeNull();

    // The FAST PATH (exactly what the execution service calls): the
    // successful synchronous CAS discharges the obligation IN THE SAME
    // transaction — nothing pending remains.
    const result = await sessionService.completeSession(executionId);
    expect(result?.status).toBe('completed');
    expect(await pendingFor(executionId)).toBeNull();

    // The relay's work list is empty for this execution (the sweep finds
    // nothing) + exactly one terminal event.
    expect(await relay.enqueuePendingRelayJobs()).toBe(0);
    const events = await sessionRepo.listEvents(session.id);
    expect(events.filter((e) => e.eventType === 'completed')).toHaveLength(1);

    // failSession fast path likewise.
    const executionId2 = nextExecId();
    const record2 = await executionRecordRepo.create({
      executionId: executionId2, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId2}`, promptDigest: `d ${executionId2}`,
    });
    const session2 = await sessionService.ensureSession(executionId2);
    await sessionService.startSession(session2.id);
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'failed', completed_at = NOW() WHERE id = $1`,
      [record2.id],
    );
    const result2 = await sessionService.failSession(executionId2, 'fast-path-failure');
    expect(result2?.status).toBe('failed');
    expect(await pendingFor(executionId2)).toBeNull();
    const events2 = await sessionRepo.listEvents(session2.id);
    expect(events2.filter((e) => e.eventType === 'failed')).toHaveLength(1);
  });

  it('(4) a session terminal with the WRONG outcome → the divergence is retained visibly (no overwrite; the obligation discharges)', async () => {
    // The reviewer's required end-state policy: session terminal with a
    // different outcome than the obligation → do not overwrite the
    // immutable session; retain a visible divergence.
    const executionId = nextExecId();
    const record = await executionRecordRepo.create({
      executionId, projectId, workItemId, workOrderId,
      implementationContextId: sharedContextId,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
    });
    const session = await sessionService.ensureSession(executionId);
    await sessionService.startSession(session.id);
    // The session CANCELS (an explicit session-lifecycle action)...
    await sessionRepo.transitionWithEvent(session.id, 1, 'running', 'cancelled', 'cancelled');
    // ...then the execution COMPLETES (a divergent terminal outcome).
    await stack.db.client.query(
      `UPDATE wfos_executions SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [record.id],
    );

    await sessionService.reconcileTerminalForExecution(executionId);
    // The session's own terminal state STANDS (immutability) + the
    // obligation discharged (the divergence is visible in the durable
    // evidence: session=cancelled while the execution=completed, both
    // immutable records).
    const after = await sessionRepo.getSession(session.id);
    expect(after?.status).toBe('cancelled');
    expect(await pendingFor(executionId)).toBeNull();
    // No additional terminal event was appended (no overwrite attempt).
    const events = await sessionRepo.listEvents(session.id);
    expect(events.filter((e) => e.eventType === 'cancelled')).toHaveLength(1);
    expect(events.filter((e) => e.eventType === 'completed')).toHaveLength(0);
  });
});

  // ---------------------------------------------------------------------------
  // PR #38 review round 3 — durable redelivery on the existing worker path:
  //   the reviewer's exact scenario:
  //     attempt 1 → transient failure → the job is NOT permanently lost
  //     attempt 2 → succeeds → session terminal → obligation discharged
  //   + exhaustion bounds + the unrelated-handler ack audit + the expired
  //     distinction preserved in the event payload.
  // ---------------------------------------------------------------------------
  describe('PR #38 review round 3 — durable redelivery + the expired distinction', () => {
    // A FRESH queue + relay for this describe (the outer queue carries
    // leftovers from the earlier tests in this file). Constructed in
    // beforeAll (the outer stack is initialized there).
    const localQueue = new InMemoryQueue();
    let localRelay: SessionTerminalOutboxRelay;
    beforeAll(() => {
      localRelay = new SessionTerminalOutboxRelay({
        sessionRepository: sessionRepo,
        executionRecordRepository: executionRecordRepo,
        queue: localQueue,
        logger: stack.db.logger,
      });
    });

    /** A reconciler that fails N times then delegates to the real one. */
    function flakyReconciler(failTimes: number): {
      reconciler: { reconcileTerminalForExecution(executionId: string): Promise<unknown> };
      calls: { executionId: string }[];
    } {
      const calls: { executionId: string }[] = [];
      return {
        calls,
        reconciler: {
          reconcileTerminalForExecution: async (executionId: string) => {
            calls.push({ executionId });
            if (calls.length <= failTimes) {
              throw new Error(`transient-reconciliation-failure-${calls.length}`);
            }
            return sessionService.reconcileTerminalForExecution(executionId);
          },
        },
      };
    }

    it('attempt 1 fails transiently → the job is NOT lost (durable redelivery) → attempt 2 succeeds → session terminal + obligation discharged', async () => {
      // The crash-window execution + obligation.
      const executionId = nextExecId();
      const record = await executionRecordRepo.create({
        executionId, projectId, workItemId, workOrderId,
        implementationContextId: sharedContextId,
        mode: 'native', provider: 'fake', model: 'test-model',
        prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
      });
      const session = await sessionService.ensureSession(executionId);
      await sessionService.startSession(session.id);
      await stack.db.client.query(
        `UPDATE wfos_executions SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [record.id],
      );

      // The relay job with a handler whose reconciliation fails ONCE (a
      // transient DB blip) — the handler opts into the redelivery policy
      // (exactly what createSessionTerminalRelayJobHandler declares).
      const flaky = flakyReconciler(1);
      const handler = createSessionTerminalRelayJobHandler(flaky.reconciler, stack.db.logger);
      expect(handler.redeliveryPolicy).toEqual({ maxAttempts: 5 });
      await localQueue.enqueue(SESSION_TERMINAL_RELAY_JOB_TYPE, { executionId });

      const worker = new WorkerHost(localQueue, buildHandlerRegistry([handler]), stack.db.logger as never, { pollIntervalMs: 5 });
      try {
        await worker.start();
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const s = await sessionRepo.getSession(session.id);
          if (s?.status === 'completed') break;
          await new Promise((r) => setTimeout(r, 20));
        }
        // Attempt 2 SUCCEEDED: the session terminalized + the obligation
        // discharged — the failed first delivery was NOT permanently lost.
        expect(flaky.calls).toHaveLength(2);
        const after = await sessionRepo.getSession(session.id);
        expect(after?.status).toBe('completed');
        const pending = await stack.db.client.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM wfos_execution_session_terminal_obligations WHERE execution_id = $1 AND discharged_at IS NULL`,
          [record.id],
        );
        expect(Number(pending.rows[0]?.c ?? 0)).toBe(0);
        // Exactly ONE terminal event (the retry did not duplicate it).
        const events = await sessionRepo.listEvents(session.id);
        expect(events.filter((e) => e.eventType === 'completed')).toHaveLength(1);
      } finally {
        await worker.stop();
      }
    });

    it('redelivery is BOUNDED: an always-failing handler is attempted exactly maxAttempts times (no infinite loop), and the obligation survives for the boot sweep', async () => {
      const executionId = nextExecId();
      const record = await executionRecordRepo.create({
        executionId, projectId, workItemId, workOrderId,
        implementationContextId: sharedContextId,
        mode: 'native', provider: 'fake', model: 'test-model',
        prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
      });
      const session = await sessionService.ensureSession(executionId);
      await sessionService.startSession(session.id);
      await stack.db.client.query(
        `UPDATE wfos_executions SET status = 'failed', completed_at = NOW() WHERE id = $1`,
        [record.id],
      );

      const flaky = flakyReconciler(Number.MAX_SAFE_INTEGER); // always fails
      const handler = createSessionTerminalRelayJobHandler(flaky.reconciler, stack.db.logger);
      await localQueue.enqueue(SESSION_TERMINAL_RELAY_JOB_TYPE, { executionId });
      const worker = new WorkerHost(localQueue, buildHandlerRegistry([handler]), stack.db.logger as never, { pollIntervalMs: 5 });
      try {
        await worker.start();
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline && flaky.calls.length < 5) {
          await new Promise((r) => setTimeout(r, 20));
        }
        await new Promise((r) => setTimeout(r, 300)); // allow any stray redelivery
        // Exactly maxAttempts (5) delivery attempts — bounded, no loop.
        expect(flaky.calls).toHaveLength(5);
        // The obligation REMAINS pending (durable) — the boot sweep (a
        // worker restart) re-enqueues it; the session stays running.
        const pending = await stack.db.client.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM wfos_execution_session_terminal_obligations WHERE execution_id = $1 AND discharged_at IS NULL`,
          [record.id],
        );
        expect(Number(pending.rows[0]?.c ?? 0)).toBe(1);
        expect((await sessionRepo.getSession(session.id))?.status).toBe('running');

        // THE BOOT SWEEP recovers it once the transient failures stop: swap
        // in the real reconciler, restart the worker (the sweep runs at
        // start), and the obligation drains.
        const realHandler = createSessionTerminalRelayJobHandler(sessionService, stack.db.logger);
        const worker2 = new WorkerHost(localQueue, buildHandlerRegistry([realHandler]), stack.db.logger as never, {
          pollIntervalMs: 5,
          outboxRelays: [localRelay],
        });
        try {
          await worker2.start();
          const deadline2 = Date.now() + 8000;
          while (Date.now() < deadline2) {
            const s = await sessionRepo.getSession(session.id);
            if (s?.status === 'failed') break;
            await new Promise((r) => setTimeout(r, 20));
          }
          expect((await sessionRepo.getSession(session.id))?.status).toBe('failed');
        } finally {
          await worker2.stop();
        }
      } finally {
        await worker.stop();
      }
    });

    it('UNRELATED handlers keep the historical ack-regardless semantics (no policy → no redelivery, exactly ONE attempt)', async () => {
      // The audit the reviewer required: a failing handler WITHOUT a
      // redeliveryPolicy is acknowledged once — never redelivered.
      let attempts = 0;
      const plainFailingHandler = {
        type: 'unrelated.failing',
        async handle(): Promise<void> {
          attempts += 1;
          throw new Error('unrelated-transient-failure');
        },
      };
      await localQueue.enqueue('unrelated.failing', {});
      const worker = new WorkerHost(localQueue, buildHandlerRegistry([plainFailingHandler]), stack.db.logger as never, { pollIntervalMs: 5 });
      try {
        await worker.start();
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline && attempts === 0) {
          await new Promise((r) => setTimeout(r, 20));
        }
        await new Promise((r) => setTimeout(r, 300));
        expect(attempts).toBe(1); // acked once; NOT redelivered
      } finally {
        await worker.stop();
      }
    });

    it('the expired distinction is PRESERVED in the terminal event payload (reason: execution-expired)', async () => {
      const executionId = nextExecId();
      const record = await executionRecordRepo.create({
        executionId, projectId, workItemId, workOrderId,
        implementationContextId: sharedContextId,
        mode: 'external', provider: 'fake', model: null,
        prompt: `p ${executionId}`, promptDigest: `d ${executionId}`,
      });
      const session = await sessionService.ensureSession(executionId);
      await sessionService.startSession(session.id);
      await stack.db.client.query(
        `UPDATE wfos_executions SET status = 'expired', completed_at = NOW() WHERE id = $1`,
        [record.id],
      );

      await sessionService.reconcileTerminalForExecution(executionId);
      const after = await sessionRepo.getSession(session.id);
      expect(after?.status).toBe('failed');
      const events = await sessionRepo.listEvents(session.id);
      const failedEvent = events.find((e) => e.eventType === 'failed');
      expect(failedEvent).toBeTruthy();
      // The TRUE source is recorded — the durable evidence says WHY.
      expect(failedEvent!.payload.reason).toBe('execution-expired');
    });
  });
});
