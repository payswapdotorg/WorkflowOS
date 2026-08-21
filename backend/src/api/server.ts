import Fastify, { type FastifyInstance } from 'fastify';
import { executionContextPlugin } from './plugins/execution-context.plugin.js';
import { healthRoutes } from './routes/health.route.js';
import { jobsRoutes, type JobsRouteDeps } from './routes/jobs.route.js';

/**
 * Build the Fastify application. Takes injected dependencies so tests can
 * supply a capturing logger and an in-memory queue.
 *
 * NOTE: the execution-context plugin and the route registrars are invoked
 * directly on the root `app` instance (rather than via `app.register`) so
 * that the request decorator and `onRequest` hook propagate to every route.
 * `app.register` creates an encapsulated child context; a decorator added
 * inside such a context would NOT be visible to sibling route registrations.
 */
export async function buildServer(deps: JobsRouteDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    genReqId: () => crypto.randomUUID(),
  });
  await executionContextPlugin(app);
  await healthRoutes(app);
  await jobsRoutes(app, deps);
  return app;
}
