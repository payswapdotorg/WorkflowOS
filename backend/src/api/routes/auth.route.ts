import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import type {
  AuthorizationService,
  SessionService,
  PasswordCredentialService,
  IdentityResolutionService,
  MachineIdentityService,
  OAuthProviderAdapter,
  OAuthStateStore,
} from '@modules/auth/index.js';
import type { AuditEventWriter } from '@modules/audit/index.js';
import type { UserRepository } from '@modules/users/index.js';
import type { MembershipRepository } from '@modules/organizations/index.js';
import {
  requireOrganizationAuthorization,
  requireUser,
  runAuthed,
} from '../plugins/auth.plugin.js';
import {
  OAUTH_TRANSACTION_COOKIE_NAME,
  OAUTH_TRANSACTION_COOKIE_TTL_SECONDS,
  SESSION_COOKIE_NAME,
  buildOAuthTransactionCookie,
  buildSessionCookie,
  clearOAuthTransactionCookie,
  clearSessionCookie,
  readCookie,
} from './session-cookie.js';

/**
 * WORK-074 — the identity runtime routes (the human login surface + the
 * machine-identity management surface). All session state is SERVER-SIDE
 * (wfos_sessions); the browser only ever holds the opaque session token in an
 * HttpOnly cookie.
 *
 * Human login (the WORK-063 providers):
 *   POST /auth/password/register  { email, password, displayName? }
 *   POST /auth/password/login     { email, password }
 *   GET  /auth/oauth/:provider/start   → { authorizeUrl } (single-use CSRF state)
 *   GET  /auth/oauth/:provider/callback?code&state → 302 + session cookie
 *   GET  /auth/providers          → which providers are configured
 *
 * Session lifecycle:
 *   GET  /auth/session            → whoami (200 { user, via } | 401)
 *   POST /auth/session/refresh    → sliding expiry extension (refresh persistence)
 *   POST /auth/session/logout     → revocation (access actually removed)
 *
 * Machine identity (human org-admin only — never machines):
 *   POST /auth/service-accounts                        { organizationId, name, capabilities }
 *   GET  /auth/service-accounts?organizationId=…
 *   GET  /auth/service-accounts/:id                    → account + keys (views, no secrets)
 *   POST /auth/service-accounts/:id/keys               { label, scopes } → raw key ONCE
 *   POST /auth/service-accounts/:id/keys/:keyId/revoke
 *
 * Security:
 *   - raw passwords/keys/tokens are never logged or audited (digest-only storage);
 *   - OAuth callbacks validate + atomically consume the server-side state
 *     TOGETHER WITH the initiating browser's pre-auth transaction binding
 *     (single use; a state presented by any other browser → typed redirect
 *     error, no session — the login-CSRF remediation); the binding is checked
 *     BEFORE any provider assertion is accepted;
 *   - unconfigured providers fail closed (503 / configured:false — the honest
 *     state the frontend renders);
 *   - machine principals are NEVER treated as users here (whoami 401s them).
 */
export interface AuthRouteDeps {
  sessionService: SessionService;
  passwordCredentials: PasswordCredentialService;
  identityResolution: IdentityResolutionService;
  /** The configured OAuth provider adapters (constructed by the composition root). */
  oauthProviders: readonly OAuthProviderAdapter[];
  oauthStateStore: OAuthStateStore;
  machineIdentity: MachineIdentityService;
  authorizationService: AuthorizationService;
  membershipRepository: MembershipRepository;
  userRepository: UserRepository;
  audit: AuditEventWriter;
  /** The public origin (used to build OAuth redirect URIs). */
  publicUrl?: string;
}

const BASE_PROVIDERS: ReadonlyArray<{ id: 'google' | 'github' }> = [
  { id: 'google' },
  { id: 'github' },
];

export async function authRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  // --- which providers are configured (the login UI renders the honest state) ---

  app.get('/auth/providers', async () => {
    const adapters = new Map(deps.oauthProviders.map((p) => [p.id, p]));
    const providers = BASE_PROVIDERS.map(({ id }) => ({
      id,
      configured: adapters.get(id)?.isConfigured() === true,
    }));
    return { providers };
  });

  // --- email/password -------------------------------------------------------------

  app.post('/auth/password/register', async (req, reply) => {
    const body = req.body as { email?: string; password?: string; displayName?: string } | null;
    if (!body?.email || !body?.password) {
      return reply.code(400).send({ error: 'email and password required' });
    }
    try {
      const { user } = await deps.passwordCredentials.register({
        email: body.email,
        password: body.password,
        displayName: body.displayName,
      });
      reply.header('Set-Cookie', await issueSessionCookie(deps, user.id, 'password'));
      return reply.code(201).send({ user: publicUser(user) });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'weak-password' || code === 'invalid-email') {
        return reply.code(400).send({ error: code, message: (err as Error).message });
      }
      if (code === 'email-taken') {
        return reply.code(409).send({ error: 'email-taken', message: (err as Error).message });
      }
      throw err;
    }
  });

  app.post('/auth/password/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string } | null;
    if (!body?.email || !body?.password) {
      return reply.code(400).send({ error: 'email and password required' });
    }
    const result = await deps.passwordCredentials.verify({ email: body.email, password: body.password });
    if (result.status !== 'valid') {
      // Uniform rejection — no user enumeration.
      return reply.code(401).send({ error: 'invalid-credentials' });
    }
    reply.header('Set-Cookie', await issueSessionCookie(deps, result.user.id, 'password'));
    return { user: publicUser(result.user) };
  });

  // --- OAuth (Google / GitHub) ------------------------------------------------------

  app.get('/auth/oauth/:provider/start', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const adapter = deps.oauthProviders.find((p) => p.id === provider);
    if (!adapter || !adapter.isConfigured()) {
      return reply.code(503).send({ error: 'provider-not-configured', provider });
    }
    const query = req.query as { redirectTo?: string } | null;
    // Redirect target: a relative path only (never an open redirect).
    const redirectTo = sanitizeRedirect(query?.redirectTo);
    // The pre-auth transaction binding: reuse the browser's in-flight
    // transaction when it has one, otherwise mint one (cryptographically
    // random, HttpOnly, never logged — its DIGEST binds the state row).
    const transactionId =
      readCookie(req.headers.cookie, OAUTH_TRANSACTION_COOKIE_NAME) ??
      randomBytes(32).toString('base64url');
    const state = await deps.oauthStateStore.create({ provider, redirectTo, transactionId });
    const redirectUri = buildRedirectUri(deps.publicUrl, provider);
    reply.header(
      'Set-Cookie',
      buildOAuthTransactionCookie(transactionId, OAUTH_TRANSACTION_COOKIE_TTL_SECONDS, isSecure(deps)),
    );
    return { authorizeUrl: adapter.authorizationUrl({ state: state.state, redirectUri }) };
  });

  app.get('/auth/oauth/:provider/callback', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const query = req.query as { code?: string; state?: string } | null;
    const adapter = deps.oauthProviders.find((p) => p.id === provider);
    if (!adapter || !adapter.isConfigured()) {
      return redirectWithError(reply, 'provider-not-configured');
    }
    // Login-CSRF protection (PR #99 remediation): the presenting browser MUST
    // carry the transaction binding that initiated this flow. Checked BEFORE
    // the state consume and BEFORE any provider assertion is accepted.
    const transactionId = readCookie(req.headers.cookie, OAUTH_TRANSACTION_COOKIE_NAME);
    if (!transactionId) {
      return redirectWithError(reply, 'invalid_state');
    }
    // CSRF: validate + atomically consume the single-use server-side state
    // TOGETHER WITH the browser binding (one statement — state and transaction
    // are spent together; a foreign browser's binding never matches).
    const consumed = query?.state
      ? await deps.oauthStateStore.consume(query.state, provider, transactionId)
      : null;
    if (!consumed) {
      return redirectWithError(reply, 'invalid_state');
    }
    if (!query?.code) {
      return redirectWithError(reply, 'missing_code', consumed.redirectTo);
    }
    let assertion;
    try {
      assertion = await adapter.exchangeAuthorizationCode({
        code: query.code,
        redirectUri: buildRedirectUri(deps.publicUrl, provider),
      });
    } catch {
      // Never surface provider error details (they can embed token material).
      return redirectWithError(reply, 'provider_exchange_failed', consumed.redirectTo);
    }
    try {
      const resolution = await deps.identityResolution.resolve({
        provider: assertion.provider,
        subject: assertion.subject,
        email: assertion.email,
        emailVerified: assertion.emailVerified,
        displayName: assertion.displayName,
      });
      // The OAuth transaction is spent: the session cookie and the retirement
      // of the pre-auth binding ride on this 302 together.
      reply.header('Set-Cookie', [
        await issueSessionCookie(deps, resolution.user.id, provider),
        clearOAuthTransactionCookie(isSecure(deps)),
      ]);
      return reply.code(302).header('Location', consumed.redirectTo).send();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'email-conflict') {
        return redirectWithError(reply, 'email_conflict', consumed.redirectTo);
      }
      throw err;
    }
  });

  // --- session lifecycle ------------------------------------------------------------

  app.get('/auth/session', async (req, reply) => {
    // Machine principals are NOT users — whoami is a human surface.
    if (req.machinePrincipal) {
      return reply.code(401).send({ error: 'unauthenticated', reason: 'machine-principal' });
    }
    // Whoami verifies the presented session SERVER-SIDE with typed rejection
    // reasons (expired / revoked / invalid) so the frontend can distinguish a
    // stale login from never-logged-in.
    const token = readSessionToken(req);
    if (!token) return reply.code(401).send({ error: 'unauthenticated' });
    const verified = await deps.sessionService.verify(token);
    if (verified.status !== 'valid') {
      return reply
        .code(401)
        .send({ error: 'unauthenticated', reason: `session-${verified.status}` });
    }
    const user = await deps.userRepository.findById(verified.userId);
    if (!user) return reply.code(401).send({ error: 'unauthenticated', reason: 'session-revoked' });
    return { user: publicUser(user), via: verified.session.provider };
  });

  app.post('/auth/session/refresh', async (req, reply) => {
    const token = readSessionToken(req);
    if (!token) return reply.code(401).send({ error: 'unauthenticated', reason: 'no-session' });
    const refreshed = await deps.sessionService.refresh(token);
    if (refreshed.status !== 'valid') {
      return reply.code(401).send({ error: 'unauthenticated', reason: `session-${refreshed.status}` });
    }
    const user = await deps.userRepository.findById(refreshed.userId);
    if (!user) return reply.code(401).send({ error: 'unauthenticated', reason: 'session-revoked' });
    // Re-issue the cookie so the browser-side Max-Age follows the new expiry.
    reply.header('Set-Cookie', buildSessionCookie(token, refreshed.session.expiresAt, isSecure(deps)));
    return { user: publicUser(user), expiresAt: refreshed.session.expiresAt.toISOString() };
  });

  app.post('/auth/session/logout', async (req, reply) => {
    const token = readSessionToken(req);
    if (token) {
      await deps.sessionService.revoke(token);
    }
    reply.header('Set-Cookie', clearSessionCookie());
    return reply.code(204).send();
  });

  // --- machine identity (scoped service accounts + keys) ------------------------------

  app.post('/auth/service-accounts', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const body = req.body as {
        organizationId?: string;
        name?: string;
        capabilities?: string[];
      } | null;
      if (!body?.organizationId || !body?.name || !Array.isArray(body.capabilities)) {
        return reply.code(400).send({ error: 'organizationId, name, and capabilities required' });
      }
      // Organization management is a HUMAN surface (org.admin).
      await requireOrganizationAuthorization(req, reply, deps, {
        permission: 'org.admin',
        organizationId: body.organizationId,
      });
      try {
        const account = await deps.machineIdentity.createServiceAccount({
          organizationId: body.organizationId,
          name: body.name,
          capabilities: body.capabilities,
          actor: user.id,
        });
        return reply.code(201).send({ serviceAccount: account });
      } catch (err) {
        return machineError(reply, err);
      }
    });
  });

  app.get('/auth/service-accounts', async (req, reply) => {
    return runAuthed(req, async () => {
      await requireUser(req, reply);
      const query = req.query as { organizationId?: string } | null;
      if (!query?.organizationId) {
        return reply.code(400).send({ error: 'organizationId required' });
      }
      await requireOrganizationAuthorization(req, reply, deps, {
        permission: 'org.admin',
        organizationId: query.organizationId,
      });
      const accounts = await deps.machineIdentity.listForOrganization(query.organizationId);
      return { serviceAccounts: accounts };
    });
  });

  app.get('/auth/service-accounts/:id', async (req, reply) => {
    return runAuthed(req, async () => {
      await requireUser(req, reply);
      const { id } = req.params as { id: string };
      const account = await deps.machineIdentity.getServiceAccount(id);
      if (!account) return reply.code(404).send({ error: 'not-found' });
      await requireOrganizationAuthorization(req, reply, deps, {
        permission: 'org.admin',
        organizationId: account.organizationId,
      });
      const keys = await deps.machineIdentity.listKeys(id);
      return { serviceAccount: account, keys };
    });
  });

  app.post('/auth/service-accounts/:id/keys', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { id } = req.params as { id: string };
      const account = await deps.machineIdentity.getServiceAccount(id);
      if (!account) return reply.code(404).send({ error: 'not-found' });
      await requireOrganizationAuthorization(req, reply, deps, {
        permission: 'org.admin',
        organizationId: account.organizationId,
      });
      const body = req.body as { label?: string; scopes?: string[] } | null;
      if (!body?.label || !Array.isArray(body.scopes)) {
        return reply.code(400).send({ error: 'label and scopes required' });
      }
      try {
        const issued = await deps.machineIdentity.issueKey({
          serviceAccountId: id,
          label: body.label,
          scopes: body.scopes,
          actor: user.id,
        });
        // The raw key is returned EXACTLY once; it is never logged or stored raw.
        return reply.code(201).send({ keyId: issued.keyId, key: issued.rawKey, scopes: issued.scopes });
      } catch (err) {
        return machineError(reply, err);
      }
    });
  });

  app.post('/auth/service-accounts/:id/keys/:keyId/revoke', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { id, keyId } = req.params as { id: string; keyId: string };
      const account = await deps.machineIdentity.getServiceAccount(id);
      if (!account) return reply.code(404).send({ error: 'not-found' });
      await requireOrganizationAuthorization(req, reply, deps, {
        permission: 'org.admin',
        organizationId: account.organizationId,
      });
      await deps.machineIdentity.revokeKey({ keyId, actor: user.id });
      return reply.code(204).send();
    });
  });
}

// --- helpers -----------------------------------------------------------------

function publicUser(user: { id: string; displayName: string; email: string | null; externalId: string }) {
  return { id: user.id, displayName: user.displayName, email: user.email };
}

async function issueSessionCookie(
  deps: AuthRouteDeps,
  userId: string,
  provider: string,
): Promise<string> {
  const created = await deps.sessionService.create({ userId, provider });
  return buildSessionCookie(created.token, created.session.expiresAt, isSecure(deps));
}

function readSessionToken(req: { headers: Record<string, unknown> }): string | null {
  return readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
}

function buildRedirectUri(publicUrl: string | undefined, provider: string): string {
  const base = (publicUrl ?? 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/api/auth/oauth/${provider}/callback`;
}

function sanitizeRedirect(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function redirectWithError(reply: FastifyReply, reason: string, redirectTo = '/'): FastifyReply {
  const sep = redirectTo.includes('?') ? '&' : '?';
  return reply.code(302).header('Location', `${redirectTo}${sep}login_error=${reason}`).send();
}

function isSecure(deps: AuthRouteDeps): boolean {
  return Boolean(deps.publicUrl && deps.publicUrl.startsWith('https://'));
}

function machineError(reply: FastifyReply, err: unknown): FastifyReply {
  const code = (err as { code?: string }).code;
  if (code === 'unknown-capability' || code === 'scope-not-in-account-capabilities') {
    return reply.code(400).send({ error: code, message: (err as Error).message });
  }
  if (code === 'not-found') {
    return reply.code(404).send({ error: code });
  }
  if (code === 'secret-store-not-writable') {
    return reply.code(503).send({ error: code, message: (err as Error).message });
  }
  throw err;
}
