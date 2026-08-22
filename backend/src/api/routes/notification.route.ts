import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type { NotificationService } from '@modules/notifications/index.js';
import { requireProjectAuthorization, runAuthed } from '../plugins/auth.plugin.js';

export interface NotificationRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  workItemRepository: WorkItemRepository;
  notificationService: NotificationService;
}

async function resolveProjectForWorkItem(
  deps: NotificationRouteDeps,
  workItemId: string,
): Promise<string | null> {
  const wi = await deps.workItemRepository.findById(workItemId);
  if (!wi) return null;
  const version = await deps.architectureVersionRepository.findById(wi.architectureVersionId);
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  return arch?.projectId ?? null;
}

export async function notificationRoutes(
  app: FastifyInstance,
  deps: NotificationRouteDeps,
): Promise<void> {
  // GET /projects/:projectId/notifications — list notifications for a project.
  app.get('/projects/:projectId/notifications', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read', projectId,
      });
      const notifications = await deps.notificationService.listForProject(projectId);
      return reply.code(200).send(notifications);
    });
  });

  // GET /work-items/:workItemId/notifications — list notifications for a work item.
  app.get('/work-items/:workItemId/notifications', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read', projectId,
      });
      const notifications = await deps.notificationService.listForWorkItem(workItemId);
      return reply.code(200).send(notifications);
    });
  });
}
