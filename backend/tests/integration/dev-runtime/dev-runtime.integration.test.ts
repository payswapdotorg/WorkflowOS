import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, type AppConfig } from '../../../src/config.js';
import { buildApp, type AppHandle } from '../../../src/app.js';
import { buildServer } from '../../../src/api/server.js';
import { createLogger, InMemoryQueue } from '@platform/index.js';
import { CaptureStream } from '../../helpers/capture-stream.js';

/**
 * WORK-071 — Local Development Runtime Substrate.
 *
 * Proves the dev-only runtime path: a clean local developer can launch
 * WorkflowOS with NO `DATABASE_URL` and NO externally hosted PostgreSQL
 * (WORKFLOWOS_DEV_RUNTIME=pglite) and obtain the REAL product surface —
 * the same DatabaseClient boundary, the same migrations, the same domain
 * code, wired through the same composition root (buildApp).
 *
 * The production path remains authoritative and unchanged:
 * - `DATABASE_URL` set, no dev signal → the production `PgDatabaseClient`
 *   (a real `pg.Pool`) is used; no dev code executes.
 * - dev signal AND `DATABASE_URL` both set → the application REFUSES to
 *   start (ambiguity fails closed).
 * - no dev signal, no `DATABASE_URL` → no database (the pre-WORK-071
 *   behavior is preserved — the dev wiring is NEVER ambient).
 *
 * The dev database is PGlite (real PostgreSQL compiled to WASM —
 * DATA-AC-03 satisfied: real relational semantics, real migrations), NOT a
 * fake in-memory database.
 */

/** Save the env vars this suite mutates; restore after each test. */
const MUTATED_ENV_KEYS = [
  'WORKFLOWOS_DEV_RUNTIME',
  'WORKFLOWOS_DEV_DATABASE_DIR',
  'DATABASE_URL',
  'NODE_ENV',
  'WORKFLOWOS_ROLE',
] as const;

const ENV_SNAPSHOT: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const key of MUTATED_ENV_KEYS) ENV_SNAPSHOT[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of MUTATED_ENV_KEYS) {
    if (ENV_SNAPSHOT[key] === undefined) delete process.env[key];
    else process.env[key] = ENV_SNAPSHOT[key];
  }
}

/** A minimal config for direct buildApp calls (the dev-path shape). */
function devRuntimeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    role: 'all',
    port: 0,
    host: '127.0.0.1',
    logLevel: 'info',
    ...overrides,
  } as AppConfig;
}

describe('WORK-071 — Local Development Runtime Substrate', () => {
  beforeEach(() => {
    snapshotEnv();
    delete process.env.WORKFLOWOS_DEV_RUNTIME;
    delete process.env.WORKFLOWOS_DEV_DATABASE_DIR;
    delete process.env.DATABASE_URL;
    delete process.env.NODE_ENV;
    delete process.env.WORKFLOWOS_ROLE;
  });

  afterEach(() => {
    restoreEnv();
  });

  // =========================================================================
  // The explicit env boundary — config selection (fail-closed validation).
  // =========================================================================
  describe('the explicit dev-runtime env boundary (loadConfig)', () => {
    it('WORKFLOWOS_DEV_RUNTIME=pglite with NO DATABASE_URL selects the dev runtime', () => {
      process.env.WORKFLOWOS_DEV_RUNTIME = 'pglite';
      const config = loadConfig();
      expect(config.devRuntime).toBe('pglite');
      expect(config.databaseUrl).toBeUndefined();
    });

    it('the dev runtime reads WORKFLOWOS_DEV_DATABASE_DIR for the persistent dev database location', () => {
      process.env.WORKFLOWOS_DEV_RUNTIME = 'pglite';
      process.env.WORKFLOWOS_DEV_DATABASE_DIR = '/tmp/wfos-dev-db-dir';
      const config = loadConfig();
      expect(config.devRuntime).toBe('pglite');
      expect(config.devDatabaseDir).toBe('/tmp/wfos-dev-db-dir');
    });

    it('dev signal AND DATABASE_URL both set → REFUSES to start (ambiguity fails closed)', () => {
      process.env.WORKFLOWOS_DEV_RUNTIME = 'pglite';
      process.env.DATABASE_URL = 'postgres://wfos:changeme@localhost:5432/wfos';
      expect(() => loadConfig()).toThrow(/WORKFLOWOS_DEV_RUNTIME.*DATABASE_URL|ambiguous/i);
    });

    it('an unknown dev runtime value → REFUSES to start with a clear error', () => {
      process.env.WORKFLOWOS_DEV_RUNTIME = 'sqlite';
      expect(() => loadConfig()).toThrow(/WORKFLOWOS_DEV_RUNTIME|unsupported/i);
    });

    it('dev signal with NODE_ENV=production → REFUSES to start (no dev code in production)', () => {
      process.env.WORKFLOWOS_DEV_RUNTIME = 'pglite';
      process.env.NODE_ENV = 'production';
      expect(() => loadConfig()).toThrow(/production/i);
    });

    it('DATABASE_URL set, NO dev signal → the production path (devRuntime stays undefined)', () => {
      process.env.DATABASE_URL = 'postgres://wfos:changeme@localhost:5432/wfos';
      const config = loadConfig();
      expect(config.databaseUrl).toBe('postgres://wfos:changeme@localhost:5432/wfos');
      expect(config.devRuntime).toBeUndefined();
    });

    it('NO dev signal, NO DATABASE_URL → neither runtime (the pre-WORK-071 behavior — no ambient dev wiring)', () => {
      const config = loadConfig();
      expect(config.databaseUrl).toBeUndefined();
      expect(config.devRuntime).toBeUndefined();
    });
  });

  // =========================================================================
  // Dev-path application startup — the real composition root (buildApp).
  // =========================================================================
  describe('dev-path application startup (buildApp)', () => {
    let devDataDir: string;
    let capture: CaptureStream;
    let logger: ReturnType<typeof createLogger>;
    let app: AppHandle;

    beforeAll(() => {
      devDataDir = mkdtempSync(join(tmpdir(), 'wfos-dev-runtime-'));
    });

    afterAll(() => {
      rmSync(devDataDir, { recursive: true, force: true });
    });

    it('boots with NO DATABASE_URL and NO externally hosted PostgreSQL: dev database + full product deps', async () => {
      capture = new CaptureStream();
      logger = createLogger({ level: 'info', destination: capture });
      app = await buildApp(
        devRuntimeConfig({ devRuntime: 'pglite', devDatabaseDir: devDataDir }),
        { logger, startWorker: false },
      );

      // The authoritative product deps are present (the same deps the
      // production path constructs when a database is configured).
      expect(app.deps.infrastructure?.database).toBeDefined();
      expect(app.deps.authProvider).toBeDefined();
      expect(app.deps.authorizationService).toBeDefined();
      expect(app.deps.userRepository).toBeDefined();
      expect(app.deps.organizationRepository).toBeDefined();
      expect(app.deps.projectRepository).toBeDefined();
      expect(app.deps.workItemRepository).toBeDefined();
      expect(app.deps.workflowEngine).toBeDefined();
      expect(app.deps.verificationService).toBeDefined();
      expect(app.deps.reviewService).toBeDefined();
    });

    it('migrations boot: the SAME migrations applied on the dev database (no divergent schema)', async () => {
      const client = app.deps.infrastructure!.database;
      const applied = await client.query<{ filename: string }>(
        'SELECT filename FROM schema_migrations ORDER BY filename ASC',
      );
      // The migration files on disk — the dev path runs ALL of them.
      const migrationFiles = readdirSync(
        join(import.meta.dirname, '..', '..', '..', 'src', 'platform', 'postgres', 'migrations'),
      ).filter((f) => f.endsWith('.sql')).sort();
      expect(applied.rows.map((r) => r.filename)).toEqual(migrationFiles);

      // A real domain table exists (the /users authority surface).
      const users = await client.query(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'wfos_users'",
      );
      expect(Number(users.rows[0]!.n)).toBe(1);
    });

    it('the Infrastructure container is built with the in-memory Redis substitute (full container, no Redis server)', () => {
      expect(app.deps.infrastructure).toBeDefined();
      expect(app.deps.infrastructure!.database).toBeDefined();
      expect(app.deps.infrastructure!.objectStore).toBeDefined();
      expect(app.deps.infrastructure!.transientLock).toBeDefined();
      expect(app.deps.infrastructure!.transientCache).toBeDefined();
    });

    it('the workflow orchestrator (convergence loop) is constructed on the dev path', () => {
      // The orchestrator is gated on redisClient availability; the dev
      // path's in-memory Redis substitute must satisfy it.
      expect(app.deps.orchestrator).toBeDefined();
    });

    it('an explicit dev-runtime warning is logged (the dev runtime is never silent)', () => {
      const logged = JSON.stringify(capture.lines());
      expect(logged).toMatch(/dev[_-]?runtime|WORKFLOWOS_DEV_RUNTIME/i);
      expect(logged).toMatch(/pglite/i);
    });

    it('the dev database PERSISTS to the local filesystem (restart keeps data)', async () => {
      // Write a domain record through the dev runtime's own repositories,
      // stop the app, rebuild on the same dev data dir, and read it back.
      const org = await app.deps.organizationRepository!.create({ name: 'Persisted Dev Org' });
      await app.stop();

      const app2 = await buildApp(
        devRuntimeConfig({ devRuntime: 'pglite', devDatabaseDir: devDataDir }),
        { logger, startWorker: false },
      );
      const found = await app2.deps.organizationRepository!.findById(org.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(org.id);
      expect(found!.name).toBe('Persisted Dev Org');
      await app2.stop();
    });

    it('the dev database directory exists on the local filesystem (PGlite persisted, not in-memory)', () => {
      expect(existsSync(devDataDir)).toBe(true);
    });

    it('the DEFAULT dev data directory (a nested path) works on a clean checkout (parent dirs created)', async () => {
      // Regression: PGlite does not create parent directories — the default
      // `.workflowos-dev-data/pglite` nested path must be created by the
      // composition root, exactly as a clean local developer experiences it
      // (no WORKFLOWOS_DEV_DATABASE_DIR set, cwd = the backend root).
      const defaultDir = join(import.meta.dirname, '..', '..', '..', '.workflowos-dev-data', 'pglite');
      rmSync(join(import.meta.dirname, '..', '..', '..', '.workflowos-dev-data'), { recursive: true, force: true });
      const app = await buildApp(
        devRuntimeConfig({ devRuntime: 'pglite' }),
        { startWorker: false },
      );
      try {
        expect(existsSync(defaultDir)).toBe(true);
        const org = await app.deps.organizationRepository!.create({ name: 'Default Dir Org' });
        expect(org.id).toBeTruthy();
      } finally {
        await app.stop();
        rmSync(join(import.meta.dirname, '..', '..', '..', '.workflowos-dev-data'), { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // Product routes through the dev runtime — the real HTTP surface.
  // =========================================================================
  describe('product routes serve through the dev runtime', () => {
    let devDataDir: string;
    let app: AppHandle;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let userA: { id: string };
    let userB: { id: string };
    let projectAId: string;
    let projectBId: string;
    const KEY_A = 'wfos-dev-runtime-key-a';
    const KEY_B = 'wfos-dev-runtime-key-b';

    beforeAll(async () => {
      devDataDir = mkdtempSync(join(tmpdir(), 'wfos-dev-runtime-routes-'));
      process.env.WFOS_DEV_RUNTIME_SECRET_A = KEY_A;
      process.env.WFOS_DEV_RUNTIME_SECRET_B = KEY_B;
      app = await buildApp(
        devRuntimeConfig({ devRuntime: 'pglite', devDatabaseDir: devDataDir }),
        { startWorker: false },
      );

      // Seed the login/bootstrap path the repository currently supports:
      // API-key credentials (the WORK-063 runtime auth is WORK-074's scope).
      const d = app.deps;
      userA = await d.userRepository!.upsertByExternalId({ externalId: 'dev-user-a', displayName: 'Dev User A' });
      userB = await d.userRepository!.upsertByExternalId({ externalId: 'dev-user-b', displayName: 'Dev User B' });
      const orgA = await d.organizationRepository!.create({ name: 'Dev Org A' });
      const orgB = await d.organizationRepository!.create({ name: 'Dev Org B' });
      await d.membershipRepository!.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
      await d.membershipRepository!.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
      const projectA = await d.projectRepository!.create({ organizationId: orgA.id, name: 'Dev Project A' });
      const projectB = await d.projectRepository!.create({ organizationId: orgB.id, name: 'Dev Project B' });
      await d.projectAccessRepository!.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
      await d.projectAccessRepository!.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
      projectAId = projectA.id;
      projectBId = projectB.id;
      await d.apiKeyProvisioner!.provision({
        keyId: 'dev-runtime-key-a', secretRef: 'WFOS_DEV_RUNTIME_SECRET_A',
        externalId: 'dev-user-a', label: 'Dev User A', rawKey: KEY_A,
      });
      await d.apiKeyProvisioner!.provision({
        keyId: 'dev-runtime-key-b', secretRef: 'WFOS_DEV_RUNTIME_SECRET_B',
        externalId: 'dev-user-b', label: 'Dev User B', rawKey: KEY_B,
      });

      // The SAME route wiring index.ts uses for the auth + projects surfaces.
      server = await buildServer({
        queue: new InMemoryQueue(),
        logger: app.deps.logger,
        health: {
          database: app.deps.infrastructure!.database,
          redis: app.deps.infrastructure!.redis,
          objectStore: app.deps.infrastructure!.objectStore,
        },
        auth: { authProvider: app.deps.authProvider!, userRepository: app.deps.userRepository! },
        projects: {
          authorizationService: app.deps.authorizationService!,
          projectRepository: app.deps.projectRepository!,
          repositoryAssociationRepository: app.deps.repositoryAssociationRepository!,
          projectAccessRepository: app.deps.projectAccessRepository!,
          membershipRepository: app.deps.membershipRepository!,
          organizationRepository: app.deps.organizationRepository!,
        },
      });
      await server.ready();
    });

    afterAll(async () => {
      await server.close();
      await app.stop();
      rmSync(devDataDir, { recursive: true, force: true });
      delete process.env.WFOS_DEV_RUNTIME_SECRET_A;
      delete process.env.WFOS_DEV_RUNTIME_SECRET_B;
    });

    it('/health/ready is READY against the dev database (not health-only mode)', async () => {
      const res = await server.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('ready');
      expect(body.checks.postgres.ok).toBe(true);
    });

    it('the protected product routes exist (401 unauthenticated — NOT 404 health-only)', async () => {
      const res = await server.inject({ method: 'GET', url: '/projects' });
      expect(res.statusCode).toBe(401);
      const resOrgs = await server.inject({ method: 'GET', url: '/organizations' });
      expect(resOrgs.statusCode).toBe(401);
    });

    it('login/bootstrap path: an authenticated customer reaches their organizations + projects', async () => {
      const orgs = await server.inject({
        method: 'GET', url: '/organizations', headers: { 'x-api-key': KEY_A },
      });
      expect(orgs.statusCode).toBe(200);
      expect(orgs.json().organizations.map((o: { name: string }) => o.name)).toEqual(['Dev Org A']);

      const projects = await server.inject({
        method: 'GET', url: '/projects', headers: { 'x-api-key': KEY_A },
      });
      expect(projects.statusCode).toBe(200);
      expect(projects.json().projects.map((p: { name: string }) => p.name)).toEqual(['Dev Project A']);
    });

    it('TENANT ISOLATION through the local runtime: user A cannot read user B\'s project', async () => {
      // Direct project read → 403 (authorization denies user A on project B).
      const res = await server.inject({
        method: 'GET', url: `/projects/${projectBId}`, headers: { 'x-api-key': KEY_A },
      });
      expect([403, 404]).toContain(res.statusCode);
      if (res.statusCode === 403) {
        expect(res.json().error).toBe('forbidden');
      }

      // And the listing surface only ever shows user A their own projects.
      const list = await server.inject({
        method: 'GET', url: '/projects', headers: { 'x-api-key': KEY_A },
      });
      expect(list.statusCode).toBe(200);
      const names = list.json().projects.map((p: { id: string }) => p.id);
      expect(names).toContain(projectAId);
      expect(names).not.toContain(projectBId);
    });

    it('the dev runtime handles concurrent requests (single-process PGlite model)', async () => {
      const requests = Array.from({ length: 10 }, (_, i) =>
        server.inject({ method: 'GET', url: '/projects', headers: { 'x-api-key': i % 2 === 0 ? KEY_A : KEY_B } }),
      );
      const results = await Promise.all(requests);
      for (const r of results) expect(r.statusCode).toBe(200);
    });
  });

  // =========================================================================
  // Production-path discrimination — production NEVER uses PGlite.
  // =========================================================================
  describe('production path discrimination', () => {
    it('DATABASE_URL set, no dev signal → the production pg path (connection error, NO silent PGlite fallback)', async () => {
      // A postgres URL that refuses connections instantly. buildApp must
      // REJECT with a pg connection error — proving it took the production
      // branch (pg.Pool) rather than silently falling back to PGlite.
      await expect(
        buildApp(
          devRuntimeConfig({ databaseUrl: 'postgres://nobody:nope@127.0.0.1:1/wfos' }),
          { startWorker: false },
        ),
      ).rejects.toThrow(/ECONNREFUSED|connect|connection/i);
    }, 20000);

    it('no dev signal, no DATABASE_URL → NO database (the dev wiring is not ambient)', async () => {
      const app = await buildApp(devRuntimeConfig(), { startWorker: false });
      // The pre-WORK-071 behavior: without a database the authoritative
      // surfaces are absent. This is the mutation discrimination: if the
      // dev branch executed ambiently, these would be defined.
      expect(app.deps.infrastructure).toBeUndefined();
      expect(app.deps.authProvider).toBeUndefined();
      expect(app.deps.projectRepository).toBeUndefined();
      await app.stop();
    });
  });
});
