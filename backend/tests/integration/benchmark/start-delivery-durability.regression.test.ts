/**
 * WORK-032 start-delivery durability: regression tests proving the
 * experiment start is CRASH-SAFE end-to-end — the transactional-outbox
 * pattern (durable intent + replayable delivery), with NO polling and NO
 * second execution engine (§34).
 *
 * The PR #35 review found the start flow was not crash-safe:
 *
 *     claimExperimentStart() → status='running' → audit → enqueue trials
 *
 * A crash after the CAS left the experiment 'running' with NO audit and
 * only some (or zero) trial jobs delivered. The fix:
 *
 *     atomic start claim (ONE CTE: CAS + durable delivery record +
 *     per-trial enqueue obligations — the repository owns the transition
 *     AND the intent)
 *         ↓
 *     replayable delivery (replayStartDeliveries — the single code path
 *     shared by the happy path + every recovery touch)
 *     ├── BENCHMARK_STARTED exactly once
 *     │     (deliverStartAudit: flag-CAS + deterministic-id INSERT
 *     │      ON CONFLICT (id) DO NOTHING — one atomic statement)
 *     └── benchmark.trial jobs delivered idempotently
 *           (enqueue-then-mark: duplicate job delivery is absorbed by
 *            the idempotent trial claim from PR #36)
 *
 * The reviewer's required coverage — a start must be recoverable after
 * ANY crash point, and repeated delivery must produce ONE logical start,
 * ONE BENCHMARK_STARTED audit, and ONE logical enqueue obligation per
 * trial:
 *
 *   1. concurrent start            → exactly one winner
 *   2. crash after CAS             → recovery resumes delivery
 *   3. crash after audit           → no duplicate audit
 *   4. crash during trial enqueue  → missing jobs are replayed
 *   5. replay after complete delivery → zero duplicate logical deliveries
 *   6. experiment already running  → no second start obligation
 *
 * Crash points are simulated by calling the REPOSITORY methods directly
 * (bypassing the service's happy-path delivery), then triggering the
 * replay via the service method the recovery touch points call. The
 * WorkerHost is intentionally NOT started (startWorker: false) so the
 * enqueued jobs stay in the queue + the enqueue counts are deterministic.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildBenchmarkStack,
  teardownBenchmarkStack,
  type BenchmarkStack,
} from './benchmark-stack.js';

describe('WORK-032 — start-delivery durability (crash-safe experiment start)', () => {
  let stack: BenchmarkStack;
  /** Log of `benchmark.trial` job payloads (trialIds), in enqueue order. */
  let enqueueLog: string[];

  beforeAll(async () => {
    // startWorker: false — the enqueued `benchmark.trial` jobs stay in the
    // queue so the per-trial enqueue counts are deterministic (no worker
    // races the assertions).
    stack = await buildBenchmarkStack({
      apiKey: 'raw-key-start-delivery',
      secretRef: 'WFOS_TEST_KEY_START_DELIVERY',
      startWorker: false,
    });
    // Count per-trial `benchmark.trial` enqueues — the delivery
    // side-effect signal. WITHOUT the durable obligations, a crash
    // mid-delivery would LOSE the undelivered jobs; WITH them, replay
    // enqueues exactly the missing ones.
    enqueueLog = [];
    const origEnqueue = stack.queue.enqueue.bind(stack.queue);
    stack.queue.enqueue = (async (type: string, payload: unknown, options?: object) => {
      if (type === 'benchmark.trial') {
        enqueueLog.push((payload as { trialId: string }).trialId);
      }
      return origEnqueue(type as never, payload as never, options as never);
    }) as typeof stack.queue.enqueue;
  });

  afterAll(async () => {
    await teardownBenchmarkStack(stack);
  });

  /** Create a snapshot + TWO-trial experiment (native + external). */
  async function makeExperiment(name: string): Promise<{ experimentId: string; trialIds: string[] }> {
    const snapshot = await stack.benchmarkService.createSnapshot({
      projectId: stack.fixture.projectId,
      workItemId: stack.fixture.workItemId,
      name: `${name}-snapshot`,
      actor: stack.fixture.userId,
    });
    const exp = await stack.benchmarkService.createExperiment({
      projectId: stack.fixture.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name,
      trials: [
        { provider: 'fake', mode: 'native', repetitions: 1 },
        { provider: 'fake', mode: 'external', repetitions: 1 },
      ],
      createdBy: stack.fixture.userId,
    });
    const { trials } = await stack.benchmarkService.listTrials(exp.id);
    return { experimentId: exp.id, trialIds: trials.map((t) => t.id) };
  }

  /** Count BENCHMARK_STARTED audits for the experiment. */
  async function countStartAudits(experimentId: string): Promise<number> {
    const audits = await stack.auditService.listForResource('benchmark_experiment', experimentId);
    return audits.filter((e) => e.eventType === 'BENCHMARK_STARTED').length;
  }

  /** Count start-delivery (outbox) rows for the experiment. */
  async function countDeliveries(experimentId: string): Promise<number> {
    const res = await stack.authStack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_benchmark_start_deliveries WHERE experiment_id = $1`,
      [experimentId],
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  /** Count enqueue obligations for the experiment (across all deliveries). */
  async function countObligations(experimentId: string): Promise<number> {
    const res = await stack.authStack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_benchmark_start_trial_deliveries o
         JOIN wfos_benchmark_start_deliveries d ON d.id = o.start_delivery_id
        WHERE d.experiment_id = $1`,
      [experimentId],
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  /** Count enqueue jobs recorded for one trial. */
  function enqueuesFor(trialId: string): number {
    return enqueueLog.filter((id) => id === trialId).length;
  }

  // -------------------------------------------------------------------------
  // 1. concurrent start → exactly one winner
  // -------------------------------------------------------------------------
  it('concurrent start → exactly one winner (one delivery, one audit, one enqueue per trial)', async () => {
    const { experimentId, trialIds } = await makeExperiment('concurrent-start-durability');
    const enqueuesBefore = enqueueLog.length;

    // TWO CONCURRENT starts. The atomic claim (CAS + intent creation in ONE
    // statement) admits exactly ONE winner; the loser creates NO second
    // start obligation + throws the invalid-state error (the sequential
    // double-start semantics).
    const results = await Promise.allSettled([
      stack.benchmarkService.startExperiment(experimentId),
      stack.benchmarkService.startExperiment(experimentId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain('benchmark-experiment-invalid-state: running');

    // ASSERTION 1 — exactly ONE logical start: one durable delivery row.
    expect(await countDeliveries(experimentId)).toBe(1);
    // ...with exactly one enqueue obligation per trial (two trials).
    expect(await countObligations(experimentId)).toBe(2);

    // ASSERTION 2 — exactly ONE BENCHMARK_STARTED audit (the loser wrote
    // none; the winner's replay wrote exactly one via the deterministic-id
    // atomic path).
    expect(await countStartAudits(experimentId)).toBe(1);

    // ASSERTION 3 — exactly ONE set of enqueues: one job per trial, no
    // duplicates from the loser.
    expect(enqueueLog.length - enqueuesBefore).toBe(2);
    expect(enqueuesFor(trialIds[0]!)).toBe(1);
    expect(enqueuesFor(trialIds[1]!)).toBe(1);

    // The experiment transitioned to 'running' exactly once.
    const after = await stack.benchmarkRepository.getExperiment(experimentId);
    expect(after?.status).toBe('running');
  });

  // -------------------------------------------------------------------------
  // 2. crash after CAS → recovery resumes delivery
  // -------------------------------------------------------------------------
  it('crash after CAS → recovery resumes delivery (audit written + all trial jobs enqueued)', async () => {
    const { experimentId, trialIds } = await makeExperiment('crash-after-cas');
    const enqueuesBefore = enqueueLog.length;

    // Simulate the crash: the worker wins the atomic claim (the CAS + the
    // durable delivery + obligations ALL committed — one statement) and
    // then DIES before ANY delivery. Pre-fix, the start's side effects
    // were in-memory intent: lost forever. Post-fix, the obligations are
    // durable + recoverable.
    const claimed = await stack.benchmarkRepository.claimExperimentStart(experimentId);
    expect(claimed).not.toBeNull();
    expect(claimed?.experiment.status).toBe('running');
    expect(claimed?.startDeliveryId).toBeTruthy();

    // CRASH: no audit, no enqueue. Nothing was delivered.
    expect(await countStartAudits(experimentId)).toBe(0);
    expect(enqueueLog.length - enqueuesBefore).toBe(0);

    // RECOVERY: the post-authorization read path (recoverExperimentIfStale
    // — the exact method GET /benchmarks/:id calls after authorization)
    // replays the incomplete delivery: the audit is written exactly once +
    // ALL the obligation jobs are enqueued.
    const recovered = await stack.benchmarkService.recoverExperimentIfStale(experimentId);
    expect(recovered?.status).toBe('running');

    expect(await countStartAudits(experimentId)).toBe(1);
    expect(enqueueLog.length - enqueuesBefore).toBe(2);
    expect(enqueuesFor(trialIds[0]!)).toBe(1);
    expect(enqueuesFor(trialIds[1]!)).toBe(1);

    // The delivery is now COMPLETE (the completion marker is set — future
    // touches stop replaying it).
    const incomplete = await stack.benchmarkRepository.listIncompleteStartDeliveries(experimentId);
    expect(incomplete).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. crash after audit → no duplicate audit
  // -------------------------------------------------------------------------
  it('crash after audit → no duplicate audit (recovery resumes the enqueue without re-auditing)', async () => {
    const { experimentId, trialIds } = await makeExperiment('crash-after-audit');
    const enqueuesBefore = enqueueLog.length;

    // Simulate the crash: the worker wins the claim, delivers the audit
    // (the atomic flag-CAS + deterministic-id INSERT — ONE statement, so
    // the audit row + the flag committed together), and then DIES before
    // enqueueing any trial job.
    const claimed = await stack.benchmarkRepository.claimExperimentStart(experimentId);
    expect(claimed).not.toBeNull();
    const auditDelivery = await stack.benchmarkRepository.deliverStartAudit(claimed!.startDeliveryId);
    expect(auditDelivery?.auditDelivered).toBe(true);
    expect(await countStartAudits(experimentId)).toBe(1);

    // CRASH: zero trial jobs delivered.
    expect(enqueueLog.length - enqueuesBefore).toBe(0);

    // RECOVERY: the replay sees audit_delivered=TRUE → does NOT re-write
    // the audit — + enqueues the missing jobs.
    await stack.benchmarkService.replayStartDeliveries(experimentId);

    // ASSERTION — exactly ONE BENCHMARK_STARTED (no duplicate from the
    // replay), and all jobs delivered.
    expect(await countStartAudits(experimentId)).toBe(1);
    expect(enqueueLog.length - enqueuesBefore).toBe(2);
    expect(enqueuesFor(trialIds[0]!)).toBe(1);
    expect(enqueuesFor(trialIds[1]!)).toBe(1);
    const incomplete = await stack.benchmarkRepository.listIncompleteStartDeliveries(experimentId);
    expect(incomplete).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. crash during trial enqueue → missing jobs are replayed
  // -------------------------------------------------------------------------
  it('crash during trial enqueue → missing jobs are replayed (delivered obligations are NOT re-enqueued)', async () => {
    const { experimentId, trialIds } = await makeExperiment('crash-mid-enqueue');
    const enqueuesBefore = enqueueLog.length;

    // Simulate the crash: the worker wins the claim, delivers the audit,
    // enqueues + marks the FIRST obligation... and then DIES midway
    // through the enqueue loop (the second obligation undelivered).
    const claimed = await stack.benchmarkRepository.claimExperimentStart(experimentId);
    expect(claimed).not.toBeNull();
    await stack.benchmarkRepository.deliverStartAudit(claimed!.startDeliveryId);
    const pending = await stack.benchmarkRepository.listPendingStartTrialObligations(claimed!.startDeliveryId);
    expect(pending).toHaveLength(2);
    // Deliver ONLY the first obligation (enqueue then mark — the ordering
    // contract), then "crash".
    await stack.queue.enqueue('benchmark.trial', { trialId: pending[0]!.trialId });
    await stack.benchmarkRepository.markStartTrialDelivered(pending[0]!.id);
    expect(enqueueLog.length - enqueuesBefore).toBe(1);

    // RECOVERY: the replay enqueues ONLY the missing obligation — the
    // delivered one is NOT re-enqueued (its flag is set).
    await stack.benchmarkService.replayStartDeliveries(experimentId);

    // ASSERTION 1 — the delivered trial was NOT re-enqueued; the missing
    // trial was enqueued exactly once by the replay.
    expect(enqueuesFor(pending[0]!.trialId)).toBe(1);
    expect(enqueuesFor(pending[1]!.trialId)).toBe(1);
    expect(enqueueLog.length - enqueuesBefore).toBe(2);

    // ASSERTION 2 — exactly one audit (written once by the pre-crash
    // worker, not duplicated by the replay).
    expect(await countStartAudits(experimentId)).toBe(1);

    // ASSERTION 3 — the delivery completes.
    const incomplete = await stack.benchmarkRepository.listIncompleteStartDeliveries(experimentId);
    expect(incomplete).toHaveLength(0);
    void trialIds;
  });

  // -------------------------------------------------------------------------
  // 5. replay after complete delivery → zero duplicate logical deliveries
  // -------------------------------------------------------------------------
  it('replay after complete delivery → zero duplicate logical deliveries', async () => {
    const { experimentId, trialIds } = await makeExperiment('replay-after-complete');
    const enqueuesBefore = enqueueLog.length;

    // The happy path: a full start (claim + immediate complete delivery).
    const started = await stack.benchmarkService.startExperiment(experimentId);
    expect(started.status).toBe('running');
    expect(await countStartAudits(experimentId)).toBe(1);
    expect(enqueueLog.length - enqueuesBefore).toBe(2);

    // REPEATED DELIVERY: two additional replays (e.g. concurrent
    // authorized reads + a worker touch) after the delivery is complete.
    // Each is a NO-OP: no new audit, no new job enqueues, no new
    // obligations — the durable flags make the replay idempotent.
    await stack.benchmarkService.replayStartDeliveries(experimentId);
    await stack.benchmarkService.replayStartDeliveries(experimentId);

    // ASSERTION — ZERO duplicate logical deliveries.
    expect(await countStartAudits(experimentId)).toBe(1);
    expect(enqueueLog.length - enqueuesBefore).toBe(2);
    expect(enqueuesFor(trialIds[0]!)).toBe(1);
    expect(enqueuesFor(trialIds[1]!)).toBe(1);
    expect(await countDeliveries(experimentId)).toBe(1);
    expect(await countObligations(experimentId)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 6. experiment already running → no second start obligation
  // -------------------------------------------------------------------------
  it('experiment already running → no second start obligation', async () => {
    const { experimentId } = await makeExperiment('already-running');

    // The first start wins + completes delivery.
    await stack.benchmarkService.startExperiment(experimentId);
    expect(await countDeliveries(experimentId)).toBe(1);
    expect(await countObligations(experimentId)).toBe(2);
    expect(await countStartAudits(experimentId)).toBe(1);
    const auditsAfterFirst = await countStartAudits(experimentId);

    // A SECOND start on the already-running experiment: the claim loses
    // (running is not startable) → the invalid-state error, and CRITICALLY
    // the claim is the ONLY path that creates a start obligation — no
    // second obligation, no new audit, no new enqueues.
    await expect(stack.benchmarkService.startExperiment(experimentId))
      .rejects.toThrow('benchmark-experiment-invalid-state: running');

    expect(await countDeliveries(experimentId)).toBe(1);
    expect(await countObligations(experimentId)).toBe(2);
    expect(await countStartAudits(experimentId)).toBe(auditsAfterFirst);
  });
});
