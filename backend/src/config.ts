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
 */
export type ProcessRole = 'api' | 'worker' | 'all';

export interface AppConfig {
  role: ProcessRole;
  port: number;
  host: string;
  redisUrl?: string;
  databaseUrl?: string;
  objectStorageDir?: string;
  logLevel: string;
}

const DEFAULT_PORT = 3001;

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

export function loadConfig(): AppConfig {
  // Only treat DATABASE_URL as a postgres connection when it actually points
  // at postgres. This guards against ambient non-postgres DATABASE_URL values
  // (e.g. a SQLite file URL leaked from a sibling project in shared envs).
  const rawDatabaseUrl = process.env.DATABASE_URL;
  const databaseUrl =
    rawDatabaseUrl && rawDatabaseUrl.startsWith('postgres')
      ? rawDatabaseUrl
      : undefined;
  return {
    role: resolveRole(),
    port: Number(process.env.PORT ?? DEFAULT_PORT),
    host: process.env.HOST ?? '0.0.0.0',
    redisUrl: process.env.REDIS_URL,
    databaseUrl,
    objectStorageDir: process.env.OBJECT_STORAGE_DIR,
    logLevel: process.env.LOG_LEVEL ?? 'info',
  };
}
