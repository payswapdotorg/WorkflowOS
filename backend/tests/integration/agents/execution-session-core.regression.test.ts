/**
 * WORK-034 (first slice) — Persistent Session Core regression tests.
 *
 * Proves, against a REAL database (pglite locally / real PostgreSQL in CI)
 * with the migration-0034 triggers applied, the durable session core:
 *
 *   create session
 *   duplicate execution → rejected
 *   CAS transition winner → succeeds
 *   CAS transition loser → no-op/conflict (null)
 *   append event → sequence increments
 *   duplicate sequence → rejected
 *   concurrent event append → unique sequences
 *   interrupt → resumable
 *   resume → exactly one state transition
 *   terminal session → further mutation rejected (CAS + DB trigger + events)
 *   wrong project/work-item/work-order linkage → rejected
 *
 * Plus the strict state machine (illegal edges rejected at the repository
 * AND at the DB trigger level) + the turn CAS + event immutability
 * (append-only: UPDATE and DELETE rejected).
 *
 * Boundary: the session is a continuation context for ONE ExecutionRecord
 * (WorkItem → WorkOrder → ExecutionRecord → ExecutionSession → events) —
 * no workflow/verification/review mutation, no provider specifics.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgExecutionRecordRepository } from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { PgExecutionSessionRepository } from '../../../src/modules/agents/internal/pg-execution-session-repository.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { ExecutionSessionError } from '../../../src/modules/agents/index.js';
import type { ExecutionSession } from '../../../src/modules/agents/index.js';


/** Assert a rejection is a TYPED ExecutionSessionError with the exact code. */
async function expectSessionError(
  promise: Promise<unknown>,
  code: string,
): Promise<ExecutionSessionError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ExecutionSessionError);
    const e = err as ExecutionSessionError;
    expect(e.code).toBe(code);
    expect(e.name).toBe('ExecutionSessionError');
    expect(typeof e.message).toBe('string');
    expect(e.message.length).toBeGreaterThan(0);
    return e;
  }
  throw new Error(`expected a rejection with ExecutionSessionError(${code}) — the promise resolved`);
}

describe('WORK-034 — Persistent Session Core (durable session slice)', () => {
  let stack: TestAuthStack;
  let executionRecordRepo: PgExecutionRecordRepository;
  let sessionRepo: PgExecutionSessionRepository;
  let contextRepo: PgImplementationContextRepository;
  let organizationId: string;
  let projectId: string;
  let workItemId: string;
  let workOrderId: string;

  beforeAll(async () => {
    stack = await buildAuthStack();
    executionRecordRepo = new PgExecutionRecordRepository(stack.db.client);
    sessionRepo = new PgExecutionSessionRepository(stack.db.client);
    contextRepo = new PgImplementationContextRepository(stack.db.client);

    const org = await stack.organizationRepository.create({ name: 'Session Core Org' });
    organizationId = org.id;
    const project = await stack.projectRepository.create({ organizationId, name: 'Session Core Project' });
    projectId = project.id;
    const arch = await stack.architectureRepository.create({ projectId, name: 'Session Core Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# Session Core' });
    const req = await stack.requirementRepository.create({
      architectureVersionId: version.id, requirementId: 'REQ-SESS-001',
      title: 'Calculator adds', description: 'add(2,3)===5',
    });
    const crit = await stack.acceptanceCriterionRepository.create({
      requirementId: req.id, criterionId: 'AC-SESS-001',
      description: 'add(2,3) returns 5', verificationExpectation: 'unit-test',
    });
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id, workItemId: 'WORK-SESS-001',
      title: 'Calculator addition', objective: 'Add a calculator.', scope: 'src/calc.ts', outOfScope: 'sub',
      metadata: { baseCommit: 'session-core-baseline-commit-00000000000001' },
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
  });

  afterAll(async () => {
    await stack.teardown();
  });

  /** Create a real ExecutionRecord (the session's continuation identity). */
  async function makeExecution(n: number): Promise<string> {
    const ctx = await contextRepo.create({
      workItemId, revision: 1, kind: 'initial',
      content: { prompt: `session-core prompt ${n}` } as never,
    });
    const record = await executionRecordRepo.create({
      executionId: `exec-session-core-${n}`,
      projectId, workItemId, workOrderId,
      implementationContextId: ctx.id,
      mode: 'native', provider: 'fake', model: 'test-model',
      prompt: `prompt ${n}`, promptDigest: `digest-${n}`,
    });
    return record.id;
  }

  async function makeSession(n: number): Promise<ExecutionSession> {
    const executionId = await makeExecution(n);
    return sessionRepo.createSession({ executionId, projectId, workItemId, workOrderId });
  }

  // ---------------------------------------------------------------------------
  // create + duplicate execution
  // ---------------------------------------------------------------------------
  it('create session — status created, version 0, turn 0, linkage persisted', async () => {
    const session = await makeSession(1);
    expect(session.status).toBe('created');
    expect(session.version).toBe(0);
    expect(session.currentTurn).toBe(0);
    expect(session.executionId).toBeTruthy();
    expect(session.projectId).toBe(projectId);
    expect(session.workItemId).toBe(workItemId);
    expect(session.workOrderId).toBe(workOrderId);
    expect(session.interruptedAt).toBeNull();
    expect(session.terminalAt).toBeNull();
    // Lookup by execution id → the SAME single session.
    const found = await sessionRepo.getSessionByExecutionId(session.executionId);
    expect(found?.id).toBe(session.id);
  });

  it('duplicate execution → rejected (one session per ExecutionRecord)', async () => {
    const executionId = await makeExecution(2);
    await sessionRepo.createSession({ executionId, projectId, workItemId, workOrderId });
    const dupErr = await expectSessionError(
      sessionRepo.createSession({ executionId, projectId, workItemId, workOrderId }),
      'execution-session-duplicate-execution',
    );
    expect(dupErr.context.executionId).toBe(executionId);
  });

  it('wrong project/work-item/work-order linkage → rejected (composite FK)', async () => {
    const executionId = await makeExecution(3);
    // A different (real) project — the tuple does not match the execution.
    const otherProject = await stack.projectRepository.create({ organizationId, name: 'Session Core Other Project' });
    const linkErr = await expectSessionError(
      sessionRepo.createSession({ executionId, projectId: otherProject.id, workItemId, workOrderId }),
      'execution-session-linkage-mismatch',
    );
    expect(linkErr.context.projectId).toBe(otherProject.id);
    // A mismatched work item id (bogus UUID) — same mechanical rejection.
    await expect(
      sessionRepo.createSession({
        executionId, projectId,
        workItemId: '99999999-9999-9999-9999-999999999999',
        workOrderId,
      }),
    ).rejects.toThrow();
    // No session was persisted for the mismatched attempts.
    expect(await sessionRepo.getSessionByExecutionId(executionId)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // CAS transitions
  // ---------------------------------------------------------------------------
  it('CAS transition winner → succeeds (version increments, timestamps derived)', async () => {
    const session = await makeSession(4);
    const running = await sessionRepo.transitionSession(session.id, 0, 'created', 'running');
    expect(running).not.toBeNull();
    expect(running?.status).toBe('running');
    expect(running?.version).toBe(1);

    // interrupt → interrupted_at derived.
    const interrupted = await sessionRepo.transitionSession(session.id, 1, 'running', 'interrupted');
    expect(interrupted?.status).toBe('interrupted');
    expect(interrupted?.version).toBe(2);
    expect(interrupted?.interruptedAt).not.toBeNull();

    // resume → back to running; the historical interrupted_at persists.
    const resumed = await sessionRepo.transitionSession(session.id, 2, 'interrupted', 'running');
    expect(resumed?.status).toBe('running');
    expect(resumed?.version).toBe(3);
    expect(resumed?.interruptedAt).not.toBeNull();

    // terminal → terminal_at derived.
    const done = await sessionRepo.transitionSession(session.id, 3, 'running', 'completed');
    expect(done?.status).toBe('completed');
    expect(done?.version).toBe(4);
    expect(done?.terminalAt).not.toBeNull();
  });

  it('CAS transition loser → null (stale version / stale status; no mutation)', async () => {
    const session = await makeSession(5);
    const winner = await sessionRepo.transitionSession(session.id, 0, 'created', 'running');
    expect(winner?.version).toBe(1);

    // Stale version: the caller claims version 0, reality is 1.
    const staleVersion = await sessionRepo.transitionSession(session.id, 0, 'created', 'running');
    expect(staleVersion).toBeNull();

    // Stale status: the caller claims 'created', reality is 'running'.
    const staleStatus = await sessionRepo.transitionSession(session.id, 1, 'created', 'running');
    expect(staleStatus).toBeNull();

    // Nothing was mutated by the losers.
    const after = await sessionRepo.getSession(session.id);
    expect(after?.version).toBe(1);
    expect(after?.status).toBe('running');
  });

  it('illegal transition edges → typed error (repository) + DB trigger backstop', async () => {
    const session = await makeSession(6);
    // Repository-level pre-validation: created → completed is not an edge.
    await expectSessionError(
      sessionRepo.transitionSession(session.id, 0, 'created', 'completed'),
      'execution-session-illegal-transition',
    );
    // created → interrupted is not an edge either.
    await expectSessionError(
      sessionRepo.transitionSession(session.id, 0, 'created', 'interrupted'),
      'execution-session-illegal-transition',
    );

    // DB-trigger backstop: direct SQL bypassing the repository is rejected.
    await sessionRepo.transitionSession(session.id, 0, 'created', 'running');
    await expect(
      stack.db.client.query(`UPDATE wfos_execution_sessions SET status = 'created' WHERE id = $1`, [session.id]),
    ).rejects.toThrow(/execution-session-illegal-transition|execution-session-terminal/);
    // running → created is illegal (the reverse edge does not exist).
    await expect(
      stack.db.client.query(`UPDATE wfos_execution_sessions SET status = 'created' WHERE id = $1`, [session.id]),
    ).rejects.toThrow('execution-session-illegal-transition');
  });

  it('turn CAS — advanceTurn only from running, version increments', async () => {
    const session = await makeSession(7);
    // Not running yet → null.
    expect(await sessionRepo.advanceTurn(session.id, 0)).toBeNull();
    await sessionRepo.transitionSession(session.id, 0, 'created', 'running');
    const t1 = await sessionRepo.advanceTurn(session.id, 1);
    expect(t1?.currentTurn).toBe(1);
    expect(t1?.version).toBe(2);
    // Stale version → null.
    expect(await sessionRepo.advanceTurn(session.id, 1)).toBeNull();
    const t2 = await sessionRepo.advanceTurn(session.id, 2);
    expect(t2?.currentTurn).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------------
  it('append event → sequence increments (1, 2, 3…)', async () => {
    const session = await makeSession(8);
    const e1 = await sessionRepo.appendEvent(session.id, 'turn_started', { turn: 1 });
    const e2 = await sessionRepo.appendEvent(session.id, 'model_interaction', { role: 'assistant' });
    const e3 = await sessionRepo.appendEvent(session.id, 'observation', { source: 'test' });
    expect(e1.sequenceNumber).toBe(1);
    expect(e2.sequenceNumber).toBe(2);
    expect(e3.sequenceNumber).toBe(3);
    const events = await sessionRepo.listEvents(session.id);
    expect(events.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.eventType)).toEqual(['turn_started', 'model_interaction', 'observation']);
  });

  it('duplicate sequence → rejected (typed error + DB unique constraint)', async () => {
    const session = await makeSession(9);
    await sessionRepo.appendEventWithSequence(session.id, 1, 'turn_started');
    // The same explicit sequence again → typed duplicate error.
    const seqErr = await expectSessionError(
      sessionRepo.appendEventWithSequence(session.id, 1, 'observation'),
      'execution-session-event-duplicate-sequence',
    );
    expect(seqErr.context.sequenceNumber).toBe(1);
    // The DB constraint is the mechanical guarantee (raw SQL collides too).
    await expect(
      stack.db.client.query(
        `INSERT INTO wfos_execution_session_events (session_id, sequence_number, event_type)
         VALUES ($1, 1, 'observation')`,
        [session.id],
      ),
    ).rejects.toThrow(/wfos_execution_session_events_sequence_unique/);
    // Still exactly one event.
    expect(await sessionRepo.listEvents(session.id)).toHaveLength(1);
  });

  it('concurrent event append → unique sequences (row-lock serialization)', async () => {
    const session = await makeSession(10);
    // 8 concurrent appends: the FOR UPDATE serialization assigns each a
    // distinct next sequence — no duplicates, no lost events.
    const appended = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        sessionRepo.appendEvent(session.id, 'observation', { i }),
      ),
    );
    const sequences = appended.map((e) => e.sequenceNumber).sort((a, b) => a - b);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const events = await sessionRepo.listEvents(session.id);
    expect(events).toHaveLength(8);
    expect(new Set(events.map((e) => e.sequenceNumber)).size).toBe(8);
  });

  it('events are append-only — UPDATE and DELETE rejected', async () => {
    const session = await makeSession(11);
    await sessionRepo.appendEvent(session.id, 'checkpoint', { note: 'before' });
    const eventId = (await sessionRepo.listEvents(session.id))[0]!.id;
    await expect(
      stack.db.client.query(
        `UPDATE wfos_execution_session_events SET payload = '{"note":"tampered"}' WHERE id = $1`,
        [eventId],
      ),
    ).rejects.toThrow('execution-session-event-immutable');
    await expect(
      stack.db.client.query(`DELETE FROM wfos_execution_session_events WHERE id = $1`, [eventId]),
    ).rejects.toThrow('execution-session-event-immutable');
    // The original payload is intact.
    const events = await sessionRepo.listEvents(session.id);
    expect(events[0]?.payload).toEqual({ note: 'before' });
  });

  // ---------------------------------------------------------------------------
  // interrupt / resume / terminal
  // ---------------------------------------------------------------------------
  it('interrupt → resumable; resume → exactly one state transition', async () => {
    const session = await makeSession(12);
    await sessionRepo.transitionSession(session.id, 0, 'created', 'running');
    // interrupt → resumable (interrupted is NOT terminal).
    const interrupted = await sessionRepo.transitionSession(session.id, 1, 'running', 'interrupted');
    expect(interrupted?.status).toBe('interrupted');
    expect(interrupted?.terminalAt).toBeNull();

    // TWO CONCURRENT resumes: exactly ONE wins the CAS (the other sees a
    // stale version and/or status → null).
    const resumes = await Promise.all([
      sessionRepo.transitionSession(session.id, 2, 'interrupted', 'running'),
      sessionRepo.transitionSession(session.id, 2, 'interrupted', 'running'),
    ]);
    const winners = resumes.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.status).toBe('running');
    expect(winners[0]?.version).toBe(3);
    const after = await sessionRepo.getSession(session.id);
    expect(after?.status).toBe('running');
    expect(after?.version).toBe(3);
  });

  it('terminal session → further mutation rejected (CAS + DB trigger + events)', async () => {
    const session = await makeSession(13);
    await sessionRepo.transitionSession(session.id, 0, 'created', 'running');
    await sessionRepo.appendEvent(session.id, 'turn_started', { turn: 1 });
    const done = await sessionRepo.transitionSession(session.id, 1, 'running', 'completed');
    expect(done?.terminalAt).not.toBeNull();

    // (a) CAS transitions FROM the terminal state → the repository's
    // transition graph has no edges from 'completed' → typed error.
    await expectSessionError(
      sessionRepo.transitionSession(session.id, 2, 'completed', 'running'),
      'execution-session-illegal-transition',
    );

    // (b) DB-trigger backstop: a direct status mutation of a terminal row
    // is rejected (terminal immutability).
    await expect(
      stack.db.client.query(
        `UPDATE wfos_execution_sessions SET status = 'running' WHERE id = $1`,
        [session.id],
      ),
    ).rejects.toThrow('execution-session-terminal-immutable');

    // (c) No further events on a terminal session (typed + trigger).
    await expectSessionError(
      sessionRepo.appendEvent(session.id, 'observation', {}),
      'execution-session-terminal',
    );
    await expect(
      stack.db.client.query(
        `INSERT INTO wfos_execution_session_events (session_id, sequence_number, event_type)
         VALUES ($1, 2, 'observation')`,
        [session.id],
      ),
    ).rejects.toThrow('execution-session-terminal');
    // Turn advancement is also rejected (not running).
    expect(await sessionRepo.advanceTurn(session.id, done!.version)).toBeNull();

    // The session is unchanged: terminal, version frozen, one event.
    const after = await sessionRepo.getSession(session.id);
    expect(after?.status).toBe('completed');
    expect(after?.version).toBe(done!.version);
    expect(await sessionRepo.listEvents(session.id)).toHaveLength(1);
  });

  it('terminal timestamp consistency is mechanically enforced', async () => {
    const session = await makeSession(14);
    await expect(
      stack.db.client.query(
        `UPDATE wfos_execution_sessions SET status = 'completed' WHERE id = $1`,
        [session.id],
      ),
    ).rejects.toThrow('execution-session-illegal-transition');
    // A terminal status without terminal_at is rejected (via the legal edge
    // running→completed first requires being running; test the timestamp
    // invariant on a running session).
    await sessionRepo.transitionSession(session.id, 0, 'created', 'running');
    await expect(
      stack.db.client.query(
        `UPDATE wfos_execution_sessions SET status = 'completed', terminal_at = NULL WHERE id = $1`,
        [session.id],
      ),
    ).rejects.toThrow('execution-session-terminal-timestamp');
    // And interrupted without interrupted_at.
    await expect(
      stack.db.client.query(
        `UPDATE wfos_execution_sessions SET status = 'interrupted', interrupted_at = NULL WHERE id = $1`,
        [session.id],
      ),
    ).rejects.toThrow('execution-session-interrupted-timestamp');
  });

  it('version never regresses (DB backstop)', async () => {
    const session = await makeSession(15);
    await expect(
      stack.db.client.query(
        `UPDATE wfos_execution_sessions SET version = -1 WHERE id = $1`,
        [session.id],
      ),
    ).rejects.toThrow(/check constraint|version/i);
    await expect(
      stack.db.client.query(
        `UPDATE wfos_execution_sessions SET version = 0 WHERE id = $1`,
        [session.id],
      ),
    ).resolves.toBeTruthy(); // no-op same version is fine (0 → 0)
    await sessionRepo.transitionSession(session.id, 0, 'created', 'running');
    await expect(
      stack.db.client.query(
        `UPDATE wfos_execution_sessions SET version = 0 WHERE id = $1`,
        [session.id],
      ),
    ).rejects.toThrow('execution-session-version-regression');
  });

  // ---------------------------------------------------------------------------
  // AUDIT CORRECTIONS (the slice-1 review):
  //   (1) terminal sessions are FULLY immutable (every authoritative field)
  //   (2) the execution identity tuple is immutable (no re-targeting)
  //   (3) typed errors are real (discriminated class + stable code)
  // ---------------------------------------------------------------------------
  it('terminal session → mutation of ANY authoritative field is rejected (status, version, current_turn, interrupted_at, terminal_at, identity)', async () => {
    const session = await makeSession(16);
    await sessionRepo.transitionSession(session.id, 0, 'created', 'running');
    await sessionRepo.advanceTurn(session.id, 1);
    await sessionRepo.transitionSession(session.id, 2, 'running', 'interrupted');
    await sessionRepo.transitionSession(session.id, 3, 'interrupted', 'running');
    const done = await sessionRepo.transitionSession(session.id, 4, 'running', 'completed');
    expect(done?.terminalAt).not.toBeNull();
    const frozenVersion = done!.version;

    const attempts: [string, string][] = [
      ['status mutation', `UPDATE wfos_execution_sessions SET status = 'running' WHERE id = '${session.id}'`],
      ['version mutation', `UPDATE wfos_execution_sessions SET version = version + 1 WHERE id = '${session.id}'`],
      ['version regression', `UPDATE wfos_execution_sessions SET version = 99 WHERE id = '${session.id}'`],
      ['current_turn mutation', `UPDATE wfos_execution_sessions SET current_turn = current_turn + 1 WHERE id = '${session.id}'`],
      ['interrupted_at tampering', `UPDATE wfos_execution_sessions SET interrupted_at = NOW() WHERE id = '${session.id}'`],
      ['terminal_at clearing', `UPDATE wfos_execution_sessions SET terminal_at = NULL WHERE id = '${session.id}'`],
      ['terminal_at shifting', `UPDATE wfos_execution_sessions SET terminal_at = NOW() WHERE id = '${session.id}'`],
    ];
    for (const [label, sql] of attempts) {
      await expect(
        stack.db.client.query(sql),
        `${label} must be rejected`,
      ).rejects.toThrow('execution-session-terminal-immutable');
    }

    // The identity tuple is guarded by BOTH the terminal guard and the
    // identity guard (the identity guard fires for every row state).
    await expect(
      stack.db.client.query(`UPDATE wfos_execution_sessions SET terminal_at = terminal_at WHERE id = '${session.id}'`),
      'a NO-OP update of a terminal row is allowed (harmless bookkeeping)',
    ).resolves.toBeTruthy();

    // Nothing changed: the session is still exactly as it was terminalized.
    const after = await sessionRepo.getSession(session.id);
    expect(after?.status).toBe('completed');
    expect(after?.version).toBe(frozenVersion);
    expect(after?.currentTurn).toBe(1);
    expect(after?.interruptedAt?.toISOString()).toBe(done!.interruptedAt?.toISOString());
    expect(after?.terminalAt?.toISOString()).toBe(done!.terminalAt?.toISOString());
  });

  it('execution identity tuple is IMMUTABLE — a session can never be re-targeted onto another ExecutionRecord', async () => {
    // A non-terminal session (the identity guard applies to EVERY row
    // state, not only terminal rows).
    const session = await makeSession(17);
    await sessionRepo.transitionSession(session.id, 0, 'created', 'running');

    // A second, REAL execution whose identity tuple is fully valid — the
    // FK would accept the move, but the identity guard must reject it.
    const otherExecutionId = await makeExecution(18);
    await expect(
      stack.db.client.query(
        `UPDATE wfos_execution_sessions SET execution_id = $1 WHERE id = $2`,
        [otherExecutionId, session.id],
      ),
    ).rejects.toThrow('execution-session-identity-immutable');

    // Re-targeting via the work-order column (keeping the execution) — also
    // part of the identity tuple.
    const bogusWorkOrder = '99999999-9999-9999-9999-999999999999';
    await expect(
      stack.db.client.query(
        `UPDATE wfos_execution_sessions SET work_order_id = $1 WHERE id = $2`,
        [bogusWorkOrder, session.id],
      ),
    ).rejects.toThrow('execution-session-identity-immutable');

    // A no-op identity update (same values) is fine.
    await expect(
      stack.db.client.query(
        `UPDATE wfos_execution_sessions SET execution_id = execution_id WHERE id = $1`,
        [session.id],
      ),
    ).resolves.toBeTruthy();

    // The session still continues its ORIGINAL execution.
    const after = await sessionRepo.getSession(session.id);
    expect(after?.executionId).toBe(session.executionId);
    expect(await sessionRepo.getSessionByExecutionId(session.executionId)?.then((s) => s?.id)).toBe(session.id);
  });

  it('typed errors are REAL — discriminated ExecutionSessionError instances with stable codes + structured context', async () => {
    // (a) instanceof + code + name + context, for every documented error:
    const executionId = await makeExecution(19);
    await sessionRepo.createSession({ executionId, projectId, workItemId, workOrderId });
    const dup = await expectSessionError(
      sessionRepo.createSession({ executionId, projectId, workItemId, workOrderId }),
      'execution-session-duplicate-execution',
    );
    expect(dup).toBeInstanceOf(ExecutionSessionError);
    expect(dup.code).toBe('execution-session-duplicate-execution');
    expect(dup.context).toEqual({ executionId });

    const session = await sessionRepo.getSessionByExecutionId(executionId);
    expect(session).not.toBeNull();

    const illegal = await expectSessionError(
      sessionRepo.transitionSession(session!.id, 0, 'created', 'completed'),
      'execution-session-illegal-transition',
    );
    expect(illegal.context).toEqual({ sessionId: session!.id, from: 'created', to: 'completed' });

    const notFound = await expectSessionError(
      sessionRepo.appendEvent('99999999-9999-9999-9999-999999999999', 'observation'),
      'execution-session-not-found',
    );
    expect(notFound.context.sessionId).toBe('99999999-9999-9999-9999-999999999999');

    await sessionRepo.transitionSession(session!.id, 0, 'created', 'running');
    await sessionRepo.transitionSession(session!.id, 1, 'running', 'cancelled');
    const terminal = await expectSessionError(
      sessionRepo.appendEvent(session!.id, 'observation'),
      'execution-session-terminal',
    );
    expect(terminal.context.status).toBe('cancelled');

    // (b) the class is exported from the /agents barrel (the public
    // contract) + the stable code list is exported for exhaustive switch
    // handling.
    const barrel = await import('../../../src/modules/agents/index.js');
    expect(barrel.ExecutionSessionError).toBe(ExecutionSessionError);
    expect(Array.isArray(barrel.EXECUTION_SESSION_ERROR_CODES)).toBe(true);
    expect(barrel.EXECUTION_SESSION_ERROR_CODES).toContain('execution-session-terminal');
    expect(barrel.EXECUTION_SESSION_ERROR_CODES).toContain('execution-session-duplicate-execution');

    // (c) NOT a plain Error of another kind: the code discriminant exists
    // only on the typed class.
    expect((new Error('x') as { code?: string }).code).toBeUndefined();
  });
});
