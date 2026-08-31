import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  OAUTH_TRANSACTION_COOKIE_NAME,
  buildOAuthTransactionCookie,
} from '../../../src/api/routes/session-cookie.js';
import {
  buildIdentityStack,
  type TestIdentityStack,
} from '../../helpers/test-identity-stack.js';
import { buildIdentityTestServer } from '../../helpers/test-identity-server.js';
import type { OAuthProviderAdapter, OAuthProviderAssertion } from '../../../src/modules/auth/internal/oauth-provider.js';

/**
 * WORK-074 — the identity runtime on the REAL Fastify server (server.inject):
 * the browser-journey proofs at the HTTP boundary.
 *
 * Proven here:
 *   - email login journey: register → session cookie → whoami → refresh →
 *     logout → 401 (revocation actually removes access);
 *   - login without any demo key provisioned (the production path never
 *     depends on the demo key);
 *   - protected route acceptance AND rejection (unauthenticated 401);
 *   - expired-session rejection on the cookie path (typed 401);
 *   - OAuth journey (fake provider adapter): start → state cookie-less CSRF
 *     contract → callback → session; an invalid/replayed state NEVER yields a
 *     session;
 *   - machine principal on real routes: granted capability CAN (project.read
 *     opt-in read), governance mutations CANNOT (typed 403), cross-tenant
 *     CANNOT (403 not-a-member);
 *   - human/machine separation through the plugin: machine keys never create
 *     a wfos_users row;
 *   - audit coverage: login, logout, api-key issuance, membership assignment;
 *   - credential safety: raw key/password/session material never appears in
 *     any wfos_* table row.
 */
describe('WORK-074 — identity runtime E2E on the real server', () => {
  let stack: TestIdentityStack;
  let server: FastifyInstance;

  let orgAId: string;
  let projectAId: string;
  let projectBId: string;
  let aliceCookie = '';
  let aliceUserId = '';

  const PASSWORD = 'correct-horse-battery';

  beforeAll(async () => {
    stack = await buildIdentityStack();
    server = await buildIdentityTestServer(stack);

    // Fixtures: Org A + project A; Org B + project B (Bob owner, programmatic).
    // A planted cross-tenant project_access row for Alice on project B must
    // grant nothing. Alice herself is created through the REGISTER ROUTE in
    // the first test (the production journey — no seeded identity).
    const orgA = await stack.organizationRepository.create({ name: 'Route Org A' });
    const orgB = await stack.organizationRepository.create({ name: 'Route Org B' });
    orgAId = orgA.id;
    const bob = await stack.userRepository.upsertByExternalId({
      externalId: 'email:bob@routes.example.com',
      displayName: 'Bob (routes)',
      email: 'bob@routes.example.com',
    });
    await stack.membershipRepository.assign({ userId: bob.id, organizationId: orgB.id, roleId: 'owner' });
    const projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Route Project A' });
    const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Route Project B' });
    projectAId = projectA.id;
    projectBId = projectB.id;
    stack.ctx.orgAId = orgA.id;
    stack.ctx.projectAId = projectA.id;
    stack.ctx.projectBId = projectB.id;
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  // --- the email login journey ---------------------------------------------------

  it('registers a human (email/password) and issues a session cookie — NO demo key exists anywhere', async () => {
    // Guard: NO api-key credentials exist in this database at all.
    const keys = await stack.db.client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM wfos_api_key_credentials',
    );
    expect(keys.rows[0]!.count).toBe('0');

    const res = await server.inject({
      method: 'POST',
      url: '/auth/password/register',
      payload: { email: 'alice@routes.example.com', password: PASSWORD, displayName: 'Alice (routes)' },
    });
    expect(res.statusCode).toBe(201);
    const sessionCookie = sessionCookieOf(res.headers);
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Lax');
    aliceCookie = extractCookieValue(sessionCookie!);
    expect(aliceCookie).toBeTruthy();

    // Resolve Alice's user id and finish her tenancy fixtures (owner of Org A,
    // planted cross-tenant row on Org B's project).
    const who = await server.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: `wfos_session=${aliceCookie}` },
    });
    aliceUserId = (JSON.parse(who.body) as { user: { id: string } }).user.id;
    await stack.membershipRepository.assign({ userId: aliceUserId, organizationId: orgAId, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: aliceUserId, projectId: projectBId, roleId: 'owner' });
  });

  it('whoami resolves the session synchronously; refresh persists it; logout removes access', async () => {
    const who = await server.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: `wfos_session=${aliceCookie}` },
    });
    expect(who.statusCode).toBe(200);
    const whoBody = JSON.parse(who.body) as { user: { id: string; email: string | null } };
    expect(whoBody.user.email).toBe('alice@routes.example.com');

    const refreshed = await server.inject({
      method: 'POST',
      url: '/auth/session/refresh',
      headers: { cookie: `wfos_session=${aliceCookie}` },
    });
    expect(refreshed.statusCode).toBe(200);

    // Protected route with the session cookie: accepted (authorization chain).
    const ok = await server.inject({
      method: 'GET',
      url: `/projects/${projectAId}`,
      headers: { cookie: `wfos_session=${aliceCookie}` },
    });
    expect(ok.statusCode).toBe(200);

    const out = await server.inject({
      method: 'POST',
      url: '/auth/session/logout',
      headers: { cookie: `wfos_session=${aliceCookie}` },
    });
    expect(out.statusCode).toBe(204);

    const afterLogout = await server.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: `wfos_session=${aliceCookie}` },
    });
    expect(afterLogout.statusCode).toBe(401);

    // Revocation actually removes access on protected routes too.
    const afterLogoutProtected = await server.inject({
      method: 'GET',
      url: `/projects/${projectAId}`,
      headers: { cookie: `wfos_session=${aliceCookie}` },
    });
    expect(afterLogoutProtected.statusCode).toBe(401);
  });

  it('logs in with the password path; a wrong password is a uniform 401 (no user enumeration)', async () => {
    const ok = await server.inject({
      method: 'POST',
      url: '/auth/password/login',
      payload: { email: 'alice@routes.example.com', password: PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    aliceCookie = extractCookieValue(sessionCookieOf(ok.headers)!);
    expect(aliceCookie).toBeTruthy();

    const bad = await server.inject({
      method: 'POST',
      url: '/auth/password/login',
      payload: { email: 'alice@routes.example.com', password: 'totally-wrong' },
    });
    expect(bad.statusCode).toBe(401);

    const unknown = await server.inject({
      method: 'POST',
      url: '/auth/password/login',
      payload: { email: 'ghost@routes.example.com', password: 'whatever-long' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(JSON.parse(unknown.body)).toEqual(JSON.parse(bad.body));
  });

  it('an expired session cookie is rejected (typed 401) on whoami and protected routes', async () => {
    const created = await stack.sessionService.create({
      userId: aliceUserId,
      provider: 'password',
      ttlSeconds: -1,
    });
    const who = await server.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: `wfos_session=${created.token}` },
    });
    expect(who.statusCode).toBe(401);
    expect((JSON.parse(who.body) as { reason?: string }).reason).toBe('session-expired');
  });

  it('unauthenticated access to a protected route is rejected with 401', async () => {
    const res = await server.inject({ method: 'GET', url: `/projects/${projectAId}` });
    expect(res.statusCode).toBe(401);
  });

  // --- tenant isolation through login ---------------------------------------------

  it('tenant isolation: Alice cannot read Org B\u2019s project even with the planted cross-tenant access row', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectBId}`,
      headers: { cookie: `wfos_session=${aliceCookie}` },
    });
    expect(res.statusCode).toBe(403);
    expect((JSON.parse(res.body) as { reason?: string }).reason).toBe('not-a-member');
  });

  it('an unconfigured provider start fails closed (503)', async () => {
    const res = await server.inject({ method: 'GET', url: '/auth/oauth/google/start' });
    expect(res.statusCode).toBe(503);
    const providers = await server.inject({ method: 'GET', url: '/auth/providers' });
    expect(providers.statusCode).toBe(200);
    const body = JSON.parse(providers.body) as { providers: Array<{ id: string; configured: boolean }> };
    const google = body.providers.find((p) => p.id === 'google');
    expect(google!.configured).toBe(false);
  });

  // --- the OAuth journey (fake provider adapter; real adapter code path) -----------

  it('OAuth journey: start → authorizeUrl with state; callback exchanges the code and issues a session', async () => {
    const assertions = new Map<string, OAuthProviderAssertion>();
    const fakeGithub: OAuthProviderAdapter = {
      id: 'github',
      isConfigured: () => true,
      authorizationUrl: (input) =>
        `https://fake-github.example.com/login/oauth/authorize?state=${input.state}&redirect_uri=${encodeURIComponent(input.redirectUri)}`,
      exchangeAuthorizationCode: async (input) => {
        const assertion = assertions.get(input.code);
        if (!assertion) throw new Error('bad verification code');
        return assertion;
      },
    };
    const fakeGoogle: OAuthProviderAdapter = {
      id: 'google',
      isConfigured: () => true,
      authorizationUrl: (input) =>
        `https://fake-google.example.com/o/oauth2/v2/auth?state=${input.state}`,
      exchangeAuthorizationCode: async (input) => {
        const assertion = assertions.get(input.code);
        if (!assertion) throw new Error('bad verification code');
        return assertion;
      },
    };
    stack.oauthProviders.register(fakeGithub);
    stack.oauthProviders.register(fakeGoogle);

    const start = await server.inject({ method: 'GET', url: '/auth/oauth/github/start' });
    expect(start.statusCode).toBe(200);
    const { authorizeUrl } = JSON.parse(start.body) as { authorizeUrl: string };
    expect(authorizeUrl).toContain('state=');
    const state = new URL(authorizeUrl).searchParams.get('state')!;
    expect(state.length).toBeGreaterThanOrEqual(32);
    // The initiating browser holds the transaction binding for this flow.
    const txCookie = setCookiesOf(start.headers).find((c) => c.startsWith(`${OAUTH_TRANSACTION_COOKIE_NAME}=`));
    expect(txCookie, 'the start mints the browser-binding transaction cookie').toBeDefined();
    const txHeaderValue = `${OAUTH_TRANSACTION_COOKIE_NAME}=${extractCookieValue(txCookie!)}`;

    // Journey 1: a fresh GitHub identity → a NEW user + session.
    const code = 'oauth-code-erin-github';
    assertions.set(code, {
      provider: 'github',
      subject: 'github-sub-routes-1',
      email: 'erin@routes.example.com',
      emailVerified: true,
      displayName: 'Erin (GitHub)',
    });
    const callback = await server.inject({
      method: 'GET',
      url: `/auth/oauth/github/callback?code=${code}&state=${state}`,
      headers: { cookie: txHeaderValue },
    });
    expect(callback.statusCode).toBe(302);
    const sessionCookie = sessionCookieOf(callback.headers);
    expect(sessionCookie).toBeDefined();
    const ghCookie = extractCookieValue(sessionCookie!);
    const who = await server.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: `wfos_session=${ghCookie}` },
    });
    expect(who.statusCode).toBe(200);
    const whoBody = JSON.parse(who.body) as { user: { id: string }; via: string };
    expect(whoBody.via).toBe('github');
    const erinId = whoBody.user.id;
    expect(erinId).toBeTruthy();

    // Journey 2: a Google identity with the SAME verified email → LINKED to
    // the SAME user (one human, two provider identities — through the real
    // HTTP flow).
    const start2 = await server.inject({ method: 'GET', url: '/auth/oauth/google/start' });
    const { authorizeUrl: authorizeUrl2 } = JSON.parse(start2.body) as { authorizeUrl: string };
    const state2 = new URL(authorizeUrl2).searchParams.get('state')!;
    const txCookie2 = setCookiesOf(start2.headers).find((c) => c.startsWith(`${OAUTH_TRANSACTION_COOKIE_NAME}=`));
    const txHeaderValue2 = `${OAUTH_TRANSACTION_COOKIE_NAME}=${extractCookieValue(txCookie2!)}`;
    const code2 = 'oauth-code-erin-google';
    assertions.set(code2, {
      provider: 'google',
      subject: 'google-sub-routes-1',
      email: 'erin@routes.example.com',
      emailVerified: true,
      displayName: 'Erin (Google)',
    });
    const callback2 = await server.inject({
      method: 'GET',
      url: `/auth/oauth/google/callback?code=${code2}&state=${state2}`,
      headers: { cookie: txHeaderValue2 },
    });
    expect(callback2.statusCode).toBe(302);
    const sessionCookie2 = sessionCookieOf(callback2.headers);
    expect(sessionCookie2).toBeDefined();
    const who2 = await server.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: `wfos_session=${extractCookieValue(sessionCookie2!)}` },
    });
    expect(who2.statusCode).toBe(200);
    const who2Body = JSON.parse(who2.body) as { user: { id: string }; via: string };
    expect(who2Body.via).toBe('google');
    expect(who2Body.user.id).toBe(erinId);
  });

  it('an unknown state is rejected (no session issued) — the CSRF contract holds', async () => {
    const callback = await server.inject({
      method: 'GET',
      url: '/auth/oauth/github/callback?code=x&state=not-a-real-state',
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain('login_error');
    const sessionCookie = sessionCookieOf(callback.headers);
    expect(sessionCookie).toBeUndefined();
  });

  it('a consumed (replayed) state cannot be used twice (single-use)', async () => {
    const start = await server.inject({ method: 'GET', url: '/auth/oauth/github/start' });
    const { authorizeUrl } = JSON.parse(start.body) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get('state')!;
    const txCookie = setCookiesOf(start.headers).find((c) => c.startsWith(`${OAUTH_TRANSACTION_COOKIE_NAME}=`));
    const txHeaderValue = `${OAUTH_TRANSACTION_COOKIE_NAME}=${extractCookieValue(txCookie!)}`;
    const first = await server.inject({
      method: 'GET',
      url: `/auth/oauth/github/callback?code=unused-code&state=${state}`,
      headers: { cookie: txHeaderValue },
    });
    // The code is unknown to the fake → error redirect, but the STATE row was consumed.
    expect(first.statusCode).toBe(302);
    const replay = await server.inject({
      method: 'GET',
      url: `/auth/oauth/github/callback?code=unused-code&state=${state}`,
      headers: { cookie: txHeaderValue },
    });
    expect(replay.statusCode).toBe(302);
    expect(replay.headers.location).toContain('login_error=invalid_state');
  });


  // --- machine principals on real routes ---------------------------------------------

  it('issues a service-account key in Org A (audited) for the implementation-agent capability set', async () => {
    const sa = await stack.machineIdentity.createServiceAccount({
      organizationId: orgAId,
      name: 'z.ai worker (routes)',
      capabilities: ['project.read', 'work-orders.read', 'execution.read'],
      actor: aliceUserId,
    });
    const issued = await stack.machineIdentity.issueKey({
      serviceAccountId: sa.id,
      label: 'agent key (routes)',
      scopes: ['project.read', 'work-orders.read', 'execution.read'],
      actor: aliceUserId,
    });
    stack.setKey('agent', issued.rawKey);
    stack.setKey('agent-key-id', issued.keyId);
    expect(issued.rawKey).toMatch(/^wfos_sk_/);
  });

  it('a machine key CAN exercise a granted capability on an in-tenant route (project.read opt-in)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectAId}`,
      headers: { 'x-api-key': stack.getKey('agent')! },
    });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { id: string }).id).toBe(projectAId);
  });

  it('a machine key CANNOT mutate the project (typed capability-not-granted 403)', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: `/projects/${projectAId}`,
      headers: { 'x-api-key': stack.getKey('agent')! },
      payload: { name: 'renamed-by-agent' },
    });
    expect(res.statusCode).toBe(403);
    expect((JSON.parse(res.body) as { reason?: string }).reason).toBe('capability-not-granted');
  });

  it('a machine key CANNOT read a cross-tenant project (403 not-a-member)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/projects/${projectBId}`,
      headers: { 'x-api-key': stack.getKey('agent')! },
    });
    expect(res.statusCode).toBe(403);
    expect((JSON.parse(res.body) as { reason?: string }).reason).toBe('not-a-member');
  });

  it('a machine principal is NEVER resolved to a user row (human/machine separation through the plugin)', async () => {
    const users = await stack.db.client.query<{ external_id: string }>(
      `SELECT external_id FROM wfos_users WHERE external_id LIKE 'service-account:%'`,
    );
    expect(users.rows.length).toBe(0);
    // And whoami does NOT treat a machine key as a session user.
    const who = await server.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { 'x-api-key': stack.getKey('agent')! },
    });
    expect(who.statusCode).toBe(401);
  });

  // --- organization membership management + audit --------------------------------------

  it('membership management: an owner assigns a member (audited); a non-member is denied', async () => {
    const newHuman = await server.inject({
      method: 'POST',
      url: '/auth/password/register',
      payload: { email: 'carol@routes.example.com', password: 'another-long-password' },
    });
    expect(newHuman.statusCode).toBe(201);
    const carolCookie = extractCookieValue(sessionCookieOf(newHuman.headers)!);
    const carolWho = await server.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: `wfos_session=${carolCookie}` },
    });
    const carolId = (JSON.parse(carolWho.body) as { user: { id: string } }).user.id;

    const assign = await server.inject({
      method: 'POST',
      url: `/organizations/${orgAId}/members`,
      headers: { cookie: `wfos_session=${aliceCookie}` },
      payload: { userId: carolId, roleId: 'member' },
    });
    expect(assign.statusCode).toBe(201);

    // Non-member denial: Bob (Org B owner) cannot manage Org A membership.
    const bob = await stack.userRepository.findByExternalId('email:bob@routes.example.com');
    expect(bob).not.toBeNull();
    const bobSession = await stack.sessionService.create({ userId: bob!.id, provider: 'password' });
    const bobAssign = await server.inject({
      method: 'POST',
      url: `/organizations/${orgAId}/members`,
      headers: { cookie: `wfos_session=${bobSession.token}` },
      payload: { userId: carolId, roleId: 'admin' },
    });
    expect(bobAssign.statusCode).toBe(403);
    expect((JSON.parse(bobAssign.body) as { reason?: string }).reason).toBe('not-a-member');
  });

  it('audit coverage: login, logout, api-key issuance, and membership assignment are on the audit surface', async () => {
    const events = await stack.db.client.query<{ event_type: string; resource_type: string }>(
      `SELECT event_type, resource_type FROM wfos_audit_events
       WHERE event_type IN ('identity.login','identity.logout','identity.api_key.issued','identity.membership.assigned')
       ORDER BY created_at ASC`,
    );
    const types = new Set(events.rows.map((r) => r.event_type));
    expect(types.has('identity.login')).toBe(true);
    expect(types.has('identity.logout')).toBe(true);
    expect(types.has('identity.api_key.issued')).toBe(true);
    expect(types.has('identity.membership.assigned')).toBe(true);
  });

  it('credential safety: raw key/password/session material never appears in any wfos_* row', async () => {
    const agentKey = stack.getKey('agent')!;
    const sessionToken = aliceCookie;
    const password = PASSWORD;
    for (const material of [agentKey, sessionToken, password]) {
      if (!material) continue;
      const tables = await stack.db.client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'wfos_%' AND table_schema = current_schema()`,
      );
      for (const { table_name } of tables.rows) {
        const cols = await stack.db.client.query<{ column_name: string; data_type: string }>(
          `SELECT column_name, data_type FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = current_schema() AND data_type IN ('text','character varying')`,
          [table_name],
        );
        for (const col of cols.rows) {
          const hit = await stack.db.client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM "${table_name}" WHERE "${col.column_name}" = $1`,
            [material],
          );
          expect(hit.rows[0]!.count, `${table_name}.${col.column_name} must not hold raw credential material`).toBe('0');
        }
      }
    }
  });

  // --- OAuth browser binding (the login-CSRF remediation) -----------------------
  //
  // The architect's review of PR #99: single-use CSRF state alone does NOT
  // bind the authorization request to the browser that initiated it — an
  // attacker could complete a login flow and have the victim's browser present
  // the callback (login-CSRF / session swapping). The server-side state MUST
  // be correlated with an initiating-browser transaction binding (a random,
  // HttpOnly pre-auth cookie) that is consumed atomically WITH the state,
  // BEFORE any provider assertion is accepted.
  describe('OAuth browser binding — the state is bound to the initiating browser', () => {
    // A dedicated fake provider id so this block never collides with the
    // adapters registered by the journey test above (find() is first-match).
    const PROVIDER = 'bindprov';
    const assertions = new Map<string, OAuthProviderAssertion>();

    beforeAll(() => {
      stack.oauthProviders.register({
        id: PROVIDER,
        isConfigured: () => true,
        authorizationUrl: (input) =>
          `https://fake-bind.example.com/auth?state=${input.state}&redirect_uri=${encodeURIComponent(input.redirectUri)}`,
        exchangeAuthorizationCode: async (input) => {
          const assertion = assertions.get(input.code);
          if (!assertion) throw new Error('bad verification code');
          return assertion;
        },
      });
    });

    function transactionCookieOf(headers: Record<string, unknown>): string | undefined {
      return setCookiesOf(headers).find((c) => c.startsWith(OAUTH_TRANSACTION_COOKIE_NAME + '='));
    }

    it('the start response mints an HttpOnly, SameSite=Lax transaction cookie with an unpredictable one-time value', async () => {
      const start = await server.inject({ method: 'GET', url: `/auth/oauth/${PROVIDER}/start` });
      expect(start.statusCode).toBe(200);
      const tx = transactionCookieOf(start.headers);
      expect(tx, 'the start response must set the pre-auth transaction cookie').toBeDefined();
      expect(tx).toContain('HttpOnly');
      expect(tx).toContain('SameSite=Lax');
      expect(tx).toMatch(/Path=\//);
      expect(tx).toMatch(/Max-Age=\d+/);
      const value = extractCookieValue(tx!);
      expect(value.length, 'the binding must be cryptographically unpredictable').toBeGreaterThanOrEqual(32);
      // A second start mints a DIFFERENT transaction (never reused).
      const start2 = await server.inject({ method: 'GET', url: `/auth/oauth/${PROVIDER}/start` });
      expect(extractCookieValue(transactionCookieOf(start2.headers)!)).not.toBe(value);
      // The https (production) builder marks the cookie Secure.
      const secureCookie = buildOAuthTransactionCookie('some-transaction-id', 600, true);
      expect(secureCookie).toContain('Secure');
      expect(secureCookie).toContain('HttpOnly');
      expect(secureCookie).toContain('SameSite=Lax');
    });

    it('browser A creates the state, browser B presents it → callback MUST reject with NO session (the login-CSRF discrimination)', async () => {
      // Browser A initiates an OAuth login and receives the binding cookie.
      const start = await server.inject({ method: 'GET', url: `/auth/oauth/${PROVIDER}/start` });
      const state = new URL((JSON.parse(start.body) as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!;
      const txA = transactionCookieOf(start.headers);
      expect(txA).toBeDefined();

      // The assertion B tries to cash in (attacker-controlled identity).
      const codeB = 'bind-code-browser-b';
      assertions.set(codeB, {
        provider: PROVIDER,
        subject: 'bind-sub-browser-b',
        email: 'browserb@bind.example.com',
        emailVerified: true,
        displayName: 'Browser B',
      });

      // Browser B presents the callback with browser A's state but WITHOUT
      // browser A's transaction cookie → rejected, NO session.
      const byB = await server.inject({
        method: 'GET',
        url: `/auth/oauth/${PROVIDER}/callback?code=${codeB}&state=${state}`,
      });
      expect(byB.statusCode).toBe(302);
      expect(byB.headers.location).toContain('login_error=invalid_state');
      expect(sessionCookieOf(byB.headers), 'no WorkflowOS session may be created for browser B').toBeUndefined();

      // Even when B presents a DIFFERENT (its own) transaction cookie, the
      // mismatched binding is rejected fail-closed.
      const byBWithOwnTx = await server.inject({
        method: 'GET',
        url: `/auth/oauth/${PROVIDER}/callback?code=${codeB}&state=${state}`,
        headers: { cookie: `${OAUTH_TRANSACTION_COOKIE_NAME}=a-different-browsers-transaction-value-0123456789` },
      });
      expect(byBWithOwnTx.statusCode).toBe(302);
      expect(byBWithOwnTx.headers.location).toContain('login_error=invalid_state');
      expect(sessionCookieOf(byBWithOwnTx.headers)).toBeUndefined();

      // The flow never reached identity resolution: no user row for B's subject.
      expect(await stack.userRepository.findByExternalId(`${PROVIDER}:bind-sub-browser-b`)).toBeNull();
    });

    it('browser A creates the state, browser A returns with the provider callback → succeeds and a session IS created', async () => {
      const start = await server.inject({ method: 'GET', url: `/auth/oauth/${PROVIDER}/start` });
      const state = new URL((JSON.parse(start.body) as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!;
      const txA = transactionCookieOf(start.headers);
      expect(txA).toBeDefined();

      const codeA = 'bind-code-browser-a';
      assertions.set(codeA, {
        provider: PROVIDER,
        subject: 'bind-sub-browser-a',
        email: 'browsera@bind.example.com',
        emailVerified: true,
        displayName: 'Browser A',
      });

      // The SAME browser returns: its transaction cookie rides along.
      const callback = await server.inject({
        method: 'GET',
        url: `/auth/oauth/${PROVIDER}/callback?code=${codeA}&state=${state}`,
        headers: { cookie: `${OAUTH_TRANSACTION_COOKIE_NAME}=${extractCookieValue(txA!)}` },
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location, 'the honest flow redirects to the post-login target, not an error').not.toContain('login_error');
      const session = sessionCookieOf(callback.headers);
      expect(session, 'the honest browser gets its WorkflowOS session').toBeDefined();
      const who = await server.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: `wfos_session=${extractCookieValue(session!)}` },
      });
      expect(who.statusCode).toBe(200);
      expect((JSON.parse(who.body) as { user: { displayName: string } }).user.displayName).toBe('Browser A');
    });

    it('a replayed state is still rejected even when presented WITH the correct binding (single-use holds)', async () => {
      const start = await server.inject({ method: 'GET', url: `/auth/oauth/${PROVIDER}/start` });
      const state = new URL((JSON.parse(start.body) as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!;
      const txValue = extractCookieValue(transactionCookieOf(start.headers)!);

      assertions.set('bind-code-replay', {
        provider: PROVIDER,
        subject: 'bind-sub-replay',
        email: 'replay@bind.example.com',
        emailVerified: true,
        displayName: 'Replay',
      });
      const first = await server.inject({
        method: 'GET',
        url: `/auth/oauth/${PROVIDER}/callback?code=bind-code-replay&state=${state}`,
        headers: { cookie: `${OAUTH_TRANSACTION_COOKIE_NAME}=${txValue}` },
      });
      expect(first.statusCode).toBe(302);
      expect(first.headers.location).not.toContain('login_error');

      const replay = await server.inject({
        method: 'GET',
        url: `/auth/oauth/${PROVIDER}/callback?code=bind-code-replay&state=${state}`,
        headers: { cookie: `${OAUTH_TRANSACTION_COOKIE_NAME}=${txValue}` },
      });
      expect(replay.statusCode).toBe(302);
      expect(replay.headers.location).toContain('login_error=invalid_state');
      expect(sessionCookieOf(replay.headers)).toBeUndefined();
    });

    it('the transaction binding is consumed atomically WITH the state and persisted DIGEST-ONLY (the raw value is in no wfos_* row)', async () => {
      const start = await server.inject({ method: 'GET', url: `/auth/oauth/${PROVIDER}/start` });
      const txValue = extractCookieValue(transactionCookieOf(start.headers)!);

      // The raw transaction value must appear in NO wfos_* text column…
      const tables = await stack.db.client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'wfos_%' AND table_schema = current_schema()`,
      );
      for (const { table_name } of tables.rows) {
        const cols = await stack.db.client.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = current_schema() AND data_type IN ('text','character varying')`,
          [table_name],
        );
        for (const { column_name } of cols.rows) {
          const hit = await stack.db.client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM "${table_name}" WHERE "${column_name}" = $1`,
            [txValue],
          );
          expect(hit.rows[0]!.count, `${table_name}.${column_name} must not hold the raw transaction id`).toBe('0');
        }
      }
      // …while the state row binds its SHA-256 digest for the atomic consume.
      const digest = createHash('sha256').update(txValue).digest('hex');
      const bound = await stack.db.client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM wfos_oauth_states WHERE transaction_digest = $1`,
        [digest],
      );
      expect(bound.rows[0]!.count, 'the state row is bound to the digest of the initiating browser transaction').toBe('1');
    });
  });
});

function extractCookieValue(setCookie: string): string {
  return setCookie.split(';')[0]!.split('=').slice(1).join('=');
}

/** light-my-request may return set-cookie as a string OR an array — normalize. */
function setCookiesOf(headers: Record<string, unknown>): string[] {
  const value = headers['set-cookie'];
  if (!value) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function sessionCookieOf(headers: Record<string, unknown>): string | undefined {
  return setCookiesOf(headers).find((c) => c.startsWith('wfos_session='));
}
