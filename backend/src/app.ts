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
import type { OrganizationRepository } from '@modules/organizations/index.js';
import { PgOrganizationRepository } from './modules/organizations/internal/pg-organization-repository.js';
import {
  PgMembershipRepository,
  PgRolePermissionRepository,
} from './modules/organizations/internal/pg-membership-repository.js';
import type {
  ProjectRepository,
  ProjectRepositoryAssociationRepository,
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
import type { AppConfig } from './config.js';
import { DefaultWorkflowEngine } from './modules/workflows/internal/workflow-engine.js';
import type { WorkflowEngine } from '@modules/workflows/index.js';

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
  /** WORK-002: project repository. Present when a database is configured. */
  projectRepository?: ProjectRepository;
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
  /** WORK-009/020: workflow engine (wired with audit emitter). */
  workflowEngine?: WorkflowEngine;
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

  const handlers = buildHandlerRegistry([
    createEchoJobHandler(logger, { onEcho: options.onEcho }),
  ]);
  const worker = new WorkerHost(queue, handlers, logger, options.workerOptions);

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
    await runMigrations(database, logger);
  }
  let objectStore: ObjectStore;
  if (config.objectStorageDir) {
    objectStore = new FsObjectStore(config.objectStorageDir);
  } else {
    objectStore = new InMemoryObjectStore();
    if (!options.queue) {
      logger.warn('app.object_store.in_memory', {
        reason: 'OBJECT_STORAGE_DIR not set; using non-durable in-memory object store',
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
  let projectRepository: ProjectRepository | undefined;
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
  let workflowEngine: WorkflowEngine | undefined;
  if (database) {
    const secretStore: SecretStore = new EnvSecretStore();
    userRepository = new PgUserRepository(database);
    const membershipRepo = new PgMembershipRepository(database);
    const rolePermissionRepo = new PgRolePermissionRepository(database);
    organizationRepository = new PgOrganizationRepository(database);
    projectRepository = new PgProjectRepository(database);
    const projectAccessRepo = new PgProjectAccessRepository(database);
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
    authProvider = new ApiKeyAuthProvider(database, secretStore);
    authorizationService = new DefaultAuthorizationService(
      membershipRepo,
      rolePermissionRepo,
      projectRepository,
      projectAccessRepo,
    );
    apiKeyProvisioner = new ApiKeyCredentialProvisioner(database);
  }

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
      projectRepository,
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
      workflowEngine,
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
