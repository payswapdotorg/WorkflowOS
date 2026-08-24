/**
 * PR #35 follow-up (idempotency): regression tests proving the benchmark
 * trial lifecycle is EXACTLY-ONCE under duplicate job delivery + concurrent
 * workers. Closes the two races identified in the PR #35 follow-up review:
 *
 *   1. `queued → running` CLAIM race: two deliveries of the same
 *      `benchmark.trial` job both observed `queued`, both passed the
 *      unconditional `UPDATE ... WHERE id=$1`, and both proceeded to
 *      clone / branch / submit — producing DUPLICATE logical executions.
 *
 *   2. `running → terminal` FINALIZATION race: two terminal-advancement
 *      jobs both called `finalizeTrial`, both did the unconditional
 *      `UPDATE ... SET status=... WHERE id=$1`, and both collected metrics +
 *      inserted findings + wrote audit events — producing DUPLICATE findings
 *      + DUPLICATE audit events (upsertMetrics was PK-protected; the audit +
 *      findings were not).
 *
 * The fix introduces an EXPLICIT, persisted phase lifecycle
 * (`queued → starting → execution_wait → delivery_wait → completed | failed`)
 * where every transition is a compare-and-swap owned by the benchmark
 * application layer (`WHERE id=$1 AND lifecycle_phase=$expected RETURNING *`).
 * Only the worker that receives a RETURNING row may perform the side effects
 * for that phase. A duplicate delivery observes an already-claimed /
 * already-advanced phase + NO-OPS.
 *
 * These tests prove the invariant the review requires:
 *
 *   duplicate job → observe already-advanced state → NO side effects
 *   (NOT: duplicate job → rerun orchestration / refinalize)
 *
 * The v2 event-driven architecture is PRESERVED — there is NO bounded poll,
 * NO second execution engine (§34 invariant). The benchmark still consumes
 * ExecutionService (owned by /agents) + reads authoritative workflow /
 * verification / review state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildBenchmarkStack,
  teardownBenchmarkStack,
  type BenchmarkStack,
} from './benchmark-stack.js';
import type { WorkflowState } from '../../../src/modules/workflows/index.js';

describe('PR #35 follow-up — benchmark trial idempotency / concurrency', () => {
  let stack: BenchmarkStack;
  /** Monkey-patched counter on the FakeGitHubAdapter.createBranch method. */
  let createBranchCount: number;

  const API_KEY = 'raw-key-idempotency-a';
  const SECRET_REF = 'WFOS_TEST_KEY_IDEMPOTENCY_A';

  beforeAll(async () => {
    stack = await buildBenchmarkStack({ apiKey: API_KEY, secretRef: SECRET_REF });
    // Monkey-patch the FakeGitHubAdapter to count createBranch calls — the
    // claim-race side-effect signal. WITHOUT the atomic claim, two duplicate
    // deliveries would both call createBranch (the loser would then hit the
    // UNIQUE constraint on the clone work item, throw, + clobber the trial).
    // WITH the atomic claim, only the winner calls createBranch.
    createBranchCount = 0;
    const orig = stack.githubAdapter.createBranch.bind(stack.githubAdapter);
    stack.githubAdapter.createBranch = async (input) => {
      createBranchCount++;
      return orig(input);
    };
  });

  afterAll(async () => {
    await teardownBenchmarkStack(stack);
  });

  /** Create a snapshot + experiment (helper — mirrors async-lifecycle). */
  async function makeExperiment(
    name: string,
    trials: { provider: string; mode: 'native' | 'external'; repetitions: number }[],
  ): Promise<{ experimentId: string; snapshotId: string }> {
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
      trials,
      createdBy: stack.fixture.userId,
    });
    return { experimentId: exp.id, snapshotId: snapshot.id };
  }

  it('duplicate runTrialJob on a QUEUED trial claims exactly once (NO duplicate clone/branch/execution)', async () => {
    const beforeBranchCount = createBranchCount;
    const { experimentId } = await makeExperiment('claim-race-native', [
      { provider: 'fake', mode: 'native', repetitions: 1 },
    ]);
    const { trials } = await stack.benchmarkService.listTrials(experimentId);
    const trialId = trials[0]!.id;

    // Two CONCURRENT deliveries of the same `benchmark.trial` job. WITHOUT
    // the atomic claim, both observe 'queued', both call runTrial → clone
    // → branch → submit (the loser's clone hits the UNIQUE constraint,
    // throws, → failTrial → CLOBBERS the trial to 'failed'). WITH the
    // atomic claim (claimTrialForSetup: queued→starting compare-and-swap),
    // only one worker wins; the loser observes null + returns WITHOUT side
    // effects.
    await Promise.all([
      stack.benchmarkService.runTrialJob(trialId),
      stack.benchmarkService.runTrialJob(trialId),
    ]);

    // ASSERTION 1: exactly ONE branch creation (the winner's). The loser
    // never reached createBranch (the claim failed first → runTrial
    // returned the current state without side effects).
    const branchCallsForThisTrial = createBranchCount - beforeBranchCount;
    expect(branchCallsForThisTrial).toBe(1);

    // ASSERTION 2: the trial is in 'delivery_wait' (native: starting →
    // delivery_wait — execution synchronous-completed, awaiting verified).
    // NOT 'failed' (the loser would have CLOBBERED it to 'failed' without
    // the claim) + NOT 'queued'/'starting' (the winner advanced).
    const after = await stack.benchmarkRepository.getTrial(trialId);
    expect(after?.lifecyclePhase).toBe('delivery_wait');
    expect(after?.status).toBe('running'); // backward-compat high-level field

    // ASSERTION 3: exactly ONE cloned work item. The clone label is
    // `${templateWorkItemId}-bench-${trialId.slice(0,8)}` — query the DB
    // + assert exactly one row. WITHOUT the claim, the loser's clone
    // would throw on the UNIQUE constraint (so this count would still be
    // 1), BUT the trial would be clobbered to 'failed' (assertion 2
    // catches that). Together, assertions 2 + 3 prove exactly-once setup.
    expect(after?.workItemId).toBeTruthy();
    expect(after?.executionId).toBeTruthy();
    const cloneCount = await stack.authStack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_work_items WHERE work_item_id LIKE $1`,
      [`%-bench-${trialId.slice(0, 8)}`],
    );
    expect(Number(cloneCount.rows[0]?.c ?? 0)).toBe(1);

    // ASSERTION 4: NO premature terminal audit events (the trial is still
    // in delivery_wait — not yet verified). The setup path writes no
    // audit; only finalize does. This catches the bug where the loser's
    // failTrial would have written a spurious TRIAL_FAILED audit event.
    const auditEvents = await stack.auditService.listForResource('benchmark_trial', trialId);
    const terminalAudits = auditEvents.filter(
      (e) => e.eventType === 'TRIAL_COMPLETED' || e.eventType === 'TRIAL_FAILED',
    );
    expect(terminalAudits).toHaveLength(0);
  });

  it('concurrent finalization on a DELIVERY_WAIT trial finalizes exactly once (NO duplicate metrics/audit)', async () => {
    const { experimentId } = await makeExperiment('finalize-race-native', [
      { provider: 'fake', mode: 'native', repetitions: 1 },
    ]);
    // Transition the experiment to 'running' WITHOUT enqueuing jobs
    // (startExperiment would enqueue → the worker would race with our
    // controlled concurrent calls). Set the status directly so
    // checkExperimentCompletion can finalize the experiment via the atomic
    // claimExperimentCompletion (WHERE status='running').
    await stack.benchmarkRepository.updateExperimentStatus(
      experimentId, 'running', { startedAt: new Date() },
    );
    const { trials } = await stack.benchmarkService.listTrials(experimentId);
    const trialId = trials[0]!.id;

    // Run the orchestrator ONCE → trial advances to delivery_wait (native:
    // starting → delivery_wait). The cloned work item is at 'ready'.
    await stack.benchmarkService.runTrialJob(trialId);
    let trial = await stack.benchmarkRepository.getTrial(trialId);
    expect(trial?.lifecyclePhase).toBe('delivery_wait');
    expect(trial?.workItemId).toBeTruthy();

    // Drive the cloned work item through the legal workflow path to
    // 'verified' (the delivery-success terminal state). Do NOT enqueue a
    // benchmark.trial job — we want to control the concurrent finalization.
    const path: WorkflowState[] = [
      'assigned', 'implementing', 'pr_open', 'verifying',
      'architect_review', 'approved', 'merged', 'verified',
    ];
    let current = (await stack.workflowEngine.getState(trial!.workItemId!))!.currentState;
    for (const target of path) {
      if (current === target || current === 'verified') break;
      const res = await stack.workflowEngine.transition({
        workItemId: trial!.workItemId!,
        toState: target,
        transitionType: 'benchmark-trial-delivery',
        actor: 'benchmark-test-driver',
      });
      if (res.success) {
        current = target;
      } else {
        const fresh = await stack.workflowEngine.getState(trial!.workItemId!);
        if (!fresh) break;
        current = fresh.currentState;
        if (current === 'verified') break;
      }
    }
    expect(current).toBe('verified');

    // Two CONCURRENT deliveries of the same `benchmark.trial` job, both
    // observing delivery_wait + verified. WITHOUT the atomic terminal
    // claim (claimTerminal: delivery_wait→completed compare-and-swap), both
    // would call finalizeTrial → both would write a TRIAL_COMPLETED audit
    // event (append-only → DUPLICATE) + both would upsertMetrics
    // (PK-protected → 1 row) + both would insertFindings (duplicate rows).
    // WITH the atomic claim, only one worker wins; the loser observes null +
    // skips ALL side effects.
    await Promise.all([
      stack.benchmarkService.runTrialJob(trialId),
      stack.benchmarkService.runTrialJob(trialId),
    ]);

    // ASSERTION 1: the trial is terminal 'completed'.
    trial = await stack.benchmarkRepository.getTrial(trialId);
    expect(trial?.lifecyclePhase).toBe('completed');
    expect(trial?.status).toBe('completed');

    // ASSERTION 2 (the key signal): exactly ONE TRIAL_COMPLETED audit
    // event. The append-only audit is the clearest proof of the finalize
    // race — WITHOUT the atomic claim, two concurrent finalize calls would
    // produce TWO events; WITH the claim, exactly one.
    const auditEvents = await stack.auditService.listForResource('benchmark_trial', trialId);
    const completedAudits = auditEvents.filter((e) => e.eventType === 'TRIAL_COMPLETED');
    expect(completedAudits).toHaveLength(1);

    // ASSERTION 3: exactly ONE metrics row (PK-protected by trial_id, so
    // this holds even without the fix — but assert it for completeness;
    // the audit count above is the real signal).
    const metrics = await stack.benchmarkService.getTrialMetrics(trialId);
    expect(metrics).not.toBeNull();

    // ASSERTION 4: the experiment reached 'completed' (exactly-once
    // experiment finalization via claimExperimentCompletion — no duplicate
    // BENCHMARK_COMPLETED audit).
    const exp = await stack.benchmarkService.getExperiment(experimentId);
    expect(exp?.status).toBe('completed');
    const expAudit = await stack.auditService.listForResource('benchmark_experiment', experimentId);
    const completedExpAudits = expAudit.filter((e) => e.eventType === 'BENCHMARK_COMPLETED');
    expect(completedExpAudits).toHaveLength(1);
  });

  it('repository-level claimTrialForSetup compare-and-swap: exactly one winner', async () => {
    const { experimentId } = await makeExperiment('repo-claim-cas', [
      { provider: 'fake', mode: 'native', repetitions: 1 },
    ]);
    const { trials } = await stack.benchmarkService.listTrials(experimentId);
    const trialId = trials[0]!.id;

    // The trial is 'queued' (no orchestrator has run). Call
    // claimTrialForSetup TWICE concurrently — the DB's atomic UPDATE
    // (WHERE lifecycle_phase='queued') ensures exactly one wins. This is
    // the direct, repository-level proof of the compare-and-swap that
    // underpins the claim race fix (test 1 tests the end-to-end invariant;
    // this test isolates the SQL mechanism).
    const [a, b] = await Promise.all([
      stack.benchmarkRepository.claimTrialForSetup(trialId),
      stack.benchmarkRepository.claimTrialForSetup(trialId),
    ]);

    // Exactly one winner (non-null) + one loser (null). XOR.
    expect(a === null || b === null).toBe(true); // at least one is null
    expect(a !== null || b !== null).toBe(true); // at least one is non-null
    // They cannot BOTH be non-null (the claim is exclusive).
    expect(!(a !== null && b !== null)).toBe(true);
    const winner = (a ?? b)!;
    expect(winner.lifecyclePhase).toBe('starting');
    expect(winner.status).toBe('running'); // bumped in the same statement

    // The trial is now 'starting' (claimed ONCE — not double-claimed to
    // some intermediate state).
    const after = await stack.benchmarkRepository.getTrial(trialId);
    expect(after?.lifecyclePhase).toBe('starting');
    expect(after?.status).toBe('running');

    // A THIRD claim attempt (now that the trial is 'starting') also returns
    // null — the compare-and-swap guard rejects it (lifecycle_phase is no
    // longer 'queued').
    const third = await stack.benchmarkRepository.claimTrialForSetup(trialId);
    expect(third).toBeNull();
  });

  it('mid-orchestration redelivery NO-OPS on the starting phase (NO spurious execution-record-not-found failure)', async () => {
    // This tests the THIRD race the review identified: a redelivery arriving
    // while the orchestrator is still mid-setup (between claim + advance to
    // delivery_wait) would — under the OLD coarse `status='running'`
    // routing — read 'running', observe executionId=null, + finalize the
    // active trial as 'execution-record-not-found'. The `starting` phase
    // makes that redelivery a no-op (it observes 'starting' + returns).
    //
    // We simulate this by claiming the trial (queued→starting) WITHOUT
    // running the full orchestrator, then calling runTrialJob — which must
    // observe 'starting' + return WITHOUT finalizing.
    const { experimentId } = await makeExperiment('starting-noop-redelivery', [
      { provider: 'fake', mode: 'external', repetitions: 1 },
    ]);
    const { trials } = await stack.benchmarkService.listTrials(experimentId);
    const trialId = trials[0]!.id;

    // Manually claim (queued → starting) WITHOUT running the orchestrator
    // — simulates the orchestrator being mid-setup.
    const claimed = await stack.benchmarkRepository.claimTrialForSetup(trialId);
    expect(claimed).not.toBeNull();
    expect(claimed?.lifecyclePhase).toBe('starting');

    // A redelivery (runTrialJob) arrives. Under the OLD routing (status=
    // 'running' → execution phase → executionId null → finalize 'failed'),
    // this would CLOBBER the active trial. Under the NEW routing
    // (lifecycle_phase='starting' → NO-OP), it returns without side effects.
    await stack.benchmarkService.runTrialJob(trialId);

    // The trial is STILL 'starting' (NOT clobbered to 'failed' with a
    // spurious 'execution-record-not-found' reason). No audit, no metrics.
    const after = await stack.benchmarkRepository.getTrial(trialId);
    expect(after?.lifecyclePhase).toBe('starting');
    expect(after?.status).toBe('running');
    const auditEvents = await stack.auditService.listForResource('benchmark_trial', trialId);
    expect(auditEvents).toHaveLength(0);
    const metrics = await stack.benchmarkService.getTrialMetrics(trialId);
    expect(metrics).toBeNull();
  });

  it('DB rejects divergent (status, lifecycle_phase) pairs — the mechanical invariant is enforced at the persistence boundary, NOT just the application layer', async () => {
    // The review explicitly warned: a dual-state model (status +
    // lifecycle_phase) "is dangerous unless there is a mechanically enforced
    // invariant between the two" — otherwise the race moves into a subtle
    // state-divergence problem (a future raw UPDATE touching only one column
    // could silently introduce a divergent row the concurrency model does
    // not know how to route). The `wfos_benchmark_trials_status_phase_invariant`
    // CHECK constraint (migration 0027) is that mechanical enforcement. This
    // test proves the DB itself REJECTS divergent writes at runtime — not
    // just that the application layer happens to update both columns together.
    const { experimentId } = await makeExperiment('db-invariant-rejection', [
      { provider: 'fake', mode: 'native', repetitions: 1 },
    ]);
    const { trials } = await stack.benchmarkService.listTrials(experimentId);
    const trialId = trials[0]!.id;
    // Sanity: the created trial is canonical (queued, queued).
    const before = await stack.benchmarkRepository.getTrial(trialId);
    expect(before?.lifecyclePhase).toBe('queued');
    expect(before?.status).toBe('queued');

    // Divergent pairings the concurrency model cannot route. Each MUST be
    // rejected by the CHECK constraint (PostgreSQL error code 23514 =
    // check_violation). These are the exact divergences the review warned
    // about: status='running' + lifecycle_phase='completed' (looks done to
    // readers but the phase router sees terminal → no-ops; looks terminal
    // to status-readers but execution may still be in flight), + the
    // inverse (status='failed' + lifecycle_phase='delivery_wait' — looks
    // terminal to status-readers but the phase router tries to finalize
    // again → duplicate side effects).
    const divergentPairs: Array<{ status: string; phase: string; label: string }> = [
      { status: 'running', phase: 'completed', label: 'status=running + phase=completed (status says in-flight, phase says terminal)' },
      { status: 'failed', phase: 'delivery_wait', label: 'status=failed + phase=delivery_wait (status says terminal, phase says awaiting delivery)' },
      { status: 'running', phase: 'failed', label: 'status=running + phase=failed (status says in-flight, phase says terminal-failed)' },
      { status: 'completed', phase: 'queued', label: 'status=completed + phase=queued (status says terminal, phase says never-claimed)' },
      { status: 'queued', phase: 'starting', label: 'status=queued + phase=starting (phase says claimed, status says never-claimed)' },
    ];
    for (const { status, phase, label } of divergentPairs) {
      const res = await stack.authStack.db.client.query(
        `UPDATE wfos_benchmark_trials
           SET status = $2, lifecycle_phase = $3
         WHERE id = $1`,
        [trialId, status, phase],
      ).catch((err: { code?: string; message: string }) => err);
      // Expect a check_violation (Postgres error code 23514). pglite surfaces
      // the constraint name in the message; native pg surfaces it via the
      // `code` field. Accept either signal so the test is portable across the
      // two drivers the stack supports.
      const isCheckViolation =
        (typeof (res as { code?: string }).code === 'string' && (res as { code: string }).code === '23514') ||
        /status_phase_invariant/i.test((res as Error).message) ||
        /violates.*check/i.test((res as Error).message);
      expect(isCheckViolation, `divergent pair (${label}) MUST be rejected by the DB CHECK constraint`).toBe(true);
      // The row MUST be unchanged (the rejected UPDATE rolled back).
      const after = await stack.benchmarkRepository.getTrial(trialId);
      expect(after?.status).toBe('queued');
      expect(after?.lifecyclePhase).toBe('queued');
    }

    // Positive control: a CANONICAL write (queued, queued → starting, running)
    // via claimTrialForSetup MUST succeed (the constraint allows it). This
    // proves the invariant is not so tight that it blocks the legal CAS path.
    const claimed = await stack.benchmarkRepository.claimTrialForSetup(trialId);
    expect(claimed).not.toBeNull();
    expect(claimed?.lifecyclePhase).toBe('starting');
    expect(claimed?.status).toBe('running');
  });

  it('migration 0027 backfill classifies native running→delivery_wait + external running→execution_wait', async () => {
    // PR #36 review fix #1: a native `running` trial is past execution
    // (native is synchronous-completed by the orchestrator) + awaiting
    // delivery, so it MUST backfill to `delivery_wait`. An external
    // `running` trial is awaiting external execution completion, so it
    // backfills to `execution_wait`. The prior single backfill (all running
    // → execution_wait) misclassified native trials — runTrialJob would
    // then re-read a non-existent execution record + finalize them as
    // 'execution-record-not-found'.
    //
    // The pre-migration state (status='running', lifecycle_phase='queued')
    // is now FORBIDDEN by the `wfos_benchmark_trials_status_phase_invariant`
    // CHECK (added after the backfill in migration 0027). To test the
    // backfill SQL at runtime we must TEMPORARILY drop the CHECK — exactly
    // mirroring the migration's own ordering (backfill runs BEFORE the
    // CHECK is added). The CHECK is re-added in a finally block so the
    // invariant is always restored.
    const { experimentId } = await makeExperiment('backfill-mode-split', [
      { provider: 'fake', mode: 'native', repetitions: 1 },
      { provider: 'fake', mode: 'external', repetitions: 1 },
    ]);
    const { trials } = await stack.benchmarkService.listTrials(experimentId);
    expect(trials).toHaveLength(2);
    const nativeTrial = trials.find((t) => t.executionMode === 'native')!;
    const externalTrial = trials.find((t) => t.executionMode === 'external')!;

    const db = stack.authStack.db.client;
    // Temporarily drop the invariant CHECK so we can recreate the
    // pre-migration divergent state the backfill is designed to fix.
    await db.query(`ALTER TABLE wfos_benchmark_trials DROP CONSTRAINT wfos_benchmark_trials_status_phase_invariant`);
    try {
      // Simulate pre-migration state: both trials at status='running' +
      // lifecycle_phase='queued' (the column default before the backfill).
      await db.query(`UPDATE wfos_benchmark_trials SET status = 'running', lifecycle_phase = 'queued' WHERE id = $1`, [nativeTrial.id]);
      await db.query(`UPDATE wfos_benchmark_trials SET status = 'running', lifecycle_phase = 'queued' WHERE id = $1`, [externalTrial.id]);

      // Run the two mode-split backfill UPDATEs from migration 0027
      // (verbatim — these are the statements the reviewer asked to split).
      await db.query(`UPDATE wfos_benchmark_trials SET lifecycle_phase = 'delivery_wait' WHERE status = 'running' AND execution_mode = 'native' AND lifecycle_phase = 'queued'`);
      await db.query(`UPDATE wfos_benchmark_trials SET lifecycle_phase = 'execution_wait' WHERE status = 'running' AND execution_mode = 'external' AND lifecycle_phase = 'queued'`);

      // ASSERTION: native trial → delivery_wait (NOT execution_wait).
      const nativeAfter = await stack.benchmarkRepository.getTrial(nativeTrial.id);
      expect(nativeAfter?.lifecyclePhase).toBe('delivery_wait');
      expect(nativeAfter?.status).toBe('running');
      // ASSERTION: external trial → execution_wait (NOT delivery_wait).
      const externalAfter = await stack.benchmarkRepository.getTrial(externalTrial.id);
      expect(externalAfter?.lifecyclePhase).toBe('execution_wait');
      expect(externalAfter?.status).toBe('running');
    } finally {
      // Always restore the invariant CHECK (even if the assertions failed).
      await db.query(`ALTER TABLE wfos_benchmark_trials ADD CONSTRAINT wfos_benchmark_trials_status_phase_invariant CHECK (lifecycle_phase = 'queued' AND status = 'queued' OR lifecycle_phase = 'starting' AND status = 'running' OR lifecycle_phase = 'execution_wait' AND status = 'running' OR lifecycle_phase = 'delivery_wait' AND status = 'running' OR lifecycle_phase = 'completed' AND status = 'completed' OR lifecycle_phase = 'failed' AND status IN ('failed','unavailable'))`);
    }
  });

  it('integrity failure does NOT expose a false completed experiment (two-phase protocol: invalidated instead)', async () => {
    // PR #36 review fix #2a: if integrity validation fails, the experiment
    // MUST end in 'invalidated' (NOT 'completed'), + BENCHMARK_INVALIDATED
    // must be audited, + BENCHMARK_COMPLETED must NOT be audited. The prior
    // version flipped the experiment to 'completed' BEFORE validation ran,
    // so a failed integrity check exposed a false successful completion.
    const { experimentId } = await makeExperiment('integrity-failure-native', [
      { provider: 'fake', mode: 'native', repetitions: 1 },
    ]);
    await stack.benchmarkRepository.updateExperimentStatus(
      experimentId, 'running', { startedAt: new Date() },
    );
    const { trials } = await stack.benchmarkService.listTrials(experimentId);
    const trialId = trials[0]!.id;

    // Run the orchestrator once → trial advances to delivery_wait (native:
    // starting → delivery_wait). The cloned work item is at 'ready'.
    await stack.benchmarkService.runTrialJob(trialId);
    let trial = await stack.benchmarkRepository.getTrial(trialId);
    expect(trial?.lifecyclePhase).toBe('delivery_wait');
    expect(trial?.workItemId).toBeTruthy();

    // Drive the cloned work item through the legal workflow path to
    // 'verified' (the delivery-success terminal state).
    const path: WorkflowState[] = [
      'assigned', 'implementing', 'pr_open', 'verifying',
      'architect_review', 'approved', 'merged', 'verified',
    ];
    let current = (await stack.workflowEngine.getState(trial!.workItemId!))!.currentState;
    for (const target of path) {
      if (current === target || current === 'verified') break;
      const res = await stack.workflowEngine.transition({
        workItemId: trial!.workItemId!,
        toState: target,
        transitionType: 'benchmark-trial-delivery',
        actor: 'benchmark-test-driver',
      });
      if (res.success) {
        current = target;
      } else {
        const fresh = await stack.workflowEngine.getState(trial!.workItemId!);
        if (!fresh) break;
        current = fresh.currentState;
        if (current === 'verified') break;
      }
    }
    expect(current).toBe('verified');

    // CORRUPT the trial's prompt_digest so it mismatches the snapshot —
    // integrity validation (§27) MUST fail when the digest set diverges
    // from the snapshot's digest. This is the corruption that, under the
    // OLD protocol, would have produced a false 'completed' experiment.
    await stack.authStack.db.client.query(
      `UPDATE wfos_benchmark_trials SET prompt_digest = 'corrupted-digest-that-mismatches-snapshot'
       WHERE id = $1`,
      [trialId],
    );

    // Final runTrialJob: finalizes the trial to 'completed' (the trial-level
    // CAS, claimTerminal, is independent of the experiment-level integrity
    // check) + then calls checkExperimentCompletion. The two-phase protocol:
    //   claimExperimentCompletion (running → finalizing)  [reservation]
    //   integrityService.validate → valid===false          [§27 digest mismatch]
    //   finalizeExperimentInvalidation (finalizing → invalidated)  [failure path]
    //   audit BENCHMARK_INVALIDATED
    await stack.benchmarkService.runTrialJob(trialId);

    // ASSERTION 1: the experiment is 'invalidated' (NOT 'completed'). This
    // is the core of the fix — a failed integrity check cannot expose a
    // false successful completion.
    const exp = await stack.benchmarkService.getExperiment(experimentId);
    expect(exp?.status).toBe('invalidated');

    // ASSERTION 2: BENCHMARK_INVALIDATED was audited (the failure path).
    const expAudit = await stack.auditService.listForResource('benchmark_experiment', experimentId);
    const invalidatedAudits = expAudit.filter((e) => e.eventType === 'BENCHMARK_INVALIDATED');
    expect(invalidatedAudits).toHaveLength(1);

    // ASSERTION 3: BENCHMARK_COMPLETED was NOT audited (the false-success
    // audit the old protocol would have written).
    const completedAudits = expAudit.filter((e) => e.eventType === 'BENCHMARK_COMPLETED');
    expect(completedAudits).toHaveLength(0);

    // ASSERTION 4: the trial itself DID reach 'completed' (the trial-level
    // finalization is independent of the experiment-level integrity check —
    // the trial's execution genuinely succeeded; it's the experiment's
    // integrity that failed because the digest was corrupted).
    trial = await stack.benchmarkRepository.getTrial(trialId);
    expect(trial?.lifecyclePhase).toBe('completed');
    expect(trial?.status).toBe('completed');
  });

  it('concurrent experiment completion finalizes exactly once (reservation + finalization)', async () => {
    // PR #36 review fix #2b: the two-phase completion protocol (reservation
    // running→finalizing, then finalization finalizing→completed) MUST
    // preserve exactly-once behavior under concurrent workers. This test
    // isolates the repository-level CAS exclusivity that underpins the
    // end-to-end exactly-once (test #2 above covers the end-to-end
    // audit count; this test isolates the two new CAS transitions).
    const { experimentId } = await makeExperiment('concurrent-completion-cas', [
      { provider: 'fake', mode: 'native', repetitions: 1 },
    ]);
    const { trials } = await stack.benchmarkService.listTrials(experimentId);
    const trialId = trials[0]!.id;

    // Put the experiment + trial into the state checkExperimentCompletion
    // expects: experiment 'running', trial terminal ('completed').
    await stack.benchmarkRepository.updateExperimentStatus(
      experimentId, 'running', { startedAt: new Date() },
    );
    await stack.authStack.db.client.query(
      `UPDATE wfos_benchmark_trials
         SET status = 'completed', lifecycle_phase = 'completed', completed_at = NOW()
       WHERE id = $1`,
      [trialId],
    );

    // Phase 1 — RESERVATION CAS exclusivity. Two concurrent
    // claimExperimentCompletion calls: exactly one wins (running→finalizing),
    // one loses (null). This is the exactly-once guarantee that only one
    // worker proceeds to integrity validation. The 30s lease TTL is enough
    // for the test to finalize without the lease expiring mid-test (the
    // recovery regression below exercises the expired-lease path).
    const [a, b] = await Promise.all([
      stack.benchmarkRepository.claimExperimentCompletion(experimentId, 30_000),
      stack.benchmarkRepository.claimExperimentCompletion(experimentId, 30_000),
    ]);
    // Exactly one winner (non-null) + one loser (null). XOR.
    expect(a === null || b === null).toBe(true);
    expect(a !== null || b !== null).toBe(true);
    expect(!(a !== null && b !== null)).toBe(true);
    const winner = (a ?? b)!;
    expect(winner.status).toBe('finalizing');

    // The experiment is now 'finalizing' (the reservation state — NOT
    // 'completed'). This is the key invariant: the reservation does NOT
    // make 'completed' authoritative.
    let exp = await stack.benchmarkService.getExperiment(experimentId);
    expect(exp?.status).toBe('finalizing');

    // A THIRD claim attempt (now that the experiment is 'finalizing') also
    // returns null — the reservation CAS guard (WHERE status='running')
    // rejects it. (The lease is also NOT stale — only 30s old — so the
    // recovery CAS would reject it too; both paths are exclusive.)
    const third = await stack.benchmarkRepository.claimExperimentCompletion(experimentId, 30_000);
    expect(third).toBeNull();

    // Phase 3a — success finalization CAS. finalizeExperimentCompletion
    // (finalizing → completed) makes the status authoritative. This is the
    // ONLY path to 'completed'.
    const finalized = await stack.benchmarkRepository.finalizeExperimentCompletion(experimentId);
    expect(finalized).not.toBeNull();
    expect(finalized?.status).toBe('completed');

    // The experiment is now 'completed' (authoritative, post-integrity).
    exp = await stack.benchmarkService.getExperiment(experimentId);
    expect(exp?.status).toBe('completed');

    // Phase 3b — failure finalization CAS guard. A second
    // finalizeExperimentCompletion returns null (the experiment is no longer
    // 'finalizing' — it's 'completed'). The CAS is exclusive.
    const duplicateFinalize = await stack.benchmarkRepository.finalizeExperimentCompletion(experimentId);
    expect(duplicateFinalize).toBeNull();

    // The failure-path finalization (finalizeExperimentInvalidation) ALSO
    // returns null (the experiment is 'completed', not 'finalizing') — the
    // experiment cannot be invalidated after it's already completed.
    const invalidationAttempt = await stack.benchmarkRepository.finalizeExperimentInvalidation(experimentId);
    expect(invalidationAttempt).toBeNull();
  });

  it('lost `finalizing` worker is recovered to exactly one terminal state + exactly one terminal audit (success path)', async () => {
    // PR #36 review fix #3: the third + final PR #36 review blocker. The
    // two-phase completion protocol (migration 0028) introduced a durable
    // `running → finalizing` reservation, but if the worker that WON the
    // reservation DIED before finalizing (process crash, container kill,
    // DB timeout between claim + finalize), the experiment was permanently
    // stuck in `finalizing`:
    //   * claimExperimentCompletion only matches WHERE status='running',
    //     so no other worker could re-enter the protocol via the fresh path.
    //   * checkExperimentCompletion is only triggered when a trial reaches
    //     terminal — but ALL trials were already terminal (the precondition
    //     for entering the protocol), so no trial would finish again to
    //     re-trigger the check.
    // The fix: a persisted `finalizing_lease_expires_at` (migration 0029) +
    // a `recoverStaleFinalizingExperiment` CAS that reclaims expired-lease
    // `finalizing` rows + renews the lease (so the recovering worker has
    // exclusive ownership) + lazy recovery on `getExperiment` reads. This
    // test proves a lost worker is recovered to EXACTLY ONE terminal state
    // (`completed`, since integrity passes) + EXACTLY ONE terminal audit
    // event (BENCHMARK_COMPLETED — the lost worker wrote NONE because it
    // died before the audit step; the recovering worker wrote exactly one).
    const { experimentId } = await makeExperiment('lost-worker-recovery-success', [
      { provider: 'fake', mode: 'native', repetitions: 1 },
    ]);
    const { trials } = await stack.benchmarkService.listTrials(experimentId);
    const trialId = trials[0]!.id;

    // Put the experiment + trial into the state checkExperimentCompletion
    // expects: experiment 'running', trial terminal ('completed').
    await stack.benchmarkRepository.updateExperimentStatus(
      experimentId, 'running', { startedAt: new Date() },
    );
    await stack.authStack.db.client.query(
      `UPDATE wfos_benchmark_trials
         SET status = 'completed', lifecycle_phase = 'completed', completed_at = NOW()
       WHERE id = $1`,
      [trialId],
    );

    // Simulate a worker winning the reservation (running → finalizing) +
    // then DYING before validation/finalization. The reservation sets a
    // 30s lease; the worker never calls finalizeExperimentCompletion.
    const claimed = await stack.benchmarkRepository.claimExperimentCompletion(experimentId, 30_000);
    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe('finalizing');

    // The lost worker wrote NO terminal audit event (it died before the
    // audit step). The reservation is durable (`finalizing`) but no audit.
    let expAudit = await stack.auditService.listForResource('benchmark_experiment', experimentId);
    expect(expAudit.filter((e) => e.eventType === 'BENCHMARK_COMPLETED')).toHaveLength(0);
    expect(expAudit.filter((e) => e.eventType === 'BENCHMARK_INVALIDATED')).toHaveLength(0);

    // Simulate the lease EXPIRING (the worker has been dead for longer
    // than the lease TTL). Set the expiry to the past so the recovery CAS
    // (`WHERE finalizing_lease_expires_at < NOW()`) will match.
    await stack.authStack.db.client.query(
      `UPDATE wfos_benchmark_experiments
         SET finalizing_lease_expires_at = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [experimentId],
    );

    // Trigger LAZY RECOVERY via getExperiment (the natural way a stuck
    // experiment is discovered — an operator/dashboard reads the status).
    // The read sees `finalizing`, calls checkExperimentCompletion which
    // runs phase 0 (recoverStaleFinalizingExperiment reclaims + renews
    // the lease), phase 2 (integrity validation — passes, the snapshot +
    // trial digests match), phase 3a (finalizeExperimentCompletion:
    // finalizing → completed) + the BENCHMARK_COMPLETED audit.
    const recovered = await stack.benchmarkService.getExperiment(experimentId);
    expect(recovered?.status).toBe('completed');

    // ASSERTION 1 — exactly ONE terminal audit event. The lost worker
    // wrote NONE (died before audit); the recovering worker wrote exactly
    // one BENCHMARK_COMPLETED. No duplicate, no BENCHMARK_INVALIDATED.
    // This is the reviewer's required invariant: "a lost worker can be
    // safely recovered to exactly one terminal state and exactly one
    // terminal audit event."
    expAudit = await stack.auditService.listForResource('benchmark_experiment', experimentId);
    expect(expAudit.filter((e) => e.eventType === 'BENCHMARK_COMPLETED')).toHaveLength(1);
    expect(expAudit.filter((e) => e.eventType === 'BENCHMARK_INVALIDATED')).toHaveLength(0);

    // ASSERTION 2 — the recovery CAS is idempotent. A SECOND getExperiment
    // call does NOT produce a second audit (the experiment is `completed`,
    // not `finalizing` — the lazy-recovery guard no-ops; + even if it did
    // re-enter, the fresh-claim CAS would reject `completed`). Exactly-once.
    await stack.benchmarkService.getExperiment(experimentId);
    expAudit = await stack.auditService.listForResource('benchmark_experiment', experimentId);
    expect(expAudit.filter((e) => e.eventType === 'BENCHMARK_COMPLETED')).toHaveLength(1);
  });

  it('lost `finalizing` worker is recovered to exactly one terminal state + exactly one terminal audit (integrity-failure path)', async () => {
    // PR #36 review fix #3 (companion to the success-path recovery test):
    // the recovery MUST also handle the INTEGRITY-FAILURE path. If the
    // experiment's integrity was corrupt (e.g. a trial's prompt_digest
    // mismatches the snapshot — §27), the recovering worker runs phase 2
    // (validation returns valid===false) + phase 3b
    // (finalizeExperimentInvalidation: finalizing → invalidated) + the
    // BENCHMARK_INVALIDATED audit. This proves the recovery reaches the
    // CORRECT terminal state for the data (invalidated, NOT a false
    // completed) + writes exactly one terminal audit.
    const { experimentId } = await makeExperiment('lost-worker-recovery-invalidation', [
      { provider: 'fake', mode: 'native', repetitions: 1 },
    ]);
    const { trials } = await stack.benchmarkService.listTrials(experimentId);
    const trialId = trials[0]!.id;

    await stack.benchmarkRepository.updateExperimentStatus(
      experimentId, 'running', { startedAt: new Date() },
    );
    await stack.authStack.db.client.query(
      `UPDATE wfos_benchmark_trials
         SET status = 'completed', lifecycle_phase = 'completed', completed_at = NOW()
       WHERE id = $1`,
      [trialId],
    );

    // CORRUPT the trial's prompt_digest so §27 integrity validation
    // fails. The recovering worker MUST observe this + finalize to
    // `invalidated` (NOT `completed` — the corruption means the
    // experiment cannot honestly read successful).
    await stack.authStack.db.client.query(
      `UPDATE wfos_benchmark_trials SET prompt_digest = 'corrupted-digest-that-mismatches-snapshot'
       WHERE id = $1`,
      [trialId],
    );

    // Simulate a worker winning the reservation + then dying.
    const claimed = await stack.benchmarkRepository.claimExperimentCompletion(experimentId, 30_000);
    expect(claimed?.status).toBe('finalizing');

    let expAudit = await stack.auditService.listForResource('benchmark_experiment', experimentId);
    expect(expAudit.filter((e) => e.eventType === 'BENCHMARK_INVALIDATED')).toHaveLength(0);
    expect(expAudit.filter((e) => e.eventType === 'BENCHMARK_COMPLETED')).toHaveLength(0);

    // Expire the lease + trigger lazy recovery via getExperiment.
    await stack.authStack.db.client.query(
      `UPDATE wfos_benchmark_experiments
         SET finalizing_lease_expires_at = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [experimentId],
    );
    const recovered = await stack.benchmarkService.getExperiment(experimentId);

    // ASSERTION 1 — the recovery reached the CORRECT terminal state for
    // the corrupt data: `invalidated` (NOT a false `completed`).
    expect(recovered?.status).toBe('invalidated');

    // ASSERTION 2 — exactly ONE terminal audit event: BENCHMARK_INVALIDATED
    // (NOT BENCHMARK_COMPLETED). The lost worker wrote NONE; the recovering
    // worker wrote exactly one. Exactly-one terminal state + exactly-one
    // terminal audit event, even on the failure path.
    expAudit = await stack.auditService.listForResource('benchmark_experiment', experimentId);
    expect(expAudit.filter((e) => e.eventType === 'BENCHMARK_INVALIDATED')).toHaveLength(1);
    expect(expAudit.filter((e) => e.eventType === 'BENCHMARK_COMPLETED')).toHaveLength(0);
  });
});
