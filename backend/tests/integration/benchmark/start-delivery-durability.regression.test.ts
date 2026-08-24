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
import { WorkerHost, buildHandlerRegistry } from '@platform/index.js';
import {
  buildBenchmarkStack,
  teardownBenchmarkStack,
  type BenchmarkStack,
} from './benchmark-stack.js';
import {
  BENCHMARK_START_DELIVERY_RELAY_JOB_TYPE,
  createStartDeliveryRelayJobHandler,
} from '../../../src/benchmark/index.js';

/** Poll until `cond` resolves true (bounded — throws on timeout). */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 5_000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

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

  // -------------------------------------------------------------------------
  // 7. ORPHANED OUTBOX after total process death → AUTONOMOUS recovery
  //    (the relay boot sweep) — the reviewer's blocking liveness scenario
  // -------------------------------------------------------------------------
  it('orphaned outbox after total process death is AUTONOMOUSLY recovered by a new worker process boot (relay boot sweep)', async () => {
    const { experimentId, trialIds } = await makeExperiment('orphan-boot-sweep');
    const enqueuesBefore = enqueueLog.length;

    // The reviewer's EXACT failure scenario (pre-relay, the outbox was
    // recoverable but NOT autonomously recoverable):
    //
    //     CAS + outbox commit
    //         ↓
    //     process dies before any queue job is delivered
    //         ↓
    //     NO trial job exists
    //     NO worker touches the experiment
    //     NO user reads the experiment
    //         ↓
    //     outbox remains permanently incomplete
    //
    // Simulate it: the atomic claim + outbox rows commit (one repository
    // statement), then the process dies — no relay job enqueued, no
    // audit, no trial job, and NO read of the experiment.
    const claimed = await stack.benchmarkRepository.claimExperimentStart(experimentId);
    expect(claimed).not.toBeNull();
    expect(await countStartAudits(experimentId)).toBe(0);
    expect(enqueueLog.length - enqueuesBefore).toBe(0);

    // ...nothing touches the experiment. The durable outbox row is the
    // ONLY record that something needs to happen.

    // A NEW worker process boots. Its WorkerHost.start() runs the generic
    // OutboxRelay BOOT SWEEP (exactly once per process start —
    // process-startup recovery, NOT a periodic poll): one relay job is
    // enqueued for the orphaned experiment, the existing poll loop drains
    // it, and the relay handler runs the idempotent consumer-side repair.
    // Delivery happens with NO user read + NO surviving trial job — the
    // autonomous-liveness invariant:
    //
    //     outbox row exists ⇒ some existing durable mechanism is
    //     guaranteed to eventually attempt delivery.
    //
    // NOTE: the recovery worker registers ONLY the relay handler — the
    // delivered trial jobs are (faithfully) left in the queue, but not
    // consumed here, keeping the enqueue-count assertions deterministic
    // (trial-lifecycle processing is covered by the async-lifecycle /
    // native-vs-external suites; this test isolates the RELAY).
    const relayOnlyHandlers = buildHandlerRegistry([
      createStartDeliveryRelayJobHandler(stack.benchmarkService as never, stack.authStack.db.logger as never),
    ]);
    const worker2 = new WorkerHost(stack.queue, relayOnlyHandlers, stack.authStack.db.logger as never, {
      pollIntervalMs: 5,
      outboxRelays: [stack.startDeliveryRelay],
    });
    try {
      await worker2.start();
      await waitFor(async () => {
        const incomplete = await stack.benchmarkRepository.listIncompleteStartDeliveries(experimentId);
        return incomplete.length === 0;
      });
    } finally {
      await worker2.stop();
    }

    // ASSERTION — exactly-once logical delivery, autonomously recovered:
    // one BENCHMARK_STARTED audit + one enqueue per trial obligation.
    expect(await countStartAudits(experimentId)).toBe(1);
    expect(enqueuesFor(trialIds[0]!)).toBe(1);
    expect(enqueuesFor(trialIds[1]!)).toBe(1);
    expect(enqueueLog.length - enqueuesBefore).toBe(2);
    // ...and the delivery is complete (the sweep's relay job finished it).
    const incomplete = await stack.benchmarkRepository.listIncompleteStartDeliveries(experimentId);
    expect(incomplete).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 8. claim-time relay job → a mid-replay crash is recovered by a LIVE
  //    worker WITHOUT a restart (the durable relay job in the queue)
  // -------------------------------------------------------------------------
  it('claim-time relay job recovers a crash after the claim WITHOUT a restart (durable queue + live worker)', async () => {
    const { experimentId, trialIds } = await makeExperiment('claim-time-relay-job');
    const enqueuesBefore = enqueueLog.length;

    // startExperiment's FIRST action after the atomic claim is enqueueing
    // the durable relay job — BEFORE the immediate replay begins. Simulate
    // the crash right after that enqueue (the immediate replay never
    // runs): the relay job sits durably in the queue.
    const claimed = await stack.benchmarkRepository.claimExperimentStart(experimentId);
    expect(claimed).not.toBeNull();
    await stack.queue.enqueue(BENCHMARK_START_DELIVERY_RELAY_JOB_TYPE, { experimentId });
    // (crash — nothing delivered yet)
    expect(await countStartAudits(experimentId)).toBe(0);
    expect(enqueueLog.length - enqueuesBefore).toBe(0);

    // A LIVE worker (already-booted processes included — no restart, no
    // boot sweep) drains the durable relay job through the EXISTING poll
    // loop + registry → the relay handler delivers. NOTE: this worker is
    // constructed WITHOUT outboxRelays (isolating the durable-relay-job
    // path from the boot sweep — scenario 7 covers the sweep) + with a
    // relay-only handler registry (the delivered trial jobs stay in the
    // queue unconsumed — deterministic enqueue counts).
    const relayOnlyHandlers = buildHandlerRegistry([
      createStartDeliveryRelayJobHandler(stack.benchmarkService as never, stack.authStack.db.logger as never),
    ]);
    const liveWorker = new WorkerHost(stack.queue, relayOnlyHandlers, stack.authStack.db.logger as never, {
      pollIntervalMs: 5,
    });
    try {
      await liveWorker.start();
      await waitFor(async () => {
        const incomplete = await stack.benchmarkRepository.listIncompleteStartDeliveries(experimentId);
        return incomplete.length === 0;
      });
    } finally {
      await liveWorker.stop();
    }

    // ASSERTION — exactly-once logical delivery via the relay job alone.
    expect(await countStartAudits(experimentId)).toBe(1);
    expect(enqueuesFor(trialIds[0]!)).toBe(1);
    expect(enqueuesFor(trialIds[1]!)).toBe(1);
    expect(enqueueLog.length - enqueuesBefore).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 9. duplicate relay jobs (claim-time + boot sweep) → exactly-once
  // -------------------------------------------------------------------------
  it('duplicate relay jobs (claim-time + boot sweep) converge to exactly-once logical delivery', async () => {
    const { experimentId, trialIds } = await makeExperiment('duplicate-relay-jobs');
    const enqueuesBefore = enqueueLog.length;

    // Race everything a real deployment can race: the claim commits, the
    // claim-time relay job is enqueued TWICE (e.g. a retrying client), and
    // the boot sweep ALSO fires (a worker restarts concurrently) — three
    // relay jobs for the same experiment. Duplicate relay jobs are
    // harmless BY CONTRACT (the consumer-side replay is idempotent).
    const claimed = await stack.benchmarkRepository.claimExperimentStart(experimentId);
    expect(claimed).not.toBeNull();
    await stack.queue.enqueue(BENCHMARK_START_DELIVERY_RELAY_JOB_TYPE, { experimentId });
    await stack.queue.enqueue(BENCHMARK_START_DELIVERY_RELAY_JOB_TYPE, { experimentId });
    const swept = await stack.startDeliveryRelay.enqueuePendingRelayJobs();
    expect(swept).toBe(1);
    expect(await countStartAudits(experimentId)).toBe(0);

    // A worker (no relays — the three queued relay jobs drive it; a
    // relay-only registry keeps the counts deterministic) drains them
    // sequentially: the first delivers everything; the rest no-op.
    const relayOnlyHandlers = buildHandlerRegistry([
      createStartDeliveryRelayJobHandler(stack.benchmarkService as never, stack.authStack.db.logger as never),
    ]);
    const worker2 = new WorkerHost(stack.queue, relayOnlyHandlers, stack.authStack.db.logger as never, {
      pollIntervalMs: 5,
    });
    try {
      await worker2.start();
      await waitFor(async () => {
        const incomplete = await stack.benchmarkRepository.listIncompleteStartDeliveries(experimentId);
        return incomplete.length === 0;
      });
      // Let the remaining duplicate relay jobs drain too (they must no-op).
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      await worker2.stop();
    }

    // ASSERTION — repeated relay delivery still produces ONE logical
    // start: one audit, one enqueue per trial, one delivery row.
    expect(await countStartAudits(experimentId)).toBe(1);
    expect(enqueuesFor(trialIds[0]!)).toBe(1);
    expect(enqueuesFor(trialIds[1]!)).toBe(1);
    expect(enqueueLog.length - enqueuesBefore).toBe(2);
    expect(await countDeliveries(experimentId)).toBe(1);
    expect(await countObligations(experimentId)).toBe(2);
  });
});
