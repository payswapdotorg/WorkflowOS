/**
 * WORK-032 (PR #35 review fix v2): shared async lifecycle helpers for the
 * benchmark integration tests.
 *
 * `startExperiment()` is now FULLY EVENT-DRIVEN + ASYNCHRONOUS. It enqueues
 * `benchmark.trial` jobs + returns immediately (experiment 'running'). The
 * WorkerHost picks up each job and calls `runTrialJob(trialId)`, which is a
 * NON-BLOCKING, RE-ENTRANT state machine:
 *
 *   queued → orchestrator (sets running + executionId) →
 *     EXECUTION PHASE (external reads authoritative execution record;
 *       native is synchronous → 'completed') →
 *     DELIVERY PHASE (reads authoritative workflow state — `verified`
 *       → trial 'completed'; terminal failure → trial 'failed').
 *
 * The trial is re-advanced by EVENT-DRIVEN composition hooks (wired in
 * app.ts), NOT by bounded polling:
 *   - `onExecutionTerminal` on `DefaultExecutionEventIngestionService` →
 *     `benchmarkService.advanceTrialsForExecution(executionId)` when an
 *     external execution reaches a terminal state.
 *   - `onTransition` on `DefaultWorkflowEngine` →
 *     `benchmarkService.advanceTrialsForWorkItem(workItemId)` when the
 *     cloned work item reaches `verified` or a terminal failure state.
 *
 * These helpers:
 *   - `driveExternalCompletions` — wait for external trials to reach
 *     handoff_ready (executionId set), then ingest a `completed` event for
 *     each external executionId. Simulates the Companion reporting
 *     completion through the authoritative ingestion boundary. The
 *     ingestion callback (when wired) auto-re-advances the trial to the
 *     delivery phase — NO manual re-enqueue needed.
 *   - `driveDeliveryLifecycle` — drive EVERY trial's cloned work item
 *     through the legal workflow transitions to `verified`, then enqueue a
 *     `benchmark.trial` job for each trial so the worker re-enters
 *     `runTrialJob` + finalizes the trial. Used when the in-process test
 *     backend wires the workflow engine WITHOUT the app.ts `onTransition`
 *     callback (the default in integration tests).
 *   - `awaitExperimentCompleted` — poll the experiment status until
 *     'completed' (or throw after a timeout).
 *   - `startAndAwaitExperiment` — convenience: start → drive external
 *     completions → drive delivery lifecycle → await experiment completed.
 */
import type { BenchmarkService } from '../../../src/benchmark/index.js';
import type { ExecutionEventIngestionService } from '../../../src/modules/agents/index.js';
import type { WorkflowEngine, WorkflowState } from '../../../src/modules/workflows/index.js';
import type { Queue } from '@platform/index.js';
import { waitFor } from '../../helpers/test-app.js';

/**
 * Wait for every external trial in the experiment to have an `executionId`
 * (meaning the orchestrator ran + submitted → execution record
 * `handoff_ready`), then ingest a `completed` event for each. This simulates
 * the Companion + provider adapter reporting completion through the
 * authoritative ingestion boundary.
 *
 * NOTE: when the in-process test backend wires the ingestion service WITH
 * the `onExecutionTerminal` callback (mirroring production), this helper
 * ALSO triggers the callback → the worker re-advances the trial through
 * the delivery phase AUTOMATICALLY. Tests that DON'T wire the callback
 * must call `driveDeliveryLifecycle` themselves to move the trial through
 * the delivery phase.
 */
export async function driveExternalCompletions(
  benchmarkService: BenchmarkService,
  ingestionService: ExecutionEventIngestionService,
  experimentId: string,
): Promise<void> {
  // 1. Wait for the orchestrator to set executionId on every external trial.
  //    The worker processes the native trial(s) + the external trial's
  //    orchestrator runs (clone → branch → submit). The external trial is
  //    then 'running' (handoff_ready) with an executionId.
  await waitFor(async () => {
    const { trials } = await benchmarkService.listTrials(experimentId);
    const external = trials.filter((t) => t.executionMode === 'external');
    if (external.length === 0) return true;
    return external.every((t) => !!t.executionId);
  }, { timeoutMs: 10_000, intervalMs: 10 });

  // 2. Ingest a `completed` event for each external executionId. This is
  //    the authoritative signal the ingestion boundary observes.
  const { trials } = await benchmarkService.listTrials(experimentId);
  for (const t of trials) {
    if (t.executionMode === 'external' && t.executionId) {
      await ingestionService.ingest({
        executionId: t.executionId,
        eventType: 'completed',
        commitRef: `${t.executionId}-commit-0`,
        pullRequestRef: `${t.executionId}-pr-1`,
        idempotencyKey: `${t.executionId}-completed`,
      });
    }
  }
}

/**
 * PR #35 review fix v2 / Blocker B: drive EVERY trial's cloned work item
 * through the legal workflow transitions from its current state to
 * `verified`, then enqueue a `benchmark.trial` job for each trial so the
 * worker re-enters `runTrialJob` + finalizes the trial.
 *
 * This helper is needed when the in-process test backend wires the
 * workflow engine WITHOUT the app.ts `onTransition` callback (the default
 * in integration tests — they construct `DefaultWorkflowEngine` directly
 * with only the audit emitter). When the callback IS wired (production or
 * E2E with callbacks), driving the workflow to `verified` auto-re-advances
 * the matching trial; the manual re-enqueue here is still safe (idempotent
 * — re-entering `runTrialJob` on a terminal trial no-ops + re-checks
 * experiment completion).
 *
 * Legal path: ready → assigned → implementing → pr_open → verifying →
 * architect_review → approved → merged → verified (per LEGAL_TRANSITIONS).
 * The cloned work item starts at `ready` (the orchestrator transitioned it
 * draft → ready). This helper advances it forward through each legal state.
 */
export async function driveDeliveryLifecycle(
  benchmarkService: BenchmarkService,
  workflowEngine: WorkflowEngine,
  queue: Queue,
  experimentId: string,
): Promise<void> {
  // Wait for ALL non-terminal trials to have a workItemId (the orchestrator
  // ran). Terminal trials (e.g. failed isolation — no workItemId, OR
  // completed earlier) are skipped — they have no delivery phase to drive.
  await waitFor(async () => {
    const { trials } = await benchmarkService.listTrials(experimentId);
    if (trials.length === 0) return false;
    const nonTerminal = trials.filter(
      (t) => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'unavailable',
    );
    if (nonTerminal.length === 0) return true; // all terminal — nothing to drive
    return nonTerminal.every((t) => !!t.workItemId);
  }, { timeoutMs: 10_000, intervalMs: 10 });

  const { trials } = await benchmarkService.listTrials(experimentId);
  // The legal path from `ready` to `verified`.
  const path: WorkflowState[] = [
    'assigned',
    'implementing',
    'pr_open',
    'verifying',
    'architect_review',
    'approved',
    'merged',
    'verified',
  ];
  for (const t of trials) {
    if (!t.workItemId) continue;
    // Skip trials already terminal (e.g. failed isolation — no delivery).
    if (t.status === 'completed' || t.status === 'failed' || t.status === 'unavailable') continue;
    const wf = await workflowEngine.getState(t.workItemId);
    if (!wf) continue;
    // If already at verified, just re-enqueue.
    if (wf.currentState === 'verified') {
      await queue.enqueue('benchmark.trial', { trialId: t.id });
      continue;
    }
    // Drive forward through the legal path. Some transitions may already be
    // applied (the orchestrator sets draft→ready; an external ingestion
    // might advance further). For each target state, attempt the transition
    // from the CURRENT state. If a transition fails (e.g. illegal because
    // the work item is further along), re-read the current state + retry
    // the remainder of the path. This is robust to any starting state in
    // [ready, assigned, implementing, pr_open, verifying, architect_review,
    // approved, merged].
    let current: WorkflowState = wf.currentState;
    for (const target of path) {
      if (current === target) continue;
      if (current === 'verified') break;
      const res = await workflowEngine.transition({
        workItemId: t.workItemId,
        toState: target,
        transitionType: 'benchmark-trial-delivery',
        actor: 'benchmark-test-driver',
      });
      if (res.success) {
        current = target;
      } else {
        // Transition failed — likely the work item is further along than
        // we expected. Re-read its state + continue from there.
        const fresh = await workflowEngine.getState(t.workItemId);
        if (!fresh) break;
        current = fresh.currentState;
        if (current === 'verified') break;
      }
    }
    // Re-enqueue the benchmark.trial job — the worker re-enters runTrialJob
    // + finalizes the trial (verified → completed).
    await queue.enqueue('benchmark.trial', { trialId: t.id });
  }
}

/**
 * Poll the experiment status until 'completed'. Throws after `timeoutMs`
 * (default 10s) — the worker should finalize quickly for deterministic
 * fixtures.
 */
export async function awaitExperimentCompleted(
  benchmarkService: BenchmarkService,
  experimentId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  await waitFor(async () => {
    const exp = await benchmarkService.getExperiment(experimentId);
    return exp?.status === 'completed';
  }, { timeoutMs: opts.timeoutMs ?? 10_000, intervalMs: opts.intervalMs ?? 10 });
}

/**
 * Convenience: start the experiment, drive external completions (if any),
 * drive the delivery lifecycle for ALL trials (native + external), then
 * wait for the experiment to reach 'completed'.
 *
 * PR #35 review fix v2: with the new contract, ALL trials (native + external)
 * need their delivery lifecycle driven — native trials no longer auto-complete
 * at submit time. This helper drives both phases.
 */
export async function startAndAwaitExperiment(
  benchmarkService: BenchmarkService,
  ingestionService: ExecutionEventIngestionService | null,
  experimentId: string,
  opts: { workflowEngine?: WorkflowEngine; queue?: Queue } = {},
): Promise<void> {
  await benchmarkService.startExperiment(experimentId);
  if (ingestionService) {
    // Wait for ALL trials to have either an executionId (external) or a
    // workItemId (native — the orchestrator ran). Then ingest external
    // completion events.
    const { trials } = await benchmarkService.listTrials(experimentId);
    const hasExternal = trials.some((t) => t.executionMode === 'external');
    if (hasExternal) {
      await driveExternalCompletions(benchmarkService, ingestionService, experimentId);
    }
  }
  if (opts.workflowEngine && opts.queue) {
    // Drive the delivery lifecycle for ALL trials (native + external).
    await driveDeliveryLifecycle(benchmarkService, opts.workflowEngine, opts.queue, experimentId);
  }
  await awaitExperimentCompleted(benchmarkService, experimentId);
}
