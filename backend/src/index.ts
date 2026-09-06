/**
 * WorkflowOS backend process entrypoint.
 *
 * A single codebase serves two logical roles (selected by WORKFLOWOS_ROLE):
 *
 * - `api`    — Fastify server that accepts HTTP traffic. Enqueues background
 *              jobs and returns immediately (PLAT-AC-03). Does NOT run the
 *              worker host.
 * - `worker` — Runs the {@link WorkerHost} polling the queue. Does NOT serve
 *              HTTP traffic.
 * - `all`    — Runs both in a single process (local dev / integration tests).
 *
 * The shared composition lives in {@link buildApp}; this entrypoint only wires
 * the Fastify server when the role requires it.
 */
import { buildApp, type AppDeps } from './app.js';
import { buildServer, type ServerDeps } from './api/server.js';
import { loadConfig } from './config.js';
import { SessionAuthProvider } from './modules/auth/internal/session-auth-provider.js';
// REALITY-REPAIR-001 (V2-REALITY-AUDIT-001 / F-001): the frozen V2 product
// authorities, imported through their public barrels so the deployment
// composition can construct them over the shared database.
import { DefaultWorkflowRepositoryService } from './workflow-repository/index.js';
import { DefaultWorkflowRunService } from './workflow-runs/index.js';
import {
  DefaultWorkflowDeploymentService,
  formatUtcTimestamp,
} from './workflow-deployments/index.js';
import { DefaultNodeCapabilityService } from './node-capability/index.js';
import {
  DefaultTeachingSessionService,
  InMemoryTeachingSessionStore,
} from './teaching-sessions/index.js';
import {
  DefaultReverseTeachingSessionService,
  InMemoryReverseTeachingSessionStore,
} from './reverse-teaching/index.js';

/**
 * REALITY-REPAIR-001 — the seven V2 product route-deps groups the real
 * deployment composition must pass to {@link buildServer}.
 */
type V2ProductRouteDeps = Pick<
  ServerDeps,
  | 'workflowRepository'
  | 'workflowRuns'
  | 'workflowDeployments'
  | 'teaching'
  | 'reverseTeaching'
  | 'workflowOptimization'
  | 'marketplace'
>;

/**
 * REALITY-REPAIR-001 (V2-REALITY-AUDIT-001 / F-001): compose the seven V2
 * product route-deps groups over the EXISTING shared database client + the
 * identity authority's membership facts — the exact service union the
 * V2-017 dogfooding runner and the V2 E2E compositions prove — so the real
 * deployment entry (`src/index.ts`, the docker-compose CMD `bun
 * src/index.ts`) SERVES the V2 product route groups instead of answering
 * 404 behind the universal shell (the audit's release blocker).
 *
 * COMPOSITION ONLY (the Work Order's boundary): every service below is a
 * frozen existing authority constructed with its published deps — NO new
 * route, NO authority redesign, NO V2-002..V2-012 semantic change. The
 * V2-011 optimization and V2-012 marketplace transport routes compose their
 * own services from the V2-002 repository + the membership resolver (the
 * integration-test recipe, including the module's OWN deterministic
 * reference payment adapter — no real provider, ever).
 *
 * Honest boundaries carried by the reference implementations (surfaced, not
 * concealed): the V2-004 node directory, the V2-006/V2-010 session stores and
 * the V2-011/V2-012 reference stores are the modules' in-memory reference
 * stores — durable persistence for those surfaces is a separately-owned
 * concern, exactly as in the proven compositions. The V2-002/V2-005/V2-009
 * facts are PostgreSQL-authoritative through the shared client.
 *
 * Returns undefined when no database is configured — the groups then stay
 * unregistered exactly as before (fail-closed composition; the caller logs
 * the degraded state).
 */
function composeV2ProductRouteDeps(deps: AppDeps): V2ProductRouteDeps | undefined {
  const db = deps.database;
  const membershipRepository = deps.membershipRepository;
  if (!db || !membershipRepository) return undefined;

  // The identity authority's membership fact source — the consumed port
  // every V2 service takes (the same resolver shape the test compositions
  // build over the same repository).
  const memberships = {
    isMember: async (userId: string, organizationId: string) =>
      (await membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
  };

  const clock = () => Date.now();
  const utcClock = { now: () => formatUtcTimestamp(clock()) };

  // V2-002 — the workflow repository authority (workflows, immutable
  // versions, forks, installations/pins; also the version-reader port the
  // teaching, optimization and marketplace surfaces consume).
  const workflowRepositoryService = new DefaultWorkflowRepositoryService({
    db,
    memberships,
  });

  // V2-005 — the run command/history authority over the same database + the
  // repository's pin resolution. currentEpoch 1 is this deployment's
  // attestation-freshness protocol epoch (the dogfooding composition
  // precedent; a production epoch bump is a governed protocol change, never
  // a silent composition decision).
  const workflowRunService = new DefaultWorkflowRunService({
    db,
    memberships,
    workflowRepository: workflowRepositoryService,
    clock: utcClock,
    currentEpoch: 1,
  });

  // V2-004 node directory — the ONLY placement matcher V2-009 consumes,
  // with the module's default in-memory key/record stores.
  const nodes = new DefaultNodeCapabilityService({ clock });

  // V2-009 — the trigger-layer authority (deployments, subscriptions, the
  // event inbox, the engine tick, manual launch).
  const workflowDeploymentService = new DefaultWorkflowDeploymentService({
    db,
    memberships,
    workflowRepository: workflowRepositoryService,
    runs: workflowRunService,
    nodes,
    clock: utcClock,
  });

  // V2-006 — the teaching authority (Teach Me sessions over pinned versions).
  const teachingSessionService = new DefaultTeachingSessionService({
    idFactory: () => `ts_${crypto.randomUUID()}`,
    clock,
    store: new InMemoryTeachingSessionStore(),
  });

  // V2-010 — the reverse-teaching authority (the §13 do-it-yourself surface).
  const reverseTeachingService = new DefaultReverseTeachingSessionService({
    idFactory: () => `rt_${crypto.randomUUID()}`,
    clock,
    store: new InMemoryReverseTeachingSessionStore(),
  });

  return {
    workflowRepository: { workflowRepositoryService },
    workflowRuns: { workflowRunService },
    workflowDeployments: { workflowDeploymentService },
    teaching: { teachingSessionService, workflowRepositoryService },
    reverseTeaching: { reverseTeachingService, workflowRepositoryService },
    workflowOptimization: { workflowRepositoryService },
    marketplace: { workflowRepositoryService, memberships },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config, { startWorker: config.role !== 'api' });

  let server: Awaited<ReturnType<typeof buildServer>> | undefined;

  if (config.role === 'api' || config.role === 'all') {
    // REALITY-REPAIR-001 (V2-REALITY-AUDIT-001 / F-001): compose the V2
    // product route groups over the shared database so the deployment
    // topology serves them; without a database they stay unregistered
    // (fail-closed — the honest degraded state, never a silent substitute).
    const v2ProductRoutes = composeV2ProductRouteDeps(app.deps);
    if (!v2ProductRoutes) {
      app.deps.logger.warn('app.api.v2_product_routes.unregistered', {
        reason: 'no shared database configured (DATABASE_URL or the dev runtime); the V2 product route groups are NOT registered',
      });
    }
    server = await buildServer({
      queue: app.deps.queue,
      logger: app.deps.logger,
      // PRODUCTION READINESS: CORS origin (the Vercel frontend URL).
      ...(config.corsOrigin ? { corsOrigin: config.corsOrigin } : {}),
      // WORK-023: wire health/readiness deps (PostgreSQL, Redis, ObjectStore)
      // so /health/ready can verify connectivity to authoritative dependencies.
      ...(app.deps.infrastructure
        ? {
            health: {
              database: app.deps.infrastructure.database,
              redis: app.deps.infrastructure.redis,
              objectStore: app.deps.infrastructure.objectStore,
            },
          }
        : {}),
      ...(app.deps.authProvider && app.deps.userRepository
        ? {
            auth: {
              authProvider: app.deps.authProvider,
              userRepository: app.deps.userRepository,
              // WORK-074: the server-side session path (HttpOnly cookie →
              // wfos_sessions). Present when a database is configured.
              ...(app.deps.sessionService
                ? {
                    sessionAuthProvider: new SessionAuthProvider(
                      app.deps.sessionService,
                      app.deps.userRepository,
                    ),
                    sessionCookieName: 'wfos_session',
                  }
                : {}),
            },
          }
        : {}),
      // WORK-074: the identity runtime routes (human login: password + OAuth;
      // session lifecycle; machine identity management).
      ...(app.deps.sessionService &&
      app.deps.passwordCredentialService &&
      app.deps.identityResolutionService &&
      app.deps.machineIdentityService &&
      app.deps.oauthStateStore &&
      app.deps.authorizationService &&
      app.deps.auditService
        ? {
            identity: {
              sessionService: app.deps.sessionService,
              passwordCredentials: app.deps.passwordCredentialService,
              identityResolution: app.deps.identityResolutionService,
              oauthProviders: app.deps.oauthProviders ?? [],
              oauthStateStore: app.deps.oauthStateStore,
              machineIdentity: app.deps.machineIdentityService,
              authorizationService: app.deps.authorizationService,
              membershipRepository: app.deps.membershipRepository!,
              userRepository: app.deps.userRepository!,
              audit: app.deps.auditService,
              publicUrl: config.publicUrl,
            },
          }
        : {}),
      // WORK-074: organization creation + membership management routes.
      ...(app.deps.membershipRepository &&
      app.deps.organizationRepository &&
      app.deps.userRepository &&
      app.deps.authorizationService &&
      app.deps.auditService
        ? {
            organizations: {
              membershipRepository: app.deps.membershipRepository,
              organizationRepository: app.deps.organizationRepository,
              userRepository: app.deps.userRepository,
              authorizationService: app.deps.authorizationService,
              audit: app.deps.auditService,
            },
          }
        : {}),
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.repositoryAssociationRepository
        ? {
            projects: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              repositoryAssociationRepository: app.deps.repositoryAssociationRepository,
              // WORK-022 product UI: optional repositories that enable the
              // `GET /projects` (list user's projects) and `GET /organizations`
              // (list user's orgs) routes. When absent, those routes are simply
              // not registered — existing test wiring is unaffected.
              ...(app.deps.projectAccessRepository
                ? { projectAccessRepository: app.deps.projectAccessRepository }
                : {}),
              ...(app.deps.membershipRepository
                ? { membershipRepository: app.deps.membershipRepository }
                : {}),
              ...(app.deps.organizationRepository
                ? { organizationRepository: app.deps.organizationRepository }
                : {}),
            },
          }
        : {}),
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.specificationRepository &&
      app.deps.specificationVersionRepository &&
      app.deps.infrastructure
        ? {
            specifications: {
              authorizationService: app.deps.authorizationService,
              specificationRepository: app.deps.specificationRepository,
              specificationVersionRepository: app.deps.specificationVersionRepository,
              projectRepository: app.deps.projectRepository,
              objectStore: app.deps.infrastructure.objectStore,
            },
          }
        : {}),
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.architectureDecisionRepository &&
      app.deps.architectureChangeRequestRepository &&
      app.deps.architectureAssertionRepository &&
      app.deps.architectureService
        ? {
            architecture: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              architectureDecisionRepository: app.deps.architectureDecisionRepository,
              architectureChangeRequestRepository: app.deps.architectureChangeRequestRepository,
              // WORK-051: the assertion store (the governed population path
              // for a version's assertion set before freeze).
              architectureAssertionRepository: app.deps.architectureAssertionRepository,
              architectureService: app.deps.architectureService,
            },
          }
        : {}),
      ...(app.deps.authorizationService &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.requirementRepository &&
      app.deps.requirementDependencyRepository &&
      app.deps.acceptanceCriterionRepository &&
      app.deps.evidenceReferenceRepository
        ? {
            requirements: {
              authorizationService: app.deps.authorizationService,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              requirementRepository: app.deps.requirementRepository,
              requirementDependencyRepository: app.deps.requirementDependencyRepository,
              acceptanceCriterionRepository: app.deps.acceptanceCriterionRepository,
              evidenceReferenceRepository: app.deps.evidenceReferenceRepository,
            },
          }
        : {}),
      ...(app.deps.authorizationService &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.workItemRepository &&
      app.deps.workItemRequirementRepository &&
      app.deps.workItemCriterionRepository &&
      app.deps.workItemDependencyRepository &&
      app.deps.pullRequestAssociationRepository &&
      app.deps.workOrderRepository
        ? {
            workItems: {
              authorizationService: app.deps.authorizationService,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              workItemRepository: app.deps.workItemRepository,
              workItemRequirementRepository: app.deps.workItemRequirementRepository,
              workItemCriterionRepository: app.deps.workItemCriterionRepository,
              workItemDependencyRepository: app.deps.workItemDependencyRepository,
              pullRequestAssociationRepository: app.deps.pullRequestAssociationRepository,
              workOrderRepository: app.deps.workOrderRepository,
            },
          }
        : {}),
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.workItemRepository &&
      app.deps.workflowEngine
        ? {
            workflow: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              workItemRepository: app.deps.workItemRepository,
              workflowEngine: app.deps.workflowEngine,
              // WORK-017/018: orchestrator (convergence loop). Present when Redis is available.
              ...(app.deps.orchestrator ? { orchestrator: app.deps.orchestrator } : {}),
              // WORK-026 (SUB-F): ImplementationContextBuilder for the
              // POST /work-items/:workItemId/start-implementation route.
              ...(app.deps.implementationContextBuilder
                ? { implementationContextBuilder: app.deps.implementationContextBuilder }
                : {}),
              // WORK-026 (PR #29 fix #1): StartImplementationService — submits
              // the persisted ImplementationContext to the AgentGateway. In
              // production, this MUST be wired (no production no-op path).
              ...(app.deps.startImplementationService
                ? { startImplementationService: app.deps.startImplementationService }
                : {}),
              // WORK-026 (PR #29 fix #1): AgentProviderRegistryService — used by
              // the start-implementation route to validate provider/model + resolve
              // platform defaults. WORK-027: also powers the execution-capability
              // surface (native readiness + external UI availability).
              ...(app.deps.agentProviderRegistryService
                ? { agentProviderRegistryService: app.deps.agentProviderRegistryService }
                : {}),
              // WORK-027: ExecutionTaskService + ExecutionService — the
              // provider-independent execution boundary behind
              // POST /work-items/:workItemId/execution. Production MUST wire
              // these (the route returns 503 otherwise).
              ...(app.deps.executionTaskService
                ? { executionTaskService: app.deps.executionTaskService }
                : {}),
              ...(app.deps.executionService
                ? { executionService: app.deps.executionService }
                : {}),
            },
          }
        : {}),
      // WORK-026 (SUB-F): /runtime routes — provider-independent deployment
      // + runtime status boundary. Wired when the deployment service + runtime
      // status service + the lower-level repositories are all present (DB-only).
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.deploymentService &&
      app.deps.runtimeStatusService &&
      app.deps.runtimeIntegrationRepository &&
      app.deps.deploymentRepository
        ? {
            runtime: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              deploymentService: app.deps.deploymentService,
              runtimeStatusService: app.deps.runtimeStatusService,
              runtimeIntegrationRepository: app.deps.runtimeIntegrationRepository,
              deploymentRepository: app.deps.deploymentRepository,
              // WORK-026 (PR #29 fix #2): expose the GitHub repo association
              // resolver so the /runtime/connect route can auto-link the
              // GitHub repo to the Vercel project.
              ...(app.deps.projectGitHubRepositoryRepository
                ? {
                    projectGitHubRepositoryResolver: (async (projectId: string) => {
                      const r = await app.deps.projectGitHubRepositoryRepository!.findByProject(projectId);
                      return r ? { owner: r.owner, repository: r.repository, defaultBranch: r.defaultBranch } : null;
                    }),
                  }
                : {}),
            },
          }
        : {}),
      // WORK-026 (SUB-F): /github provisioning routes — create/link a GitHub
      // repo for a project. Wired when the github adapter + installation
      // repository + project link repository are all present.
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.githubAdapter &&
      app.deps.githubInstallationRepository &&
      app.deps.projectGitHubRepositoryRepository
        ? {
            githubProvisioning: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              githubAdapter: app.deps.githubAdapter,
              projectGitHubRepositoryRepository: app.deps.projectGitHubRepositoryRepository,
              githubInstallationRepository: app.deps.githubInstallationRepository,
            },
          }
        : {}),
      // WORK-027: /execution routes — the secure external-handoff + event
      // ingestion boundary. Wired when the execution repositories + services
      // are present (DB-only composition). PR #30 review fix #1: the list
      // route resolves WorkItem → project for authorization, so the work-item
      // + architecture repositories are required; PR #30 fix #2 adds the
      // scoped callback-token service.
      ...(app.deps.authorizationService &&
      app.deps.workItemRepository &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.executionRecordRepository &&
      app.deps.executionHandoffService &&
      app.deps.executionCallbackService &&
      app.deps.executionEventIngestionService
        ? {
            execution: {
              authorizationService: app.deps.authorizationService,
              workItemRepository: app.deps.workItemRepository,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              executionRecordRepository: app.deps.executionRecordRepository,
              executionHandoffService: app.deps.executionHandoffService,
              executionCallbackService: app.deps.executionCallbackService,
              executionEventIngestionService: app.deps.executionEventIngestionService,
              // WORK-042: cross-mode handoff service (native <-> external for
              // the SAME logical execution — ONE ExecutionRecord preserved).
              // OPTIONAL — the route returns 503 when it is absent (the
              // existing execution routes are unaffected). Wired when DB +
              // agent-policy + execution-policy + agent-provider-registry are
              // all configured.
              crossModeHandoffService: app.deps.crossModeHandoffService,
            },
          }
        : {}),
      // WORK-028: Companion extension handoff redemption. Registered WITHOUT
      // the auth guard — the route's authority is the ONE-TIME handoff token
      // itself (the extension holds no WorkflowOS API key by design).
      ...(app.deps.executionHandoffService && app.deps.executionCallbackService
        ? {
            companion: {
              executionHandoffService: app.deps.executionHandoffService,
              executionCallbackService: app.deps.executionCallbackService,
            },
          }
        : {}),
      // WORK-032: Native vs External Execution Benchmark routes.
      // Backend-authorized (project.read / project.write). The frontend is a
      // consumer, never an authority (§34 static check).
      ...(app.deps.authorizationService && app.deps.benchmarkService
        ? {
            benchmark: {
              authorizationService: app.deps.authorizationService,
              benchmarkService: app.deps.benchmarkService,
            },
          }
        : {}),
      // WORK-033: Execution Policy & Fair Benchmarking routes.
      // Backend-authorized (project.read / project.write). The route layer
      // derives the actor from requireProjectAuthorization (server-side,
      // PR #35 fix #5 pattern) — NEVER from the request body (§27).
      ...(app.deps.authorizationService &&
      app.deps.executionPolicyService &&
      app.deps.projectRepository &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.workItemRepository
        ? {
            executionPolicy: {
              authorizationService: app.deps.authorizationService,
              executionPolicyService: app.deps.executionPolicyService,
              projectRepository: app.deps.projectRepository,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              workItemRepository: app.deps.workItemRepository,
            },
          }
        : {}),
      // WORK-044: Adaptive Execution Router routes — the two DISTINCT caller
      // intents (GET .../routing/recommendation = recommendation mode;
      // POST .../routing/selection = automatic-selection mode). Both are
      // ADVISORY: neither mutates authoritative workflow state; the caller
      // dispatches via the existing execution submit authority. Backend-
      // authorized (project.read); the organization scope is resolved
      // SERVER-SIDE by the router (the AR-043-04 lesson).
      ...(app.deps.authorizationService &&
      app.deps.executionRouterService &&
      app.deps.projectRepository &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.workItemRepository
        ? {
            executionRouting: {
              authorizationService: app.deps.authorizationService,
              executionRouterService: app.deps.executionRouterService,
              projectRepository: app.deps.projectRepository,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              workItemRepository: app.deps.workItemRepository,
            },
          }
        : {}),
      // WORK-045: Agent Roles routes — the read-only, provider-independent
      // role-catalog surface (backend-authorized project.read within the
      // caller's project context — W045-AC11 tenant-safe resolution). The
      // role layer itself is pure static data with no authority: these
      // routes expose the closed catalog + deterministic identity
      // resolution, and NEVER mutate workflow state.
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.agentRoleCatalogService
        ? {
            agentRoles: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              agentRoleCatalogService: app.deps.agentRoleCatalogService,
            },
          }
        : {}),
      // WORK-046: Multi-Agent Delegation routes — the bounded coordination
      // surface (create-or-converge a plan for ONE Work Item, read the
      // structured state, drive/retry/interrupt). Wired when the delegation
      // services + the work-item/architecture repositories are present (the
      // delegation layer itself consumes only the EXISTING execution
      // boundary + the WORK-045 catalog — there is no second engine and no
      // scheduler; drive is always an explicit call).
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.workItemRepository &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.delegationPlanService &&
      app.deps.delegationCoordinator
        ? {
            delegation: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              workItemRepository: app.deps.workItemRepository,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              delegationPlanService: app.deps.delegationPlanService,
              delegationCoordinator: app.deps.delegationCoordinator,
              // The EXISTING registry — provider validation mirrors the
              // existing execution route (no new selection semantics).
              agentProviderRegistryService: app.deps.agentProviderRegistryService,
            },
          }
        : {}),
      // WORK-047: Agent Intelligence routes — the READ-ONLY advisory surface
      // (the execution recommendation + the delegation decomposition
      // recommendation; project.read — the recommendation computes but
      // mutates NOTHING; the caller dispatches through the existing
      // authority, which carries its own authorization). The intelligence
      // layer consumes the WORK-044 routing result and NEVER bypasses hard
      // constraints; the decomposition is data the caller submits through
      // the EXISTING WORK-046 delegation boundary.
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.workItemRepository &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.agentIntelligenceService
        ? {
            agentIntelligence: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              workItemRepository: app.deps.workItemRepository,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              agentIntelligenceService: app.deps.agentIntelligenceService,
            },
          }
        : {}),
      // WORK-048: Developer Workbench read-model routes — the READ-ONLY thin
      // composition layer over the OWNING authorities (work items +
      // dependencies + workflow states, executions, pr-associations,
      // verification runs, reviews). Backend-authorized project.read with
      // server-side project scoping; never a second business domain.
      ...(app.deps.authorizationService &&
      app.deps.workItemRepository &&
      app.deps.workItemDependencyRepository &&
      app.deps.workItemDependencyService &&
      app.deps.workflowEngine &&
      app.deps.executionRecordRepository &&
      app.deps.pullRequestAssociationRepository &&
      app.deps.verificationService &&
      app.deps.reviewService
        ? {
            workbench: {
              authorizationService: app.deps.authorizationService,
              workItemRepository: app.deps.workItemRepository,
              workItemDependencyRepository: app.deps.workItemDependencyRepository,
              dependencyService: app.deps.workItemDependencyService,
              workflowEngine: app.deps.workflowEngine,
              executionRecordRepository: app.deps.executionRecordRepository,
              pullRequestAssociationRepository: app.deps.pullRequestAssociationRepository,
              verificationService: app.deps.verificationService,
              reviewService: app.deps.reviewService,
            },
          }
        : {}),
      // WORK-037: Agent Policy & Permissions routes. Backend-authorized
      // (project.read / project.admin). The engine never imports the
      // authorization service — only this route layer calls
      // requireProjectAuthorization (the one-way dependency invariant).
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.agentPolicyEngine
        ? {
            agentPolicy: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              agentPolicyEngine: app.deps.agentPolicyEngine,
            },
          }
        : {}),
      // WORK-038: Existing Project Onboarding routes (connect + analyze a
      // repository revision + the authorized confirmation path). Backend-
      // authorized (project.read / project.write / project.admin). The
      // orchestrator composes /github + /agents + /projects; the baseline is
      // stored THROUGH /projects (the single project authority). A repository
      // or baseline UUID is NOT an authorization credential — every route
      // resolves the resource + verifies authorization server-side.
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.projectBaselineRepository &&
      app.deps.onboardingService
        ? {
            onboarding: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              projectBaselineRepository: app.deps.projectBaselineRepository,
              onboardingService: app.deps.onboardingService,
            },
          }
        : {}),
      // WORK-039: Repository and Context Intelligence routes (build + retrieve
      // + inspect + stale-advisory for a revision-bound context index).
      // Backend-authorized (project.read / project.write). The orchestrator
      // composes /projects + /github + /architecture + /requirements +
      // /work-items; the context index is stored THROUGH /projects (the single
      // project authority). A baseline or index UUID is NOT an authorization
      // credential — every route resolves the resource + verifies
      // authorization server-side. Provenance re-uses the WORK-038 vocabulary;
      // the ranker NEVER promotes provenance. Repository revision is
      // fundamental — an index is pinned to a concrete baseline_commit_sha,
      // never silently swapped.
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.projectBaselineRepository &&
      app.deps.projectContextIndexRepository &&
      app.deps.repositoryIntelligenceService &&
      app.deps.projectGitHubRepositoryRepository &&
      app.deps.githubAdapter &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.requirementRepository &&
      app.deps.acceptanceCriterionRepository &&
      app.deps.workItemRepository &&
      app.deps.workItemRequirementRepository &&
      app.deps.workItemCriterionRepository
        ? {
            repositoryIntelligence: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              projectBaselineRepository: app.deps.projectBaselineRepository,
              projectContextIndexRepository: app.deps.projectContextIndexRepository,
              repositoryIntelligenceService: app.deps.repositoryIntelligenceService,
              projectGitHubRepositoryRepository: app.deps.projectGitHubRepositoryRepository,
              githubAdapter: app.deps.githubAdapter,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              architectureRepository: app.deps.architectureRepository,
              requirementRepository: app.deps.requirementRepository,
              acceptanceCriterionRepository: app.deps.acceptanceCriterionRepository,
              workItemRepository: app.deps.workItemRepository,
              workItemRequirementRepository: app.deps.workItemRequirementRepository,
              workItemCriterionRepository: app.deps.workItemCriterionRepository,
            },
          }
        : {}),
      // WORK-040: Continuous Development Planner routes (evaluate +
      // evaluate-async + read-only recommendations list/inspect). Backend-
      // authorized (project.read / project.write). The orchestrator composes
      // /work-items (authoritative Work Item creation through the existing
      // WorkItemRepository.create with the deterministic proposedWorkItemId
      // as the dedup key) + /architecture + /requirements + /projects to
      // decide "what should be done next?" + convergently create governed
      // Work Items. The planner NEVER mutates the dependency graph, NEVER
      // mutates workflow / verification / review state, NEVER starts
      // execution, NEVER selects a provider. The queue (optional) enables
      // evaluate-async (reuses the EXISTING platform Queue + WorkerHost — NO
      // new scheduler).
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.requirementRepository &&
      app.deps.acceptanceCriterionRepository &&
      app.deps.workItemRepository &&
      app.deps.workItemDependencyRepository &&
      app.deps.developmentPlannerService
        ? {
            developmentPlanner: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              architectureRepository: app.deps.architectureRepository,
              requirementRepository: app.deps.requirementRepository,
              acceptanceCriterionRepository: app.deps.acceptanceCriterionRepository,
              workItemRepository: app.deps.workItemRepository,
              workItemDependencyRepository: app.deps.workItemDependencyRepository,
              plannerService: app.deps.developmentPlannerService,
              logger: app.deps.logger,
              queue: app.deps.queue,
            },
          }
        : {}),
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.workItemRepository &&
      app.deps.auditService
        ? {
            audit: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              workItemRepository: app.deps.workItemRepository,
              auditQuery: app.deps.auditService,
            },
          }
        : {}),
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.workItemRepository &&
      app.deps.notificationService
        ? {
            notifications: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              workItemRepository: app.deps.workItemRepository,
              notificationService: app.deps.notificationService,
            },
          }
        : {}),
      // --- PRODUCTION READINESS: wire the remaining route groups ---
      // These were previously only wired in the test/E2E composition.
      // Production must wire them so the deployed API has the full route set.
      // WORK-017/018: workflow orchestrator is added to the workflow route deps
      // when present (constructed in app.ts when Redis is available).
      // The `workflow` route group is already wired above — here we just ensure
      // the orchestrator is passed through when it exists.
      // (The workflow route deps are constructed inline above; the orchestrator
      //  is added via a spread when present.)
      // WORK-012: agent gateway + agent run routes.
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.workItemRepository &&
      app.deps.agentGateway &&
      app.deps.agentRunRepository &&
      app.deps.queue
        ? {
            agents: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              workItemRepository: app.deps.workItemRepository,
              agentGateway: app.deps.agentGateway,
              agentRunRepository: app.deps.agentRunRepository,
              queue: app.deps.queue,
              // WORK-026 (SUB-F): agent provider registry routes. The 3 new
              // endpoints (GET /agents/providers, GET /projects/:id/agents/providers,
              // POST /projects/:id/agents/providers) are conditionally
              // registered inside agentRoutes() based on these deps.
              ...(app.deps.agentProviderRegistryService
                ? { agentProviderRegistryService: app.deps.agentProviderRegistryService }
                : {}),
              ...(app.deps.agentProviderConfigRepository
                ? { agentProviderConfigRepository: app.deps.agentProviderConfigRepository }
                : {}),
            },
          }
        : {}),
      // WORK-015: verification routes.
      ...(app.deps.authorizationService &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.workItemRepository &&
      app.deps.requirementRepository &&
      app.deps.acceptanceCriterionRepository &&
      app.deps.verificationService &&
      app.deps.ciEvidenceIngestionService
        ? {
            verification: {
              authorizationService: app.deps.authorizationService,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              workItemRepository: app.deps.workItemRepository,
              requirementRepository: app.deps.requirementRepository,
              acceptanceCriterionRepository: app.deps.acceptanceCriterionRepository,
              verificationService: app.deps.verificationService,
              ciEvidenceIngestionService: app.deps.ciEvidenceIngestionService,
            },
          }
        : {}),
      // WORK-016: review routes.
      ...(app.deps.authorizationService &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.workItemRepository &&
      app.deps.reviewService
        ? {
            reviews: {
              authorizationService: app.deps.authorizationService,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              workItemRepository: app.deps.workItemRepository,
              reviewService: app.deps.reviewService,
            },
          }
        : {}),
      // WORK-013: LLM gateway routes.
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.workItemRepository &&
      app.deps.llmGateway &&
      app.deps.llmExecutionRecordRepository
        ? {
            llm: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              workItemRepository: app.deps.workItemRepository,
              llmGateway: app.deps.llmGateway,
              executionRecordRepository: app.deps.llmExecutionRecordRepository,
            },
          }
        : {}),
      // WORK-014: architect service routes.
      ...(app.deps.authorizationService &&
      app.deps.projectRepository &&
      app.deps.architectureRepository &&
      app.deps.architectureVersionRepository &&
      app.deps.workItemRepository &&
      app.deps.workOrderRepository &&
      app.deps.workItemRequirementRepository &&
      app.deps.workItemCriterionRepository &&
      app.deps.workItemDependencyRepository &&
      app.deps.requirementRepository &&
      app.deps.acceptanceCriterionRepository &&
      app.deps.llmGateway &&
      app.deps.architectService &&
      app.deps.conversationalArchitectService &&
      app.deps.architectSessionRepository &&
      app.deps.planApplier
        ? {
            architect: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              llmGateway: app.deps.llmGateway,
              architectService: app.deps.architectService,
              conversationalArchitectService: app.deps.conversationalArchitectService,
              sessionRepository: app.deps.architectSessionRepository,
              planApplier: app.deps.planApplier,
              db: app.deps.infrastructure?.database as never,
            },
          }
        : {}),
      // WORK-008/009: GitHub webhook routes (signature-validated, not auth-gated).
      ...(app.deps.githubAdapter &&
      app.deps.webhookEventRepository &&
      app.deps.secretStore
        ? {
            githubWebhook: {
              queue: app.deps.queue,
              logger: app.deps.logger,
              secretStore: app.deps.secretStore,
              webhookSecretRef: config.githubWebhookSecretRef ?? 'WORKFLOWOS_GITHUB_WEBHOOK_SECRET',
              githubAdapter: app.deps.githubAdapter,
              webhookEventRepository: app.deps.webhookEventRepository,
              ...(app.deps.webhookProcessingService ? { webhookProcessingService: app.deps.webhookProcessingService } : {}),
            },
          }
        : {}),
      // REALITY-REPAIR-001 (V2-REALITY-AUDIT-001 / F-001): the V2 product
      // route groups (V2-002 workflow repository, V2-005 workflow runs,
      // V2-009 workflow deployments, V2-006 teaching, V2-010 reverse
      // teaching, V2-011 optimization, V2-012 marketplace) composed over
      // the shared database — the release-blocking composition gap the
      // reality audit recorded (every V2 product route 404'd on the real
      // deployment entry). Present whenever the shared database + the
      // identity membership repository are configured; the docker-compose
      // topology (CMD bun src/index.ts) inherits this wiring unchanged.
      ...(v2ProductRoutes ?? {}),
    });
    await server.listen({ host: config.host, port: config.port });
    app.deps.logger.info('app.api.listening', {
      host: config.host,
      port: config.port,
      role: config.role,
    });
  }

  await app.start();

  const shutdown = async (signal: string): Promise<void> => {
    app.deps.logger.info('app.shutdown', { signal });
    await app.stop();
    if (server) await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
