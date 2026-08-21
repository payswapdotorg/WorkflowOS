import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger.js';

/**
 * Transient, distributed lock backed by Redis (DATA-002).
 *
 * Used for short-lived coordination: preventing duplicate webhook processing,
 * serializing a non-idempotent operation across workers, etc. The lock is
 * deliberately NOT authoritative application state (architecture §29,
 * `DATA2-AC-02`): losing Redis (or calling {@link release} / letting the TTL
 * expire) MUST NOT destroy any persisted WorkflowOS state.
 *
 * Implementation: Redis `SET key value NX PX <ttl>` for atomic acquire, and a
 * Lua-guarded `DEL` for release that only deletes when the caller owns the
 * lock (token comparison). This prevents a slow holder from releasing a lock
 * it no longer owns.
 */
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export interface AcquireOptions {
  /** Lock time-to-live in milliseconds. The lock auto-releases after this. */
  ttlMs: number;
}

export interface AcquiredLock {
  /** The lock key. */
  readonly key: string;
  /** The opaque ownership token. Used by {@link TransientLock.release}. */
  readonly token: string;
  /** Releases the lock. No-op if the TTL has expired or the lock is held by another caller. */
  release(): Promise<void>;
}

export class TransientLock {
  constructor(
    private readonly redis: Redis,
    private readonly logger?: Logger,
  ) {}

  /**
   * Attempt to acquire `key`. Returns the lock on success, `null` if the key
   * is already held (or any other acquire failure).
   */
  async acquire(key: string, options: AcquireOptions): Promise<AcquiredLock | null> {
    const token = randomUUID();
    const result = await this.redis.set(key, token, 'PX', options.ttlMs, 'NX');
    if (result !== 'OK') {
      this.logger?.debug('transient_lock.acquire_failed', { key });
      return null;
    }
    this.logger?.debug('transient_lock.acquired', { key, ttlMs: options.ttlMs });
    const redis = this.redis;
    const log = this.logger;
    return {
      key,
      token,
      async release(): Promise<void> {
        await redis.eval(RELEASE_SCRIPT, 1, key, token);
        log?.debug('transient_lock.released', { key });
      },
    };
  }

  /**
   * Convenience: run `fn` while holding `key`. The lock is always released
   * when `fn` returns (or throws). Returns the value of `fn`, or `null` if
   * the lock could not be acquired.
   */
  async withLock<T>(
    key: string,
    options: AcquireOptions,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const lock = await this.acquire(key, options);
    if (!lock) return null;
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }
}
