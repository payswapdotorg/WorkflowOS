import {
  createPgliteDatabaseClient,
} from '@platform/postgres/pglite-database-client.js';
import { runMigrations } from '@platform/postgres/migration-runner.js';
import { createLogger } from '@platform/logger.js';
import type { DatabaseClient, DatabaseTx, QueryParams } from '@platform/postgres/database-client.js';
import type { QueryResult, QueryResultRow } from 'pg';
import { Client as PgClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { CaptureStream } from './capture-stream.js';

/**
 * Test database harness for WORK-003.
 *
 * Selects a real PostgreSQL backend:
 *
 * - When `WORKFLOWOS_DATABASE_URL` is set (CI with a real postgres service),
 *   uses a real `pg` connection against that server, isolated per call via a
 *   unique schema (`wfos_test_<uuid>`) so parallel test files do not collide.
 * - Otherwise (local dev), uses `@electric-sql/pglite` (real PostgreSQL
 *   compiled to WASM, in-process). Each pglite instance is already isolated,
 *   so no schema isolation is needed.
 *
 * In both cases the test exercises real PostgreSQL relational semantics:
 * real foreign keys, real transactions, real `SERIAL`/`UUID` defaults. No fake
 * in-memory database is used as proof of DATA-AC-03.
 *
 * **Parallel-safety (Correction 1):** the real-pg path creates a unique
 * schema per `buildTestDatabase()` call and scopes all DDL/DML to it via
 * `SET search_path`. Each test file gets its own schema, so parallel vitest
 * workers never drop/truncate each other's tables. The schema is dropped on
 * `close()`.
 */
export interface TestDatabase {
  client: DatabaseClient;
  logger: ReturnType<typeof createLogger>;
  capture: CaptureStream;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * A `DatabaseClient` backed by a single `pg.Client` connection with a
 * `search_path` scoped to a test schema. Used by the real-pg test path so
 * every statement (including those inside transactions) executes against the
 * per-call schema without per-query `SET` calls.
 */
class SchemaScopedPgDatabaseClient implements DatabaseClient {
  constructor(private readonly client: PgClient) {}

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: QueryParams,
  ): Promise<QueryResult<R>> {
    return this.client.query<R>(text, params as never) as Promise<QueryResult<R>>;
  }

  async exec(text: string): Promise<void> {
    await this.client.query(text);
  }

  async transaction<R>(fn: (tx: DatabaseTx) => Promise<R>): Promise<R> {
    await this.client.query('BEGIN');
    try {
      let result: R;
      try {
        result = await fn({
          query: (t, p) => this.client.query(t, p),
          exec: async (t) => {
            await this.client.query(t);
          },
        });
      } catch (err) {
        await this.client.query('ROLLBACK');
        throw err;
      }
      await this.client.query('COMMIT');
      return result;
    } catch (outerErr) {
      try {
        await this.client.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw outerErr;
    }
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

/**
 * Build a test database isolated for the calling test file.
 *
 * Real-pg path: creates schema `wfos_test_<uuid>`, sets `search_path`, runs
 * migrations within it, and drops the schema on `close()`.
 * Pglite path: fresh in-memory instance per call (already isolated).
 */
export async function buildTestDatabase(): Promise<TestDatabase> {
  const capture = new CaptureStream();
  const logger = createLogger({ level: 'info', destination: capture });

  const databaseUrl = process.env.WORKFLOWOS_DATABASE_URL;
  let client: DatabaseClient;
  let cleanup: (() => Promise<void>) | undefined;

  if (databaseUrl && databaseUrl.startsWith('postgres')) {
    // --- Real PostgreSQL path with per-call schema isolation. ---
    const schemaName = `wfos_test_${randomUUID().replace(/-/g, '_')}`;

    // Bootstrap connection (default search_path) to create the schema.
    const bootstrap = new PgClient(databaseUrl);
    await bootstrap.connect();
    try {
      await bootstrap.query(`CREATE SCHEMA ${schemaName}`);
    } finally {
      await bootstrap.end();
    }

    // Test connection scoped to the new schema.
    const testConn = new PgClient(databaseUrl);
    await testConn.connect();
    await testConn.query(`SET search_path TO ${schemaName}, public`);

    client = new SchemaScopedPgDatabaseClient(testConn);

    // Run migrations — tables are created in the test schema (search_path).
    await runMigrations(client, logger);

    cleanup = async () => {
      // Drop the schema via a fresh connection (the test connection may be
      // holding locks on objects within it).
      const dropper = new PgClient(databaseUrl);
      await dropper.connect();
      try {
        await dropper.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      } finally {
        await dropper.end();
      }
    };
  } else {
    // --- Pglite path (already isolated per-instance). ---
    client = await createPgliteDatabaseClient();
    await runMigrations(client, logger);
  }

  const reset = async () => {
    // Truncate infrastructure tables (preserve schema_migrations). Safe within
    // the per-call schema / isolated pglite instance.
    await client.exec(`
      TRUNCATE wfos_fixture_child, wfos_fixture_parent RESTART IDENTITY CASCADE;
      TRUNCATE wfos_artifact_metadata;
    `);
  };

  const close = async () => {
    await client.close();
    if (cleanup) await cleanup();
  };

  return { client, logger, capture, reset, close };
}
