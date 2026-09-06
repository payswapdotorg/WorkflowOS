/**
 * REALITY-REPAIR-001 — the real deployment composition serves the V2 product
 * routes (deterministic integration proof over the REAL entrypoint).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-001.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-001 ACCEPT).
 *
 * F-001 (the audit's release-blocking composition gap): `api/server.ts`
 * registers the seven V2 product route groups only when their optional deps
 * objects are passed, and the REAL deployment entry (`src/index.ts` — also
 * the docker-compose CMD `bun src/index.ts`) passed none of them, so every
 * V2 product surface 404'd behind the universal shell while migrations
 * 0060–0062 DID run.
 *
 * This test boots the REAL entrypoint AS A PROCESS — `bun src/index.ts` on
 * the WORK-071 pglite dev runtime (the same real-PostgreSQL-WASM
 * DatabaseClient + the SAME migrations as production) with WORKFLOWOS_ROLE=all
 * — and proves, at the HTTP boundary a deployed container actually exposes:
 *
 *   1. the entry boots and serves /health (the audit's DEP-1 precondition);
 *   2. a representative AUTH-GATED READ (or create-then-read pair where the
 *      group has no list route) from EVERY V2 product route group returns a
 *      real route response — 200/201 with the group's typed payload shape —
 *      rather than the Fastify unrouted 404:
 *        V2-002  GET  /organizations/:orgId/workflow-repository/workflows
 *        V2-005  GET  /organizations/:orgId/workflow-runs/runs
 *        V2-009  GET  /organizations/:orgId/workflow-deployments/deployments
 *        V2-006  POST /teaching-sessions/sessions → GET …/sessions/:sessionId
 *        V2-010  POST /reverse-teaching/sessions → GET …/sessions/:sessionId
 *        V2-011  POST /workflow-optimization/analyze + GET …/proposals
 *        V2-012  GET  /marketplace/listings
 *   3. the existing identity/organizations/engineering routes REMAIN
 *      functional on the same composition (password register/login session,
 *      organization creation, the /projects read);
 *   4. the unrouted-404 shape is NEGATIVELY discriminated: a genuinely
 *      missing route still answers the Fastify generic 404, so a passing
 *      group assertion can never be satisfied by the generic 404 body.
 *
 * Composition discipline (the Work Order's non-goals): this test must pass
 * with ZERO changes to any V2 module, any route file, or the server — the
 * ONLY production surface authorized for this repair is the deployment
 * composition (`src/index.ts` + the shared-database exposure on AppDeps).
 *
 * The seed (register → org → workflow → install → listing) flows through the
 * REAL routes exactly as the audit's persona seeding did — no direct DB
 * writes, no second authority.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  spawn,
  type ChildProcessByStdio,
} from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import {
  authorNotifyDocument,
  versionContentOf,
} from '../workflow-deployments/trigger-test-support.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = join(HERE, '..', '..', '..');

/** The persona (deterministic per run — the DB dir is fresh every run). */
const PERSONA_EMAIL = 'reality-repair-001@deployment.test';
const PERSONA_PASSWORD = 'the-reality-repair-password-42';
const ORG_NAME = 'Reality Repair Verification Org';

interface SpawnedEntry {
  readonly port: number;
  readonly baseUrl: string;
  /** The current wfos_session cookie token (updated on every Set-Cookie). */
  readonly cookie: () => string;
  /** The session-cookie setter (call() updates it from Set-Cookie). */
  readonly setCookie: (token: string) => void;
  readonly stop: () => Promise<void>;
}

/** Find a free TCP port (listen(0) → read the assigned port → close). */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    srv.on('error', reject);
  });
}

/** Poll a URL until it answers ok (the entry's readiness signal). */
async function waitUntilHealthy(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the real deployment entry never became healthy (last: ${lastError})`);
}

/** The REAL entry's environment (the pglite dev runtime, role=all). */
function entryEnv(port: number, dataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WORKFLOWOS_DEV_RUNTIME: 'pglite',
    WORKFLOWOS_ROLE: 'all',
    WORKFLOWOS_DEV_DATABASE_DIR: dataDir,
    PORT: String(port),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
    // The entry must not inherit a production NODE_ENV (WORK-071 refuses
    // the dev runtime under production) nor a stray DATABASE_URL.
    NODE_ENV: 'test',
    DATABASE_URL: '',
  };
}

/** Boot the REAL deployment entry as a process (the docker-compose CMD). */
async function spawnRealEntry(): Promise<SpawnedEntry> {
  const port = await findFreePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'reality-repair-001-pglite-'));
  // The docker-compose CMD is `bun src/index.ts` — run the entry under the
  // same runtime when available (fallback: the repo's tsx start script).
  const useBun = await new Promise<boolean>((resolve) => {
    const probe = spawn('bun', ['--version'], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('exit', (code) => resolve(code === 0));
  });
  const child: ChildProcessByStdio<null, Readable, Readable> = useBun
    ? spawn('bun', ['src/index.ts'], {
        cwd: BACKEND_ROOT,
        env: entryEnv(port, dataDir),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawn(process.execPath, [join('node_modules', '.bin', 'tsx'), 'src/index.ts'], {
        cwd: BACKEND_ROOT,
        env: entryEnv(port, dataDir),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
  const stderrTail: string[] = [];
  child.stderr.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) stderrTail.push(s);
  });
  const cookieHolder = { value: '' };
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitUntilHealthy(baseUrl, 60_000);
  } catch (err) {
    child.kill('SIGTERM');
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\nentry stderr tail:\n${stderrTail.slice(-20).join('\n')}`,
    );
  }
  return {
    port,
    baseUrl,
    cookie: () => cookieHolder.value,
    setCookie: (token: string) => {
      cookieHolder.value = token;
    },
    stop: async () => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 10_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * A JSON fetch over the entry's own auth channel (the wfos_session cookie —
 * the same HttpOnly channel the browser uses). Set-Cookie responses update
 * the entry's session token (register and login both set it).
 */
async function call(
  entry: SpawnedEntry,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${entry.baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(entry.cookie() ? { cookie: `wfos_session=${entry.cookie()}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const match = /wfos_session=([^;]+)/.exec(setCookie);
    if (match) entry.setCookie(match[1]!);
  }
  return { status: res.status, json, text };
}

describe('REALITY-REPAIR-001 — the real deployment entry serves the V2 product routes', () => {
  let entry: SpawnedEntry;
  let orgId = '';
  let workflowId = '';
  let versionId = '';
  let installationId = '';

  beforeAll(async () => {
    entry = await spawnRealEntry();
  }, 120_000);

  afterAll(async () => {
    await entry.stop();
  }, 30_000);

  it(
    'boots the real entry and the unrouted-404 shape is the negative control',
    async () => {
      const health = await call(entry, 'GET', '/health');
      expect(health.status).toBe(200);
      // A genuinely missing route answers Fastify's generic 404 — this is
      // the shape the V2 product routes must NOT answer with (F-001).
      const missing = await call(entry, 'GET', '/reality-repair-001-no-such-route');
      expect(missing.status).toBe(404);
      expect(String((missing.json as { message?: string } | null)?.message ?? '')).toContain(
        'not found',
      );
    },
    30_000,
  );

  it(
    'identity + organizations + engineering routes remain functional (register → login → org → /projects)',
    async () => {
      const register = await call(entry, 'POST', '/auth/password/register', {
        email: PERSONA_EMAIL,
        password: PERSONA_PASSWORD,
        displayName: 'Reality Repair Verifier',
      });
      expect(register.status).toBe(201);

      const login = await call(entry, 'POST', '/auth/password/login', {
        email: PERSONA_EMAIL,
        password: PERSONA_PASSWORD,
      });
      expect(login.status).toBe(200);
      expect(login.json).toHaveProperty('user');
      expect(entry.cookie()).not.toBe('');

      const org = await call(entry, 'POST', '/organizations', { name: ORG_NAME });
      expect(org.status).toBe(201);
      orgId = (org.json as { organization: { id: string } }).organization.id;
      expect(orgId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const projects = await call(entry, 'GET', '/projects');
      expect(projects.status).toBe(200);

      const ready = await call(entry, 'GET', '/health/ready');
      expect(ready.status).toBe(200);
    },
    60_000,
  );

  it(
    'V2-002 workflow repository: author + representative read (was the F-001 404)',
    async () => {
      const create = await call(entry, 'POST', `/organizations/${orgId}/workflow-repository/workflows`, {
        slug: 'reality-repair-001-notify',
        name: 'Reality Repair Notify',
        description: 'The REALITY-REPAIR-001 representative workflow',
        visibility: 'public',
        content: versionContentOf(authorNotifyDocument()),
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      });
      expect(create.status).toBe(201);
      workflowId = (create.json as { workflow: { id: string } }).workflow.id;
      versionId = (create.json as { initialVersion: { id: string } }).initialVersion.id;

      const list = await call(entry, 'GET', `/organizations/${orgId}/workflow-repository/workflows`);
      expect(list.status).toBe(200);
      const items = (list.json as { workflows: Array<{ id: string }> }).workflows;
      expect(items.some((w) => w.id === workflowId)).toBe(true);

      const installations = await call(
        entry,
        'POST',
        `/organizations/${orgId}/workflow-repository/installations`,
        { workflowId, versionId },
      );
      expect(installations.status).toBe(201);
      installationId = (installations.json as { installation: { id: string } }).installation.id;
    },
    60_000,
  );

  it(
    'V2-005 workflow runs: representative read (was the F-001 404)',
    async () => {
      const runs = await call(entry, 'GET', `/organizations/${orgId}/workflow-runs/runs`);
      expect(runs.status).toBe(200);
      expect(Array.isArray((runs.json as { runs?: unknown }).runs)).toBe(true);
    },
    30_000,
  );

  it(
    'V2-009 workflow deployments: representative read (was the F-001 404)',
    async () => {
      const deployments = await call(
        entry,
        'GET',
        `/organizations/${orgId}/workflow-deployments/deployments`,
      );
      expect(deployments.status).toBe(200);
      expect(Array.isArray((deployments.json as { deployments?: unknown }).deployments)).toBe(true);
    },
    30_000,
  );

  it(
    'V2-006 teaching sessions: create + read over the real pin (was the F-001 404)',
    async () => {
      const create = await call(entry, 'POST', '/teaching-sessions/sessions', {
        workflowId,
        versionId,
      });
      expect(create.status).toBe(201);
      const sessionId = (create.json as { session: { id: string } }).session.id;
      expect(sessionId.length).toBeGreaterThan(0);

      const read = await call(entry, 'GET', `/teaching-sessions/sessions/${sessionId}`);
      expect(read.status).toBe(200);
      expect((read.json as { session: { id: string } }).session.id).toBe(sessionId);
    },
    30_000,
  );

  it(
    'V2-010 reverse teaching: create + read over the real pin (was the F-001 404)',
    async () => {
      const create = await call(entry, 'POST', '/reverse-teaching/sessions', {
        organizationId: orgId,
        workflowId,
        versionId,
        installationId,
      });
      expect(create.status).toBe(201);
      const sessionId = (create.json as { session: { id: string } }).session.id;

      const read = await call(entry, 'GET', `/reverse-teaching/sessions/${sessionId}`);
      expect(read.status).toBe(200);
      expect((read.json as { session: { id: string } }).session.id).toBe(sessionId);
    },
    30_000,
  );

  it(
    'V2-011 workflow optimization: analyze + proposals read (was the F-001 404)',
    async () => {
      const analyze = await call(entry, 'POST', '/workflow-optimization/analyze', {
        workflowId,
        versionId,
      });
      expect(analyze.status).toBe(200);
      expect((analyze.json as { analysis?: unknown }).analysis).toBeDefined();

      const proposals = await call(
        entry,
        'GET',
        `/workflow-optimization/proposals?workflowId=${encodeURIComponent(workflowId)}`,
      );
      expect(proposals.status).toBe(200);
      expect(Array.isArray((proposals.json as { proposals?: unknown }).proposals)).toBe(true);
    },
    30_000,
  );

  it(
    'V2-012 marketplace: representative read (was the F-001 404)',
    async () => {
      const listings = await call(entry, 'GET', '/marketplace/listings');
      expect(listings.status).toBe(200);
      expect(Array.isArray((listings.json as { listings?: unknown }).listings)).toBe(true);
    },
    30_000,
  );
});
