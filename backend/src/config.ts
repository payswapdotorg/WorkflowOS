/**
 * Process configuration for the WorkflowOS backend.
 *
 * The modular monolith runs in two logical roles that share the same codebase:
 *
 * - `api`    — serves inbound HTTP traffic. Enqueues background jobs and
 *              returns immediately (PLAT-AC-03).
 * - `worker` — polls the queue and executes job handlers.
 *
 * The role is selected by the `WORKFLOWOS_ROLE` env var (or `--role=` CLI arg).
 * The default `all` runs both in a single process, which is convenient for
 * local development and for the integration tests.
 *
 * WORK-071 — the local development runtime substrate. The environment
 * boundary is EXPLICIT, never ambient:
 *
 * - production: `DATABASE_URL` set (no dev signal) → the production
 *   `PgDatabaseClient` against a networked PostgreSQL (DATA-AC-03 — the
 *   authoritative path, unchanged).
 * - development: `WORKFLOWOS_DEV_RUNTIME=pglite` set and `DATABASE_URL`
 *   unset → the dev-only runtime path (a PGlite-backed `DatabaseClient` —
 *   real PostgreSQL compiled to WASM, persisted to the local filesystem).
 *   The dev path runs the SAME migrations and the SAME domain code; it is a
 *   different implementation of the same `DatabaseClient` boundary, never a
 *   second persistence authority.
 * - test: no `DATABASE_URL`, no dev signal → no database is configured
 *   (tests construct their own PGlite clients through the test harness).
 *
 * The configuration FAILS CLOSED on ambiguity: the dev signal together with
 * a `DATABASE_URL`, the dev signal in a production-declared environment
 * (`NODE_ENV=production`), or an unsupported dev runtime value are all
 * refused with explicit errors at startup.
 */
export type ProcessRole = 'api' | 'worker' | 'all';

/**
 * WORK-071: the supported local-development runtimes.
 *
 * `pglite` — real PostgreSQL compiled to WASM (`@electric-sql/pglite`),
 * persisted to a local filesystem directory. Satisfies DATA-AC-03 (proof
 * from a real relational database, not a fake) while requiring no
 * externally hosted PostgreSQL server.
 */
export type DevRuntime = 'pglite';

export interface AppConfig {
  role: ProcessRole;
  port: number;
  host: string;
  redisUrl?: string;
  databaseUrl?: string;
  /**
   * WORK-071: the explicit dev-runtime signal (`WORKFLOWOS_DEV_RUNTIME`).
   * Present ONLY in local development; production never sets it. When set,
   * `databaseUrl` must be absent (ambiguity fails closed in loadConfig).
   */
  devRuntime?: DevRuntime;
  /**
   * WORK-071: the filesystem directory holding the persistent dev PGlite
   * database (`WORKFLOWOS_DEV_DATABASE_DIR`). Defaults to
   * {@link DEFAULT_DEV_DATABASE_DIR} relative to the process working
   * directory. Only meaningful when `devRuntime` is set.
   */
  devDatabaseDir?: string;
  objectStorageDir?: string;
  logLevel: string;
  /** PRODUCTION READINESS: env var name holding the GitHub webhook secret. */
  githubWebhookSecretRef?: string;
  /** PRODUCTION READINESS: CORS origin (the Vercel frontend URL). */
  corsOrigin?: string;
}

const DEFAULT_PORT = 3001;

/**
 * WORK-071: the default local directory for the persistent dev PGlite
 * database (resolved against the process working directory — the backend
 * root when started through the backend package scripts).
 */
export const DEFAULT_DEV_DATABASE_DIR = '.workflowos-dev-data/pglite';

/** The env var carrying the WORK-071 dev-runtime signal. */
export const DEV_RUNTIME_ENV_VAR = 'WORKFLOWOS_DEV_RUNTIME';

function resolveRole(): ProcessRole {
  const fromEnv = process.env.WORKFLOWOS_ROLE;
  if (fromEnv === 'api' || fromEnv === 'worker' || fromEnv === 'all') return fromEnv;
  // Allow `tsx src/index.ts --role=api`
  const arg = process.argv.find((a) => a.startsWith('--role='));
  if (arg) {
    const value = arg.slice('--role='.length);
    if (value === 'api' || value === 'worker' || value === 'all') return value;
  }
  return 'all';
}

/**
 * WORK-071: resolve + validate the dev-runtime signal. Fail-closed:
 *
 * - an unsupported value → refuse (a typo must never silently select the
 *   wrong runtime);
 * - the dev signal together with a PostgreSQL `DATABASE_URL` → refuse
 *   (ambiguity: which database is authoritative?);
 * - the dev signal with `NODE_ENV=production` → refuse (no dev-path code
 *   may execute in production).
 */
function resolveDevRuntime(databaseUrl: string | undefined): DevRuntime | undefined {
  const raw = process.env.WORKFLOWOS_DEV_RUNTIME;
  if (raw === undefined || raw === '') return undefined;

  if (raw !== 'pglite') {
    throw new Error(
      `Invalid ${DEV_RUNTIME_ENV_VAR}="${raw}" — the only supported local development runtime is ` +
      `"pglite" (real PostgreSQL compiled to WASM). Unset ${DEV_RUNTIME_ENV_VAR} to use the ` +
      `production path (DATABASE_URL → networked PostgreSQL), or set it to "pglite" for the ` +
      `local development runtime.`,
    );
  }

  if (databaseUrl) {
    throw new Error(
      `Ambiguous runtime configuration: ${DEV_RUNTIME_ENV_VAR}=pglite is set AND DATABASE_URL ` +
      `(${databaseUrl}) is set. The local development runtime and the production database path ` +
      `are mutually exclusive — the database authority must be unambiguous. For local development ` +
      `WITHOUT an externally hosted PostgreSQL, unset DATABASE_URL; for production (or local ` +
      `development WITH a hosted PostgreSQL), unset ${DEV_RUNTIME_ENV_VAR}.`,
    );
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `Refusing to start: ${DEV_RUNTIME_ENV_VAR}=pglite is set while NODE_ENV=production. The ` +
      `local development runtime is dev-only and MUST NOT execute in a production environment ` +
      `(the production path requires DATABASE_URL → networked PostgreSQL).`,
    );
  }

  return 'pglite';
}

export function loadConfig(): AppConfig {
  // Only treat DATABASE_URL as a postgres connection when it actually points
  // at postgres. This guards against ambient non-postgres DATABASE_URL values
  // (e.g. a SQLite file URL leaked from a sibling project in shared envs).
  // The WORK-071 ambiguity check below deliberately uses this NORMALIZED
  // value (an ambient non-postgres DATABASE_URL is ignored by the runtime,
  // so it is not an authority conflict).
  const rawDatabaseUrl = process.env.DATABASE_URL;
  const databaseUrl =
    rawDatabaseUrl && rawDatabaseUrl.startsWith('postgres')
      ? rawDatabaseUrl
      : undefined;
  const devRuntime = resolveDevRuntime(databaseUrl);
  return {
    role: resolveRole(),
    port: Number(process.env.PORT ?? DEFAULT_PORT),
    host: process.env.HOST ?? '0.0.0.0',
    redisUrl: process.env.REDIS_URL,
    databaseUrl,
    ...(devRuntime ? { devRuntime } : {}),
    ...(devRuntime
      ? { devDatabaseDir: process.env.WORKFLOWOS_DEV_DATABASE_DIR ?? DEFAULT_DEV_DATABASE_DIR }
      : {}),
    objectStorageDir: process.env.OBJECT_STORAGE_DIR,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    githubWebhookSecretRef: process.env.WORKFLOWOS_GITHUB_WEBHOOK_SECRET_REF ?? 'WORKFLOWOS_GITHUB_WEBHOOK_SECRET',
    corsOrigin: process.env.CORS_ORIGIN,
  };
}
