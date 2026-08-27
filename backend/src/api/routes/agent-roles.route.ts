/**
 * WORK-045: Agent-roles routes — the read-only HTTP surface for the
 * provider-independent role catalog:
 *
 *   GET /projects/:projectId/agent-roles          — the closed catalog in
 *        the declared deterministic order (W045-AC03), each role with its
 *        declaration semantics (W045-AC13).
 *   GET /projects/:projectId/agent-roles/:roleId  — resolve ONE role by its
 *        stable identity (deterministic; unknown identity → 404).
 *
 * All routes are backend-authorized (project.read within the caller's
 * project context — W045-AC11: request-scoped resolution stays inside the
 * authorized project/organization context; the catalog itself is global,
 * context-free truth that no tenant metadata can affect).
 *
 * The route layer is the ONLY place authorization meets the catalog (the
 * one-way dependency invariant): the role domain imports no authorization,
 * no repository, and no request context. Routes are READ-ONLY — role
 * resolution is advisory/configuration and never mutates workflow state
 * (W045-AC07), never dispatches, and never evaluates anything.
 *
 * SECURITY: no route ever returns credentials, tokens, or cookies (the
 * catalog contains none — structurally).
 */
import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { AgentRoleCatalogService } from '../../agent-roles/index.js';
import {
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

export interface AgentRolesRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  agentRoleCatalogService: AgentRoleCatalogService;
}

export async function agentRolesRoutes(app: FastifyInstance, deps: AgentRolesRouteDeps): Promise<void> {
  const { agentRoleCatalogService } = deps;

  // --- the closed catalog (declared deterministic order — W045-AC03) ------

  app.get('/projects/:projectId/agent-roles', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      if (!user) return;
      const project = await deps.projectRepository.findById(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'not-found', reason: 'project-missing' });
      }
      // Advisory read: role resolution mutates nothing (W045-AC07/AC08).
      return { roles: agentRoleCatalogService.listRoles() };
    });
  });

  // --- resolve ONE role by stable identity (W045-AC03) ----------------------

  app.get('/projects/:projectId/agent-roles/:roleId', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const roleId = (req.params as { roleId?: string } | null)?.roleId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      if (!user) return;
      const project = await deps.projectRepository.findById(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'not-found', reason: 'project-missing' });
      }
      const resolution = agentRoleCatalogService.resolveRole(roleId);
      if (!resolution) {
        // The closed catalog has NO fallback role: an unknown identity is a
        // 404, never a nearest-match guess (deterministic fail-safe).
        return reply.code(404).send({
          error: 'role-not-found',
          reason: 'unknown-role-identity',
          roleId,
        });
      }
      return { role: resolution.role, declarationSemantics: resolution.declarationSemantics };
    });
  });
}
