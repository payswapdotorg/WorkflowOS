import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ensureExecutionId, runWithExecutionContext } from '@platform/execution-context.js';
import { generateExecutionId } from '@platform/ids.js';

/**
 * Per-request execution context plugin.
 *
 * Establishes a traceable execution id for every inbound HTTP request so that
 * any log line emitted while handling the request — including the act of
 * enqueuing a background job — automatically carries the request's execution
 * id (OBS-AC-02). Callers may override the id via the `X-Execution-Id`
 * header; otherwise one is generated.
 *
 * The same execution id is attached to any job enqueued during the request,
 * so it propagates API → queue → worker → worker logs (OBS-AC-01).
 */
export async function executionContextPlugin(app: FastifyInstance): Promise<void> {
  // Decorate the request with a typed executionId field. Defaults to an empty
  // string and is populated by the onRequest hook for every request.
  app.decorateRequest('executionId', '');

  app.addHook('onRequest', async (req: FastifyRequest, _reply: FastifyReply) => {
    const incoming = req.headers['x-execution-id'];
    const value =
      typeof incoming === 'string' && incoming.length > 0 ? incoming : generateExecutionId();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).executionId = value;
  });
}

/**
 * Returns the execution id established for a request by the plugin.
 */
export function getRequestExecutionId(req: FastifyRequest): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stored = (req as any).executionId as string | undefined;
  return stored && stored.length > 0 ? stored : ensureExecutionId();
}

/**
 * Run a handler inside the request's execution context. Routes that enqueue
 * background jobs should wrap their body in this so logs and enqueued jobs
 * carry the request execution id (OBS-AC-01 / OBS-AC-02).
 */
export async function runInRequestContext<T>(
  req: FastifyRequest,
  fn: () => Promise<T>,
): Promise<T> {
  const executionId = getRequestExecutionId(req);
  return runWithExecutionContext({ executionId, requestId: req.id }, fn);
}
