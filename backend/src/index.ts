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
import { buildApp } from './app.js';
import { buildServer } from './api/server.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config, { startWorker: config.role !== 'api' });

  let server: Awaited<ReturnType<typeof buildServer>> | undefined;

  if (config.role === 'api' || config.role === 'all') {
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
        ? { auth: { authProvider: app.deps.authProvider, userRepository: app.deps.userRepository } }
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
      app.deps.architectureService
        ? {
            architecture: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              architectureDecisionRepository: app.deps.architectureDecisionRepository,
              architectureChangeRequestRepository: app.deps.architectureChangeRequestRepository,
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
      app.deps.requirementRepository &&
      app.deps.acceptanceCriterionRepository &&
      app.deps.llmGateway &&
      app.deps.architectService
        ? {
            architect: {
              authorizationService: app.deps.authorizationService,
              projectRepository: app.deps.projectRepository,
              architectureRepository: app.deps.architectureRepository,
              architectureVersionRepository: app.deps.architectureVersionRepository,
              workItemRepository: app.deps.workItemRepository,
              workOrderRepository: app.deps.workOrderRepository,
              requirementRepository: app.deps.requirementRepository,
              acceptanceCriterionRepository: app.deps.acceptanceCriterionRepository,
              llmGateway: app.deps.llmGateway,
              architectService: app.deps.architectService,
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
