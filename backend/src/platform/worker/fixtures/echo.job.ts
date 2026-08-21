import type { JobRecord } from '../../queue/queue.js';
import type { JobHandler } from '../job-handler.js';
import type { Logger } from '../../logger.js';
import { getExecutionContext } from '../../execution-context.js';

/**
 * Echo fixture job (WORK-001).
 *
 * A minimal job used to demonstrate and verify the reusable background-worker
 * mechanism end-to-end: API enqueues → queue → worker → handler → log lines
 * that include the job's execution id (OBS-AC-01 / OBS-AC-02).
 *
 * Domain jobs (`github.webhook`, `llm.request`, `agent.execute`,
 * `verification.collect`, `architect.review`, `notification.send`) are out of
 * scope for WORK-001 and will be added by later work items using the same
 * {@link JobHandler} contract.
 */
export interface EchoJobPayload {
  message: string;
  /** Optional artificial delay (ms) used by async-execution tests (PLAT-AC-03). */
  delayMs?: number;
}

export interface EchoJobResult {
  echoed: string;
  receivedExecutionId: string | undefined;
}

/**
 * Side-effect channel used by tests to observe that the handler ran and to
 * assert it ran asynchronously relative to the API request (PLAT-AC-03) and
 * that the execution id propagated (OBS-AC-01 / OBS-AC-02).
 */
export type EchoListener = (job: JobRecord, result: EchoJobResult) => void;

export interface EchoJobOptions {
  /** Test-only listener invoked synchronously after a job completes. */
  onEcho?: EchoListener;
}

export function createEchoJobHandler(
  logger: Logger,
  options: EchoJobOptions = {},
): JobHandler {
  return {
    type: 'echo',
    async handle(job: JobRecord): Promise<void> {
      const payload = job.payload as EchoJobPayload;
      if (payload?.delayMs && payload.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
      }
      const ctx = getExecutionContext();
      // This log line is the OBS-AC-02 evidence: it is emitted inside the
      // worker, in the job's execution context, so it includes executionId.
      logger.info('echo.handled', {
        jobId: job.id,
        message: payload?.message ?? '',
        receivedExecutionId: ctx?.executionId,
      });
      const result: EchoJobResult = {
        echoed: payload?.message ?? '',
        receivedExecutionId: ctx?.executionId,
      };
      options.onEcho?.(job, result);
    },
  };
}
