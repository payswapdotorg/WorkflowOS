import { PGlite } from '@electric-sql/pglite';
import type { DatabaseClient, DatabaseTx, QueryParams } from './database-client.js';
import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Pglite-backed {@link DatabaseClient} (real PostgreSQL compiled to WASM).
 *
 * Two sanctioned consumers:
 *
 * 1. The test suite — every integration test runs against a per-test PGlite
 *    instance (real PostgreSQL semantics without a database server).
 * 2. The WORK-071 local development runtime — the composition root's
 *    dev-only branch (`WORKFLOWOS_DEV_RUNTIME=pglite`, `DATABASE_URL`
 *    unset) constructs this adapter with a LOCAL FILESYSTEM directory so a
 *    clean local developer runs the real product surface with a persistent
 *    dev database and no externally hosted PostgreSQL.
 *
 * Pglite is NOT a fake in-memory database: it is the actual PostgreSQL
 * server compiled to WebAssembly, enforcing the same relational
 * constraints, foreign keys, and transaction semantics as a networked
 * PostgreSQL. This satisfies the DATA-AC-03 requirement that proof come
 * from a real relational database, not a fake.
 *
 * The API surface mirrors `pg`'s `query` so domain code written against
 * {@link DatabaseClient} works unchanged against either implementation —
 * the dev path runs the SAME migrations and the SAME domain code; it is a
 * different implementation of the ONE persistence boundary, never a second
 * authority.
 *
 * Production uses {@link PgDatabaseClient} (real `pg.Pool` against a
 * networked PostgreSQL) constructed by {@link createDatabaseClient} from
 * `DATABASE_URL`; the dev branch never executes in production (the config
 * layer refuses the dev signal under `NODE_ENV=production` and alongside
 * `DATABASE_URL`).
 */
export class PgliteDatabaseClient implements DatabaseClient {
  private readonly pglite: PGlite;

  constructor(connectionStringOrOptions?: string | ConstructorParameters<typeof PGlite>[0]) {
    this.pglite = new PGlite(connectionStringOrOptions as never);
  }

  /**
   * Initialize the pglite instance. Must be awaited before the first query.
   * Returned by {@link createPgliteDatabaseClient} already-initialized.
   */
  async init(): Promise<void> {
    // Pglite lazily initializes on first query; this warms it up so errors
    // surface at construction time.
    await this.pglite.query('SELECT 1 AS ok');
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: QueryParams,
  ): Promise<QueryResult<R>> {
    // Pglite's query() signature is compatible with pg's for the subset we use.
    const result = (await this.pglite.query(text, params as never)) as unknown as QueryResult<R>;
    return result;
  }

  async exec(text: string): Promise<void> {
    // Pglite's `exec` runs raw multi-statement SQL (simple query protocol).
    // Use this for migrations and other multi-statement DDL.
    await this.pglite.exec(text);
  }

  async transaction<R>(fn: (tx: DatabaseTx) => Promise<R>): Promise<R> {
    await this.pglite.exec('BEGIN');
    try {
      let result: R;
      try {
        result = await fn({
          query: (t, p) => this.query(t, p),
          exec: (t) => this.exec(t),
        });
      } catch (err) {
        await this.pglite.exec('ROLLBACK');
        throw err;
      }
      await this.pglite.exec('COMMIT');
      return result;
    } catch (outerErr) {
      // If COMMIT itself failed (rare), ensure we are not left in a transaction.
      try {
        await this.pglite.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw outerErr;
    }
  }

  async close(): Promise<void> {
    await this.pglite.close();
  }
}

/**
 * Create and initialize a pglite-backed {@link DatabaseClient} for tests.
 * Caller owns the lifecycle (`await client.close()` when done).
 */
export async function createPgliteDatabaseClient(
  connectionStringOrOptions?: string | ConstructorParameters<typeof PGlite>[0],
): Promise<DatabaseClient> {
  const client = new PgliteDatabaseClient(connectionStringOrOptions);
  await client.init();
  return client;
}
