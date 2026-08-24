/**
 * WORK-032 (PR #35 review fix #4): shared async lifecycle helpers for the
 * benchmark integration tests.
 *
 * `startExperiment()` is now EVENT-DRIVEN + ASYNCHRONOUS — it enqueues
 * `benchmark.trial` jobs + returns immediately (experiment 'running'). The
 * WorkerHost picks up each job + calls `runTrialJob(trialId)`. For external
 * trials, the job polls the execution record until terminal; the test
 * fixture simulates the Companion by ingesting a `completed` event via the
 * ExecutionEventIngestionService.
 *
 * These helpers:
 *   - `driveExternalCompletions` — wait for external trials to reach
 *     handoff_ready (executionId set), then ingest a `completed` event for
 *     each external executionId. Simulates the Companion + provider adapter
 *     reporting completion through the authoritative ingestion boundary.
 *   - `awaitExperimentCompleted` — poll the experiment status until
 *     'completed' (or throw after a timeout).
 */
import type { BenchmarkService } from '../../../src/benchmark/index.js';
import type { ExecutionEventIngestionService } from '../../../src/modules/agents/index.js';
import { waitFor } from '../../helpers/test-app.js';

/**
 * Wait for every external trial in the experiment to have an `executionId`
 * (meaning the orchestrator ran + submitted → execution record
 * `handoff_ready`), then ingest a `completed` event for each. This simulates
 * the Companion + provider adapter reporting completion through the
 * authoritative ingestion boundary.
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
  //    the authoritative signal the job handler polls for.
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
 * then wait for the experiment to reach 'completed'. Use this for any
 * experiment that contains external trials. For native-only experiments,
 * `awaitExperimentCompleted` alone suffices (the deterministic native
 * provider completes synchronously inside the worker).
 */
export async function startAndAwaitExperiment(
  benchmarkService: BenchmarkService,
  ingestionService: ExecutionEventIngestionService | null,
  experimentId: string,
): Promise<void> {
  await benchmarkService.startExperiment(experimentId);
  if (ingestionService) {
    // Check whether the experiment has external trials before driving.
    const { trials } = await benchmarkService.listTrials(experimentId);
    const hasExternal = trials.some((t) => t.executionMode === 'external');
    if (hasExternal) {
      await driveExternalCompletions(benchmarkService, ingestionService, experimentId);
    }
  }
  await awaitExperimentCompleted(benchmarkService, experimentId);
}
