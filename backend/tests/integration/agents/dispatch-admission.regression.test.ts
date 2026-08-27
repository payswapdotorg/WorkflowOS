/**
 * WORK-043 (§33.3) — PR #48 round 4 / AR-043-05: THE DISPATCH ADMISSION
 * BOUNDARY — real-PostgreSQL regression tests.
 *
 * The architect's AR-043-05 scenario, proven at BOTH dispatch mutation
 * boundaries on real PostgreSQL:
 *
 *   Two concurrent callers can both observe `usage = 0, limit = 1` (the
 *   ADVISORY eligibility evaluation returns `eligible = true` for both) and
 *   both reach for the provider. The HARD ADMISSION boundary — the dispatch
 *   mutation itself, advisory-lock-serialized per project — admits EXACTLY
 *   ONE of them:
 *
 *     R4-B (the DIRECT arm — PgExecutionRecordRepository.create): two
 *          concurrent execution-record creations on INDEPENDENT connections
 *          against a one-unit daily quota → exactly ONE row is created; the
 *          loser throws the typed DispatchAdmissionRejectedError
 *          (quota/daily) with NO row, NO dispatch, NO audit event.
 *
 *     R4-C (the DIRECT arm — the per-provider rate window): two concurrent
 *          creations targeting the SAME provider against a one-request
 *          window → one admitted, one rejected (rate_limited); a DIFFERENT
 *          provider stays admissible (per-provider scoping).
 *
 *     R4-F (the HANDOFF arm — beginFencedDispatch): two concurrent
 *          gate-opens for two DIFFERENT handoff obligations on INDEPENDENT
 *          connections → exactly ONE gate opens; the loser's admission is
 *          rejected BEFORE any provider call (the opened gate IS the
 *          reservation — arm 4 of the pressure derivation).
 *
 *     R4-D (the CROSS-BOUNDARY pressure — ONE admission boundary): an OPEN
 *          cross-mode handoff dispatch gate (a handoff dispatch in flight)
 *          counts as admission pressure for a CONCURRENT DIRECT attempt —
 *          the in-flight gate IS the reservation; the direct path honors
 *          it, and the reservation releases when the gate completes.
 *
 *     R4-E (the RESERVATION RELEASE): a pre-dispatch REJECTED execution
 *          (status 'failed', no artifact — the provider-submit failure
 *          shape) releases its reservation — AR-043-01's "rejected before
 *          dispatch does not count" extends to admission pressure.
 *
 * The two-actor races (R4-B/C/F) run on TWO INDEPENDENT pg.Client
 * connections (the established real-PG concurrency harness — T1 = the test
 * schema's primary client, T2 = createSecondClient; the per-transaction
 * advisory lock blocks across connections exactly as it does across
 * processes). They SKIP on the pglite path (single-connection — the
 * established skipIf pattern). The single-actor semantics (R4-D/E) run
 * everywhere.
 *
 * The pressure derivation (dispatch artifacts + open gates + horizon-bounded
 * created rows) reuses the EXISTING authoritative structures — NO parallel
 * usage ledger (no new table, no new column; the advisory engine's usage
 * derivation is untouched).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import type { DatabaseClient } from '@platform/index.js';
import { PgExecutionRecordRepository } from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { PgCrossModeHandoffRepository } from '../../../src/modules/agents/internal/pg-cross-mode-handoff-repository.js';
import { PgExecutionPolicyRepository } from '../../../src/execution-policy/index.js';
import {
  DispatchAdmissionRejectedError,
  DISPATCH_RESERVATION_HORIZON_MS,
} from '../../../src/modules/agents/internal/dispatch-admission.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';

const isRealPg = !!process.env.WORKFLOWOS_DATABASE_URL
  && process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');

describe('WORK-043 round 4 — the DISPATCH ADMISSION BOUNDARY (AR-043-05)', () => {
  let stack: TestAuthStack;
  let executionRecordRepo: PgExecutionRecordRepository;
  let handoffRepo: PgCrossModeHandoffRepository;
  let policyRepo: PgExecutionPolicyRepository;
  let organizationId: string;
  let projectId: string;
  let workItemId: string;
  let workOrderId: string;
  let contextId: string;
  let execCount = 0;

  beforeAll(async () => {
    stack = await buildAuthStack();
    const db = stack.db.client;
    executionRecordRepo = new PgExecutionRecordRepository(db);
    handoffRepo = new PgCrossModeHandoffRepository(db);
    policyRepo = new PgExecutionPolicyRepository(db);

    const org = await stack.organizationRepository.create({ name: 'W043 R4 Admission Org' });
    organizationId = org.id;
    const project = await stack.projectRepository.create({ organizationId, name: 'W043 R4 Admission Project' });
    projectId = project.id;

    // The FK-valid execution chain (project → architecture → version →
    // work item → work order → implementation context).
    const arch = await stack.architectureRepository.create({ projectId, name: 'W043 R4 Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# W043 R4' });
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id,
      workItemId: 'WORK-W043-R4-001',
      title: 'Admission fixture',
      objective: 'fixture',
      scope: 'src/x.ts',
      outOfScope: 'none',
      metadata: { baseCommit: 'w043-r4-baseline-commit-00000000001' },
    });
    workItemId = workItem.id;
    const workOrder = await stack.workOrderRepository.create({
      workItemId: workItem.id,
      projectId,
      architectureVersionId: version.id,
      requirementIds: [],
      criterionIds: [],
      scope: 'src/x.ts',
      verificationRequirements: [],
    });
    workOrderId = workOrder.id;
    const contextRepo = new PgImplementationContextRepository(db);
    const contextBuilder = new DefaultImplementationContextBuilder(
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
    const ctx = await contextBuilder.build(workItem.id);
    contextId = ctx.id;
  });

  afterAll(async () => {
    await stack.teardown();
  });

  /** Set/replace the project's policy row (the admission limits). */
  async function setPolicy(limits: {
    maxExecutionsPerDay?: number | null;
    maxExecutionsPerMonth?: number | null;
    rateLimitMaxRequests?: number | null;
    rateLimitWindowSeconds?: number | null;
  }): Promise<void> {
    await stack.db.client.query(
      `INSERT INTO wfos_execution_policies
         (organization_id, project_id, max_executions_per_day, max_executions_per_month,
          rate_limit_max_requests, rate_limit_window_seconds)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (project_id) DO UPDATE SET
         max_executions_per_day = EXCLUDED.max_executions_per_day,
         max_executions_per_month = EXCLUDED.max_executions_per_month,
         rate_limit_max_requests = EXCLUDED.rate_limit_max_requests,
         rate_limit_window_seconds = EXCLUDED.rate_limit_window_seconds`,
      [
        organizationId,
        projectId,
        limits.maxExecutionsPerDay ?? null,
        limits.maxExecutionsPerMonth ?? null,
        limits.rateLimitMaxRequests ?? null,
        limits.rateLimitWindowSeconds ?? null,
      ],
    );
  }

  /** Clear the policy row (no active limits — the boundary's fast path). */
  async function clearPolicy(): Promise<void> {
    await stack.db.client.query(
      `DELETE FROM wfos_execution_policies WHERE project_id = $1`,
      [projectId],
    );
  }

  /** Create an execution record input for the project. */
  function recordInput(provider: string) {
    const executionId = `wf-w043-r4-${++execCount}`;
    return {
      executionId,
      projectId,
      workItemId,
      workOrderId,
      implementationContextId: contextId,
      mode: 'native' as const,
      provider,
      model: `${provider}-model`,
      prompt: `p-${executionId}`,
      promptDigest: `d-${executionId}`,
      branch: null,
    };
  }

  /** Mark a record definitively REJECTED BEFORE DISPATCH (released). */
  async function releaseReservation(recordId: string): Promise<void> {
    await executionRecordRepo.updateStatus(recordId, {
      status: 'failed',
      completedAt: new Date(),
      benchmarkMetadata: { failureStage: 'provider-submit', errorMessage: 'fixture: rejected before dispatch (released)' },
    });
  }

  // =========================================================================
  // The TWO-ACTOR races (R4-B / R4-C / R4-F) — real PostgreSQL, two
  // INDEPENDENT connections (the established concurrency harness). The
  // per-transaction advisory lock blocks across connections exactly as it
  // does across processes: T2's admission blocks until T1's transaction
  // commits, then T2's pressure derivation observes T1's committed
  // reservation. Skipped on pglite (single connection — no true blocking).
  // =========================================================================
  describe.skipIf(!isRealPg)('R4 two-actor races (real PostgreSQL, independent connections)', () => {
    let second: { client: DatabaseClient; close: () => Promise<void> };

    beforeAll(async () => {
      if (!stack.db.createSecondClient) throw new Error('second client unavailable on the real-pg path');
      second = await stack.db.createSecondClient();
    });

    afterAll(async () => {
      await second?.close();
    });

    it('R4-B. two concurrent DIRECT submissions, daily quota = 1 → exactly ONE record created; the loser rejects with the typed quota admission error and NO row', async () => {
      await setPolicy({ maxExecutionsPerDay: 1 });
      try {
        const before = await stack.db.client.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM wfos_executions WHERE project_id = $1`,
          [projectId],
        );
        const beforeCount = Number(before.rows[0]!.c);

        // THE TWO-ACTOR RACE — both actors observe usage=0/limit=1 (the
        // advisory evaluation would return eligible for both); both submit
        // CONCURRENTLY on INDEPENDENT connections. The admission boundary's
        // advisory lock serializes them.
        const t2Repo = new PgExecutionRecordRepository(second.client);
        const [a, b] = await Promise.allSettled([
          executionRecordRepo.create(recordInput('fake')),
          t2Repo.create(recordInput('fake')),
        ]);

        const fulfilled = [a, b].filter((o) => o.status === 'fulfilled');
        const rejected = [a, b].filter((o) => o.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        // The winner: the record EXISTS (the reservation is the row itself).
        if (fulfilled[0]!.status !== 'fulfilled') throw new Error('unreachable');
        const winner = fulfilled[0]!.value;

        // The loser: the typed admission rejection — quota/daily, with the
        // usage + limit in the detail (1/1: the winner's in-flight row).
        if (rejected[0]!.status !== 'rejected') throw new Error('unreachable');
        const err = rejected[0]!.reason as DispatchAdmissionRejectedError;
        expect(err).toBeInstanceOf(DispatchAdmissionRejectedError);
        expect(err.code).toBe('execution-admission-rejected');
        expect(err.detail.category).toBe('quota');
        expect(err.detail.constraint).toBe('daily_quota_exhausted');
        expect(err.detail.limit).toBe(1);
        expect(err.detail.usage).toBe(1);
        expect(err.message).toContain('Daily execution quota exhausted');

        // Exactly ONE new row exists (the loser created NOTHING).
        const after = await stack.db.client.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM wfos_executions WHERE project_id = $1`,
          [projectId],
        );
        expect(Number(after.rows[0]!.c)).toBe(beforeCount + 1);

        // The ADVISORY usage derivation still counts ZERO dispatches — the
        // winner's row has no dispatch artifact (AR-043-01: a
        // created-without-dispatch record is NOT usage). The admission
        // pressure (1) and the advisory usage (0) are DIFFERENT models —
        // exactly as the frozen semantics define.
        const dayStart = new Date(
          Date.UTC(
            new Date().getUTCFullYear(),
            new Date().getUTCMonth(),
            new Date().getUTCDate(),
          ),
        );
        const usage = await policyRepo.countProjectDispatchedExecutionsSince(projectId, dayStart);
        expect(usage).toBe(0);

        // A THIRD sequential attempt is ALSO rejected (the winner's
        // reservation still holds — it is within the horizon).
        const third = await executionRecordRepo.create(recordInput('fake')).catch((e) => e);
        expect(third).toBeInstanceOf(DispatchAdmissionRejectedError);

        await releaseReservation(winner.id);
      } finally {
        await clearPolicy();
      }
    });

    it('R4-C. two concurrent DIRECT submissions to the SAME provider, rate window 1/3600s → one admitted, one rate-rejected naming the provider', async () => {
      await setPolicy({ rateLimitMaxRequests: 1, rateLimitWindowSeconds: 3600 });
      try {
        const t2Repo = new PgExecutionRecordRepository(second.client);
        const [a, b] = await Promise.allSettled([
          executionRecordRepo.create(recordInput('ratep')),
          t2Repo.create(recordInput('ratep')),
        ]);
        const fulfilled = [a, b].filter((o) => o.status === 'fulfilled');
        const rejected = [a, b].filter((o) => o.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const err = (rejected[0] as PromiseRejectedResult).reason as DispatchAdmissionRejectedError;
        expect(err).toBeInstanceOf(DispatchAdmissionRejectedError);
        expect(err.detail.category).toBe('rate_limit');
        expect(err.detail.constraint).toBe('rate_limit_window_exhausted');
        expect(err.detail.limit).toBe(1);
        expect(err.detail.usage).toBe(1);
        expect(err.message).toContain('ratep');

        if (fulfilled[0]!.status !== 'fulfilled') throw new Error('unreachable');
        await releaseReservation(fulfilled[0]!.value.id);

        // The limit is PER-PROVIDER: a DIFFERENT provider has zero pressure
        // and is admitted while the first provider's window is full.
        const other = await executionRecordRepo.create(recordInput('otherp'));
        expect(other.provider).toBe('otherp');
        await releaseReservation(other.id);
      } finally {
        await clearPolicy();
      }
    });

    it('R4-F. two concurrent HANDOFF gate-opens (two different obligations), one-unit rate window → exactly ONE gate opens; the loser is admission-rejected BEFORE the provider call', async () => {
      await setPolicy({ rateLimitMaxRequests: 1, rateLimitWindowSeconds: 3600 });
      try {
        // Two independent handoff obligations on two terminal native
        // records (both released — no artifacts, no reservations).
        const t2HandoffRepo = new PgCrossModeHandoffRepository(second.client);
        const fixtures: { handoffId: string; owner: string; epoch: number }[] = [];
        for (const owner of ['r4f-owner-1', 'r4f-owner-2']) {
          const record = await executionRecordRepo.create(recordInput('gatep'));
          await releaseReservation(record.id);
          const claim = await handoffRepo.createHandoffAndClaim(
            {
              executionRecordId: record.id,
              fromMode: 'native',
              toMode: 'external',
              reason: 'r4-f fixture',
              actor: owner,
              source: 'test',
              previousStatus: 'failed',
              resultingStatus: 'handoff_ready',
              previousAgentRunId: null,
              previousExternalSessionRef: null,
              previousPackageValue: null,
              authorized: true,
              policyDecision: 'r4-f',
              idempotencyKey: `r4-f-${record.executionId}`,
            },
            owner,
            60_000,
          );
          if (!claim.claimed) throw new Error('fixture claim failed');
          fixtures.push({ handoffId: claim.handoff.id, owner, epoch: claim.claimEpoch });
        }

        // THE TWO-ACTOR RACE at the HANDOFF dispatch boundary: two
        // concurrent beginFencedDispatch calls on INDEPENDENT connections
        // (two different obligations — no claim contention; the ONLY
        // serialization is the admission boundary's advisory lock).
        const [g1, g2] = await Promise.allSettled([
          handoffRepo.beginFencedDispatch(fixtures[0]!.handoffId, fixtures[0]!.owner, fixtures[0]!.epoch, `cross-mode-dispatch-${fixtures[0]!.handoffId}`),
          t2HandoffRepo.beginFencedDispatch(fixtures[1]!.handoffId, fixtures[1]!.owner, fixtures[1]!.epoch, `cross-mode-dispatch-${fixtures[1]!.handoffId}`),
        ]);

        const opened = [g1, g2].filter((o) => o.status === 'fulfilled' && o.value === true);
        const rejected = [g1, g2].filter((o) => o.status === 'rejected');
        // Exactly one gate OPENED; the other actor was admission-rejected
        // (a fenced-out gate — claim-fence-lost — would be a FALSE return,
        // not a rejection; the assertion shape distinguishes them).
        expect(opened).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const err = (rejected[0] as PromiseRejectedResult).reason as DispatchAdmissionRejectedError;
        expect(err).toBeInstanceOf(DispatchAdmissionRejectedError);
        expect(err.detail.category).toBe('rate_limit');
        expect(err.detail.constraint).toBe('rate_limit_window_exhausted');
        expect(err.detail.usage).toBe(1);
        expect(err.detail.limit).toBe(1);
        expect(err.message).toContain('gatep');

        // The OPENED gate is the reservation: the winner's gate row is
        // in_flight, and the loser's gate was NEVER opened (still NULL).
        const gates = await stack.db.client.query<{ handoff_id: string; dispatch_state: string | null }>(
          `SELECT handoff_id, dispatch_state FROM wfos_cross_mode_handoff_obligations
            WHERE handoff_id IN ($1, $2)`,
          [fixtures[0]!.handoffId, fixtures[1]!.handoffId],
        );
        const states = gates.rows.map((r) => r.dispatch_state);
        expect(states.filter((s) => s === 'in_flight')).toHaveLength(1);
        expect(states.filter((s) => s === null)).toHaveLength(1);

        // A concurrent DIRECT submission to the SAME provider sees the open
        // gate as pressure (the ONE-boundary proof — the cross-mode and
        // direct paths share the admission boundary).
        const direct = await executionRecordRepo.create(recordInput('gatep')).catch((e) => e);
        expect(direct).toBeInstanceOf(DispatchAdmissionRejectedError);
        const directErr = direct as DispatchAdmissionRejectedError;
        expect(directErr.detail.usage).toBe(1);

        // CLEANUP: complete the opened gate (the fenced completion) so the
        // fixture leaves no admission pressure behind for the later
        // describes. Identify the winner by its open gate.
        const openFixture = gates.rows.find((r) => r.dispatch_state === 'in_flight')!;
        const openIdx = fixtures.findIndex((f) => f.handoffId === openFixture.handoff_id);
        const closed = await handoffRepo.completeFencedDispatch(
          openFixture.handoff_id,
          fixtures[openIdx]!.owner,
          fixtures[openIdx]!.epoch,
          // The execution record id is not needed for the gate CAS itself —
          // resolve it for the outcome write.
          (await stack.db.client.query<{ id: string }>(
            `SELECT e.id FROM wfos_executions e
               JOIN wfos_execution_mode_handoffs h ON h.execution_record_id = e.id
              WHERE h.id = $1`,
            [openFixture.handoff_id],
          )).rows[0]!.id,
          { status: 'handoff_ready' },
        );
        expect(closed).toBe(true);
      } finally {
        await clearPolicy();
      }
    });
  });

  // =========================================================================
  // The CROSS-BOUNDARY pressure (R4-D) + the RESERVATION RELEASE (R4-E) —
  // single-actor semantics, deterministic everywhere (including pglite).
  // =========================================================================
  describe('R4-D + R4-E — the cross-boundary pressure + the reservation release (single-actor semantics)', () => {
    afterAll(async () => {
      await clearPolicy();
    });

    it('R4-D. an OPEN handoff dispatch gate is admission pressure for the DIRECT path; the reservation releases when the gate completes', async () => {
      await setPolicy({ rateLimitMaxRequests: 1, rateLimitWindowSeconds: 3600 });

      // A terminal native record (a failed first phase — released: no
      // artifact, no created-reservation) to hand off.
      const record = await executionRecordRepo.create(recordInput('xprod'));
      await releaseReservation(record.id);

      // The handoff obligation + claim (the legitimate reserve path), then
      // OPEN THE DISPATCH GATE — beginFencedDispatch IS the admission
      // boundary for the handoff arm: admitted (pressure 0), the gate row
      // turns in_flight (the RESERVATION, attributed to the record's
      // provider 'xprod').
      const claimResult = await handoffRepo.createHandoffAndClaim(
        {
          executionRecordId: record.id,
          fromMode: 'native',
          toMode: 'external',
          reason: 'r4-d fixture',
          actor: 'r4-d-actor',
          source: 'test',
          previousStatus: 'failed',
          resultingStatus: 'handoff_ready',
          previousAgentRunId: null,
          previousExternalSessionRef: null,
          previousPackageValue: null,
          authorized: true,
          policyDecision: 'r4-d',
          idempotencyKey: `r4-d-${record.executionId}`,
        },
        'r4-d-owner-1',
        60_000,
      );
      expect(claimResult.claimed).toBe(true);
      const handoffId = claimResult.handoff.id;
      const claimEpoch = claimResult.claimEpoch as number;
      expect(claimEpoch).toBeGreaterThan(0);
      const began = await handoffRepo.beginFencedDispatch(
        handoffId,
        'r4-d-owner-1',
        claimEpoch,
        `cross-mode-dispatch-${handoffId}`,
      );
      expect(began).toBe(true);

      // THE CROSS-BOUNDARY PRESSURE: the open gate is a dispatch in flight
      // for provider 'xprod' — a concurrent DIRECT submission to 'xprod'
      // is NOT admitted (the two dispatch paths share ONE boundary).
      const direct = await executionRecordRepo.create(recordInput('xprod')).catch((e) => e);
      expect(direct).toBeInstanceOf(DispatchAdmissionRejectedError);
      const err = direct as DispatchAdmissionRejectedError;
      expect(err.detail.category).toBe('rate_limit');
      expect(err.detail.usage).toBe(1);
      expect(err.detail.limit).toBe(1);

      // A DIFFERENT provider is admitted (the reservation is attributed to
      // the dispatching provider only).
      const otherProvider = await executionRecordRepo.create(recordInput('yprod'));
      expect(otherProvider.provider).toBe('yprod');

      // The reservation releases when the gate COMPLETES (the fenced
      // completion) — after completion, a fresh 'xprod' submission is
      // admitted again (the completed gate is no longer pressure; no
      // package artifact was written by this fixture's completion, so the
      // usage model ALSO stays at zero — the reservation is gone entirely).
      const completed = await handoffRepo.completeFencedDispatch(
        handoffId,
        'r4-d-owner-1',
        claimEpoch,
        record.id,
        { status: 'handoff_ready' },
      );
      expect(completed).toBe(true);
      const after = await executionRecordRepo.create(recordInput('xprod'));
      expect(after.provider).toBe('xprod');

      // Release the fixture reservations.
      await releaseReservation(otherProvider.id);
      await releaseReservation(after.id);
    });

    it('R4-E. a pre-dispatch-rejected execution releases its reservation — AR-043-01\'s posture extends to admission pressure; the horizon constant is pinned', async () => {
      await setPolicy({ maxExecutionsPerDay: 1 });

      // The first submission is admitted (its row is the reservation)...
      const first = await executionRecordRepo.create(recordInput('fake'));

      // ...and then definitively REJECTED BEFORE DISPATCH (the
      // ExecutionService's provider-failure shape: status 'failed' +
      // failureStage 'provider-submit' — NO dispatch artifact ever exists).
      await releaseReservation(first.id);

      // The reservation is RELEASED: the next submission is ADMITTED (the
      // failed row is neither usage — AR-043-01 — nor pressure).
      const second = await executionRecordRepo.create(recordInput('fake'));
      expect(second.executionId).not.toBe(first.executionId);
      await releaseReservation(second.id);

      // The horizon exists ONLY for crash recovery: a stale 'created' row
      // stops counting as pressure after the horizon. Proven structurally —
      // the reservation-arm predicate is horizon-bounded in the SQL
      // (created_at >= now - horizon), so a crashed reservation
      // self-releases without any sweep. (Sleeping 10 minutes in a test is
      // not viable; the horizon constant is pinned here so the semantics
      // cannot silently drift.)
      expect(DISPATCH_RESERVATION_HORIZON_MS).toBe(10 * 60 * 1000);
    });
  });
});
