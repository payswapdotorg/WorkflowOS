/**
 * WORK-032 (PR #35 review fix #4): the `benchmark.trial` background job
 * handler. The WorkerHost picks up each enqueued `benchmark.trial` job and
 * dispatches it here. The handler delegates to the
 * {@link BenchmarkTrialRunner} (the DefaultBenchmarkService), which advances
 * a single trial to terminal state, collects metrics, and checks experiment
 * completion.
 *
 * This handler is the async bridge between `startExperiment()` (which
 * enqueues + returns immediately) and the trial lifecycle (which runs on
 * the worker host, not the HTTP request thread). It is the reason an
 * experiment is NEVER marked 'completed' while an external trial is still
 * 'handoff_ready'/'running': the trial only reaches terminal after the
 * external execution record does, and the experiment only completes when
 * every trial is terminal.
 *
 * Boundary: imports @platform/* (JobHandler, Logger) + the benchmark
 * internal BenchmarkTrialRunner contract. Never reaches into frozen module
 * internals.
 */
import type { JobHandler, JobRecord } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type { BenchmarkTrialRunner } from './benchmark.types.js';

/**
 * Build the `benchmark.trial` job handler. Registered with the WorkerHost's
 * HandlerRegistry at composition time (app.ts). Each job carries
 * `{ trialId: string }`; the handler calls `runner.runTrialJob(trialId)`.
 */
export function createBenchmarkTrialJobHandler(
  runner: BenchmarkTrialRunner,
  logger: Logger,
): JobHandler {
  return {
    type: 'benchmark.trial',
    async handle(job: JobRecord): Promise<void> {
      const payload = job.payload as { trialId?: string } | null;
      const trialId = payload?.trialId;
      if (!trialId) {
        logger.error('benchmark.trial.missing_trial_id', {
          jobId: job.id,
          executionId: job.executionId,
        });
        return;
      }
      await runner.runTrialJob(trialId);
    },
  };
}
