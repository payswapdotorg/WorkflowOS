/**
 * WORK-025: Transaction-scoped adapter.
 *
 * Wraps a DatabaseTx to satisfy the DatabaseClient interface so existing
 * repository constructors (which accept DatabaseClient) can be bound to a
 * transaction. All queries through this adapter execute on the same
 * transaction connection.
 */
import type { DatabaseClient, DatabaseTx, QueryParams } from './database-client.js';
import type { QueryResult, QueryResultRow } from 'pg';

export class TxDatabaseClientAdapter implements DatabaseClient {
  constructor(private readonly tx: DatabaseTx) {}

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: QueryParams,
  ): Promise<QueryResult<R>> {
    return this.tx.query<R>(text, params);
  }

  async exec(text: string): Promise<void> {
    await this.tx.exec(text);
  }

  async transaction<R>(fn: (tx: DatabaseTx) => Promise<R>): Promise<R> {
    return fn(this.tx);
  }

  async close(): Promise<void> {
    // The transaction client is owned by the caller — don't close it here.
  }
}
