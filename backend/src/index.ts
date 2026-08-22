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
