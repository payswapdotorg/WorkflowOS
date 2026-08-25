import type { Logger, Queue, WorkerHostOptions, EchoJobOptions, Infrastructure, ObjectStore, DatabaseClient, SecretStore } from '@platform/index.js';
import {
  InMemoryQueue,
  RedisQueue,
  WorkerHost,
  buildHandlerRegistry,
  createEchoJobHandler,
  createLogger,
  createRedisClient,
  createDatabaseClient,
  runMigrations,
  FsObjectStore,
  InMemoryObjectStore,
  EnvSecretStore,
  buildInfrastructure,
  type HandlerRegistry,
} from '@platform/index.js';
import type { AuthProvider, AuthorizationService } from '@modules/auth/index.js';
import { ApiKeyAuthProvider } from './modules/auth/internal/api-key-auth-provider.js';
import {
  DefaultAuthorizationService,
  ApiKeyCredentialProvisioner,
} from './modules/auth/internal/authorization-service.js';
import type { UserRepository } from '@modules/users/index.js';
import { PgUserRepository } from './modules/users/internal/pg-user-repository.js';
import type {
  OrganizationRepository,
  MembershipRepository,
} from '@modules/organizations/index.js';
import { PgOrganizationRepository } from './modules/organizations/internal/pg-organization-repository.js';
import {
  PgMembershipRepository,
  PgRolePermissionRepository,
} from './modules/organizations/internal/pg-membership-repository.js';
import type {
  ProjectRepository,
  ProjectRepositoryAssociationRepository,
  ProjectAccessRepository,
} from '@modules/projects/index.js';
import {
  PgProjectRepository,
  PgProjectAccessRepository,
  PgProjectRepositoryAssociationRepository,
} from './modules/projects/internal/pg-project-repository.js';
import type {
  SpecificationRepository,
  SpecificationVersionRepository,
} from '@modules/specifications/index.js';
import {
  PgSpecificationRepository,
  PgSpecificationVersionRepository,
} from './modules/specifications/internal/pg-specification-repository.js';
import type {
  ArchitectureRepository,
  ArchitectureVersionRepository,
  ArchitectureDecisionRepository,
  ArchitectureChangeRequestRepository,
  ArchitectureService,
} from '@modules/architecture/index.js';
import {
  PgArchitectureRepository,
  PgArchitectureVersionRepository,
  PgArchitectureDecisionRepository,
  PgArchitectureChangeRequestRepository,
} from './modules/architecture/internal/pg-architecture-repository.js';
import { DefaultArchitectureService } from './modules/architecture/internal/architecture-service.js';
import type {
  RequirementRepository,
  RequirementDependencyRepository,
  AcceptanceCriterionRepository,
  EvidenceReferenceRepository,
} from '@modules/requirements/index.js';
import {
  PgRequirementRepository,
  PgRequirementDependencyRepository,
  PgAcceptanceCriterionRepository,
  PgEvidenceReferenceRepository,
} from './modules/requirements/internal/pg-requirement-repository.js';
import type {
  WorkItemRepository,
  WorkItemRequirementRepository,
  WorkItemCriterionRepository,
  WorkItemDependencyRepository,
  PullRequestAssociationRepository,
  WorkOrderRepository,
} from '@modules/work-items/index.js';
import {
  PgWorkItemRepository,
  PgWorkItemRequirementRepository,
  PgWorkItemCriterionRepository,
  PgWorkItemDependencyRepository,
  PgPullRequestAssociationRepository,
  PgWorkOrderRepository,
} from './modules/work-items/internal/pg-work-item-repository.js';
import { DefaultWorkItemDependencyService } from './modules/work-items/internal/work-item-dependency-service.js';
import { DefaultAuditService } from './modules/audit/internal/audit-service.js';
import type { AuditService } from '@modules/audit/index.js';
import { DefaultNotificationService, createNotificationJobHandler } from './modules/notifications/internal/notification-service.js';
import type { NotificationService } from '@modules/notifications/index.js';
import type { AppConfig } from './config.js';
import { DefaultWorkflowEngine } from './modules/workflows/internal/workflow-engine.js';
import type { WorkflowEngine } from '@modules/workflows/index.js';
import { DefaultWorkflowOrchestrator, createConvergenceJobHandler } from './modules/workflows/internal/workflow-orchestrator.js';
import type { WorkflowOrchestrator } from '@modules/workflows/index.js';
import { DefaultAgentGateway } from './modules/agents/internal/agent-gateway.js';
import type { AgentGateway } from '@modules/agents/index.js';
import { PgAgentRunRepository } from './modules/agents/internal/pg-agent-repository.js';
import type { AgentRunRepository } from '@modules/agents/index.js';
import { DefaultLlmGateway } from './modules/llm/internal/llm-gateway.js';
import type { LlmGateway, LlmExecutionRecordRepository } from '@modules/llm/index.js';
import { PgLlmExecutionRecordRepository } from './modules/llm/internal/pg-llm-repository.js';
import { createOpenAiCompatibleAdapterFromEnv } from './modules/llm/internal/openai-compatible-adapter.js';
import type { LlmProviderAdapter } from './modules/llm/internal/llm.types.js';
import { createOpenAiAgentAdapterFromEnv } from './modules/agents/internal/openai-agent-adapter.js';
import type { AgentProviderAdapter } from './modules/agents/internal/agent.types.js';
import { createS3ObjectStoreFromEnv, type S3ObjectStore } from './platform/storage/s3-object-store.js';
import { DefaultProviderRegistry } from './platform/default-provider-registry.js';
import { DefaultArchitectService } from './modules/llm/internal/architect-service.js';
import type { ArchitectService } from '@modules/llm/index.js';
import { DefaultVerificationService } from './modules/verification/internal/verification-service.js';
import type { VerificationService } from '@modules/verification/index.js';
import { DefaultReviewService } from './modules/reviews/internal/review-service.js';
import type { ReviewService } from '@modules/reviews/index.js';
import { DefaultGitHubAdapter, PgGitHubInstallationRepository, PgWebhookEventRepository } from './modules/github/internal/pg-github-repository.js';
import { PgCiEvidenceIngestionRepository } from './modules/github/internal/pg-ci-evidence-repository.js';
import { DefaultCiEvidenceIngestionService } from './modules/github/internal/ci-evidence-ingestion-service.js';
import type { CiEvidenceIngestionService } from '@modules/github/index.js';
import { DefaultWebhookProcessingService, createWebhookJobHandler } from './modules/github/internal/webhook-processing-service.js';
import type { WebhookProcessingService } from '@modules/github/index.js';
import type { GitHubAdapter, GitHubInstallationRepository } from '@modules/github/index.js';
import type { WebhookEventRepository } from '@modules/github/index.js';
import { generateExecutionId } from '@platform/ids.js';
import { DefaultWorkItemCompletionService } from './modules/work-items/internal/pg-work-item-repository.js';
// WORK-026: /runtime module — provider-independent deployment / preview boundary.
import {
  PgRuntimeIntegrationRepository,
  PgDeploymentRepository,
} from './modules/runtime/internal/pg-runtime-repository.js';
import { DefaultDeploymentService } from './modules/runtime/internal/deployment-service.js';
import { FakeDeploymentProvider } from './modules/runtime/internal/fake-deployment-provider.js';
import { VercelDeploymentProvider } from './modules/runtime/internal/vercel-deployment-provider.js';
import { DefaultRuntimeStatusService } from './modules/runtime/internal/runtime-status-service.js';
import type {
  DeploymentService,
  RuntimeIntegrationRepository,
  DeploymentRepository,
  RuntimeStatusService,
} from '@modules/runtime/index.js';
// WORK-026: /github repository provisioning extensions.
import { PgProjectGitHubRepositoryRepository } from './modules/github/internal/pg-project-github-repository-repository.js';
import type { ProjectGitHubRepositoryRepository } from '@modules/github/index.js';
// WORK-026: /work-items ImplementationContext.
import { PgImplementationContextRepository } from './modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultImplementationContextBuilder } from './modules/work-items/internal/implementation-context-builder.js';
import { DefaultStartImplementationService } from './modules/work-items/internal/start-implementation-service.js';
import type { StartImplementationService } from './api/routes/workflow.route.js';
import type { ImplementationContextBuilder } from '@modules/work-items/index.js';
// WORK-026: /agents provider registry.
import { PgAgentProviderConfigRepository } from './modules/agents/internal/pg-agent-provider-config-repository.js';
import { DefaultAgentProviderRegistryService } from './modules/agents/internal/agent-provider-registry-service.js';
import { DefaultAgentProviderRegistry } from './platform/default-agent-provider-registry.js';
import type { AgentProviderConfigRepository } from '@modules/agents/index.js';
// WORK-027: execution provider abstraction (/agents + /work-items).
import { PgExecutionRecordRepository, PgExecutionEventRepository, PgExecutionHandoffRepository, PgExecutionCallbackRepository } from './modules/agents/internal/pg-execution-repository.js';
import { NativeExecutionProvider } from './modules/agents/internal/native-execution-provider.js';
import { ExternalExecutionProvider } from './modules/agents/internal/external-execution-provider.js';
import { DefaultExecutionService } from './modules/agents/internal/execution-service.js';
import { PgExecutionSessionRepository } from './modules/agents/internal/pg-execution-session-repository.js';
import { DefaultExecutionSessionService } from './modules/agents/internal/execution-session-service.js';
import {
  SessionTerminalOutboxRelay,
  createSessionTerminalRelayJobHandler,
} from './modules/agents/internal/session-terminal-relay.js';
import { PgAgentWorkspaceRepository } from './modules/agents/internal/pg-agent-workspace-repository.js';
import { DefaultAgentWorkspaceService } from './modules/agents/internal/agent-workspace-service.js';
import { DefaultToolRuntime } from './modules/agents/internal/tool-runtime-service.js';
import { DefaultToolPolicyGate } from './modules/agents/internal/tool-runtime.types.js';
import { FsToolExecutor } from './platform/tools/fs-tool-executor.js';
import { ProcessToolExecutor } from './platform/tools/process-tool-executor.js';
import { HttpToolExecutor } from './platform/tools/http-tool-executor.js';
import { BrowserToolExecutor } from './platform/tools/browser-tool-executor.js';
import { FsWorktreeMaterializer } from './platform/workspace/fs-worktree-materializer.js';
import {
  WorkspaceReleaseOutboxRelay,
  createWorkspaceReleaseRelayJobHandler,
} from './modules/agents/internal/workspace-release-relay.js';
import { DefaultExecutionHandoffService } from './modules/agents/internal/execution-handoff-service.js';
import { DefaultExecutionEventIngestionService } from './modules/agents/internal/execution-event-ingestion-service.js';
import { DefaultExecutionCallbackService } from './modules/agents/internal/execution-callback-service.js';
// WORK-032: Native vs External Execution Benchmark — application-layer
// orchestrator at src/benchmark/ (outside src/modules/ — a cross-cutting
// harness that CONSUMES the 17 frozen domain modules via their public
// barrels). It does NOT create another workflow/verification/review/CI engine.
import {
  DefaultBenchmarkService,
  DefaultBenchmarkSnapshotService,
  DefaultBenchmarkIntegrityService,
  DefaultBenchmarkMetricCollector,
  DefaultBenchmarkTrialOrchestrator,
  DefaultBenchmarkExportService,
  DefaultBenchmarkRecommendationService,
  PgBenchmarkRepository,
  createBenchmarkTrialJobHandler,
  BenchmarkStartDeliveryOutboxRelay,
  createStartDeliveryRelayJobHandler,
} from './benchmark/index.js';
import type { BenchmarkService, BenchmarkTrialRunner } from './benchmark/index.js';
import type { OutboxRelay } from '@platform/index.js';
// WORK-033: Execution Policy & Fair Benchmarking — application-layer
// orchestrator at src/execution-policy/ (outside src/modules/ — mirrors the
// §34 benchmark pattern: CONSUMES the 17 frozen modules via their public
// barrels; NEVER mutates workflow state; NEVER stores credentials; NEVER
// invents provider capabilities — composes ExecutionProviderInfo +
// EXTERNAL_UI_CATALOG from @modules/agents).
import {
  DefaultExecutionPolicyService,
  DefaultExecutionEligibilityService,
  DefaultExecutionRecommendationService,
  DefaultExecutionTaskProfileBuilder,
  DefaultBenchmarkEvidenceProvider,
  PgExecutionPolicyRepository,
} from './execution-policy/index.js';
import type { ExecutionPolicyService } from './execution-policy/index.js';
import { DefaultExecutionPromptBuilder } from './modules/work-items/internal/execution-prompt-builder.js';
import { DefaultExecutionTaskService } from './modules/work-items/internal/execution-task-service.js';
import type {
  ExecutionService,
  ExecutionRecordRepository,
  ExecutionHandoffService,
  ExecutionCallbackService,
  ExecutionEventIngestionService,
  ToolRuntime,
} from '@modules/agents/index.js';
import type { ExecutionTaskService } from '@modules/work-items/index.js';

/**
 * Application composition root.
 *
 * Wires together the shared runtime foundation required by WORK-001:
 *
 * - structured, execution-aware {@link Logger}
 * - background {@link Queue} (Redis in production, in-memory for tests/dev)
 * - {@link WorkerHost} with the registered job handlers
 *
 * The API process and the worker process share the same codebase and
 * composition; only the {@link AppConfig.role} differs.
 */
export interface AppDeps {
  logger: Logger;
  queue: Queue;
  handlers: HandlerRegistry;
  worker: WorkerHost;
  /** Shared infrastructure (PostgreSQL, Redis extensions, object storage). May be undefined when no DATABASE_URL/OBJECT_STORAGE_DIR is configured. */
  infrastructure?: Infrastructure;
  /** WORK-002: auth provider(s). Present when a database is configured. */
  authProvider?: AuthProvider;
  /** WORK-002: reusable backend authorization service. Present when a database is configured. */
  authorizationService?: AuthorizationService;
  /** WORK-002: API-key credential provisioner. Present when a database is configured. */
  apiKeyProvisioner?: ApiKeyCredentialProvisioner;
  /** WORK-002: user repository. Present when a database is configured. */
  userRepository?: UserRepository;
  /** WORK-002: organization repository. Present when a database is configured. */
  organizationRepository?: OrganizationRepository;
  /** WORK-002: organization membership repository. Present when a database is configured.
   *  Exposed so the projects route can serve `GET /organizations` (list orgs for
   *  the current user — the frontend create-project flow uses this). */
  membershipRepository?: MembershipRepository;
  /** WORK-002: project repository. Present when a database is configured. */
  projectRepository?: ProjectRepository;
  /** WORK-002: project access repository. Present when a database is configured.
   *  Exposed so the projects route can serve `GET /projects` (list projects the
   *  current user has access to — the frontend dashboard uses this). */
  projectAccessRepository?: ProjectAccessRepository;
  /** WORK-004: project repository association repository. Present when a database is configured. */
  repositoryAssociationRepository?: ProjectRepositoryAssociationRepository;
  /** WORK-004: specification repository. Present when a database is configured. */
  specificationRepository?: SpecificationRepository;
  /** WORK-004: specification version repository. Present when a database is configured. */
  specificationVersionRepository?: SpecificationVersionRepository;
  /** WORK-005: architecture repository. Present when a database is configured. */
  architectureRepository?: ArchitectureRepository;
  /** WORK-005: architecture version repository. */
  architectureVersionRepository?: ArchitectureVersionRepository;
  /** WORK-005: architecture decision (ADR) repository. */
  architectureDecisionRepository?: ArchitectureDecisionRepository;
  /** WORK-005: architecture change request repository. */
  architectureChangeRequestRepository?: ArchitectureChangeRequestRepository;
  /** WORK-005: architecture service (freeze, approve change → replacement version). */
  architectureService?: ArchitectureService;
  /** WORK-006: requirement repository. */
  requirementRepository?: RequirementRepository;
  /** WORK-006: requirement dependency repository. */
  requirementDependencyRepository?: RequirementDependencyRepository;
  /** WORK-006: acceptance criterion repository. */
  acceptanceCriterionRepository?: AcceptanceCriterionRepository;
  /** WORK-006: evidence reference repository. */
  evidenceReferenceRepository?: EvidenceReferenceRepository;
  /** WORK-007: work item repository. */
  workItemRepository?: WorkItemRepository;
  /** WORK-007: work item requirement association repository. */
  workItemRequirementRepository?: WorkItemRequirementRepository;
  /** WORK-007: work item criterion association repository. */
  workItemCriterionRepository?: WorkItemCriterionRepository;
  /** WORK-007: work item dependency repository. */
  workItemDependencyRepository?: WorkItemDependencyRepository;
  /** WORK-007: PR association repository. */
  pullRequestAssociationRepository?: PullRequestAssociationRepository;
  /** WORK-007: work order repository. */
  workOrderRepository?: WorkOrderRepository;
  /** WORK-020: audit service (workflow audit emission + query). */
  auditService?: AuditService;
  /** WORK-021: notification service. */
  notificationService?: NotificationService;
  /** WORK-009/020: workflow engine (wired with audit emitter). */
  workflowEngine?: WorkflowEngine;
  /** WORK-017/018: workflow orchestrator (convergence loop). Present when DB + Redis. */
  orchestrator?: WorkflowOrchestrator;
  /** WORK-012: agent gateway. Present when DB + Redis configured. */
  agentGateway?: AgentGateway;
  /** WORK-012: agent run repository. Present when DB configured. */
  agentRunRepository?: AgentRunRepository;
  /** WORK-013: LLM gateway. Present when DB configured. */
  llmGateway?: LlmGateway;
  /** WORK-013: LLM execution record repository. Present when DB configured. */
  llmExecutionRecordRepository?: LlmExecutionRecordRepository;
  /** WORK-014: architect service. Present when DB configured. */
  architectService?: ArchitectService;
  /** WORK-025: Conversational Architect service. */
  conversationalArchitectService?: import('@modules/llm/index.js').ConversationalArchitectService;
  /** WORK-025: Architect session repository. */
  architectSessionRepository?: import('@modules/llm/index.js').ArchitectSessionRepository;
  /** WORK-025: Atomic plan applier (transaction-scoped). */
  planApplier?: import('@modules/llm/index.js').ArchitectPlanApplier;
  /** WORK-015: verification service. Present when DB configured. */
  verificationService?: VerificationService;
  /** WORK-016: review service. Present when DB configured. */
  reviewService?: ReviewService;
  /** WORK-015: CI evidence ingestion service. Present when DB configured. */
  ciEvidenceIngestionService?: CiEvidenceIngestionService;
  /** WORK-008/009: GitHub webhook processing service. Present when DB configured. */
  webhookProcessingService?: WebhookProcessingService;
  /** WORK-008: GitHub webhook event repository. Present when DB configured. */
  webhookEventRepository?: WebhookEventRepository;
  /** WORK-008: GitHub adapter (signature verification, provider calls). */
  githubAdapter?: GitHubAdapter;
  /** WORK-008: GitHub installation repository. Present when DB configured. */
  githubInstallationRepository?: GitHubInstallationRepository;
  /** WORK-002/008: secret store (for API keys + webhook secrets). */
  secretStore?: SecretStore;
  // --- WORK-026 (SUB-F): /runtime + /github provisioning + /work-items
  // ImplementationContext + /agents provider registry composition-root wiring. ---
  /** WORK-026: provider-independent deployment service (Vercel + fake). Present when DB configured. */
  deploymentService?: DeploymentService;
  /** WORK-026: aggregated runtime status (GitHub + Vercel + Architect + Agent). Present when DB configured. */
  runtimeStatusService?: RuntimeStatusService;
  /** WORK-026: lower-level integration repository (for list/create/remove route ops).
   *  Constructed alongside the deployment service; same Pg instance. */
  runtimeIntegrationRepository?: RuntimeIntegrationRepository;
  /** WORK-026: lower-level deployment repository (for list-across-integrations route op).
   *  Constructed alongside the deployment service; same Pg instance. */
  deploymentRepository?: DeploymentRepository;
  /** WORK-026: GitHub project↔repo provisioning link repository. Present when DB configured. */
  projectGitHubRepositoryRepository?: ProjectGitHubRepositoryRepository;
  /** WORK-026: builds + persists ImplementationContext revisions for autonomous implementation. Present when DB configured. */
  implementationContextBuilder?: ImplementationContextBuilder;
  /** WORK-026 (PR #29 fix #1): submits the persisted ImplementationContext to the AgentGateway. PRODUCTION MUST WIRE THIS. */
  startImplementationService?: StartImplementationService;
  /** WORK-026: per-project agent provider config repository. Present when DB configured. */
  agentProviderConfigRepository?: AgentProviderConfigRepository;
  /** WORK-026: composes platform + per-project agent provider registry. Present when DB configured. */
  agentProviderRegistryService?: DefaultAgentProviderRegistryService;
  /** WORK-027: execution record repository (wfos_executions). Present when DB configured. */
  executionRecordRepository?: ExecutionRecordRepository;
  /** WORK-027: builds the provider-independent ExecutionTask from the persisted
   *  ImplementationContext. PRODUCTION MUST WIRE THIS. */
  executionTaskService?: ExecutionTaskService;
  /** WORK-027: submits tasks through the ExecutionProvider boundary (native →
   *  AgentGateway; external → secure handoff package). PRODUCTION MUST WIRE THIS. */
  executionService?: ExecutionService;
  /** WORK-027: one-time, short-lived handoff token boundary for external packages. */
  executionHandoffService?: ExecutionHandoffService;
  /** WORK-027 (PR #30 fix #2): scoped event-ingestion callback token boundary. */
  executionCallbackService?: ExecutionCallbackService;
  /** WORK-027: provider-independent external result ingestion boundary. */
  executionEventIngestionService?: ExecutionEventIngestionService;
  /** WORK-036: the governed Tool Runtime. Present when DB + agents are
   *  configured. Capabilities, never authorities — tool outcomes are
   *  observations (session events + audit) and never mutate workflow,
   *  verification, review, merge, or architecture state. */
  toolRuntime?: ToolRuntime;
  /** WORK-032: Native vs External Execution Benchmark service. Present when
   *  DB + execution + workflow + verification + review are configured. */
  benchmarkService?: BenchmarkService;
  /** WORK-033: Execution Policy & Fair Benchmarking service. Present when
   *  DB + execution + benchmark + agent-provider-registry are configured.
   *  Advisory only — never bypasses ExecutionService.submit() (§34). */
  executionPolicyService?: ExecutionPolicyService;
}

export interface BuildAppOptions {
  /** Override the queue (tests inject an in-memory queue). */
  queue?: Queue;
  /** Override the logger (tests inject a capturing logger). */
  logger?: Logger;
  /** Echo job listener (tests observe async completion). */
  onEcho?: EchoJobOptions['onEcho'];
  /** Worker host options. */
  workerOptions?: WorkerHostOptions;
  /** Whether to start the worker host. The `api` role does not start it. */
  startWorker?: boolean;
}

export interface AppHandle {
  deps: AppDeps;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Build the WorkflowOS application handle from config.
 *
 * Resource ownership rules:
 * - When `BuildAppOptions.queue` is supplied (tests), the caller owns it and
 *   is responsible for closing it.
 * - When the app creates a Redis client for a `RedisQueue`, the app owns the
 *   client and closes it on `stop()`.
 */
export async function buildApp(
  config: AppConfig,
  options: BuildAppOptions = {},
): Promise<AppHandle> {
  const logger = options.logger ?? createLogger({ level: config.logLevel });

  let queue: Queue;
  let ownsRedis = false;
  let redisClient: Awaited<ReturnType<typeof createRedisClient>> | undefined;

  if (options.queue) {
    queue = options.queue;
  } else if (config.redisUrl) {
    redisClient = await createRedisClient(config.redisUrl);
    queue = new RedisQueue(redisClient);
    ownsRedis = true;
  } else {
    queue = new InMemoryQueue();
    logger.warn('app.queue.in_memory', {
      reason: 'REDIS_URL not set; using non-durable in-memory queue',
    });
  }

  // Handler registry is built AFTER database wiring (below) so that
  // database-dependent handlers (notification.send, etc.) can be registered.

  // --- WORK-003: optional infrastructure wiring (PostgreSQL + object storage).
  // When DATABASE_URL is set, a real PostgreSQL client is constructed and
  // migrations are applied. When OBJECT_STORAGE_DIR is set, a filesystem-backed
  // object store is constructed; otherwise an in-memory store is used for dev.
  // Domain modules obtain these from the Infrastructure container rather than
  // constructing their own clients.
  let infrastructure: Infrastructure | undefined;
  let ownsDatabase = false;
  let database: DatabaseClient | undefined;
  if (config.databaseUrl) {
    database = createDatabaseClient({ connectionString: config.databaseUrl });
    ownsDatabase = true;
    // WORK-023: only the API role runs migrations. When the API and worker
    // start simultaneously (as in docker-compose), both would race to apply
    // migrations and the loser crashes with a duplicate-key error. The
    // worker trusts that the API has already applied the schema.
    if (config.role !== 'worker') {
      await runMigrations(database, logger);
    }
  }
  let objectStore: ObjectStore;
  // PRODUCTION READINESS: S3-compatible object storage (Cloudflare R2).
  // When OBJECT_STORAGE_PROVIDER=s3, use the S3 adapter. Otherwise fall back
  // to filesystem (local dev) or in-memory (tests).
  const s3Store = createS3ObjectStoreFromEnv();
  if (s3Store) {
    objectStore = s3Store;
    logger.info('app.object_store.s3', { bucket: s3Store['config' as keyof S3ObjectStore] ? 'configured' : 'unknown' });
  } else if (config.objectStorageDir) {
    objectStore = new FsObjectStore(config.objectStorageDir);
  } else {
    objectStore = new InMemoryObjectStore();
    if (!options.queue) {
      logger.warn('app.object_store.in_memory', {
        reason: 'OBJECT_STORAGE_PROVIDER not s3 and OBJECT_STORAGE_DIR not set; using non-durable in-memory object store',
      });
    }
  }
  // infrastructure requires a Redis client (for locks/cache) and a database.
  // If we have a Redis client (created above for the queue), reuse it.
  if (redisClient && database) {
    infrastructure = buildInfrastructure({
      database,
      redis: redisClient,
      queue,
      objectStore,
      logger,
    });
  } else if (database) {
    // No Redis configured — infrastructure is partial (DB + object store only).
    // We still build it so domain code can use the database; lock/cache will
    // be present only if redisClient exists. For WORK-003 we keep it simple:
    // require Redis for the full Infrastructure container.
    infrastructure = undefined;
    logger.warn('app.infrastructure.partial', {
      reason: 'REDIS_URL not set; infrastructure container requires Redis for locks/cache',
    });
  }

  // --- WORK-002: identity, organizations, authorization, secrets.
  // When a database is configured, construct the /users, /organizations,
  // /projects repositories and the /auth authorization service + API-key
  // auth provider. The SecretStore abstraction is the only sanctioned way to
  // access raw secret values (SEC-001). Domain code receives these from the
  // AppDeps container; it never constructs its own clients.
  let authProvider: AuthProvider | undefined;
  let authorizationService: AuthorizationService | undefined;
  let apiKeyProvisioner: ApiKeyCredentialProvisioner | undefined;
  let userRepository: UserRepository | undefined;
  let organizationRepository: OrganizationRepository | undefined;
  let membershipRepo: MembershipRepository | undefined;
  let projectRepository: ProjectRepository | undefined;
  let projectAccessRepo: ProjectAccessRepository | undefined;
  let repositoryAssociationRepository: ProjectRepositoryAssociationRepository | undefined;
  let specificationRepository: SpecificationRepository | undefined;
  let specificationVersionRepository: SpecificationVersionRepository | undefined;
  let architectureRepository: ArchitectureRepository | undefined;
  let architectureVersionRepository: ArchitectureVersionRepository | undefined;
  let architectureDecisionRepository: ArchitectureDecisionRepository | undefined;
  let architectureChangeRequestRepository: ArchitectureChangeRequestRepository | undefined;
  let architectureService: ArchitectureService | undefined;
  let requirementRepository: RequirementRepository | undefined;
  let requirementDependencyRepository: RequirementDependencyRepository | undefined;
  let acceptanceCriterionRepository: AcceptanceCriterionRepository | undefined;
  let evidenceReferenceRepository: EvidenceReferenceRepository | undefined;
  let workItemRepository: WorkItemRepository | undefined;
  let workItemRequirementRepository: WorkItemRequirementRepository | undefined;
  let workItemCriterionRepository: WorkItemCriterionRepository | undefined;
  let workItemDependencyRepository: WorkItemDependencyRepository | undefined;
  let pullRequestAssociationRepository: PullRequestAssociationRepository | undefined;
  let workOrderRepository: WorkOrderRepository | undefined;
  let auditService: AuditService | undefined;
  let notificationService: NotificationService | undefined;
  let workflowEngine: WorkflowEngine | undefined;
  let orchestrator: WorkflowOrchestrator | undefined;
  let agentGateway: AgentGateway | undefined;
  let agentRunRepository: AgentRunRepository | undefined;
  let llmGateway: LlmGateway | undefined;
  let llmExecutionRecordRepository: LlmExecutionRecordRepository | undefined;
  let architectService: ArchitectService | undefined;
  let conversationalArchitectService: import('@modules/llm/index.js').ConversationalArchitectService | undefined;
  let architectSessionRepository: import('@modules/llm/index.js').ArchitectSessionRepository | undefined;
  let planApplier: import('@modules/llm/index.js').ArchitectPlanApplier | undefined;
  let verificationService: VerificationService | undefined;
  let reviewService: ReviewService | undefined;
  let ciEvidenceIngestionService: CiEvidenceIngestionService | undefined;
  let webhookProcessingService: WebhookProcessingService | undefined;
  let webhookEventRepository: WebhookEventRepository | undefined;
  let githubInstallationRepository: GitHubInstallationRepository | undefined;
  // --- WORK-026 (SUB-F): new service variables. ---
  let deploymentService: DeploymentService | undefined;
  let runtimeStatusService: RuntimeStatusService | undefined;
  let runtimeIntegrationRepository: RuntimeIntegrationRepository | undefined;
  let deploymentRepository: DeploymentRepository | undefined;
  let projectGitHubRepositoryRepository: ProjectGitHubRepositoryRepository | undefined;
  let implementationContextBuilder: ImplementationContextBuilder | undefined;
  let startImplementationService: StartImplementationService | undefined;
  let agentProviderConfigRepository: AgentProviderConfigRepository | undefined;
  let agentProviderRegistryService: DefaultAgentProviderRegistryService | undefined;
  // WORK-027: execution provider abstraction services.
  let executionRecordRepository: ExecutionRecordRepository | undefined;
  let executionTaskService: ExecutionTaskService | undefined;
  let executionService: ExecutionService | undefined;
  let benchmarkService: (BenchmarkService & BenchmarkTrialRunner) | undefined;
  // WORK-032 start-delivery durability: the generic OutboxRelay for the
  // benchmark start-delivery outbox. Injected into the WorkerHost below —
  // the boot sweep (once per process start) is what makes an orphaned
  // outbox autonomously recoverable after total process death.
  let benchmarkStartDeliveryRelay: OutboxRelay | undefined;
  // WORK-034 (PR #38 review): the session-terminal outbox relay (declared
  // at function scope — constructed inside the agents block, consumed by
  // the WorkerHost boot sweep below).
  let sessionTerminalRelay: OutboxRelay | undefined;
  // WORK-035: the workspace-release outbox relay (declared at function
  // scope; constructed inside the agents block).
  let workspaceReleaseRelay: OutboxRelay | undefined;
  let agentWorkspaceServiceRef: { reconcilePendingReleases(): Promise<number> } | undefined;
  // WORK-036: the governed tool runtime (declared at function scope; the
  // agents block constructs it — exposed for the future native-execution
  // path that drives governed tools inside the workspace).
  let toolRuntimeRef: ToolRuntime | undefined;
  // The session service is also referenced by the handler registry below.
  let executionSessionServiceRef: { reconcileTerminalForExecution(executionId: string): Promise<unknown> } | undefined;
  let executionPolicyService: ExecutionPolicyService | undefined;
  let executionHandoffService: ExecutionHandoffService | undefined;
  let executionCallbackService: ExecutionCallbackService | undefined;
  let executionEventIngestionService: ExecutionEventIngestionService | undefined;
  const githubAdapter: GitHubAdapter = new DefaultGitHubAdapter();
  // PRODUCTION READINESS: the SecretStore is needed for the GitHub webhook
  // route (signature validation). Hoist it out of the database block so the
  // webhook route can be wired even if other DB-dependent services aren't.
  const secretStore: SecretStore = new EnvSecretStore();
  if (database) {
    userRepository = new PgUserRepository(database);
    membershipRepo = new PgMembershipRepository(database);
    const rolePermissionRepo = new PgRolePermissionRepository(database);
    organizationRepository = new PgOrganizationRepository(database);
    projectRepository = new PgProjectRepository(database);
    projectAccessRepo = new PgProjectAccessRepository(database);
    repositoryAssociationRepository = new PgProjectRepositoryAssociationRepository(database);
    specificationRepository = new PgSpecificationRepository(database);
    specificationVersionRepository = new PgSpecificationVersionRepository(database);
    architectureRepository = new PgArchitectureRepository(database);
    architectureVersionRepository = new PgArchitectureVersionRepository(database);
    architectureDecisionRepository = new PgArchitectureDecisionRepository(database);
    architectureChangeRequestRepository = new PgArchitectureChangeRequestRepository(database);
    architectureService = new DefaultArchitectureService(database);
    requirementRepository = new PgRequirementRepository(database);
    requirementDependencyRepository = new PgRequirementDependencyRepository(database);
    acceptanceCriterionRepository = new PgAcceptanceCriterionRepository(database);
    evidenceReferenceRepository = new PgEvidenceReferenceRepository(database);
    workItemRepository = new PgWorkItemRepository(database);
    workItemRequirementRepository = new PgWorkItemRequirementRepository(database);
    workItemCriterionRepository = new PgWorkItemCriterionRepository(database);
    workItemDependencyRepository = new PgWorkItemDependencyRepository(database);
    pullRequestAssociationRepository = new PgPullRequestAssociationRepository(database);
    workOrderRepository = new PgWorkOrderRepository(database);
    // WORK-020: wire the audit service — production workflow transitions
    // emit audit events through this service. Without this wiring, the
    // DefaultWorkflowEngine in index.ts would have no audit emitter.
    auditService = new DefaultAuditService(database, logger);
    // WORK-020: wire the workflow engine with the audit emitter so
    // production workflow transitions emit audit events. Without this,
    // transitions can execute without audit (issue 1 from PR #19 review).
    // PR #35 review fix v2 / Blocker B: also wire an `onTransition`
    // composition hook so the benchmark service can re-advance any trial
    // awaiting the work item's terminal transition (verified /
    // verification_failed / implementation_blocked). The hook is a
    // forward-reference closure over the `benchmarkService` binding — by
    // the time any transition fires (after buildApp returns), the
    // benchmark service has been constructed + the binding is assigned.
    // The hook is best-effort (wrapped in try/catch + log) so a callback
    // failure NEVER breaks the core transition.
    const depService = new DefaultWorkItemDependencyService(database);
    workflowEngine = new DefaultWorkflowEngine(
      database, logger,
      (wiId: string) => depService.canBeginImplementation(wiId),
      auditService, // WorkflowAuditEmitter — workflow transitions emit audit events
      async (workItemId, _from, to) => {
        if (
          benchmarkService &&
          (to === 'verified' || to === 'verification_failed' || to === 'implementation_blocked')
        ) {
          await benchmarkService.advanceTrialsForWorkItem(workItemId);
        }
      },
    );
    // WORK-021: wire the notification service + register the
    // notification.send worker handler so production can deliver
    // notifications asynchronously through the existing WorkerHost.
    notificationService = new DefaultNotificationService(database, logger, queue, []);

    // --- PRODUCTION READINESS: wire the full service stack ---
    // These services were previously only constructed in the test/E2E
    // composition. Production must wire them so every route group works.
    // WORK-012: agent gateway + run repository.
    // PRODUCTION READINESS: use the OpenAI-compatible agent adapter when
    // AGENT_API_KEY / LLM_API_KEY is set. Falls back to no adapters (tests inject FakeAgentAdapter).
    agentRunRepository = new PgAgentRunRepository(database);
    const agentAdapters: AgentProviderAdapter[] = [];
    const agentAdapter = createOpenAiAgentAdapterFromEnv();
    if (agentAdapter) {
      agentAdapters.push(agentAdapter);
      logger.info('app.agent.adapter', { provider: agentAdapter.providerName });
    } else {
      logger.warn('app.agent.no_adapter', { reason: 'AGENT_API_KEY not set; agent runs will fail' });
    }
    agentGateway = new DefaultAgentGateway(database, logger, agentAdapters, 3);
    // WORK-013/014: LLM gateway + architect service.
    // PRODUCTION READINESS: use the OpenAI-compatible adapter when LLM_API_KEY
    // is set. Falls back to no adapters (tests inject FakeLlmAdapter).
    llmExecutionRecordRepository = new PgLlmExecutionRecordRepository(database);
    const llmAdapters: LlmProviderAdapter[] = [];
    const openaiAdapter = createOpenAiCompatibleAdapterFromEnv();
    if (openaiAdapter) {
      llmAdapters.push(openaiAdapter);
      logger.info('app.llm.adapter', { provider: openaiAdapter.providerName });
    } else {
      logger.warn('app.llm.no_adapter', { reason: 'LLM_API_KEY not set; LLM routes will return errors' });
    }
    llmGateway = new DefaultLlmGateway(database, logger, llmAdapters, 3);
    architectService = new DefaultArchitectService(database, llmGateway, workOrderRepository, logger);
    // WORK-025: Conversational Architect service + session repository.
    const { PgArchitectSessionRepository } = await import('./modules/llm/internal/pg-architect-session-repository.js');
    const { DefaultConversationalArchitectService } = await import('./modules/llm/internal/conversational-architect-service.js');
    architectSessionRepository = new PgArchitectSessionRepository(database);
    const archRepoModule = await import('./modules/architecture/internal/pg-architecture-repository.js');
    const reqRepoModule = await import('./modules/requirements/internal/pg-requirement-repository.js');
    const wiRepoModule = await import('./modules/work-items/internal/pg-work-item-repository.js');
    planApplier = new (await import('./modules/llm/internal/architect-plan-applier.js')).ArchitectPlanApplier(
      database, architectSessionRepository,
      {
        createArchitectureRepository: (db) => new archRepoModule.PgArchitectureRepository(db),
        createArchitectureVersionRepository: (db) => new archRepoModule.PgArchitectureVersionRepository(db),
        createRequirementRepository: (db) => new reqRepoModule.PgRequirementRepository(db),
        createAcceptanceCriterionRepository: (db) => new reqRepoModule.PgAcceptanceCriterionRepository(db),
        createWorkItemRepository: (db) => new wiRepoModule.PgWorkItemRepository(db),
        createWorkItemRequirementRepository: (db) => new wiRepoModule.PgWorkItemRequirementRepository(db),
        createWorkItemCriterionRepository: (db) => new wiRepoModule.PgWorkItemCriterionRepository(db),
        createWorkOrderRepository: (db) => new wiRepoModule.PgWorkOrderRepository(db),
        createWorkItemDependencyRepository: (db) => new wiRepoModule.PgWorkItemDependencyRepository(db),
        createArchitectSessionRepository: (db) => new PgArchitectSessionRepository(db),
      },
      logger,
    );
    conversationalArchitectService = new DefaultConversationalArchitectService(
      database, llmGateway, projectRepository,
      architectureRepository, architectureVersionRepository,
      requirementRepository, acceptanceCriterionRepository,
      workItemRepository, new DefaultProviderRegistry(secretStore), logger,
    );
    // WORK-008/015: GitHub CI evidence ingestion + installation repo.
    githubInstallationRepository = new PgGitHubInstallationRepository(database);
    const ciIngestionRepo = new PgCiEvidenceIngestionRepository(database);
    ciEvidenceIngestionService = new DefaultCiEvidenceIngestionService(ciIngestionRepo, githubInstallationRepository, logger);
    // WORK-015: verification service.
    verificationService = new DefaultVerificationService(
      database, requirementRepository, acceptanceCriterionRepository,
      architectureVersionRepository, workItemRepository,
      workItemRequirementRepository, workItemCriterionRepository,
      ciIngestionRepo, objectStore, logger,
    );
    // WORK-016: review service.
    reviewService = new DefaultReviewService(database, workItemRepository, logger);
    // WORK-008/009: webhook event repository + processing service.
    const pgWebhookEventRepo = new PgWebhookEventRepository(database);
    webhookEventRepository = pgWebhookEventRepo;
    webhookProcessingService = new DefaultWebhookProcessingService(
      pgWebhookEventRepo,
      githubInstallationRepository as PgGitHubInstallationRepository,
      pullRequestAssociationRepository as PgPullRequestAssociationRepository,
      repositoryAssociationRepository as PgProjectRepositoryAssociationRepository,
      logger,
      database,
    );
    // WORK-017/018: workflow orchestrator (convergence loop). Requires
    // Redis for the queue — constructed only when redisClient is available.
    if (redisClient) {
      orchestrator = new DefaultWorkflowOrchestrator(
        database, logger, queue, workflowEngine,
        workItemRepository, workOrderRepository, depService,
        // WORK-007: work item completion service.
        new DefaultWorkItemCompletionService(workItemRepository as PgWorkItemRepository),
        pullRequestAssociationRepository, agentGateway, agentRunRepository,
        architectService,
        verificationService, reviewService, githubAdapter,
        architectureVersionRepository, architectureRepository,
        projectRepository, generateExecutionId,
      );
    }
    authProvider = new ApiKeyAuthProvider(database, secretStore);
    authorizationService = new DefaultAuthorizationService(
      membershipRepo,
      rolePermissionRepo,
      projectRepository,
      projectAccessRepo,
    );
    apiKeyProvisioner = new ApiKeyCredentialProvisioner(database);

    // -----------------------------------------------------------------------
    // WORK-026 (SUB-F): composition-root wiring for /runtime, /github
    // provisioning, /work-items ImplementationContextBuilder, and /agents
    // provider registry. All services are constructed ONLY when a database is
    // present (their state lives in PostgreSQL). External-provider activation
    // (Vercel API token, GitHub App creds) is OPTIONAL — services still
    // construct when env vars are absent; the runtime status resolver + the
    // adapter health() probe report 'not-configured' so the API can surface
    // the gap to operators without throwing.
    // -----------------------------------------------------------------------

    // --- /runtime module: deployment provider boundary (SUB-B). ---
    runtimeIntegrationRepository = new PgRuntimeIntegrationRepository(database);
    deploymentRepository = new PgDeploymentRepository(database);
    deploymentService = new DefaultDeploymentService(
      runtimeIntegrationRepository,
      deploymentRepository,
      logger,
    );
    // Always register the fake provider so dev/test parity is preserved (the
    // /runtime/providers route surfaces 'test-mode' for it).
    deploymentService.registerProvider(new FakeDeploymentProvider());
    if (process.env.VERCEL_API_TOKEN) {
      deploymentService.registerProvider(
        new VercelDeploymentProvider({
          apiToken: process.env.VERCEL_API_TOKEN,
          teamId: process.env.VERCEL_TEAM_ID,
        }),
      );
      logger.info('app.runtime.vercel', { configured: true });
    } else {
      logger.warn('app.runtime.no_vercel', {
        reason: 'VERCEL_API_TOKEN not set; runtime deployments surface not-configured',
      });
    }

    // --- /github module: project↔GitHub repository provisioning (SUB-C). ---
    projectGitHubRepositoryRepository = new PgProjectGitHubRepositoryRepository(database);

    // --- /work-items module: ImplementationContextBuilder (SUB-D). ---
    // The builder consumes the 10 repository deps + 4 optional callback
    // resolvers wired here to avoid a hard module cycle between /work-items,
    // /github, /agents, and /reviews. Each resolver is a thin closure over
    // existing AppDeps services. The builder issues NO SQL of its own (SUB-D
    // omitted the `db: DatabaseClient` constructor arg — see SUB-D deviation
    // note in the worklog).
    const implementationContextRepository =
      new PgImplementationContextRepository(database);

    const repositoryResolver = async (projectId: string) => {
      const r = await projectGitHubRepositoryRepository!.findByProject(projectId);
      return r
        ? {
            owner: r.owner,
            repository: r.repository,
            defaultBranch: r.defaultBranch,
          }
        : null;
    };

    const pullRequestResolver = async (workItemId: string) => {
      // Use the canonical "active PR" lookup (one active PR per work item —
      // enforced by the partial unique index on wfos_pull_request_associations).
      // Parse the canonical 'github:owner/repo#<num>' externalPrId format to
      // extract the PR number; null when the format doesn't match (defensive).
      const pr = await pullRequestAssociationRepository!.findActiveForWorkItem(workItemId);
      if (!pr) return null;
      const match = pr.externalPrId.match(/^github:([^/]+)\/([^#]+)#(\d+)$/);
      const num = match ? Number.parseInt(match[3]!, 10) : 0;
      return {
        number: Number.isFinite(num) ? num : 0,
        url: pr.externalPrId,
        headSha: pr.headCommit ?? '',
      };
    };

    const agentRunResolver = async (workItemId: string) => {
      const runs = await agentRunRepository!.findByWorkItem(workItemId);
      return runs.map((r) => {
        // `configuration: Record<string, unknown>` carries the agent model name
        // under the conventional `model` key (set by the route + orchestrator).
        const modelRaw = (r.configuration as Record<string, unknown> | null)?.model;
        return {
          executionId: r.executionId,
          provider: r.provider,
          model: typeof modelRaw === 'string' ? modelRaw : '',
          status: r.status,
          commitRef: r.commitRef,
          pullRequestRef: r.pullRequestRef,
          createdAt: r.createdAt.toISOString(),
        };
      });
    };

    const reviewResolver = async (workItemId: string) => {
      const reviews = await reviewService!.listReviewsForWorkItem(workItemId);
      const finalized = reviews.filter(
        (r) => r.status === 'completed' && r.outcome !== null,
      );
      return Promise.all(
        finalized.map(async (r) => {
          const findings = await reviewService!.listFindingsForReview(r.id);
          return {
            reviewId: r.id,
            verdict: r.outcome as string,
            summary: r.summary ?? '',
            findings: findings.map((f) => f.description),
            createdAt: r.createdAt.toISOString(),
          };
        }),
      );
    };

    implementationContextBuilder = new DefaultImplementationContextBuilder(
      workItemRepository,
      workOrderRepository,
      workItemRequirementRepository,
      workItemCriterionRepository,
      workItemDependencyRepository,
      requirementRepository,
      acceptanceCriterionRepository,
      architectureVersionRepository,
      architectureRepository,
      implementationContextRepository,
      repositoryResolver,
      pullRequestResolver,
      agentRunResolver,
      reviewResolver,
    );

    // --- /work-items + /agents: WORK-027 execution provider abstraction. ---
    // The deterministic prompt builder is a pure function of the persisted
    // ImplementationContextContent (no timestamps, no UUIDs, no randomness).
    const executionPromptBuilder = new DefaultExecutionPromptBuilder();

    // The task service loads WI + latest Work Order, builds (or reuses) the
    // ImplementationContext, resolves the project, and assembles the
    // provider-independent ExecutionTask.
    executionTaskService = new DefaultExecutionTaskService({
      workItemRepository,
      workOrderRepository,
      architectureVersionRepository,
      architectureRepository,
      implementationContextBuilder,
      contextRepository: implementationContextRepository,
      promptBuilder: executionPromptBuilder,
      logger,
    });

    // Execution persistence + the two ExecutionProviders. NATIVE wraps the
    // EXISTING AgentGateway (there is no second gateway); EXTERNAL generates
    // a deterministic, secret-free handoff package (no Z.ai/ChatGPT/Claude
    // adapters yet — WORK-028/029).
    executionRecordRepository = new PgExecutionRecordRepository(database);
    const executionEventRepository = new PgExecutionEventRepository(database);
    const executionHandoffRepository = new PgExecutionHandoffRepository(database);
    const nativeExecutionProvider = new NativeExecutionProvider({
      agentGateway: agentGateway!,
      agentRunRepository: agentRunRepository!,
      logger,
    });
    const externalExecutionProvider = new ExternalExecutionProvider();
    // WORK-034: the persistent session lifecycle boundary. The execution
    // service becomes session-aware (exactly one session per execution
    // record, CAS start + turn_started, session outcomes mirror execution
    // outcomes). Providers are NOT session-aware — session lifecycle stays
    // /agents-owned.
    const executionSessionRepository = new PgExecutionSessionRepository(database);
    const executionSessionService = new DefaultExecutionSessionService({
      sessionRepository: executionSessionRepository,
      executionRecordRepository,
      logger,
      // PR #38 review (durable terminalization): the claim-time relay-job
      // enqueue (the obligation row itself is written by migration 0035's
      // trigger, atomically with the record's terminal transition).
      queue,
    });
    // The session-terminal outbox relay (the generic OutboxRelay): the
    // boot sweep re-enqueues reconcile jobs for every pending obligation.
    sessionTerminalRelay = new SessionTerminalOutboxRelay({
      sessionRepository: executionSessionRepository,
      executionRecordRepository,
      queue,
      logger,
    });
    executionSessionServiceRef = executionSessionService;

    // --- WORK-035: Agent Workspaces and Git Worktrees. ---
    // The workspace boundary: the filesystem/repository environment for
    // one logical execution (NOT the execution lifecycle — the session
    // owns that; NOT a GitHub authority — the /github repository row is
    // the linkage). The FsWorktreeMaterializer executes git-worktree-class
    // operations under the configured workspace root (no credentials; the
    // installation credential stays in /github's SecretStore).
    // PR #39 review fix #1 — the AUTHORITATIVE BASELINE: base_revision is
    // the repository's default-branch HEAD commit, resolved through the
    // EXISTING /github adapter read (githubAdapter.getBranch — the same
    // source the benchmark snapshot service uses for baseCommit; the
    // workspace layer itself never holds GitHub credentials — the adapter
    // is injected through the DI boundary).
    const agentWorkspaceRepository = new PgAgentWorkspaceRepository({
      db: database,
      executionRecordRepository,
      projectGitHubRepositoryLookup: projectGitHubRepositoryRepository!,
      baselineResolver: githubAdapter,
    });
    // The ONE workspace materializer (shared by the workspace service and
    // the WORK-036 tool runtime's host-path re-resolution).
    const workspaceMaterializer = new FsWorktreeMaterializer({
      rootDir: process.env.WFOS_WORKSPACE_ROOT ?? './.workspaces',
      logger,
    });
    const agentWorkspaceService = new DefaultAgentWorkspaceService({
      workspaceRepository: agentWorkspaceRepository,
      materializer: workspaceMaterializer,
      logger,
    });
    workspaceReleaseRelay = new WorkspaceReleaseOutboxRelay({
      workspaceRepository: agentWorkspaceRepository,
      queue,
      logger,
    });
    agentWorkspaceServiceRef = agentWorkspaceService;

    // --- WORK-036: Tool Runtime — the governed tool boundary BENEATH the
    // execution/session/workspace authority. Tools are capabilities, never
    // authorities: outcomes are observations (session `tool_call` +
    // `observation` events + audit), never workflow/verification/review
    // mutations. The executors are platform-owned execution infrastructure
    // (workspace-confined fs/process/git/package/http/browser); the policy
    // gate is the WORK-037 enforcement seam (default: allow — no permission
    // engine in WORK-036). The SAME materializer instance re-resolves each
    // invocation's workspace worktree root (the WORK-035 boundary reused,
    // never duplicated). No browser driver is configured by default — the
    // family fails closed with the typed unavailability outcome until a
    // provider driver adapter is supplied behind the port.
    const toolRuntime = new DefaultToolRuntime({
      sessionService: executionSessionService,
      sessionRepository: executionSessionRepository,
      workspaceRepository: agentWorkspaceRepository,
      materializer: workspaceMaterializer,
      executors: {
        filesystem: new FsToolExecutor({ logger }),
        terminal: new ProcessToolExecutor('terminal', { logger }),
        git: new ProcessToolExecutor('git', { logger }),
        package: new ProcessToolExecutor('package', { logger }),
        http: new HttpToolExecutor({ logger }),
        browser: new BrowserToolExecutor({ logger }),
      },
      policyGate: new DefaultToolPolicyGate(),
      auditWriter: auditService,
      logger,
    });
    toolRuntimeRef = toolRuntime;
    executionService = new DefaultExecutionService({
      executionRecordRepository,
      providers: [nativeExecutionProvider, externalExecutionProvider],
      auditService,
      logger,
      sessionService: executionSessionService,
    });
    executionHandoffService = new DefaultExecutionHandoffService({
      executionRecordRepository,
      handoffRepository: executionHandoffRepository,
      auditService,
      logger,
    });
    // PR #30 review fix #2: scoped event-ingestion callback credentials —
    // the ONLY credential the Companion extension needs (no API key).
    const executionCallbackRepository = new PgExecutionCallbackRepository(database);
    executionCallbackService = new DefaultExecutionCallbackService({
      executionRecordRepository,
      callbackRepository: executionCallbackRepository,
      auditService,
      logger,
    });
    // PR #35 review fix v2 / Blocker A: wire the `onExecutionTerminal`
    // composition hook so the benchmark service can re-advance any trial
    // awaiting an external execution's terminal state (completed / failed).
    // Forward-reference closure over `benchmarkService` — by the time any
    // terminal ingestion event fires (after buildApp returns), the
    // benchmark service has been constructed + the binding is assigned.
    // The hook is best-effort (wrapped in try/catch + log inside the
    // ingestion service) so a callback failure NEVER breaks the core
    // ingestion operation.
    executionEventIngestionService = new DefaultExecutionEventIngestionService({
      executionRecordRepository,
      eventRepository: executionEventRepository,
      auditService,
      logger,
      onExecutionTerminal: async (execId, state) => {
        // WORK-034: an external execution reaching its terminal state
        // (completed/failed) terminalizes its session through the same
        // logical execution identity (idempotent — already-terminal
        // sessions are a no-op). Session completion does NOT mean
        // VERIFIED/MERGED — those stay /verification + GitHub authority.
        try {
          if (state === 'completed') {
            await executionSessionService.completeSession(execId);
          } else if (state === 'failed') {
            await executionSessionService.failSession(execId, 'external-execution-failed');
          }
        } catch (err) {
          logger.error('execution.session-terminal-hook-failed', {
            executionId: execId,
            error: (err as Error).message,
          });
        }
        if (benchmarkService) {
          await benchmarkService.advanceTrialsForExecution(execId);
        }
      },
    });

    // --- WORK-032: Native vs External Execution Benchmark. ---
    // The benchmark is a cross-cutting application-layer orchestrator at
    // src/benchmark/ that CONSUMES the 17 frozen domain modules via their
    // public barrels. It does NOT create another workflow/verification/review/
    // CI engine (static check in tests/architecture/static-architecture.test.ts).
    // It delegates execution to ExecutionService (owned by /agents) and reads
    // authoritative state from /workflows, /verification, /reviews, /github,
    // /agents, /audit. NEVER stores credentials.
    const benchmarkRepository = new PgBenchmarkRepository(database);
    // WORK-032 start-delivery durability: the outbox relay for the benchmark
    // start-delivery obligations. Constructed next to its repository (it
    // needs the boot-sweep query + the queue); consumed by the WorkerHost
    // wiring below (outboxRelays) — the generic platform contract lives at
    // platform/worker/outbox-relay.ts.
    benchmarkStartDeliveryRelay = new BenchmarkStartDeliveryOutboxRelay({
      repository: benchmarkRepository,
      queue,
      logger,
    });
    const benchmarkSnapshotService = new DefaultBenchmarkSnapshotService({
      repository: benchmarkRepository,
      workItemRepository: workItemRepository!,
      workOrderRepository: workOrderRepository!,
      architectureVersionRepository: architectureVersionRepository!,
      architectureRepository: architectureRepository!,
      projectRepository: projectRepository!,
      implementationContextBuilder: implementationContextBuilder!,
      contextRepository: implementationContextRepository,
      promptBuilder: executionPromptBuilder,
      projectGitHubRepositoryRepository: projectGitHubRepositoryRepository!,
      githubAdapter: githubAdapter!,
      logger,
    });
    const benchmarkIntegrityService = new DefaultBenchmarkIntegrityService({
      repository: benchmarkRepository,
      logger,
    });
    const benchmarkMetricCollector = new DefaultBenchmarkMetricCollector({
      repository: benchmarkRepository,
      workflowEngine: workflowEngine!,
      verificationService: verificationService!,
      reviewService: reviewService!,
      pullRequestAssociationRepository: pullRequestAssociationRepository!,
      ciEvidenceIngestionRepository: new PgCiEvidenceIngestionRepository(database),
      agentRunRepository: agentRunRepository!,
      logger,
    });
    const benchmarkTrialOrchestrator = new DefaultBenchmarkTrialOrchestrator({
      repository: benchmarkRepository,
      executionService: executionService!,
      executionTaskService: executionTaskService!,
      agentRunRepository: agentRunRepository!,
      workItemRepository: workItemRepository!,
      workOrderRepository: workOrderRepository!,
      workItemRequirementRepository: workItemRequirementRepository!,
      workItemCriterionRepository: workItemCriterionRepository!,
      workItemDependencyRepository: workItemDependencyRepository!,
      workflowEngine: workflowEngine!,
      projectGitHubRepositoryRepository: projectGitHubRepositoryRepository!,
      githubAdapter: githubAdapter!,
      logger,
    });
    const benchmarkExportService = new DefaultBenchmarkExportService({
      repository: benchmarkRepository,
      logger,
    });
    const benchmarkRecommendationService = new DefaultBenchmarkRecommendationService({
      repository: benchmarkRepository,
      logger,
    });
    benchmarkService = new DefaultBenchmarkService({
      db: database,
      logger,
      repository: benchmarkRepository,
      snapshotService: benchmarkSnapshotService,
      integrityService: benchmarkIntegrityService,
      metricCollector: benchmarkMetricCollector,
      trialOrchestrator: benchmarkTrialOrchestrator,
      exportService: benchmarkExportService,
      recommendationService: benchmarkRecommendationService,
      auditService: auditService!,
      authorizationService: authorizationService!,
      // PR #35 review fix v2 (Blocker A + Blocker B): the benchmark trial
      // lifecycle is FULLY EVENT-DRIVEN + ASYNCHRONOUS.
      // `startExperiment()` enqueues `benchmark.trial` jobs onto this queue
      // + returns immediately; the WorkerHost picks them up + calls
      // `runTrialJob(trialId)`. The trial is re-advanced by:
      //   - onExecutionTerminal hook (wired above on the ingestion
      //     service) → advanceTrialsForExecution(executionId) when an
      //     external execution reaches a terminal state.
      //   - onTransition hook (wired above on the workflow engine) →
      //     advanceTrialsForWorkItem(workItemId) when the cloned work
      //     item reaches `verified` or a terminal failure state.
      // NO bounded poll. NO `externalTimeoutMs`.
      queue,
      executionRecordRepository: executionRecordRepository!,
      workflowEngine: workflowEngine!,
    });

    // --- /work-items module: DefaultStartImplementationService (PR #29 fix #1,
    //     WORK-027 refactor). Wires the persisted ImplementationContext to the
    //     native execution path through the ExecutionService boundary. In
    //     production, this service MUST be wired — there is NO production
    //     no-op path that returns success without an AgentRun. The route
    //     returns 503 if this service is absent.
    startImplementationService = new DefaultStartImplementationService({
      executionTaskService,
      executionService,
      logger,
    });

    // --- /agents module: provider registry (SUB-E). ---
    // `DefaultAgentProviderRegistry` lives in the platform layer (mirrors the
    // /llm ProviderRegistry pattern). It is NOT exported through the platform
    // barrel — imported directly from its file (precedent: DefaultProviderRegistry
    // import on app.ts line ~117).
    agentProviderConfigRepository = new PgAgentProviderConfigRepository(database);
    const agentProviderRegistry = new DefaultAgentProviderRegistry(secretStore);
    agentProviderRegistryService = new DefaultAgentProviderRegistryService(
      agentProviderRegistry,
      agentProviderConfigRepository,
      secretStore,
    );

    // --- WORK-033: Execution Policy & Fair Benchmarking (application-layer
    //     orchestrator at src/execution-policy/). Constructed AFTER the
    //     benchmark service (evidence provider consumes the benchmark
    //     repository) + the agent-provider-registry service (capability
    //     source of truth). Advisory only — the caller (route layer) still
    //     submits via ExecutionService.submit(); this layer never bypasses
    //     it (§34). NEVER stores credentials; NEVER invents capabilities.
    const executionPolicyRepository = new PgExecutionPolicyRepository(database);
    const executionEvidenceProvider = new DefaultBenchmarkEvidenceProvider({
      benchmarkRepository: benchmarkRepository,
    });
    const executionTaskProfileBuilder = new DefaultExecutionTaskProfileBuilder({
      workItemRepository: workItemRepository!,
      workOrderRepository: workOrderRepository!,
      implementationContextRepository: implementationContextRepository!,
      logger,
    });
    executionPolicyService = new DefaultExecutionPolicyService({
      db: database,
      logger,
      repository: executionPolicyRepository,
      eligibilityService: new DefaultExecutionEligibilityService(),
      recommendationService: new DefaultExecutionRecommendationService(),
      taskProfileBuilder: executionTaskProfileBuilder,
      agentProviderRegistry: agentProviderRegistryService,
      benchmarkEvidenceProvider: executionEvidenceProvider,
    });

    // --- /runtime module: DefaultRuntimeStatusService (SUB-B). ---
    // Aggregates GitHub + Vercel + Architect + Agent status for a project.
    // The resolvers are closures over existing services; each catches its own
    // errors (the DefaultRuntimeStatusService wraps them in try/catch and
    // degrades to 'error' or 'not-configured' per ProjectRuntimeStatus shape).
    runtimeStatusService = new DefaultRuntimeStatusService(
      {
        resolveGithub: async (projectId) => {
          const r = await projectGitHubRepositoryRepository!.findByProject(projectId);
          return {
            status: r ? 'connected' : 'not-configured',
            owner: r?.owner,
            repository: r?.repository,
            defaultBranch: r?.defaultBranch ?? null,
          };
        },
        resolveVercel: async (projectId) => {
          const dep = await deploymentService!.getLatestDeployment(projectId);
          const integ = await runtimeIntegrationRepository!.findByProjectAndProvider(
            projectId,
            'vercel',
          );
          return {
            status: integ ? 'connected' : 'not-configured',
            projectId: integ?.projectExternalId,
            previewUrl: dep?.previewUrl ?? null,
            latestDeployment: dep,
          };
        },
        resolveArchitect: async (_projectId) => {
          const providers = conversationalArchitectService!.getProviders();
          return {
            status: providers.some((p) => p.status === 'ready')
              ? 'connected'
              : 'not-configured',
            providers: providers.map((p) => ({
              name: p.name,
              provider: p.provider,
              model: p.model,
              status: p.status,
            })),
          };
        },
        resolveAgent: async (_projectId) => {
          const providers = agentProviderRegistry.getProviders();
          return {
            status: providers.some((p) => p.status === 'ready')
              ? 'connected'
              : 'not-configured',
            providers: providers.map((p) => ({
              name: p.name,
              provider: p.provider,
              model: p.model,
              status: p.status,
            })),
          };
        },
      },
      logger,
    );
  }

  // Build handler registry AFTER database wiring so database-dependent
  // handlers can be registered.
  const handlerList: import('@platform/index.js').JobHandler[] = [
    createEchoJobHandler(logger, { onEcho: options.onEcho }),
  ];
  if (notificationService) {
    handlerList.push(createNotificationJobHandler(notificationService, logger));
  }
  // WORK-017: convergence job handler — drives the workflow convergence loop.
  if (orchestrator) {
    handlerList.push(createConvergenceJobHandler(orchestrator, logger));
  }
  // WORK-008: GitHub webhook job handler — processes webhook events async.
  if (webhookProcessingService) {
    handlerList.push(createWebhookJobHandler(webhookProcessingService, logger));
  }
  // WORK-032 (PR #35 review fix #4): benchmark trial job handler — drives
  // the async trial lifecycle (clone → branch → submit → poll external →
  // collect metrics → check experiment completion).
  // WORK-032 start-delivery durability: the start-delivery relay job
  // handler — the consumer-side repair the relay job (boot sweep /
  // claim-time enqueue) invokes. Registered NEXT TO the trial handler in
  // the SAME existing WorkerHost registry.
  if (benchmarkService) {
    handlerList.push(createBenchmarkTrialJobHandler(benchmarkService, logger));
    handlerList.push(createStartDeliveryRelayJobHandler(benchmarkService, logger));
  }
  // WORK-034 (PR #38 review): the session-terminal reconcile relay job
  // handler — the durable recovery for the terminal-session
  // reconciliation (the fast path remains in the execution service; the
  // relay job + the boot sweep are the backstop for the crash window).
  if (executionSessionServiceRef) {
    handlerList.push(createSessionTerminalRelayJobHandler(executionSessionServiceRef, logger));
  }
  // WORK-035: the workspace-release reconcile relay job handler (the
  // durable execution-terminal cleanup for workspaces).
  if (agentWorkspaceServiceRef) {
    handlerList.push(createWorkspaceReleaseRelayJobHandler(agentWorkspaceServiceRef, logger));
  }
  const handlers = buildHandlerRegistry(handlerList);
  const worker = new WorkerHost(queue, handlers, logger, {
    ...options.workerOptions,
    // WORK-032 start-delivery durability: the outbox relay boot sweep —
    // every worker-process start re-enqueues relay jobs for ALL
    // incomplete durable start obligations (process-startup recovery,
    // NOT a periodic poll; see platform/worker/outbox-relay.ts).
    outboxRelays: [
      ...(benchmarkStartDeliveryRelay ? [benchmarkStartDeliveryRelay] : []),
      // WORK-034 (PR #38 review): the session-terminal obligation boot
      // sweep — every worker start re-enqueues reconcile jobs for ALL
      // pending obligations (the durable liveness backstop).
      ...(sessionTerminalRelay ? [sessionTerminalRelay] : []),
      // WORK-035: the workspace-release obligation boot sweep.
      ...(workspaceReleaseRelay ? [workspaceReleaseRelay] : []),
    ],
  });

  const handle: AppHandle = {
    deps: {
      logger,
      queue,
      handlers,
      worker,
      infrastructure,
      authProvider,
      authorizationService,
      apiKeyProvisioner,
      userRepository,
      organizationRepository,
      membershipRepository: membershipRepo,
      projectRepository,
      projectAccessRepository: projectAccessRepo,
      repositoryAssociationRepository,
      specificationRepository,
      specificationVersionRepository,
      architectureRepository,
      architectureVersionRepository,
      architectureDecisionRepository,
      architectureChangeRequestRepository,
      architectureService,
      requirementRepository,
      requirementDependencyRepository,
      acceptanceCriterionRepository,
      evidenceReferenceRepository,
      workItemRepository,
      workItemRequirementRepository,
      workItemCriterionRepository,
      workItemDependencyRepository,
      pullRequestAssociationRepository,
      workOrderRepository,
      auditService,
      notificationService,
      workflowEngine,
      orchestrator,
      agentGateway,
      agentRunRepository,
      llmGateway,
      llmExecutionRecordRepository,
      architectService,
      conversationalArchitectService,
      architectSessionRepository,
      planApplier,
      verificationService,
      reviewService,
      ciEvidenceIngestionService,
      webhookProcessingService,
      webhookEventRepository,
      githubAdapter,
      githubInstallationRepository,
      secretStore,
      // WORK-026 (SUB-F): new runtime + provisioning + implementation-context +
      // agent-registry deps.
      deploymentService,
      runtimeStatusService,
      runtimeIntegrationRepository,
      deploymentRepository,
      projectGitHubRepositoryRepository,
      implementationContextBuilder,
      startImplementationService,
      agentProviderConfigRepository,
      agentProviderRegistryService,
      // WORK-027: execution provider abstraction deps.
      executionRecordRepository,
      executionTaskService,
      executionService,
      executionHandoffService,
      executionCallbackService,
      executionEventIngestionService,
      // WORK-036: the governed tool runtime (present when DB + agents
      // configured). Capabilities, never authorities — observations only.
      toolRuntime: toolRuntimeRef,
      // WORK-032: benchmark service (present when DB + execution configured).
      benchmarkService,
      // WORK-033: execution-policy service (present when DB + benchmark +
      // agent-provider-registry configured). Advisory only (§34).
      executionPolicyService,
    },
    start: async () => {
      if (options.startWorker !== false) {
        await worker.start();
      }
    },
    stop: async () => {
      await worker.stop();
      if (options.queue) {
        // Caller owns the queue.
        return;
      }
      await queue.close();
      if (ownsRedis && redisClient) {
        await redisClient.quit();
      }
      if (ownsDatabase && database) {
        await database.close();
      }
    },
  };
  return handle;
}
