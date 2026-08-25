/**
 * WORK-037: Agent-policy routes — the HTTP surface for the agent-capability
 * policy authority.
 *
 * All routes are backend-authorized. The engine NEVER imports the
 * authorization service — only THIS ROUTE LAYER calls
 * requireProjectAuthorization to gate WHICH USERS may mutate policy
 * documents / resolve approvals (project authorization, WORK-002). The
 * engine decides WHAT AGENTS MAY DO. These are two separate concerns; the
 * route is the only place they meet (the one-way dependency invariant).
 *
 * Routes NEVER accept `actor`/`userId`/`createdBy` from the request body —
 * they are derived server-side from the authenticated
 * requireProjectAuthorization user (§27, the PR #35 fix #5 pattern).
 *
 * Routes:
 *   GET    /projects/:projectId/agent-policy                      — effective policy (project → org → platform default)
 *   PUT    /projects/:projectId/agent-policy                      — set project override (project.admin)
 *   DELETE /projects/:projectId/agent-policy                      — remove project override (project.admin)
 *   GET    /organizations/:organizationId/agent-policy            — org default (project.read on any project OR org auth)
 *   PUT    /organizations/:organizationId/agent-policy            — set org default (project.admin scoped to org)
 *   DELETE /organizations/:organizationId/agent-policy            — remove org default (project.admin scoped to org)
 *   GET    /projects/:projectId/agent-policy/approvals            — list approvals (?status=pending|approved|denied|expired)
 *   POST   /projects/:projectId/agent-policy/approvals/:approvalId/resolve  — resolve (action: approve|deny) (project.admin)
 *
 * SECURITY: no route ever returns credentials. The policy document is rule
 * selectors + effects + reasons (no secrets). Approvals carry only subject
 * identifiers + resolution identity (no secrets).
 */
import type { FastifyInstance } from 'fastify';
import type { ProjectRepository } from '@modules/projects/index.js';
import type { AuthorizationService } from '@modules/auth/index.js';
import type {
  AgentPolicyApprovalStatus,
  AgentPolicyDocument,
  AgentPolicyService,
} from '@modules/agents/index.js';
import { AgentPolicyError } from '@modules/agents/index.js';
import {
  requireOrganizationAuthorization,
  requireProjectAuthorization,
  runAuthed,
} from '../plugins/auth.plugin.js';

export interface AgentPolicyRouteDeps {
  authorizationService: AuthorizationService;
  projectRepository: ProjectRepository;
  agentPolicyEngine: AgentPolicyService;
}

export async function agentPolicyRoutes(app: FastifyInstance, deps: AgentPolicyRouteDeps): Promise<void> {
  const { agentPolicyEngine } = deps;

  // --- effective policy (project-scoped; the resolved document + version) ---

  app.get('/projects/:projectId/agent-policy', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      if (!user) return;
      const org = await resolveOrgForProject(deps, projectId);
      if (!org) return reply.code(404).send({ error: 'not-found', reason: 'project-missing' });
      const policy = await agentPolicyEngine.getEffectivePolicy(org, projectId);
      return { policy };
    });
  });

  app.put('/projects/:projectId/agent-policy', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.admin',
        projectId,
      });
      if (!user) return;
      const org = await resolveOrgForProject(deps, projectId);
      if (!org) return reply.code(404).send({ error: 'not-found', reason: 'project-missing' });
      const document = (req.body as { document?: AgentPolicyDocument } | null)?.document;
      if (!document) {
        return reply.code(400).send({ error: 'invalid-document', message: 'body must contain a `document` field' });
      }
      try {
        const policy = await agentPolicyEngine.setProjectPolicy({ organizationId: org, projectId, document, userId: user.id });
        return { policy };
      } catch (err) {
        return mapPolicyError(reply, err);
      }
    });
  });

  app.delete('/projects/:projectId/agent-policy', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.admin',
        projectId,
      });
      if (!user) return;
      const org = await resolveOrgForProject(deps, projectId);
      if (!org) return reply.code(404).send({ error: 'not-found', reason: 'project-missing' });
      const removed = await agentPolicyEngine.clearProjectPolicy(org, projectId, user.id);
      return { removed };
    });
  });

  // --- organization default ---

  app.get('/organizations/:organizationId/agent-policy', async (req, reply) => {
    return runAuthed(req, async () => {
      const organizationId = (req.params as { organizationId?: string } | null)?.organizationId ?? '';
      await requireOrganizationAuthorization(req, reply, deps, {
        permission: 'project.read',
        organizationId,
      });
      const policy = await agentPolicyEngine.getOrganizationPolicy(organizationId);
      return { policy };
    });
  });

  app.put('/organizations/:organizationId/agent-policy', async (req, reply) => {
    return runAuthed(req, async () => {
      const organizationId = (req.params as { organizationId?: string } | null)?.organizationId ?? '';
      const user = await requireOrganizationAuthorization(req, reply, deps, {
        permission: 'project.admin',
        organizationId,
      });
      const document = (req.body as { document?: AgentPolicyDocument } | null)?.document;
      if (!document) {
        return reply.code(400).send({ error: 'invalid-document', message: 'body must contain a `document` field' });
      }
      try {
        const policy = await agentPolicyEngine.setOrganizationPolicy({ organizationId, document, userId: user.id });
        return { policy };
      } catch (err) {
        return mapPolicyError(reply, err);
      }
    });
  });

  app.delete('/organizations/:organizationId/agent-policy', async (req, reply) => {
    return runAuthed(req, async () => {
      const organizationId = (req.params as { organizationId?: string } | null)?.organizationId ?? '';
      const user = await requireOrganizationAuthorization(req, reply, deps, {
        permission: 'project.admin',
        organizationId,
      });
      const removed = await agentPolicyEngine.clearOrganizationPolicy(organizationId, user.id);
      return { removed };
    });
  });

  // --- approvals (the ASK interaction) ---

  app.get('/projects/:projectId/agent-policy/approvals', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.read',
        projectId,
      });
      if (!user) return;
      const status = (req.query as { status?: string } | null)?.status as AgentPolicyApprovalStatus | undefined;
      const approvals = await agentPolicyEngine.listApprovals(projectId, status);
      return { approvals };
    });
  });

  app.post('/projects/:projectId/agent-policy/approvals/:approvalId/resolve', async (req, reply) => {
    return runAuthed(req, async () => {
      const projectId = (req.params as { projectId?: string } | null)?.projectId ?? '';
      const approvalId = (req.params as { approvalId?: string } | null)?.approvalId ?? '';
      const user = await requireProjectAuthorization(req, reply, deps, {
        permission: 'project.admin',
        projectId,
      });
      if (!user) return;
      // Verify the approval belongs to THIS project before resolving — a
      // project.admin on project A must not resolve an approval for project B.
      const approval = await agentPolicyEngine.getApproval(approvalId);
      if (!approval || approval.projectId !== projectId) {
        return reply.code(404).send({ error: 'approval-not-found', message: `approval ${approvalId} does not exist on this project` });
      }
      const body = (req.body as { action?: string; note?: string } | null) ?? {};
      if (body.action !== 'approve' && body.action !== 'deny') {
        return reply.code(400).send({ error: 'invalid-action', message: "body.action must be 'approve' | 'deny'" });
      }
      try {
        const resolved = await agentPolicyEngine.resolveApproval({
          approvalId,
          action: body.action,
          userId: user.id,
          note: typeof body.note === 'string' ? body.note : undefined,
        });
        return { approval: resolved };
      } catch (err) {
        return mapPolicyError(reply, err);
      }
    });
  });
}

async function resolveOrgForProject(deps: AgentPolicyRouteDeps, projectId: string): Promise<string | null> {
  const project = await deps.projectRepository.findById(projectId);
  return project?.organizationId ?? null;
}

function mapPolicyError(reply: import('fastify').FastifyReply, err: unknown): import('fastify').FastifyReply {
  const e = err as AgentPolicyError;
  const message = (err as Error).message;
  switch (e.code) {
    case 'agent-policy-invalid-document':
      return reply.code(400).send({ error: 'invalid-document', message });
    case 'agent-policy-approval-not-found':
      return reply.code(404).send({ error: 'approval-not-found', message });
    case 'agent-policy-approval-already-resolved':
      return reply.code(409).send({ error: 'approval-already-resolved', message });
    case 'agent-policy-approval-not-pending':
      return reply.code(409).send({ error: 'approval-not-pending', message });
    case 'agent-policy-scope-unresolvable':
      return reply.code(404).send({ error: 'scope-unresolvable', message });
    default:
      return reply.code(500).send({ error: 'agent-policy-error', message });
  }
}
