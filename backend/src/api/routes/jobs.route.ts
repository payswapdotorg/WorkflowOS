import type { FastifyInstance } from 'fastify';
import type { Queue, Logger } from '@platform/index.js';
import { createEchoJobHandler, type EchoJobPayload } from '@platform/index.js';
import { runInRequestContext, getRequestExecutionId } from '../plugins/execution-context.plugin.js';

/**
 * Background-job demonstration routes.
 *
 * `POST /jobs/echo` enqueues a background job and returns immediately with the
 * job id and the request's execution id. The handler runs asynchronously in
 * the worker host; the API does NOT block on its completion (PLAT-AC-03).
 *
 * The returned `executionId` is the traceable identifier that will appear in
 * the worker's structured log lines for the enqueued job (OBS-AC-01 /
 * OBS-AC-02).
 */
export interface JobsRouteDeps {
  queue: Queue;
  logger: Logger;
}

export async function jobsRoutes(app: FastifyInstance, deps: JobsRouteDeps): Promise<void> {
  // Ensure the echo handler is registered for diagnostics; in production the
  // worker process owns the registry. We only need the type string here.
  const echoType = createEchoJobHandler(deps.logger).type;

  app.post('/jobs/echo', async (req, reply) => {
    return runInRequestContext(req, async () => {
      const body = (req.body ?? {}) as Partial<EchoJobPayload>;
      const payload: EchoJobPayload = {
        message: typeof body.message === 'string' ? body.message : '',
        delayMs: typeof body.delayMs === 'number' ? body.delayMs : undefined,
      };
      const executionId = getRequestExecutionId(req);
      const record = await deps.queue.enqueue<EchoJobPayload>(echoType, payload, {
        executionId,
        correlationId: executionId,
      });
      deps.logger.info('api.job.enqueued', {
        jobId: record.id,
        jobType: record.type,
        executionId: record.executionId,
      });
      // Return immediately. The worker will process the job asynchronously.
      void reply.code(202);
      return {
        accepted: true,
        jobId: record.id,
        jobType: record.type,
        executionId: record.executionId,
        correlationId: record.correlationId,
      };
    });
  });
}
