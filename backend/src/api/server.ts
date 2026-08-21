import Fastify, { type FastifyInstance } from 'fastify';
import { executionContextPlugin } from './plugins/execution-context.plugin.js';
import { authPlugin, type AuthPluginDeps } from './plugins/auth.plugin.js';
import { healthRoutes } from './routes/health.route.js';
import { jobsRoutes, type JobsRouteDeps } from './routes/jobs.route.js';
import { projectsRoutes, type ProjectsRouteDeps } from './routes/projects.route.js';

/**
 * Build the Fastify application. Takes injected dependencies so tests can
 * supply a capturing logger and an in-memory queue.
 *
 * NOTE: the execution-context plugin and the route registrars are invoked
 * directly on the root `app` instance (rather than via `app.register`) so
 * that the request decoration and `onRequest` hook propagate to every route.
 * `app.register` creates an encapsulated child context; a decorator added
 * inside such a context would NOT be visible to sibling route registrations.
 */
export interface ServerDeps extends JobsRouteDeps {
  /** When provided, the auth plugin + protected routes are registered. */
  auth?: AuthPluginDeps;
  /** When auth is enabled, the protected /projects route uses this. */
  projects?: ProjectsRouteDeps;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    genReqId: () => crypto.randomUUID(),
  });
  await executionContextPlugin(app);
  if (deps.auth) {
    await authPlugin(app, deps.auth);
  }
  await healthRoutes(app);
  await jobsRoutes(app, deps);
  if (deps.auth && deps.projects) {
    await projectsRoutes(app, deps.projects);
  }
  return app;
}
