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
  let verificationService: VerificationService | undefined;
  let reviewService: ReviewService | undefined;
  let ciEvidenceIngestionService: CiEvidenceIngestionService | undefined;
  let webhookProcessingService: WebhookProcessingService | undefined;
  let webhookEventRepository: WebhookEventRepository | undefined;
  let githubInstallationRepository: GitHubInstallationRepository | undefined;
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
    const depService = new DefaultWorkItemDependencyService(database);
    workflowEngine = new DefaultWorkflowEngine(
      database, logger,
      (wiId: string) => depService.canBeginImplementation(wiId),
      auditService, // WorkflowAuditEmitter — workflow transitions emit audit events
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
  const handlers = buildHandlerRegistry(handlerList);
  const worker = new WorkerHost(queue, handlers, logger, options.workerOptions);

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
      verificationService,
      reviewService,
      ciEvidenceIngestionService,
      webhookProcessingService,
      webhookEventRepository,
      githubAdapter,
      githubInstallationRepository,
      secretStore,
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
