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
import { executionPolicyRoutes, type ExecutionPolicyRouteDeps } from './routes/execution-policy.route.js';
import { executionRoutingRoutes, type ExecutionRoutingRouteDeps } from './routes/execution-routing.route.js';
import { agentRolesRoutes, type AgentRolesRouteDeps } from './routes/agent-roles.route.js';
import { delegationRoutes, type DelegationRouteDeps } from './routes/delegation.route.js';
import {
  agentIntelligenceRoutes,
  type AgentIntelligenceRouteDeps,
} from './routes/agent-intelligence.route.js';
import { workbenchRoutes, type WorkbenchRouteDeps } from './routes/workbench.route.js';
import { agentPolicyRoutes, type AgentPolicyRouteDeps } from './routes/agent-policy.route.js';
import { onboardingRoutes, type OnboardingRouteDeps } from './routes/onboarding.route.js';
import {
  repositoryIntelligenceRoutes,
  type RepositoryIntelligenceRouteDeps,
} from './routes/repository-intelligence.route.js';
import {
  developmentPlannerRoutes,
  type DevelopmentPlannerRouteDeps,
} from './routes/development-planner.route.js';
import {
  maintenanceRoutes,
  type MaintenanceRouteDeps,
} from './routes/maintenance.route.js';
import { authRoutes, type AuthRouteDeps } from './routes/auth.route.js';
import { organizationsRoutes, type OrganizationsRouteDeps } from './routes/organizations.route.js';
import {
  workflowRepositoryRoutes,
  type WorkflowRepositoryRouteDeps,
} from './routes/workflow-repository.route.js';
import {
  workflowRunsRoutes,
  type WorkflowRunsRouteDeps,
} from './routes/workflow-runs.route.js';
import {
  workflowDeploymentsRoutes,
  type WorkflowDeploymentsRouteDeps,
} from './routes/workflow-deployments.route.js';
import {
  teachingSessionsRoutes,
  type TeachingSessionsRouteDeps,
} from './routes/teaching-sessions.route.js';
import {
  reverseTeachingRoutes,
  type ReverseTeachingRouteDeps,
} from './routes/reverse-teaching.route.js';
import {
  workflowOptimizationRoutes,
  type WorkflowOptimizationRouteDeps,
} from './routes/workflow-optimization.route.js';
import {
  marketplaceRoutes,
  type MarketplaceRouteDeps,
} from './routes/marketplace.route.js';

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
  /** WORK-033: Execution Policy & Fair Benchmarking routes. Backend-authorized. */
  executionPolicy?: ExecutionPolicyRouteDeps;
  /** WORK-044: Adaptive Execution Router routes (recommendation + automatic
   *  selection — both ADVISORY; backend-authorized, never mutating workflow
   *  state). */
  executionRouting?: ExecutionRoutingRouteDeps;
  /** WORK-045: Agent Roles routes — the read-only, provider-independent
   *  role-catalog surface (backend-authorized project.read; advisory
   *  configuration only — never workflow authority). */
  agentRoles?: AgentRolesRouteDeps;
  /** WORK-046: Multi-Agent Delegation routes — the bounded coordination
   *  surface (create/get/drive/retry/interrupt; backend-authorized; every
   *  delegated execution goes through the EXISTING execution boundary). */
  delegation?: DelegationRouteDeps;
  /** WORK-047: Agent Intelligence routes — the READ-ONLY advisory surface
   *  (the execution recommendation + the delegation decomposition
   *  recommendation; backend-authorized project.read; advisory/ranking
   *  only — hard constraints always dominate; the decomposition is data
   *  submitted through the EXISTING WORK-046 boundary). */
  agentIntelligence?: AgentIntelligenceRouteDeps;
  /** WORK-048: Developer Workbench read-model routes — the READ-ONLY thin
   *  composition layer (work graph + project rollups; backend-authorized
   *  project.read; consumes the OWNING authorities — never a second domain). */
  workbench?: WorkbenchRouteDeps;
  /** WORK-037: Agent Policy & Permissions routes. Backend-authorized. */
  agentPolicy?: AgentPolicyRouteDeps;
  /** WORK-038: Existing Project Onboarding routes (connect + analyze a
   *  repository revision + the authorized confirmation path). Backend-authorized. */
  onboarding?: OnboardingRouteDeps;
  /** WORK-039: Repository and Context Intelligence routes (build + retrieve +
   *  inspect + stale-advisory for a revision-bound context index). Backend-
   *  authorized. The orchestrator composes /projects + /github + /architecture
   *  + /requirements + /work-items; the index is stored THROUGH /projects. */
  repositoryIntelligence?: RepositoryIntelligenceRouteDeps;
  /** WORK-040: Continuous Development Planner routes (evaluate + evaluate-async
   *  + read-only recommendations list/inspect). Backend-authorized
   *  (project.read / project.write). The orchestrator composes /work-items
   *  (authoritative Work Item creation through the existing
   *  WorkItemRepository.create) + /architecture + /requirements + /projects.
   *  The planner NEVER mutates the dependency graph, NEVER mutates workflow /
   *  verification / review state, NEVER starts execution, NEVER selects a
   *  provider. */
  developmentPlanner?: DevelopmentPlannerRouteDeps;
  /** WORK-041: Maintenance + Project Health Engine route deps (the maintenance
   *  capability: POST evaluate/evaluate-async [user requests → planner] +
   *  POST scan/scan-async [detector trigger → detectors → planner] + GET
   *  signals/health). Backend-authorized (project.read / project.write). The
   *  maintenance capability NEVER calls WorkItemRepository.create directly (it
   *  goes THROUGH the planner), NEVER mutates the dependency graph, NEVER
   *  mutates workflow / verification / review state, NEVER starts execution,
   *  NEVER selects a provider. */
  maintenance?: MaintenanceRouteDeps;
  /** WORK-074: the identity runtime routes (human login + session lifecycle +
   *  machine identity management). Registered when auth is enabled. */
  identity?: AuthRouteDeps;
  /** WORK-074: organization creation + membership management routes.
   *  Registered when auth is enabled. */
  organizations?: OrganizationsRouteDeps;
  /** V2-002 (W1): Workflow Repository routes — the Git-like durable
   *  repository HTTP surface (workflows, immutable versions, forks,
   *  installations/pins). Backend-authorized; repository visibility is
   *  decided by the injected WorkflowRepositoryService. Registered when
   *  auth is enabled. */
  workflowRepository?: WorkflowRepositoryRouteDeps;
  /** V2-005 (W2B): Workflow Runs routes — the durable run command + history
   *  HTTP surface (request/start/pause/resume/interrupt/cancel/complete/
   *  fail, step + invocation records, evidence, attestation attach, run +
   *  reconstructed history). Backend-authorized; tenant scoping is decided
   *  by the injected WorkflowRunService. Registered when auth is enabled. */
  workflowRuns?: WorkflowRunsRouteDeps;
  /** V2-009 (W4): Workflow Deployments routes — the trigger-layer HTTP
   *  surface (deployments + placement policy, trigger subscriptions, the
   *  idempotent event inbox, the engine tick, delivery/correlation reads,
   *  manual launch). Backend-authorized; tenant scoping is decided by the
   *  injected WorkflowDeploymentService. Registered when auth is enabled. */
  workflowDeployments?: WorkflowDeploymentsRouteDeps;
  /** V2-017 T9: teaching-sessions TRANSPORT routes — the consumer Teach Me
   *  surface over the frozen V2-006 authority (session lifecycle, lesson,
   *  checkpoints, practice, assessment). Transport only; every teaching
   *  decision stays the injected service's. Registered when auth is on. */
  teaching?: TeachingSessionsRouteDeps;
  /** V2-017 T9: reverse-teaching TRANSPORT routes — the §13 do-it-yourself
   *  surface over the frozen V2-010 authority (manual-task view, safety
   *  gates, manual performance). Transport only. Registered when auth is on. */
  reverseTeaching?: ReverseTeachingRouteDeps;
  /** V2-017 T11: workflow-optimization TRANSPORT routes — the §19/§20
   *  versions/updates/improvements surface over the frozen V2-011
   *  authority (analysis, proposals, the owner approval gate,
   *  materialization as NEW versions through the V2-002-backed materializer
   *  port, the deterministic comparison). Transport only; the route owns
   *  the request-scoped principal channel for the materializer. Registered
   *  when auth is on. */
  workflowOptimization?: WorkflowOptimizationRouteDeps;
  /** V2-017 T12: marketplace TRANSPORT routes — the §21/§22/§23
   *  sharing/marketplace/install surface over the frozen V2-012 authority
   *  (listing browse/read + revision history, create-or-converge + publish,
   *  offer acceptance → entitlement, the version-access DECISION, customer
   *  cancellation). Transport only; every marketplace decision stays the
   *  composed DefaultMarketplaceService's. Registered when auth is on. */
  marketplace?: MarketplaceRouteDeps;
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
  if (deps.auth && deps.identity) {
    await authRoutes(app, deps.identity);
  }
  if (deps.auth && deps.organizations) {
    await organizationsRoutes(app, deps.organizations);
  }
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
  if (deps.auth && deps.executionPolicy) {
    await executionPolicyRoutes(app, deps.executionPolicy);
  }
  if (deps.auth && deps.executionRouting) {
    await executionRoutingRoutes(app, deps.executionRouting);
  }
  if (deps.auth && deps.agentRoles) {
    await agentRolesRoutes(app, deps.agentRoles);
  }
  if (deps.auth && deps.delegation) {
    await delegationRoutes(app, deps.delegation);
  }
  if (deps.auth && deps.agentIntelligence) {
    await agentIntelligenceRoutes(app, deps.agentIntelligence);
  }
  if (deps.auth && deps.workbench) {
    await workbenchRoutes(app, deps.workbench);
  }
  if (deps.auth && deps.agentPolicy) {
    await agentPolicyRoutes(app, deps.agentPolicy);
  }
  if (deps.auth && deps.onboarding) {
    await onboardingRoutes(app, deps.onboarding);
  }
  if (deps.auth && deps.repositoryIntelligence) {
    await repositoryIntelligenceRoutes(app, deps.repositoryIntelligence);
  }
  if (deps.auth && deps.developmentPlanner) {
    await developmentPlannerRoutes(app, deps.developmentPlanner);
  }
  if (deps.auth && deps.maintenance) {
    await maintenanceRoutes(app, deps.maintenance);
  }
  if (deps.auth && deps.workflowRepository) {
    await workflowRepositoryRoutes(app, deps.workflowRepository);
  }
  if (deps.auth && deps.workflowRuns) {
    await workflowRunsRoutes(app, deps.workflowRuns);
  }
  if (deps.auth && deps.workflowDeployments) {
    await workflowDeploymentsRoutes(app, deps.workflowDeployments);
  }
  if (deps.auth && deps.teaching) {
    await teachingSessionsRoutes(app, deps.teaching);
  }
  if (deps.auth && deps.reverseTeaching) {
    await reverseTeachingRoutes(app, deps.reverseTeaching);
  }
  if (deps.auth && deps.workflowOptimization) {
    await workflowOptimizationRoutes(app, deps.workflowOptimization);
  }
  if (deps.auth && deps.marketplace) {
    await marketplaceRoutes(app, deps.marketplace);
  }
  return app;
}
