import {
  createPgliteDatabaseClient,
} from '@platform/postgres/pglite-database-client.js';
import { createDatabaseClient } from '@platform/postgres/database-factory.js';
import { runMigrations, resetMigrationsTable } from '@platform/postgres/migration-runner.js';
import { createLogger } from '@platform/logger.js';
import type { DatabaseClient } from '@platform/postgres/database-client.js';
import { CaptureStream } from './capture-stream.js';

/**
 * Test database harness for WORK-003.
 *
 * Selects a real PostgreSQL backend:
 *
 * - When `DATABASE_URL` is set (CI with a real postgres service), uses
 *   `pg.Pool` against that server.
 * - Otherwise (local dev), uses `@electric-sql/pglite` (real PostgreSQL
 *   compiled to WASM, in-process).
 *
 * In both cases the test exercises real PostgreSQL relational semantics:
 * real foreign keys, real transactions, real `SERIAL`/`UUID` defaults. No fake
 * in-memory database is used as proof of DATA-AC-03.
 *
 * Each suite gets an isolated database: pglite creates a fresh in-memory
 * instance per harness; the pg path uses a unique schema prefix per run so
 * parallel CI runs do not collide (future enhancement; for now CI uses a
 * single shared DB and tests are sequenced).
 */
export interface TestDatabase {
  client: DatabaseClient;
  logger: ReturnType<typeof createLogger>;
  capture: CaptureStream;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export async function buildTestDatabase(): Promise<TestDatabase> {
  const capture = new CaptureStream();
  const logger = createLogger({ level: 'info', destination: capture });

  // Use a real PostgreSQL server only when WORKFLOWOS_DATABASE_URL points at
  // one. We deliberately ignore the ambient DATABASE_URL env var (which in the
  // sandbox belongs to an unrelated project) — callers must opt in via
  // WORKFLOWOS_DATABASE_URL. This keeps the test selection explicit and avoids
  // accidentally hitting a non-postgres URL.
  const databaseUrl = process.env.WORKFLOWOS_DATABASE_URL;
  let client: DatabaseClient;
  if (databaseUrl && databaseUrl.startsWith('postgres')) {
    client = createDatabaseClient({ connectionString: databaseUrl });
  } else {
    client = await createPgliteDatabaseClient();
  }

  await resetMigrationsTable(client);
  // Drop infrastructure tables so the migration recreates them cleanly.
  // Use exec so this works on both pg and pglite (multi-statement).
  await client.exec(`
    DROP TABLE IF EXISTS wfos_fixture_child;
    DROP TABLE IF EXISTS wfos_fixture_parent;
    DROP TABLE IF EXISTS wfos_artifact_metadata;
  `);
  await runMigrations(client, logger);

  const reset = async () => {
    // Truncate infrastructure tables (preserve schema_migrations).
    await client.exec(`
      TRUNCATE wfos_fixture_child, wfos_fixture_parent RESTART IDENTITY CASCADE;
      TRUNCATE wfos_artifact_metadata;
    `);
  };

  const close = async () => {
    await client.close();
  };

  return { client, logger, capture, reset, close };
}
