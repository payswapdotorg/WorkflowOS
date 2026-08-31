import type { FastifyInstance } from 'fastify';
import { buildServer } from '@api/server.js';
import { InMemoryQueue } from '@platform/index.js';
import type { AuthPluginDeps } from '../../src/api/plugins/auth.plugin.js';
import type { AuthRouteDeps } from '../../src/api/routes/auth.route.js';
import type { OrganizationsRouteDeps } from '../../src/api/routes/organizations.route.js';
import type { TestIdentityStack } from './test-identity-stack.js';

/**
 * WORK-074: build the REAL Fastify server with the identity runtime wired
 * exactly the way the composition root wires it (auth plugin + the /auth
 * identity routes + the /organizations membership routes + the protected
 * /projects routes) on top of the identity test stack.
 *
 * The heavier product routes (workbench, specifications, …) are intentionally
 * absent — the identity suites exercise the identity surface.
 */
export function buildAuthPluginDeps(stack: TestIdentityStack): AuthPluginDeps {
  return {
    authProvider: stack.authProvider,
    userRepository: stack.userRepository,
    sessionAuthProvider: stack.sessionAuthProvider,
    sessionCookieName: 'wfos_session',
  };
}

/** The /auth identity-route deps for a stack (shared by the E2E specs). */
export function buildIdentityRouteDeps(stack: TestIdentityStack): AuthRouteDeps {
  return {
    sessionService: stack.sessionService,
    passwordCredentials: stack.passwordCredentials,
    identityResolution: stack.identityResolution,
    oauthProviders: stack.oauthProviders.adapters,
    oauthStateStore: stack.oauthStateStore,
    machineIdentity: stack.machineIdentity,
    authorizationService: stack.authorizationService,
    membershipRepository: stack.membershipRepository,
    userRepository: stack.userRepository,
    audit: stack.auditService,
    publicUrl: 'http://localhost:5173',
  };
}

/** The /organizations membership-route deps for a stack (shared by the E2E specs). */
export function buildOrganizationsRouteDeps(stack: TestIdentityStack): OrganizationsRouteDeps {
  return {
    membershipRepository: stack.membershipRepository,
    organizationRepository: stack.organizationRepository,
    userRepository: stack.userRepository,
    authorizationService: stack.authorizationService,
    audit: stack.auditService,
  };
}

export async function buildIdentityTestServer(stack: TestIdentityStack): Promise<FastifyInstance> {
  const authDeps: AuthPluginDeps = buildAuthPluginDeps(stack);
  const identityDeps: AuthRouteDeps = buildIdentityRouteDeps(stack);
  const organizationsDeps: OrganizationsRouteDeps = buildOrganizationsRouteDeps(stack);
  return buildServer({
    // ServerDeps requires the queue/logger pair (the jobs routes' deps) — the
    // identity suites use the in-memory queue + the harness capture logger.
    queue: new InMemoryQueue(),
    logger: stack.db.logger,
    auth: authDeps,
    identity: identityDeps,
    organizations: organizationsDeps,
    projects: {
      authorizationService: stack.authorizationService,
      projectRepository: stack.projectRepository,
      repositoryAssociationRepository: stack.repositoryAssociationRepository,
      projectAccessRepository: stack.projectAccessRepository,
      organizationRepository: stack.organizationRepository,
      membershipRepository: stack.membershipRepository,
    },
  });
}
