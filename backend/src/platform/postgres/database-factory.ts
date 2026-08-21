import { Pool, type PoolConfig } from 'pg';
import type { DatabaseClient } from './database-client.js';
import { PgDatabaseClient } from './database-client.js';

/**
 * PostgreSQL connection factory (DATA-001).
 *
 * Centralizes connection configuration so domain modules never construct
 * their own `pg.Pool`. The factory returns the shared
 * {@link DatabaseClient} abstraction; callers must not depend on `pg`
 * directly.
 *
 * Configuration is read from the provided {@link PoolConfig} (or
 * `DATABASE_URL` env var by default). The pool size, ssl, and statement
 * timeout can be overridden via standard `pg` config.
 *
 * PostgreSQL is the authoritative WorkflowOS application/workflow state
 * (architecture §28, §2.1, `DATA-AC-03`).
 */
export function createDatabaseClient(config?: PoolConfig): DatabaseClient {
  const poolConfig: PoolConfig = config ?? defaultPoolConfig();
  const pool = new Pool(poolConfig);
  return new PgDatabaseClient(pool);
}

/**
 * Build the default `pg` pool config from the environment. Used when no
 * explicit config is passed to {@link createDatabaseClient}.
 */
export function defaultPoolConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL;
  return {
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis: Number(
      process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 5_000,
    ),
  };
}
