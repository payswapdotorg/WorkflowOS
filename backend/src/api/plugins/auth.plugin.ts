import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthProvider, AuthorizationService, AuthenticatedPrincipal, MachinePrincipalContext } from '@modules/auth/index.js';
import type { User, UserRepository } from '@modules/users/index.js';
import { runWithExecutionContext } from '@platform/execution-context.js';

/**
 * Fastify authentication plugin (AUTH-001, AUTH-AC-02).
 *
 * Resolves inbound credentials to an {@link AuthenticatedPrincipal} and — for
 * HUMAN principals — to a persisted WorkflowOS {@link User}. Rejects
 * unauthenticated requests with 401 at the route layer. Does NOT make
 * authorization decisions — that is the {@link AuthorizationService}'s job
 * (AUTHZ-AC-01..03).
 *
 * WORK-074 credential paths (in priority order):
 *   1. `Authorization: Bearer <key>` / `X-API-Key` — the API-key provider
 *      (automation; legacy human-principal keys AND scoped machine keys).
 *   2. The HttpOnly `wfos_session` cookie — the server-side session provider
 *      (the human login: password or OAuth under the /auth routes).
 *
 * Machine principals (scoped service-account keys) are attached to the request
 * as `req.machinePrincipal` and NEVER resolved to a user: a machine principal
 * is not a human user (WORK-063 invariant #3). Routes decide per-surface
 * whether a machine principal may act (through the SAME AuthorizationService).
 *
 * The resolved user is attached to the request as `req.user` (or `null` when
 * unauthenticated). Routes that require authentication use
 * {@link requireUser}; routes that require authorization use
 * {@link requireAuthorization}.
 */
export interface AuthPluginDeps {
  /** API-key credential verification (legacy + scoped machine keys). */
  authProvider: AuthProvider;
  userRepository: UserRepository;
  /**
   * WORK-074: when present, the HttpOnly session cookie is verified through
   * this provider and the request is authenticated as the session's user.
   */
  sessionAuthProvider?: AuthProvider;
  /** WORK-074: session cookie name (default `wfos_session`). */
  sessionCookieName?: string;
}

export const DEFAULT_SESSION_COOKIE_NAME = 'wfos_session';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthenticatedPrincipal | null;
    user?: User | null;
    /** WORK-074: present ONLY for scoped machine principals (never for humans). */
    machinePrincipal?: MachinePrincipalContext | null;
  }
}

export async function authPlugin(app: FastifyInstance, deps: AuthPluginDeps): Promise<void> {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = extractApiKey(req);
    if (raw) {
      const result = await deps.authProvider.authenticate(raw);
      if (result.kind !== 'principal') {
        req.principal = null;
        req.user = null;
        req.machinePrincipal = null;
        // Don't 401 here — let the route decide whether auth is required.
        // Routes that require auth will call requireUser which 401s.
        void reply;
        return;
      }
      req.principal = result.principal;
      if (result.principal.machine) {
        // MACHINE principal: never a human user; no wfos_users resolution.
        req.user = null;
        req.machinePrincipal = result.principal.machine;
        return;
      }
      req.machinePrincipal = null;
      // Resolve the principal to a persisted WorkflowOS user (AUTH-AC-01).
      const user = await deps.userRepository.upsertByExternalId({
        externalId: result.principal.externalId,
        displayName: result.principal.label,
      });
      req.user = user;
      return;
    }

    // WORK-074: the session-cookie path (server-side sessions).
    const sessionToken = extractSessionToken(req, deps.sessionCookieName ?? DEFAULT_SESSION_COOKIE_NAME);
    if (sessionToken && deps.sessionAuthProvider) {
      const sessionResult = await deps.sessionAuthProvider.authenticate(sessionToken);
      if (sessionResult.kind === 'principal' && sessionResult.principal.session) {
        req.principal = sessionResult.principal;
        req.machinePrincipal = null;
        const user = await deps.userRepository.findById(sessionResult.principal.session.userId);
        req.user = user ?? null;
        return;
      }
      // Invalid/expired/revoked session: treat as unauthenticated (typed
      // 401s with the reason are produced by the /auth session routes; other
      // protected routes simply 401).
    }

    req.principal = null;
    req.user = null;
    req.machinePrincipal = null;
  });
}

/** Extract a raw API key from request headers. */
function extractApiKey(req: FastifyRequest): string | null {
  const bearer = req.headers.authorization;
  if (typeof bearer === 'string' && bearer.toLowerCase().startsWith('bearer ')) {
    return bearer.slice(7).trim() || null;
  }
  const xKey = req.headers['x-api-key'];
  if (typeof xKey === 'string' && xKey.length > 0) return xKey;
  return null;
}

/** Extract the session token from the HttpOnly cookie header (WORK-074). */
function extractSessionToken(req: FastifyRequest, cookieName: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === cookieName) {
      const value = rest.join('=');
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/**
 * Route helper: require an authenticated HUMAN user. Sends 401 if absent.
 * A machine principal is NOT a human user and does not satisfy this guard
 * (WORK-063 invariant #3).
 * Returns the user when present so the route can use it.
 */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<User> {
  if (!req.user) {
    await reply.code(401).send({ error: 'unauthenticated' });
    throw new Error('unauthenticated');
  }
  return req.user;
}

export interface RequireAuthorizationDeps {
  authorizationService: AuthorizationService;
}

/**
 * Route helper: require an authorization decision for a project resource.
 * Sends 403 when denied. Backend-owned — frontend checks are irrelevant
 * (AUTHZ-AC-03).
 *
 * WORK-074: when the request carries a MACHINE principal, the decision goes
 * through the SAME AuthorizationService's machine path — the route must
 * declare the machine `capability` that guards the surface; undeclared →
 * typed fail-closed denial (machine access requires explicit opt-in).
 * The `input.machineCapability` is IGNORED for human users (their decisions
 * remain the unchanged membership → role → permission → project-access chain).
 */
export async function requireProjectAuthorization(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: RequireAuthorizationDeps,
  input: { permission: string; projectId: string; machineCapability?: string },
): Promise<User> {
  if (req.machinePrincipal) {
    const authorizeMachine = deps.authorizationService.authorizeForMachinePrincipal?.bind(
      deps.authorizationService,
    );
    if (typeof authorizeMachine !== 'function') {
      await reply.code(403).send({
        error: 'forbidden',
        reason: 'capability-not-granted',
        permission: input.permission,
        projectId: input.projectId,
      });
      throw new Error('forbidden');
    }
    const machineDecision = await authorizeMachine({
      principal: req.machinePrincipal,
      capability: input.machineCapability,
      permission: input.permission,
      resource: { kind: 'project', projectId: input.projectId },
    });
    if (!machineDecision.allowed) {
      await reply.code(403).send({
        error: 'forbidden',
        reason: machineDecision.deniedReason ?? 'capability-not-granted',
        permission: input.permission,
        projectId: input.projectId,
      });
      throw new Error('forbidden');
    }
    // Machine decisions do not resolve to a wfos_users row. Routes that only
    // read `.id` off the return value (audit metadata, response attribution)
    // get a clearly machine-namespaced ACTOR — never a persisted user.
    return machineActor(req.machinePrincipal);
  }

  const user = await requireUser(req, reply);
  const decision = await deps.authorizationService.authorize({
    user,
    permission: input.permission,
    resource: { kind: 'project', projectId: input.projectId },
  });
  if (!decision.allowed) {
    await reply.code(403).send({
      error: 'forbidden',
      reason: decision.deniedReason,
      permission: input.permission,
      projectId: input.projectId,
    });
    throw new Error('forbidden');
  }
  return user;
}

/**
 * Route helper: require an authorization decision for an organization-level
 * operation (e.g. creating a project within an org). Sends 403 when denied.
 * Uses the reusable {@link AuthorizationService.authorizeForOrganization} —
 * no synthetic project id, no ad-hoc membership logic.
 *
 * WORK-074: organization-level MANAGEMENT is a human surface — machine
 * principals are denied fail-closed with a typed reason (they have no
 * membership chain and no organizational capabilities in the closed set).
 */
export async function requireOrganizationAuthorization(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: RequireAuthorizationDeps,
  input: { permission: string; organizationId: string },
): Promise<User> {
  if (req.machinePrincipal) {
    await reply.code(403).send({
      error: 'forbidden',
      reason: 'capability-not-granted',
      permission: input.permission,
      organizationId: input.organizationId,
    });
    throw new Error('forbidden');
  }
  const user = await requireUser(req, reply);
  const decision = await deps.authorizationService.authorizeForOrganization({
    user,
    permission: input.permission,
    organizationId: input.organizationId,
  });
  if (!decision.allowed) {
    await reply.code(403).send({
      error: 'forbidden',
      reason: decision.deniedReason,
      permission: input.permission,
      organizationId: input.organizationId,
    });
    throw new Error('forbidden');
  }
  return user;
}

/**
 * The machine ACTOR object returned by the authorization guards for machine
 * principals. NOT a persisted user — a namespaced attribution identity so
 * routes can record WHO acted (audit metadata, response attribution) without
 * any wfos_users row (WORK-063 invariant #3).
 */
function machineActor(principal: MachinePrincipalContext): User {
  return {
    id: `service-account:${principal.serviceAccountId}`,
    externalId: `service-account:${principal.serviceAccountId}`,
    displayName: principal.label,
    email: null,
    createdAt: new Date(0),
  };
}

/**
 * Run a handler inside the request's execution context (so logs/audit carry
 * the execution id). Convenience for authed routes.
 */
export async function runAuthed<T>(
  req: FastifyRequest,
  fn: () => Promise<T>,
): Promise<T> {
  const executionId =
    (req as unknown as { executionId?: string }).executionId ?? 'unknown';
  return runWithExecutionContext({ executionId, requestId: req.id }, fn);
}
