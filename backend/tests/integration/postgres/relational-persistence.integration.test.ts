import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestDatabase, type TestDatabase } from '../../helpers/test-database.js';

/**
 * DATA-AC-01 — Core entities persist relationally in PostgreSQL.
 *
 * Evidence: infrastructure-level fixture data (parent/child rows in the
 * `wfos_fixture_*` tables created by migration 0001) is inserted via the
 * shared {@link DatabaseClient} abstraction and read back, proving real
 * relational persistence through the infrastructure boundary.
 *
 * No domain entities are introduced; the fixture tables exist solely to
 * prove the persistence boundary is wired to a real PostgreSQL.
 */
describe('DATA-AC-01 — PostgreSQL relational persistence', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await buildTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  it('inserts and reads back rows through the shared DatabaseClient', async () => {
    const insert = await db.client.query<{ id: number }>(
      'INSERT INTO wfos_fixture_parent (name) VALUES ($1) RETURNING id',
      ['alpha'],
    );
    const parentId = insert.rows[0]!.id;
    expect(typeof parentId).toBe('number');

    await db.client.query(
      'INSERT INTO wfos_fixture_child (parent_id, note) VALUES ($1, $2)',
      [parentId, 'child-1'],
    );

    const joined = await db.client.query<{
      parent_name: string;
      child_note: string;
    }>(
      `SELECT p.name AS parent_name, c.note AS child_note
       FROM wfos_fixture_parent p
       JOIN wfos_fixture_child c ON c.parent_id = p.id
       WHERE p.id = $1`,
      [parentId],
    );
    expect(joined.rows).toHaveLength(1);
    expect(joined.rows[0]!.parent_name).toBe('alpha');
    expect(joined.rows[0]!.child_note).toBe('child-1');
  });

  it('SERIAL primary keys auto-increment', async () => {
    const a = await db.client.query<{ id: number }>(
      'INSERT INTO wfos_fixture_parent (name) VALUES ($1) RETURNING id',
      ['seq-a'],
    );
    const b = await db.client.query<{ id: number }>(
      'INSERT INTO wfos_fixture_parent (name) VALUES ($1) RETURNING id',
      ['seq-b'],
    );
    expect(b.rows[0]!.id).toBeGreaterThan(a.rows[0]!.id);
  });

  it('UUID default columns populate', async () => {
    const result = await db.client.query<{ id: string }>(
      `INSERT INTO wfos_artifact_metadata
         (storage_key, storage_provider, content_length)
       VALUES ($1, $2, $3) RETURNING id`,
      ['test-key', 'memory', 0],
    );
    expect(result.rows[0]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('JSONB columns persist structured metadata', async () => {
    const insert = await db.client.query<{ id: string }>(
      `INSERT INTO wfos_artifact_metadata
         (storage_key, storage_provider, content_length, metadata)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['jsonb-key', 'memory', 42, JSON.stringify({ foo: 'bar', n: 7 })],
    );
    const id = insert.rows[0]!.id;
    const select = await db.client.query<{ metadata: { foo: string; n: number } }>(
      'SELECT metadata FROM wfos_artifact_metadata WHERE id = $1',
      [id],
    );
    expect(select.rows[0]!.metadata.foo).toBe('bar');
    expect(select.rows[0]!.metadata.n).toBe(7);
  });
});
