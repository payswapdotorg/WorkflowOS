import type { FastifyInstance } from 'fastify';
import type { DatabaseClient, ObjectStore, Redis } from '@platform/index.js';

/**
 * Health check routes (WORK-001 liveness + WORK-023 readiness).
 *
 * `GET /health` — liveness probe. Returns `{ status: 'ok' }` as long as the
 * process is running. Used for deployment liveness checks and as a smoke test
 * in the integration test suite.
 *
 * `GET /health/ready` — readiness probe (WORK-023). Verifies that the process
 * can reach its authoritative dependencies:
 *   - PostgreSQL (SELECT 1)
 *   - Redis (PING)
 *   - ObjectStore (put + get a small probe object)
 *
 * Returns 200 `{ status: 'ready', checks: { ... } }` when all pass, or
 * 503 `{ status: 'not_ready', checks: { ... } }` when any fail. Each check
 * reports `ok: boolean` and an optional `error` string.
 *
 * The readiness endpoint is optional — when the deps are not wired (e.g. in
 * tests that don't need it), the route returns 200 with `checks: {}` (no
 * dependencies to check). This preserves the existing /health behaviour for
 * tests that don't provide deps.
 */
export interface HealthRouteDeps {
  /** PostgreSQL client for the readiness SELECT 1 check. Optional. */
  database?: DatabaseClient;
  /** Redis client for the readiness PING check. Optional. */
  redis?: Redis;
  /** ObjectStore for the readiness put+get check. Optional. */
  objectStore?: ObjectStore;
}

interface CheckResult {
  ok: boolean;
  error?: string;
  latencyMs?: number;
}

async function checkDatabase(db: DatabaseClient): Promise<CheckResult> {
  const start = Date.now();
  try {
    await db.query('SELECT 1 as ok');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: (err as Error).message, latencyMs: Date.now() - start };
  }
}

async function checkRedis(redis: Redis): Promise<CheckResult> {
  const start = Date.now();
  try {
    const pong = await redis.ping();
    if (pong !== 'PONG') {
      return { ok: false, error: `unexpected ping response: ${pong}`, latencyMs: Date.now() - start };
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: (err as Error).message, latencyMs: Date.now() - start };
  }
}

async function checkObjectStore(store: ObjectStore): Promise<CheckResult> {
  const start = Date.now();
  try {
    const body = Buffer.from('ok', 'utf8');
    const putResult = await store.put({ body, contentType: 'text/plain' });
    const retrieved = await store.get(putResult.key);
    if (!retrieved) {
      return { ok: false, error: 'object not found after put', latencyMs: Date.now() - start };
    }
    const content = retrieved.body.toString('utf8');
    if (content !== 'ok') {
      return { ok: false, error: 'object content mismatch', latencyMs: Date.now() - start };
    }
    // Clean up the probe object.
    await store.delete(putResult.key).catch(() => {});
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: (err as Error).message, latencyMs: Date.now() - start };
  }
}

export async function healthRoutes(
  app: FastifyInstance,
  deps: HealthRouteDeps = {},
): Promise<void> {
  // Liveness — always returns ok if the process is running.
  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // Readiness — verifies connectivity to PostgreSQL, Redis, ObjectStore.
  // WORK-023: used by deployment probes and the deployment validation test.
  app.get('/health/ready', async (_req, reply) => {
    const checks: Record<string, CheckResult> = {};

    const [dbCheck, redisCheck, storeCheck] = await Promise.all([
      deps.database ? checkDatabase(deps.database) : Promise.resolve(undefined),
      deps.redis ? checkRedis(deps.redis) : Promise.resolve(undefined),
      deps.objectStore ? checkObjectStore(deps.objectStore) : Promise.resolve(undefined),
    ]);

    if (dbCheck) checks.postgres = dbCheck;
    if (redisCheck) checks.redis = redisCheck;
    if (storeCheck) checks.objectStore = storeCheck;

    const allOk = Object.values(checks).every((c) => c.ok);

    if (allOk) {
      return reply.code(200).send({ status: 'ready', checks });
    }
    return reply.code(503).send({ status: 'not_ready', checks });
  });
}
