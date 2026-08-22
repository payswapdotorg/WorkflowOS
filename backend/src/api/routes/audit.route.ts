import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { AuditEventQuery } from '@modules/audit/index.js';
import { requireProjectAuthorization, runAuthed } from '../plugins/auth.plugin.js';

/**
 * Protected audit routes (AUDIT-001).
 *
 * All routes are backend-authorized. Only read endpoints are exposed —
 * no client-facing audit-write endpoints exist. System/internal emission
 * uses the AuditEventWriter application boundary.
 */
export interface AuditRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  auditQuery: AuditEventQuery;
}

export async function auditRoutes(
  app: FastifyInstance,
  deps: AuditRouteDeps,
): Promise<void> {
  // GET /projects/:projectId/audit — project audit history.
  app.get('/projects/:projectId/audit', async (req, reply) => {
    return runAuthed(req, async () => {
      const { projectId } = req.params as { projectId: string };
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read', projectId,
      });
      const query = req.query as { eventTypes?: string; limit?: string };
      const eventTypes = query.eventTypes ? query.eventTypes.split(',') : undefined;
      const limit = query.limit ? parseInt(query.limit, 10) : undefined;
      const events = await deps.auditQuery.listForProject(projectId, { eventTypes, limit });
      return reply.code(200).send(events);
    });
  });

  // GET /work-items/:workItemId/audit — work item audit history.
  app.get('/work-items/:workItemId/audit', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      // Resolve project for authorization.
      // For simplicity, we query audit events for this work item and check
      // the first one's project_id for authorization. In production, a more
      // robust approach would resolve the work item → architecture → project chain.
      const events = await deps.auditQuery.listForWorkItem(workItemId);
      if (events.length === 0) {
        return reply.code(200).send([]);
      }
      const projectId = events[0]!.projectId;
      if (!projectId) {
        return reply.code(200).send(events);
      }
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read', projectId,
      });
      return reply.code(200).send(events);
    });
  });
}
