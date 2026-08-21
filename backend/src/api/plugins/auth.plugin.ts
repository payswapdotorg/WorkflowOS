import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthProvider, AuthorizationService, AuthenticatedPrincipal } from '@modules/auth/index.js';
import type { User, UserRepository } from '@modules/users/index.js';
import { runWithExecutionContext } from '@platform/execution-context.js';

/**
 * Fastify authentication plugin (AUTH-001, AUTH-AC-02).
 *
 * Resolves an inbound API key (via the `Authorization: Bearer <key>` or
 * `X-API-Key` header) to an {@link AuthenticatedPrincipal} and then to a
 * persisted WorkflowOS {@link User}. Rejects unauthenticated requests with
 * 401. Does NOT make authorization decisions — that is the
 * {@link AuthorizationService}'s job (AUTHZ-AC-01..03).
 *
 * The resolved user is attached to the request as `req.user` (or `null` when
 * unauthenticated). Routes that require authentication use
 * {@link requireUser}; routes that require authorization use
 * {@link requireAuthorization}.
 */
export interface AuthPluginDeps {
  authProvider: AuthProvider;
  userRepository: UserRepository;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthenticatedPrincipal | null;
    user?: User | null;
  }
}

export async function authPlugin(app: FastifyInstance, deps: AuthPluginDeps): Promise<void> {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = extractApiKey(req);
    if (!raw) {
      req.principal = null;
      req.user = null;
      return;
    }
    const result = await deps.authProvider.authenticate(raw);
    if (result.kind !== 'principal') {
      req.principal = null;
      req.user = null;
      // Don't 401 here — let the route decide whether auth is required.
      // Routes that require auth will call requireUser which 401s.
      void reply;
      return;
    }
    req.principal = result.principal;
    // Resolve the principal to a persisted WorkflowOS user (AUTH-AC-01).
    const user = await deps.userRepository.upsertByExternalId({
      externalId: result.principal.externalId,
      displayName: result.principal.label,
    });
    req.user = user;
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

/**
 * Route helper: require an authenticated user. Sends 401 if absent.
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
 */
export async function requireProjectAuthorization(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: RequireAuthorizationDeps,
  input: { permission: string; projectId: string },
): Promise<User> {
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
