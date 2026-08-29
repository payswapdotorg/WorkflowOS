import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import type { DatabaseClient, DatabaseTx } from '@platform/index.js';
import { PgDelegationRepository } from '../../../src/delegation/index.js';

/**
 * WORK-046 architectural concurrency regression (architect round-3 review of
 * PR #60 — CHANGES REQUIRED): the attempt-generation race in
 * PgDelegationRepository.recordAttemptOutcome().
 *
 * The defect: the attempt outcome row was fenced by attemptId, but the
 * unit-state mutation was fenced only by
 *
 *   unit_id AND status IN ('dispatched', 'failed', 'unresolved')
 *
 * with NO fence tying the unit mutation to the CURRENT attempt. That permits:
 *
 *   attempt 1 → unresolved → retry → attempt 2 allocated (unit = dispatched)
 *   → a LATE attempt-1 result arrives → recordAttemptOutcome(attempt 1)
 *   → unit = succeeded  ← WRONG: attempt 2 is still executing
 *
 * which can propagate into the plan-completion check and incorrectly complete
 * the delegation plan.
 *
 * The fix (the attempt-generation fence): the unit mutation additionally
 * requires the recorded attempt to BE the unit's current attempt —
 * `a.attempt_no = u.attempt_count` (the allocation transaction bumps
 * attempt_count and inserts that very attempt_no atomically under the unit
 * row lock, so the equality holds for exactly one live attempt). A result for
 * attempt N-1 after a retry allocated attempt N is structurally incapable of
 * changing the unit's current state.
 *
 * The architect's required regression matrix (both directions + the
 * resolution), preferring a PostgreSQL two-actor proof:
 *
 *   1. attempt 1 unresolved → attempt 2 allocated → stale attempt 1 SUCCESS
 *      → unit remains dispatched on attempt 2
 *   2. attempt 1 unresolved → attempt 2 allocated → stale attempt 1 FAILURE
 *      → unit remains dispatched on attempt 2
 *   3. attempt 2 resolves → unit takes the attempt-2 outcome → plan may
 *      complete
 *
 * The two-actor proofs run the stale outcome recorder (T1) and the retry
 * allocation (T2) on TWO INDEPENDENT PostgreSQL connections, with T1's unit
 * mutation genuinely BLOCKED on T2's row lock when T2 commits the retry —
 * the READ COMMITTED re-evaluation then sees the NEW row version
 * (attempt_count = 2) and the fence rejects the stale attempt. They skip on
 * the single-connection pglite path (cross-connection contention is
 * impossible there by construction).
 */
describe('WORK-046 — attempt-generation race guard (a stale attempt result cannot change the unit\'s current state)', () => {
  let stack: TestAuthStack;
  let workItemId: string;
  const executionId = (n: number) => `wf_${randomUUID().replace(/-/g, '').slice(0, 24)}-a${n}`;

  beforeAll(async () => {
    stack = await buildAuthStack({});

    const org = await stack.organizationRepository.create({ name: 'Delegation Attempt-Gen Race Org' });
    const user = await stack.userRepository.upsertByExternalId({
      externalId: `delegation-attemptgen-${randomUUID()}`,
      displayName: 'U',
    });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    const project = await stack.projectRepository.create({ organizationId: org.id, name: 'Delegation Attempt-Gen Race Project' });
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Arch-AttemptGen' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'content' });
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id,
      workItemId: `WI-AGEN-${randomUUID().slice(0, 8)}`,
      title: 'Attempt-generation race guard',
      objective: 'Prove stale attempt results cannot mutate the unit',
      scope: 'Database concurrency regression',
    });
    workItemId = workItem.id;
  });

  afterAll(async () => {
    await stack.teardown();
  });

  /** A fresh plan + one pending unit (the pre-attempt coordination state). */
  async function freshUnit(planKey: string): Promise<{ planId: string; unitId: string }> {
    const planId = randomUUID();
    const unitId = randomUUID();
    await stack.db.client.query(
      `INSERT INTO wfos_delegation_plans (id, work_item_id, plan_key, status)
       VALUES ($1, $2, $3, 'active')`,
      [planId, workItemId, planKey],
    );
    await stack.db.client.query(
      `INSERT INTO wfos_delegation_units
         (id, plan_id, unit_key, role_id, role_revision, mode, provider, model, depends_on, status)
       VALUES ($1, $2, 'implement', 'implementer', 'race-revision', 'native', 'fake', 'fake-model', '[]'::jsonb, 'pending')`,
      [unitId, planId],
    );
    return { planId, unitId };
  }

  /**
   * The PRODUCTION attempt allocation (PgDelegationRepository.allocateAttempt
   * inside the dispatchUnit transaction): under the unit row lock, CAS the
   * unit to 'dispatched' + attempt_count+1, INSERT the attempt row. Runs on
   * whichever connection/transaction handle is passed in.
   */
  async function allocateAttempt(
    tx: Pick<DatabaseTx, 'query'>,
    unitId: string,
    expectedStatus: string,
    attemptNo: number,
    execId: string,
  ): Promise<void> {
    const cas = await tx.query(
      `UPDATE wfos_delegation_units
          SET status = 'dispatched', attempt_count = attempt_count + 1, updated_at = NOW()
        WHERE id = $1 AND status = $2`,
      [unitId, expectedStatus],
    );
    if ((cas.rowCount ?? 0) !== 1) throw new Error(`allocation CAS lost (expected ${expectedStatus})`);
    await tx.query(
      `INSERT INTO wfos_delegation_attempts
         (unit_id, attempt_no, execution_id, mode, provider, model)
       VALUES ($1, $2, $3, 'native', 'fake', 'fake-model')`,
      [unitId, attemptNo, execId],
    );
  }

  /** The attempt row id for a (unit, attempt_no). */
  async function attemptId(unitId: string, attemptNo: number): Promise<string> {
    const row = await stack.db.client.query<{ id: string }>(
      `SELECT id FROM wfos_delegation_attempts WHERE unit_id = $1 AND attempt_no = $2`,
      [unitId, attemptNo],
    );
    return row.rows[0]!.id;
  }

  async function unitState(unitId: string): Promise<{ status: string; attempt_count: number }> {
    const row = await stack.db.client.query<{ status: string; attempt_count: number }>(
      `SELECT status, attempt_count FROM wfos_delegation_units WHERE id = $1`,
      [unitId],
    );
    return row.rows[0]!;
  }

  async function attemptOutcomes(unitId: string): Promise<{ attempt_no: number; outcome: string | null }[]> {
    const rows = await stack.db.client.query<{ attempt_no: number; outcome: string | null }>(
      `SELECT attempt_no, outcome FROM wfos_delegation_attempts WHERE unit_id = $1 ORDER BY attempt_no`,
      [unitId],
    );
    return rows.rows;
  }

  /**
   * The interleaved two-actor race: T1 = the LATE attempt-1 outcome recorder
   * (the exact production recordAttemptOutcome transaction shape — the
   * attempt-row UPDATE, then the ATTEMPT-FENCED unit UPDATE), T2 = the retry
   * allocation on an INDEPENDENT connection (the production dispatch
   * transaction: lock the unit, CAS unresolved → dispatched, allocate attempt
   * 2). T1's unit UPDATE genuinely BLOCKS on T2's row lock; when T2 commits,
   * PostgreSQL re-evaluates the fenced WHERE against the NEW row version.
   *
   * Returns T1's unit-mutation rowCount (0 = the fence held; the stale result
   * changed nothing).
   */
  async function runStaleOutcomeVsRetryRace(
    t2: Pick<DatabaseClient, 'transaction'>,
    unitId: string,
    attempt1Id: string,
    staleOutcome: 'succeeded' | 'failed',
  ): Promise<number> {
    // T2 — the retry allocation, paused while holding the unit row lock.
    let retryLocked!: () => void;
    const retryHasLocked = new Promise<void>((resolve) => {
      retryLocked = resolve;
    });
    let allowRetryToCommit!: () => void;
    const allowCommit = new Promise<void>((resolve) => {
      allowRetryToCommit = resolve;
    });

    const retry = t2.transaction(async (tx) => {
      await tx.query(`SELECT id FROM wfos_delegation_units WHERE id = $1 FOR UPDATE`, [unitId]);
      retryLocked();
      await allowCommit;
      await allocateAttempt(tx, unitId, 'unresolved', 2, executionId(2));
    });
    await retryHasLocked;

    // T1 — the late attempt-1 observer on the MAIN connection: mirrors
    // PgDelegationRepository.recordAttemptOutcome exactly (the attempt-row
    // UPDATE, then the attempt-fenced unit UPDATE). The unit UPDATE blocks on
    // T2's row lock.
    const stale = stack.db.client.transaction(async (tx) => {
      await tx.query(
        `UPDATE wfos_delegation_attempts
            SET outcome = $2, outcome_detail = $3::jsonb, updated_at = NOW()
          WHERE id = $1 AND (outcome IS NULL OR outcome = 'unresolved')`,
        [attempt1Id, staleOutcome, JSON.stringify({ observedAt: new Date().toISOString(), stale: true, attemptNo: 1 })],
      );
      // THE ATTEMPT-GENERATION FENCE (mirrors the production SQL):
      const updated = await tx.query(
        `UPDATE wfos_delegation_units u
            SET status = $2, updated_at = NOW()
          WHERE u.id = $1
            AND u.status IN ('dispatched', 'failed', 'unresolved')
            AND EXISTS (
              SELECT 1
                FROM wfos_delegation_attempts a
               WHERE a.id = $3
                 AND a.unit_id = u.id
                 AND a.attempt_no = u.attempt_count
            )`,
        [unitId, staleOutcome, attempt1Id],
      );
      return updated.rowCount ?? 0;
    });

    // PROOF OF CONTENTION: T1's unit mutation CANNOT resolve while T2 holds
    // the row lock — the stale result's unit UPDATE is genuinely blocked (not
    // sequentially evaluated against the pre-retry state).
    const probe = await Promise.race([
      stale.then(() => 'resolved'),
      new Promise<'still-blocked'>((resolve) => setTimeout(() => resolve('still-blocked'), 500)),
    ]);
    expect(probe).toBe('still-blocked');

    // T2 commits the retry: attempt 2 is now the unit's CURRENT attempt
    // (attempt_count = 2, unit = 'dispatched').
    allowRetryToCommit();
    await retry;

    // T1's blocked unit UPDATE unblocks and re-evaluates against the NEW
    // committed row version: attempt 1's attempt_no (1) ≠ attempt_count (2)
    // → the fence rejects the stale mutation.
    return stale;
  }

  it('TWO-ACTOR — attempt 1 unresolved → attempt 2 allocated → stale attempt 1 SUCCESS: the unit REMAINS dispatched on attempt 2', async () => {
    const second = stack.db.createSecondClient;
    if (!second) return; // pglite: single-connection — the race is unrepresentable

    const repo = new PgDelegationRepository(stack.db.client);
    const { planId, unitId } = await freshUnit('stale-success');

    // Attempt 1 allocated (the production allocation) + honestly recorded
    // 'unresolved' (the production method — attempt 1 IS the current attempt).
    await stack.db.client.transaction(async (tx) => {
      await allocateAttempt(tx, unitId, 'pending', 1, executionId(1));
    });
    const attempt1 = await attemptId(unitId, 1);
    const unresolved = await repo.recordAttemptOutcome({
      attemptId: attempt1,
      outcome: 'unresolved',
      outcomeDetail: { observedAt: new Date().toISOString(), attemptNo: 1 },
      unitId,
      unitStatus: 'unresolved',
    });
    expect(unresolved!.status).toBe('unresolved');

    const t2 = await second();
    try {
      // THE RACE: the late attempt-1 SUCCESS vs the retry allocating attempt 2.
      const mutated = await runStaleOutcomeVsRetryRace(t2.client, unitId, attempt1, 'succeeded');
      expect(mutated).toBe(0); // the fence held — the stale SUCCESS changed no unit state

      // The unit REMAINS dispatched on attempt 2 (the current attempt).
      expect(await unitState(unitId)).toEqual({ status: 'dispatched', attempt_count: 2 });

      // The attempt HISTORY is truthful: attempt 1's late outcome is recorded
      // on its own row (per-attempt truth); attempt 2 is in flight. Only the
      // unit's CURRENT state was protected.
      expect(await attemptOutcomes(unitId)).toEqual([
        { attempt_no: 1, outcome: 'succeeded' },
        { attempt_no: 2, outcome: null },
      ]);

      // The PRODUCTION method carries the same fence: re-recording the
      // (now terminal, now stale) attempt 1 — even with the OPPOSITE outcome —
      // mutates nothing and returns null (converge on the current row).
      const staleAgain = await repo.recordAttemptOutcome({
        attemptId: attempt1,
        outcome: 'failed',
        outcomeDetail: { observedAt: new Date().toISOString(), attemptNo: 1, stale: true },
        unitId,
        unitStatus: 'failed',
      });
      expect(staleAgain).toBeNull();
      expect(await unitState(unitId)).toEqual({ status: 'dispatched', attempt_count: 2 });

      // Scenario 3 (first half): attempt 2 resolves SUCCESS (the production
      // method — attempt 2 IS the current attempt) → the unit takes the
      // attempt-2 outcome.
      const attempt2 = await attemptId(unitId, 2);
      const resolved = await repo.recordAttemptOutcome({
        attemptId: attempt2,
        outcome: 'succeeded',
        outcomeDetail: { observedAt: new Date().toISOString(), attemptNo: 2 },
        unitId,
        unitStatus: 'succeeded',
      });
      expect(resolved!.status).toBe('succeeded');
      expect(await unitState(unitId)).toEqual({ status: 'succeeded', attempt_count: 2 });

      // …and the plan may complete through the CURRENT attempt (the production
      // completion CAS — this is the propagation the stale result could have
      // wrongly triggered under the unfenced mutation).
      const completed = await repo.casPlanStatus(planId, 'active', 'completed');
      expect(completed!.status).toBe('completed');
    } finally {
      await t2.close();
    }
  });

  it('TWO-ACTOR — attempt 1 unresolved → attempt 2 allocated → stale attempt 1 FAILURE: the unit REMAINS dispatched on attempt 2', async () => {
    const second = stack.db.createSecondClient;
    if (!second) return; // pglite: single-connection — the race is unrepresentable

    const repo = new PgDelegationRepository(stack.db.client);
    const { planId, unitId } = await freshUnit('stale-failure');

    await stack.db.client.transaction(async (tx) => {
      await allocateAttempt(tx, unitId, 'pending', 1, executionId(1));
    });
    const attempt1 = await attemptId(unitId, 1);
    const unresolved = await repo.recordAttemptOutcome({
      attemptId: attempt1,
      outcome: 'unresolved',
      outcomeDetail: { observedAt: new Date().toISOString(), attemptNo: 1 },
      unitId,
      unitStatus: 'unresolved',
    });
    expect(unresolved!.status).toBe('unresolved');

    const t2 = await second();
    try {
      // THE RACE: the late attempt-1 FAILURE vs the retry allocating attempt 2.
      const mutated = await runStaleOutcomeVsRetryRace(t2.client, unitId, attempt1, 'failed');
      expect(mutated).toBe(0); // the fence held — the stale FAILURE changed no unit state

      // The unit REMAINS dispatched on attempt 2 (without the fence, a stale
      // FAILURE would mark the unit 'failed' while attempt 2 still executes —
      // wrongly exposing it to ANOTHER retry and duplicate work).
      expect(await unitState(unitId)).toEqual({ status: 'dispatched', attempt_count: 2 });
      expect(await attemptOutcomes(unitId)).toEqual([
        { attempt_no: 1, outcome: 'failed' },
        { attempt_no: 2, outcome: null },
      ]);

      // The PRODUCTION method carries the same fence (terminal + stale + the
      // opposite outcome → no mutation, null return).
      const staleAgain = await repo.recordAttemptOutcome({
        attemptId: attempt1,
        outcome: 'succeeded',
        outcomeDetail: { observedAt: new Date().toISOString(), attemptNo: 1, stale: true },
        unitId,
        unitStatus: 'succeeded',
      });
      expect(staleAgain).toBeNull();
      expect(await unitState(unitId)).toEqual({ status: 'dispatched', attempt_count: 2 });

      // Scenario 3 (second half): attempt 2 resolves FAILURE → the unit takes
      // the attempt-2 outcome ('failed'), and the plan stays ACTIVE +
      // recoverable (the retry contract — completion only through current
      // outcomes).
      const attempt2 = await attemptId(unitId, 2);
      const resolved = await repo.recordAttemptOutcome({
        attemptId: attempt2,
        outcome: 'failed',
        outcomeDetail: { observedAt: new Date().toISOString(), attemptNo: 2 },
        unitId,
        unitStatus: 'failed',
      });
      expect(resolved!.status).toBe('failed');
      expect(await unitState(unitId)).toEqual({ status: 'failed', attempt_count: 2 });

      const plan = await stack.db.client.query<{ status: string }>(
        `SELECT status FROM wfos_delegation_plans WHERE id = $1`,
        [planId],
      );
      expect(plan.rows[0]!.status).toBe('active');
    } finally {
      await t2.close();
    }
  });

  it('attempt 2 resolves → the unit takes the attempt-2 outcome → the plan may complete (the CURRENT attempt owns the unit state)', async () => {
    // The sequential contract (runs on BOTH pglite and real PostgreSQL — no
    // cross-connection interleaving needed): every step through the
    // PRODUCTION repository methods.
    const repo = new PgDelegationRepository(stack.db.client);
    const { planId, unitId } = await freshUnit('current-attempt');

    // Attempt 1: allocated, honestly recorded 'unresolved' (attempt 1 is the
    // current attempt — the fence permits the unit transition).
    await stack.db.client.transaction(async (tx) => {
      const allocated = await repo.allocateAttempt(tx, {
        unitId,
        attemptNo: 1,
        executionId: executionId(1),
        mode: 'native',
        provider: 'fake',
        model: 'fake-model',
        expectedStatus: 'pending',
      });
      expect(allocated!.status).toBe('dispatched');
      expect(allocated!.attempt_count).toBe(1);
    });
    const attempt1 = await attemptId(unitId, 1);
    const unresolved = await repo.recordAttemptOutcome({
      attemptId: attempt1,
      outcome: 'unresolved',
      outcomeDetail: { observedAt: new Date().toISOString(), attemptNo: 1 },
      unitId,
      unitStatus: 'unresolved',
    });
    expect(unresolved!.status).toBe('unresolved');

    // The retry allocates attempt 2 (the production path — the unit's current
    // attempt becomes 2).
    await stack.db.client.transaction(async (tx) => {
      const retried = await repo.allocateAttempt(tx, {
        unitId,
        attemptNo: 2,
        executionId: executionId(2),
        mode: 'native',
        provider: 'fake',
        model: 'fake-model',
        expectedStatus: 'unresolved',
      });
      expect(retried!.status).toBe('dispatched');
      expect(retried!.attempt_count).toBe(2);
    });

    // A LATE attempt-1 terminal result (sequential form): the attempt row
    // records its history, but the unit-state mutation is fenced away.
    const stale = await repo.recordAttemptOutcome({
      attemptId: attempt1,
      outcome: 'succeeded',
      outcomeDetail: { observedAt: new Date().toISOString(), attemptNo: 1, stale: true },
      unitId,
      unitStatus: 'succeeded',
    });
    expect(stale).toBeNull();
    expect(await unitState(unitId)).toEqual({ status: 'dispatched', attempt_count: 2 });
    expect((await attemptOutcomes(unitId))[0]!.outcome).toBe('succeeded'); // history kept

    // Attempt 2 resolves → the unit takes the ATTEMPT-2 outcome.
    const attempt2 = await attemptId(unitId, 2);
    const resolved = await repo.recordAttemptOutcome({
      attemptId: attempt2,
      outcome: 'succeeded',
      outcomeDetail: { observedAt: new Date().toISOString(), attemptNo: 2 },
      unitId,
      unitStatus: 'succeeded',
    });
    expect(resolved!.status).toBe('succeeded');

    // The plan completes through the CURRENT attempt (the production
    // completion CAS — drivePlan's check: every unit succeeded).
    const completed = await repo.casPlanStatus(planId, 'active', 'completed');
    expect(completed!.status).toBe('completed');
    expect(await attemptOutcomes(unitId)).toEqual([
      { attempt_no: 1, outcome: 'succeeded' },
      { attempt_no: 2, outcome: 'succeeded' },
    ]);
  });
});
