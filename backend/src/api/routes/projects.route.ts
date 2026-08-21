import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * Protected project route demonstrating backend authorization (AUTHZ-AC-01..03).
 *
 * `GET /projects/:projectId` requires the `project.read` permission on the
 * requested project. The decision is made server-side by the
 * {@link AuthorizationService}; frontend state is irrelevant (AUTHZ-AC-03).
 *
 * A cross-tenant request (User A requesting Project B owned by Org B) is
 * rejected with 403 even though the project exists (AUTHZ-AC-02).
 */
export interface ProjectsRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
}

export async function projectsRoutes(app: FastifyInstance, deps: ProjectsRouteDeps): Promise<void> {
  app.get('/projects/:projectId', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    return runAuthed(req, async () => {
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const project = await deps.projectRepository.findById(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'not-found' });
      }
      return {
        id: project.id,
        organizationId: project.organizationId,
        name: project.name,
        accessedBy: user.id,
      };
    });
  });
}
