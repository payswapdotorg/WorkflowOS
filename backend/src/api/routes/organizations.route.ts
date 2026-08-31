import type { FastifyInstance } from 'fastify';
import type { AuthorizationService } from '@modules/auth/index.js';
import type { AuditEventWriter } from '@modules/audit/index.js';
import type {
  MembershipRepository,
  OrganizationRepository,
} from '@modules/organizations/index.js';
import type { UserRepository } from '@modules/users/index.js';
import {
  requireOrganizationAuthorization,
  requireUser,
  runAuthed,
} from '../plugins/auth.plugin.js';

/**
 * WORK-074 — organization membership management (the "organization onboarding
 * and membership/role enforcement" surface of the WORK-063 self-hosting
 * journey: sign in → create organization → invite developers).
 *
 * Authorization: every route requires the caller to be a member of the
 * organization with the `org.members` permission — decided by the SAME
 * AuthorizationService (AUTHZ-AC-01..03). Machine principals are denied
 * fail-closed (organization management is a human surface).
 *
 * Audit: membership/role changes are recorded on the /audit surface
 * (identity.membership.assigned / identity.membership.removed) — WORK-063
 * invariant #12.
 *
 * Routes:
 *   POST /organizations/:orgId/members   { userId, roleId } — assign a role
 *   GET  /organizations/:orgId/members   — list memberships
 *   DELETE /organizations/:orgId/members/:userId — remove a membership
 *
 * Note: organization CREATION is open to any authenticated human (the
 * self-hosting journey: after signing up, the user creates their
 * organization). It creates the org and assigns the creator the `owner` role.
 */
export interface OrganizationsRouteDeps {
  membershipRepository: MembershipRepository;
  organizationRepository: OrganizationRepository;
  userRepository: UserRepository;
  authorizationService: AuthorizationService;
  audit: AuditEventWriter;
}

const VALID_ROLES = new Set(['owner', 'admin', 'member']);

export async function organizationsRoutes(app: FastifyInstance, deps: OrganizationsRouteDeps): Promise<void> {
  // POST /organizations — create an organization (authenticated humans only).
  // The creator becomes its `owner` (the WORK-063 onboarding journey step 2).
  app.post('/organizations', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const body = req.body as { name?: string } | null;
      if (!body?.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
        return reply.code(400).send({ error: 'name required' });
      }
      const org = await deps.organizationRepository.create({ name: body.name.trim() });
      await deps.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
      await deps.audit.write({
        eventType: 'identity.membership.assigned',
        actor: user.id,
        source: 'auth',
        resourceType: 'organization_membership',
        resourceId: `${org.id}:${user.id}`,
        organizationId: org.id,
        metadata: { roleId: 'owner', reason: 'organization-creation' },
      });
      return reply.code(201).send({ organization: org, roleId: 'owner' });
    });
  });

  // POST /organizations/:orgId/members — assign a member a role (org.members).
  app.post('/organizations/:orgId/members', async (req, reply) => {
    return runAuthed(req, async () => {
      const actor = await requireOrganizationAuthorization(req, reply, deps, {
        permission: 'org.members',
        organizationId: (req.params as { orgId: string }).orgId,
      });
      const { orgId } = req.params as { orgId: string };
      const body = req.body as { userId?: string; roleId?: string } | null;
      if (!body?.userId || !body?.roleId) {
        return reply.code(400).send({ error: 'userId and roleId required' });
      }
      if (!VALID_ROLES.has(body.roleId)) {
        return reply.code(400).send({ error: 'invalid-role', validRoles: [...VALID_ROLES] });
      }
      const target = await deps.userRepository.findById(body.userId);
      if (!target) return reply.code(404).send({ error: 'user-not-found' });
      try {
        const membership = await deps.membershipRepository.assign({
          userId: target.id,
          organizationId: orgId,
          roleId: body.roleId,
        });
        await deps.audit.write({
          eventType: 'identity.membership.assigned',
          actor: actor.id,
          source: 'auth',
          resourceType: 'organization_membership',
          resourceId: membership.id,
          organizationId: orgId,
          metadata: { userId: target.id, roleId: body.roleId },
        });
        return reply.code(201).send(membership);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('duplicate key') || message.includes('unique')) {
          return reply.code(409).send({ error: 'already-a-member' });
        }
        throw err;
      }
    });
  });

  // GET /organizations/:orgId/members — list memberships (org.members).
  app.get('/organizations/:orgId/members', async (req, reply) => {
    return runAuthed(req, async () => {
      const { orgId } = req.params as { orgId: string };
      await requireOrganizationAuthorization(req, reply, deps, {
        permission: 'org.members',
        organizationId: orgId,
      });
      const memberships = await deps.membershipRepository.listForOrganization(orgId);
      const members = await Promise.all(
        memberships.map(async (m) => {
          const user = await deps.userRepository.findById(m.userId);
          return {
            userId: m.userId,
            displayName: user?.displayName ?? null,
            email: user?.email ?? null,
            roleId: m.roleId,
            createdAt: m.createdAt,
          };
        }),
      );
      return { members };
    });
  });

  // DELETE /organizations/:orgId/members/:userId — remove a membership (org.members).
  app.delete('/organizations/:orgId/members/:userId', async (req, reply) => {
    return runAuthed(req, async () => {
      const actor = await requireOrganizationAuthorization(req, reply, deps, {
        permission: 'org.members',
        organizationId: (req.params as { orgId: string }).orgId,
      });
      const { orgId, userId } = req.params as { orgId: string; userId: string };
      const removed = await deps.membershipRepository.remove(userId, orgId);
      if (!removed) return reply.code(404).send({ error: 'not-found' });
      await deps.audit.write({
        eventType: 'identity.membership.removed',
        actor: actor.id,
        source: 'auth',
        resourceType: 'organization_membership',
        resourceId: `${orgId}:${userId}`,
        organizationId: orgId,
        metadata: { userId },
      });
      return reply.code(204).send();
    });
  });
}
