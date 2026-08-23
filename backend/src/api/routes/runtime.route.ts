import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type {
  DeploymentService,
  RuntimeStatusService,
  RuntimeIntegrationRepository,
  DeploymentRepository,
  RuntimeIntegration,
  Deployment,
  DeploymentStatus,
} from '@modules/runtime/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * WORK-026 (SUB-F): /runtime routes — provider-independent deployment /
 * preview environment boundary.
 *
 * Route surface (PLAN-1 §2.4):
 *   POST   /projects/:projectId/runtime/integrations        — create a runtime integration (project.write)
 *   GET    /projects/:projectId/runtime/integrations        — list integrations (project.read)
 *   DELETE /projects/:projectId/runtime/integrations/:integrationId — remove (project.admin)
 *   POST   /projects/:projectId/runtime/deployments        — record a deployment (project.write)
 *   GET    /projects/:projectId/runtime/deployments        — list deployments (project.read)
 *   GET    /projects/:projectId/runtime/deployments/latest — latest deployment (project.read)
 *   GET    /projects/:projectId/runtime                    — ProjectRuntimeStatus via runtimeStatusService (project.read)
 *   GET    /projects/:projectId/runtime/providers          — deployment providers health (project.read)
 *
 * The route handler is THIN: it delegates to the injected DeploymentService +
 * RuntimeStatusService + the lower-level RuntimeIntegrationRepository /
 * DeploymentRepository contracts. The /runtime module barrel exposes these
 * repository interfaces as TYPE-only contracts (the concrete Pg* classes
 * live in /runtime internal/ and are constructed by the composition root).
 *
 * Secrets never cross this boundary — provider credentials live inside the
 * adapter layer; the runtime status resolver returns readiness flags only.
 */
export interface RuntimeRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  deploymentService: DeploymentService;
  runtimeStatusService: RuntimeStatusService;
  /**
   * Direct repository access for the integration list/create/remove routes.
   * The DeploymentService facade does not currently expose list/remove
   * methods; the route uses the repository contract (re-exported from the
   * /runtime public barrel) for these operations. Wired by the composition
   * root from the same `PgRuntimeIntegrationRepository` instance handed to
   * the DeploymentService.
   */
  runtimeIntegrationRepository: RuntimeIntegrationRepository;
  /**
   * Direct repository access for the deployments list route. The
   * DeploymentService facade exposes only `getLatestDeployment`; this route
   * uses the repository's `findByIntegration` to enumerate the project's
   * recent deployments across all providers.
   */
  deploymentRepository: DeploymentRepository;
}

const VALID_PROVIDERS = new Set<string>(['vercel', 'fake']);
const VALID_DEPLOYMENT_STATUSES = new Set<DeploymentStatus>([
  'queued',
  'building',
  'ready',
  'error',
  'canceled',
]);

export async function runtimeRoutes(
  app: FastifyInstance,
  deps: RuntimeRouteDeps,
): Promise<void> {
  // POST /projects/:projectId/runtime/integrations — create a runtime
  // integration link (project ↔ deployment-provider). Body:
  // { provider, projectExternalId, metadata? }.
  //
  // This endpoint records a manually-established link — it does NOT call the
  // provider's createProject. Use POST .../runtime/deployments to record a
  // deployment against an existing integration.
  app.post('/projects/:projectId/runtime/integrations', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        provider?: string;
        projectExternalId?: string;
        metadata?: Record<string, unknown>;
      };
      if (!body?.provider || !body?.projectExternalId) {
        return reply
          .code(400)
          .send({ error: 'provider and projectExternalId required' });
      }
      if (!VALID_PROVIDERS.has(body.provider)) {
        return reply.code(400).send({
          error: 'invalid-provider',
          provider: body.provider,
          allowed: Array.from(VALID_PROVIDERS),
        });
      }
      const project = await deps.projectRepository.findById(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'project-not-found' });
      }
      const integration = await deps.runtimeIntegrationRepository.create({
        projectId,
        provider: body.provider,
        projectExternalId: body.projectExternalId,
        metadata: body.metadata,
      });
      return reply.code(201).send(integration);
    });
  });

  // GET /projects/:projectId/runtime/integrations — list integrations.
  app.get('/projects/:projectId/runtime/integrations', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const integrations: RuntimeIntegration[] =
        await deps.runtimeIntegrationRepository.findByProject(projectId);
      return { integrations };
    });
  });

  // DELETE /projects/:projectId/runtime/integrations/:integrationId — remove.
  app.delete(
    '/projects/:projectId/runtime/integrations/:integrationId',
    async (req, reply) => {
      return runAuthed(req, async () => {
        const { projectId, integrationId } = req.params as {
          projectId: string;
          integrationId: string;
        };
        await requireProjectAuthorization(req, reply, deps, {
          permission: 'project.admin',
          projectId,
        });
        // Verify the integration belongs to this project before removing
        // (defensive — a malicious caller could supply an integrationId from
        // another project; the repository is project-scoped via the row's
        // project_id, but the route enforces the authz check too).
        const integration = await deps.runtimeIntegrationRepository.findById(
          integrationId,
        );
        if (!integration || integration.projectId !== projectId) {
          return reply.code(404).send({ error: 'integration-not-found' });
        }
        await deps.runtimeIntegrationRepository.remove(integrationId);
        return reply.code(204).send();
      });
    },
  );

  // POST /projects/:projectId/runtime/deployments — record a deployment.
  app.post('/projects/:projectId/runtime/deployments', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as {
        provider?: string;
        externalId?: string;
        commitSha?: string;
        branch?: string;
        previewUrl?: string;
        status?: DeploymentStatus;
        metadata?: Record<string, unknown>;
      };
      if (!body?.provider || !body?.externalId) {
        return reply
          .code(400)
          .send({ error: 'provider and externalId required' });
      }
      if (body.status && !VALID_DEPLOYMENT_STATUSES.has(body.status)) {
        return reply.code(400).send({
          error: 'invalid-status',
          status: body.status,
          allowed: Array.from(VALID_DEPLOYMENT_STATUSES),
        });
      }
      const project = await deps.projectRepository.findById(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'project-not-found' });
      }
      try {
        const deployment = await deps.deploymentService.recordDeployment({
          projectId,
          provider: body.provider,
          externalId: body.externalId,
          status: body.status ?? 'ready',
          previewUrl: body.previewUrl,
          commitSha: body.commitSha,
          branch: body.branch,
          metadata: body.metadata,
        });
        return reply.code(201).send(deployment);
      } catch (err) {
        // The DeploymentService throws 'runtime-integration-not-found' when
        // no integration exists for (projectId, provider). Surface 409 so the
        // operator knows to create the integration first.
        const msg = (err as Error).message ?? '';
        if (msg.includes('runtime-integration-not-found')) {
          return reply.code(409).send({
            error: 'runtime-integration-not-found',
            projectId,
            provider: body.provider,
          });
        }
        return reply.code(502).send({
          error: 'runtime-deployment-record-failed',
          message: msg,
        });
      }
    });
  });

  // GET /projects/:projectId/runtime/deployments — list deployments across
  // all integrations linked to the project. Sorted newest-first.
  app.get('/projects/:projectId/runtime/deployments', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const integrations = await deps.runtimeIntegrationRepository.findByProject(
        projectId,
      );
      // For each integration, list its deployments (newest-first per the
      // repository's ORDER BY). Concatenate then re-sort to give a stable
      // newest-first view across providers.
      const lists = await Promise.all(
        integrations.map((i) => deps.deploymentRepository.findByIntegration(i.id)),
      );
      const deployments: Deployment[] = lists.flat().sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      return { deployments };
    });
  });

  // GET /projects/:projectId/runtime/deployments/latest — latest deployment.
  app.get(
    '/projects/:projectId/runtime/deployments/latest',
    async (req, reply) => {
      return runAuthed(req, async () => {
        const { projectId } = req.params as { projectId: string };
        await requireProjectAuthorization(req, reply, deps, {
          permission: 'project.read',
          projectId,
        });
        const deployment =
          await deps.deploymentService.getLatestDeployment(projectId);
        return { deployment };
      });
    },
  );

  // GET /projects/:projectId/runtime — aggregated ProjectRuntimeStatus.
  app.get('/projects/:projectId/runtime', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const status = await deps.runtimeStatusService.getStatus(projectId);
      return reply.code(200).send(status);
    });
  });

  // GET /projects/:projectId/runtime/providers — deployment provider health.
  app.get('/projects/:projectId/runtime/providers', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      // Health is provider-scoped (not project-scoped), but we still require
      // project.read so the endpoint is gated by authorization. Each
      // provider's health() returns 'connected' | 'not-configured' | 'error' |
      // 'test-mode'.
      const providers = await Promise.all(
        deps.deploymentService.listProviders().map(async (p) => ({
          name: p.name,
          status: await p.health(),
        })),
      );
      return { providers };
    });
  });
}
