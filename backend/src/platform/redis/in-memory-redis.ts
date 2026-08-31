import type { Redis } from './redis-client.js';

/**
 * In-memory Redis substitute for the WORK-071 local development runtime.
 *
 * Redis is NOT authoritative application/workflow state (architecture §29,
 * `DATA2-AC-02`): it backs the transient lock, the transient cache, and
 * readiness probes — never persisted WorkflowOS state. This substitute lets
 * the FULL development runtime (the `Infrastructure` container with
 * `TransientLock`/`TransientCache`, the workflow orchestrator, the
 * `/health/ready` Redis check) run without a Redis server, exactly like
 * `InMemoryQueue` lets the queue boundary run without Redis.
 *
 * Scope — it implements exactly the Redis surface the platform consumes:
 *
 * - `set(key, value)` / `set(key, value, 'PX', ttlMs)` / `set(key, value, 'PX', ttlMs, 'NX')`
 *   ({@link TransientCache}, {@link TransientLock} acquire)
 * - `get` / `del` ({@link TransientCache}, key expiry)
 * - `eval(script, 1, key, token)` — the ONE Lua script the platform ships
 *   (the `TransientLock` token-guarded release); unknown scripts are
 *   rejected fail-closed with a clear error so an unsupported use is
 *   discovered immediately, never silently mis-executed.
 * - `ping` ({@link ../api/routes/health.route.js} readiness)
 * - `quit` / `disconnect` (lifecycle no-ops — nothing to close)
 *
 * It is a DEV-ONLY stand-in returned typed as the ioredis `Redis` contract
 * (the same boundary treatment as the test suite's `ioredis-mock`, which is
 * also cast to `Redis`); production constructs a real `ioredis` client via
 * {@link createRedisClient}. It is deliberately minimal: anything outside
 * the documented surface raises a loud `TypeError` at call time rather than
 * pretending to be a general Redis.
 *
 * TTL semantics follow Redis lazily: entries carry `expiresAt` and are
 * treated as absent once expired (checked on `get`, `set .. NX`, and the
 * release `eval`), so a lock holder that crashes releases its lock after
 * the TTL just like the real server.
 */

interface StoredValue {
  value: string;
  /** Epoch millis after which the entry is treated as absent. `null` = no expiry. */
  expiresAt: number | null;
}

/** The exact Lua release script `TransientLock` ships (token-guarded DEL). */
const TRANSIENT_LOCK_RELEASE_SCRIPT =
  `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

class InMemoryRedisEngine {
  private readonly store = new Map<string, StoredValue>();
  private closed = false;

  private assertOpen(): void {
    if (this.closed) throw new Error('InMemoryRedis (WORK-071 dev runtime): client is closed');
  }

  private live(key: string): StoredValue | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(key: string, value: string, ...rest: unknown[]): Promise<'OK' | null> {
    this.assertOpen();
    // Supported suffix shapes (the superset the platform uses):
    //   set(key, value)
    //   set(key, value, 'PX', ttlMs)
    //   set(key, value, 'PX', ttlMs, 'NX')
    let ttlMs: number | null = null;
    let nx = false;
    let i = 0;
    while (i < rest.length) {
      const token = rest[i];
      if (token === 'PX') {
        const ttl = rest[i + 1];
        if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
          throw new Error(`InMemoryRedis: unsupported set() TTL argument ${String(ttl)}`);
        }
        ttlMs = ttl;
        i += 2;
      } else if (token === 'NX') {
        nx = true;
        i += 1;
      } else {
        throw new Error(
          `InMemoryRedis (WORK-071 dev runtime): unsupported set() argument ${String(token)} — ` +
          `supported forms: set(key, value), set(key, value, 'PX', ttlMs, ['NX'])`,
        );
      }
    }
    if (nx && this.live(key) !== undefined) return null;
    this.store.set(key, {
      value,
      expiresAt: ttlMs === null ? null : Date.now() + ttlMs,
    });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.assertOpen();
    const entry = this.live(key);
    return entry ? entry.value : null;
  }

  async del(...keys: string[]): Promise<number> {
    this.assertOpen();
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(key)) removed += 1;
    }
    return removed;
  }

  async eval(script: string, numKeys: number, ...args: unknown[]): Promise<unknown> {
    this.assertOpen();
    if (script === TRANSIENT_LOCK_RELEASE_SCRIPT && numKeys === 1 && args.length === 2) {
      const [key, token] = args as [string, string];
      const entry = this.live(key);
      if (entry && entry.value === token) {
        this.store.delete(key);
        return 1;
      }
      return 0;
    }
    throw new Error(
      `InMemoryRedis (WORK-071 dev runtime): eval() supports only the TransientLock release ` +
      `script. Refusing to execute an unknown Lua script (fail-closed): ${script.slice(0, 60)}…`,
    );
  }

  async ping(): Promise<'PONG'> {
    this.assertOpen();
    return 'PONG';
  }

  async flushdb(): Promise<'OK'> {
    this.store.clear();
    return 'OK';
  }

  async quit(): Promise<'OK'> {
    this.closed = true;
    return 'OK';
  }

  disconnect(): void {
    this.closed = true;
  }
}

/**
 * Create the WORK-071 dev-runtime in-memory Redis substitute, typed as the
 * platform `Redis` contract (see the module docstring for the scope and the
 * rationale). Constructed only by the dev branch of the composition root —
 * never in production.
 */
export function createInMemoryRedis(): Redis {
  return new InMemoryRedisEngine() as unknown as Redis;
}
