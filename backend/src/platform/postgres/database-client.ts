import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * Database client abstraction for WorkflowOS (DATA-001).
 *
 * This is the shared infrastructure boundary that domain modules use to access
 * the authoritative PostgreSQL application database (architecture §28). It is
 * intentionally minimal: a `query` method that mirrors the `pg` API plus a
 * `transaction` method for atomic units of work.
 *
 * Production uses a `pg.Pool` against a real PostgreSQL server. Tests use the
 * same `pg.Pool` against a real PostgreSQL service (CI) or a real PostgreSQL
 * compiled to WASM (`@electric-sql/pglite`, local dev) — both enforce real
 * relational constraints and real transaction semantics. No fake in-memory
 * database is used as proof of DATA-AC-03.
 *
 * Domain modules MUST depend on this interface (or a higher-level repository
 * abstraction built atop it), never on `pg.Pool` or `pglite` directly. This is
 * enforced statically — see `tests/architecture/static-architecture.test.ts`
 * (PLAT-AC-02 / forbidden-dependency invariants for WORK-003).
 */
export type QueryParams = unknown[];

export interface DatabaseClient {
  /**
   * Execute a parameterized SQL query. Returns the standard `pg` query result
   * (rows, rowCount, etc.).
   *
   * Note: must contain a SINGLE statement. Multi-statement SQL (e.g. a
   * migration file with several `CREATE TABLE`s) must go through
   * {@link DatabaseClient.exec} instead, because some PostgreSQL wire
   * implementations (notably pglite) reject multi-statement prepared
   * statements.
   */
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: QueryParams,
  ): Promise<QueryResult<R>>;

  /**
   * Execute one or more raw SQL statements with no parameters. Used by the
   * migration runner to apply multi-statement migration files. No row data is
   * returned.
   */
  exec(text: string): Promise<void>;

  /**
   * Run `fn` inside a single SQL transaction. The transaction is committed on
   * successful return and rolled back on any thrown error.
   *
   * The callback receives a transaction-scoped {@link DatabaseTx} whose
   * `query` is bound to the same connection so all statements execute
   * atomically.
   */
  transaction<R>(fn: (tx: DatabaseTx) => Promise<R>): Promise<R>;

  /** Close the underlying connection pool / client. */
  close(): Promise<void>;
}

/**
 * Transaction-scoped database handle. Same query contract as
 * {@link DatabaseClient.query} but bound to a single connection.
 */
export interface DatabaseTx {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: QueryParams,
  ): Promise<QueryResult<R>>;
  /** Execute raw multi-statement SQL within the transaction. */
  exec(text: string): Promise<void>;
}

/**
 * Production {@link DatabaseClient} backed by a `pg` connection pool.
 *
 * Used when `DATABASE_URL` points at a real PostgreSQL server (CI and
 * production). One pool per process; domain modules obtain the client from
 * the shared DI container rather than constructing their own.
 */
export class PgDatabaseClient implements DatabaseClient {
  constructor(private readonly pool: Pool) {}

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: QueryParams,
  ): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, params) as Promise<QueryResult<R>>;
  }

  async exec(text: string): Promise<void> {
    // `pg`'s `query` supports multi-statement SQL when no parameters are
    // passed (the simple query protocol). We rely on that here.
    await this.pool.query(text);
  }

  async transaction<R>(fn: (tx: DatabaseTx) => Promise<R>): Promise<R> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let result: R;
      try {
        result = await fn({
          query: (t, p) => client.query(t, p),
          exec: async (t) => {
            await client.query(t);
          },
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      await client.query('COMMIT');
      return result;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export type { Pool, PoolClient };
