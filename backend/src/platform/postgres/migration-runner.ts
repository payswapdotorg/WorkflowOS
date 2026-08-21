import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseClient, DatabaseTx } from './database-client.js';
import type { Logger } from '../logger.js';

/**
 * Lightweight schema migration runner for WorkflowOS (DATA-001).
 *
 * SQL migration files live under `src/platform/postgres/migrations/` and are
 * named `NNNN_description.sql` (e.g. `0001_init.sql`). The runner applies them
 * in lexical order inside a `schema_migrations` table that records which
 * migrations have been applied. Already-applied migrations are skipped.
 *
 * This is intentionally minimal — it is enough for the WORK-003 infrastructure
 * foundation and for future work items to extend. It is NOT a domain concept;
 * migration files are infrastructure-only.
 */

const MIGRATIONS_DIR = fileURLToPath(
  new URL('./migrations/', import.meta.url),
);

interface AppliedMigration {
  filename: string;
  applied_at: Date;
}

/** Ensure the `schema_migrations` table exists, then return applied filenames. */
async function ensureMigrationsTable(client: DatabaseClient): Promise<Set<string>> {
  // Use exec for the multi-statement CREATE TABLE IF NOT EXISTS so both `pg`
  // and pglite handle it (pglite rejects multi-statement prepared queries).
  await client.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const result = await client.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations ORDER BY filename ASC',
  );
  return new Set(result.rows.map((r: { filename: string }) => r.filename));
}

function listMigrationFiles(): string[] {
  if (!statSync(MIGRATIONS_DIR).isDirectory()) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Apply all pending migrations from `migrations/`. Idempotent: already-applied
 * migrations are skipped. Throws on SQL error (the migration is left
 * un-applied so a re-run will retry).
 */
export async function runMigrations(
  client: DatabaseClient,
  logger?: Logger,
): Promise<string[]> {
  const applied = await ensureMigrationsTable(client);
  const files = listMigrationFiles();
  const newlyApplied: string[] = [];

  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    logger?.info('migrations.applying', { filename });
    await client.transaction(async (tx: DatabaseTx) => {
      // Migration files contain multiple statements (DDL). Use exec which
      // routes through the simple query protocol on both pg and pglite.
      await tx.exec(sql);
      await tx.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [filename],
      );
    });
    newlyApplied.push(filename);
    logger?.info('migrations.applied', { filename });
  }

  return newlyApplied;
}

/** Drop all rows from `schema_migrations`. Used by tests to reset state. */
export async function resetMigrationsTable(client: DatabaseClient): Promise<void> {
  // DROP TABLE is a single statement; either query or exec works. Use exec for
  // consistency with multi-statement DDL paths.
  await client.exec('DROP TABLE IF EXISTS schema_migrations');
}

export type { AppliedMigration };
