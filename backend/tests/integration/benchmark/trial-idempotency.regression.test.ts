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
});
