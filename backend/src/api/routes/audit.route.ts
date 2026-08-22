import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { ArchitectureRepository, ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
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
  architectureRepository: ArchitectureRepository;
  architectureVersionRepository: ArchitectureVersionRepository;
  workItemRepository: WorkItemRepository;
  auditQuery: AuditEventQuery;
}

async function resolveProjectForWorkItem(
  deps: AuditRouteDeps,
  workItemId: string,
): Promise<string | null> {
  const wi = await deps.workItemRepository.findById(workItemId);
  if (!wi) return null;
  const version = await deps.architectureVersionRepository.findById(wi.architectureVersionId);
  if (!version) return null;
  const arch = await deps.architectureRepository.findById(version.architectureId);
  return arch?.projectId ?? null;
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
  //
  // WORK-020 correction (PR #19 issue 2): resolve the authoritative project
  // from the work item → architecture_version → architecture → project chain
  // BEFORE returning any results (including empty results). This prevents
  // unauthorized access: a user without project access cannot discover whether
  // a work item has audit events.
  app.get('/work-items/:workItemId/audit', async (req, reply) => {
    return runAuthed(req, async () => {
      const { workItemId } = req.params as { workItemId: string };
      // Resolve the project from the work item chain.
      const projectId = await resolveProjectForWorkItem(deps, workItemId);
      if (!projectId) {
        return reply.code(404).send({ error: 'work-item-not-found' });
      }
      // Authorize BEFORE querying — even if there are no audit events,
      // the caller must have project.read permission.
      await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read', projectId,
      });
      const events = await deps.auditQuery.listForWorkItem(workItemId);
      return reply.code(200).send(events);
    });
  });
}
