import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type {
  ProjectRepository,
  ProjectRepositoryAssociationRepository,
  ProjectState,
} from '@modules/projects/index.js';
import {
  requireProjectAuthorization,
  requireOrganizationAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * Protected project routes demonstrating WORK-004 contracts (PROJ-AC-01..03).
 *
 * All routes are backend-authorized via the reusable {@link AuthorizationService}
 * (AUTHZ-AC-01..03). Frontend state is irrelevant.
 *
 * `POST /organizations/:orgId/projects` — create a project in an org. Requires
 *   the caller to be a member of that org with `project.write`.
 * `GET /projects/:projectId` — fetch a project. Requires `project.read`.
 * `PATCH /projects/:projectId` — update a project. Requires `project.write`.
 * `POST /projects/:projectId/transition` — transition lifecycle state.
 *   Requires `project.admin`.
 * `POST /projects/:projectId/repositories` — associate a repository (PROJ-AC-02).
 *   Requires `project.admin`.
 * `GET /projects/:projectId/repositories` — list associations. Requires `project.read`.
 */
export interface ProjectsRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  repositoryAssociationRepository: ProjectRepositoryAssociationRepository;
}

const VALID_STATES: ProjectState[] = ['active', 'archived'];

export async function projectsRoutes(app: FastifyInstance, deps: ProjectsRouteDeps): Promise<void> {
  // Create a project in an organization. The caller MUST be a member of the
  // requested organization with the `project.write` permission. Authorized
  // through the reusable AuthorizationService.authorizeForOrganization — no
  // synthetic project id, no ad-hoc membership logic (architect review PR #5).
  app.post('/organizations/:orgId/projects', async (req, reply) => {
    return runAuthed(req, async () => {
      const { orgId } = req.params as { orgId: string };
      await requireOrganizationAuthorization(req, reply, deps, {
        permission: 'project.write',
        organizationId: orgId,
      });
      const body = req.body as { name?: string; metadata?: Record<string, unknown> };
      if (!body?.name) {
        return reply.code(400).send({ error: 'name required' });
      }
      const project = await deps.projectRepository.create({
        organizationId: orgId,
        name: body.name,
        metadata: body.metadata,
      });
      return reply.code(201).send(project);
    });
  });

  app.get('/projects/:projectId', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const project = await deps.projectRepository.findById(projectId);
      if (!project) return reply.code(404).send({ error: 'not-found' });
      return { ...project, accessedBy: user.id };
    });
  });

  app.patch('/projects/:projectId', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.write',
        projectId,
      });
      const body = req.body as { name?: string; metadata?: Record<string, unknown> };
      const updated = await deps.projectRepository.update(projectId, {
        name: body?.name,
        metadata: body?.metadata,
      });
      if (!updated) return reply.code(404).send({ error: 'not-found' });
      return updated;
    });
  });

  app.post('/projects/:projectId/transition', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.admin',
        projectId,
      });
      const body = req.body as { to?: string };
      if (!body?.to || !VALID_STATES.includes(body.to as ProjectState)) {
        return reply.code(400).send({ error: 'invalid state', validStates: VALID_STATES });
      }
      try {
        const result = await deps.projectRepository.transitionState(
          projectId,
          body.to as ProjectState,
        );
        return result;
      } catch (err) {
        return reply.code(409).send({ error: 'invalid-transition', message: (err as Error).message });
      }
    });
  });

  app.post('/projects/:projectId/repositories', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.admin',
        projectId,
      });
      const body = req.body as {
        provider?: string;
        externalId?: string;
        canonicalRef?: string;
        metadata?: Record<string, unknown>;
      };
      if (!body?.provider || !body?.externalId || !body?.canonicalRef) {
        return reply.code(400).send({ error: 'provider, externalId, canonicalRef required' });
      }
      const assoc = await deps.repositoryAssociationRepository.associate({
        projectId,
        provider: body.provider,
        externalId: body.externalId,
        canonicalRef: body.canonicalRef,
        metadata: body.metadata,
      });
      return reply.code(201).send(assoc);
    });
  });

  app.get('/projects/:projectId/repositories', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      const list = await deps.repositoryAssociationRepository.listForProject(projectId);
      return { repositories: list };
    });
  });
}
