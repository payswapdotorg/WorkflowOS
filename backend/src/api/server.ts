import Fastify, { type FastifyInstance } from 'fastify';
import { executionContextPlugin } from './plugins/execution-context.plugin.js';
import { authPlugin, type AuthPluginDeps } from './plugins/auth.plugin.js';
import { healthRoutes, type HealthRouteDeps } from './routes/health.route.js';
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
import { auditRoutes, type AuditRouteDeps } from './routes/audit.route.js';
import { notificationRoutes, type NotificationRouteDeps } from './routes/notification.route.js';
import { runtimeRoutes, type RuntimeRouteDeps } from './routes/runtime.route.js';
import { githubProvisioningRoutes, type GithubProvisioningRouteDeps } from './routes/github-provisioning.route.js';
import { executionRoutes, type ExecutionRouteDeps } from './routes/execution.route.js';
import { companionRoutes, type CompanionRouteDeps } from './routes/companion.route.js';
import { benchmarkRoutes, type BenchmarkRouteDeps } from './routes/benchmark.route.js';

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
  /** Health/readiness route deps (WORK-023). Optional — when not provided,
   *  /health/ready returns 200 with no checks. */
  health?: HealthRouteDeps;
  /** PRODUCTION READINESS: CORS origin (the Vercel frontend URL). When set,
   *  the server adds CORS headers + handles OPTIONS preflight. Must be a
   *  full origin (e.g. https://app.example.com). Do not use '*' for
   *  authenticated production APIs. */
  corsOrigin?: string;
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
  /** Audit routes (backend-authorized, read-only). */
  audit?: AuditRouteDeps;
  /** Notification routes (backend-authorized, read-only). */
  notifications?: NotificationRouteDeps;
  /** WORK-026: /runtime routes (deployment provider boundary). Backend-authorized. */
  runtime?: RuntimeRouteDeps;
  /** WORK-026: /github provisioning routes (repository provisioning + health). Backend-authorized. */
  githubProvisioning?: GithubProvisioningRouteDeps;
  /** WORK-027: execution routes (external handoff + event ingestion). Backend-authorized. */
  execution?: ExecutionRouteDeps;
  /** WORK-028: Companion extension handoff redemption (one-time-token authorized). */
  companion?: CompanionRouteDeps;
  /** WORK-032: Native vs External Execution Benchmark routes. Backend-authorized. */
  benchmark?: BenchmarkRouteDeps;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    genReqId: () => crypto.randomUUID(),
  });
  await executionContextPlugin(app);

  // PRODUCTION READINESS: CORS support. When corsOrigin is set, add the
  // Access-Control-Allow-Origin header + handle OPTIONS preflight. This
  // allows the Vercel frontend to make authenticated API requests.
  if (deps.corsOrigin) {
    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers.origin;
      if (origin && origin === deps.corsOrigin) {
        reply.header('Access-Control-Allow-Origin', deps.corsOrigin);
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-github-delivery, x-github-event, x-hub-signature-256');
        reply.header('Access-Control-Allow-Credentials', 'true');
      }
      // Handle preflight.
      if (req.method === 'OPTIONS') {
        return reply.code(204).send();
      }
    });
  }

  if (deps.auth) {
    await authPlugin(app, deps.auth);
  }
  await healthRoutes(app, deps.health ?? {});
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
  if (deps.auth && deps.audit) {
    await auditRoutes(app, deps.audit);
  }
  if (deps.auth && deps.notifications) {
    await notificationRoutes(app, deps.notifications);
  }
  if (deps.auth && deps.runtime) {
    await runtimeRoutes(app, deps.runtime);
  }
  if (deps.auth && deps.githubProvisioning) {
    await githubProvisioningRoutes(app, deps.githubProvisioning);
  }
  if (deps.auth && deps.execution) {
    await executionRoutes(app, deps.execution);
  }
  if (deps.companion) {
    await companionRoutes(app, deps.companion);
  }
  if (deps.auth && deps.benchmark) {
    await benchmarkRoutes(app, deps.benchmark);
  }
  return app;
}
