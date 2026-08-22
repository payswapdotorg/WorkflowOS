import Fastify, { type FastifyInstance } from 'fastify';
import { executionContextPlugin } from './plugins/execution-context.plugin.js';
import { authPlugin, type AuthPluginDeps } from './plugins/auth.plugin.js';
import { healthRoutes } from './routes/health.route.js';
import { jobsRoutes, type JobsRouteDeps } from './routes/jobs.route.js';
import { projectsRoutes, type ProjectsRouteDeps } from './routes/projects.route.js';
import { specificationsRoutes, type SpecificationsRouteDeps } from './routes/specifications.route.js';
import { architectureRoutes, type ArchitectureRouteDeps } from './routes/architecture.route.js';
import { requirementsRoutes, type RequirementsRouteDeps } from './routes/requirements.route.js';
import { workItemsRoutes, type WorkItemsRouteDeps } from './routes/work-items.route.js';
import { githubWebhookRoutes, type WebhookRouteDeps } from './routes/github-webhook.route.js';
import { workflowRoutes, type WorkflowRouteDeps } from './routes/workflow.route.js';
import { llmRoutes, type LlmRouteDeps } from './routes/llm.route.js';
import { agentRoutes, type AgentRouteDeps } from './routes/agent.route.js';
import { architectRoutes, type ArchitectRouteDeps } from './routes/architect.route.js';
import { verificationRoutes, type VerificationRouteDeps } from './routes/verification.route.js';
import { reviewRoutes, type ReviewRouteDeps } from './routes/review.route.js';

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
  /** When auth is enabled, the protected /specifications route uses this. */
  specifications?: SpecificationsRouteDeps;
  /** When auth is enabled, the protected /architecture route uses this. */
  architecture?: ArchitectureRouteDeps;
  /** When auth is enabled, the protected /requirements route uses this. */
  requirements?: RequirementsRouteDeps;
  /** When auth is enabled, the protected /work-items route uses this. */
  workItems?: WorkItemsRouteDeps;
  /** GitHub webhook ingress (isolated from auth — uses signature validation). */
  githubWebhook?: WebhookRouteDeps;
  /** Workflow state machine routes (backend-authorized). */
  workflow?: WorkflowRouteDeps;
  /** LLM Gateway routes (backend-authorized). */
  llm?: LlmRouteDeps;
  /** Agent Gateway routes (backend-authorized). */
  agents?: AgentRouteDeps;
  /** Architect Service routes (backend-authorized). */
  architect?: ArchitectRouteDeps;
  /** Verification Engine routes (backend-authorized). */
  verification?: VerificationRouteDeps;
  /** Review routes (backend-authorized). */
  reviews?: ReviewRouteDeps;
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
  if (deps.auth && deps.specifications) {
    await specificationsRoutes(app, deps.specifications);
  }
  if (deps.auth && deps.architecture) {
    await architectureRoutes(app, deps.architecture);
  }
  if (deps.auth && deps.workItems) {
    await workItemsRoutes(app, deps.workItems);
  }
  if (deps.auth && deps.requirements) {
    await requirementsRoutes(app, deps.requirements);
  }
  if (deps.githubWebhook) {
    await githubWebhookRoutes(app, deps.githubWebhook);
  }
  if (deps.auth && deps.workflow) {
    await workflowRoutes(app, deps.workflow);
  }
  if (deps.auth && deps.llm) {
    await llmRoutes(app, deps.llm);
  }
  if (deps.auth && deps.agents) {
    await agentRoutes(app, deps.agents);
  }
  if (deps.auth && deps.architect) {
    await architectRoutes(app, deps.architect);
  }
  if (deps.auth && deps.verification) {
    await verificationRoutes(app, deps.verification);
  }
  if (deps.auth && deps.reviews) {
    await reviewRoutes(app, deps.reviews);
  }
  return app;
}
