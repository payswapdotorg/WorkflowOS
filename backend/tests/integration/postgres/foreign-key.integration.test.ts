import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestDatabase, type TestDatabase } from '../../helpers/test-database.js';

/**
 * DATA-AC-02 — Invalid foreign-key references fail.
 *
 * Evidence: PostgreSQL itself rejects an INSERT into `wfos_fixture_child`
 * that references a non-existent `wfos_fixture_parent(id)`. The constraint is
 * database-enforced (a real FOREIGN KEY), not application-level validation.
 */
describe('DATA-AC-02 — PostgreSQL foreign-key integrity', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await buildTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  it('rejects a child row with a non-existent parent id', async () => {
    const orphanParentId = 9_999_999;
    // Sanity: that parent genuinely does not exist.
    const exists = await db.client.query<{ id: number }>(
      'SELECT id FROM wfos_fixture_parent WHERE id = $1',
      [orphanParentId],
    );
    expect(exists.rows).toHaveLength(0);

    await expect(
      db.client.query(
        'INSERT INTO wfos_fixture_child (parent_id, note) VALUES ($1, $2)',
        [orphanParentId, 'orphan'],
      ),
    ).rejects.toThrow(/foreign key constraint/i);
  });

  it('accepts a child row with a valid parent id', async () => {
    const parent = await db.client.query<{ id: number }>(
      'INSERT INTO wfos_fixture_parent (name) VALUES ($1) RETURNING id',
      ['valid-parent'],
    );
    await expect(
      db.client.query(
        'INSERT INTO wfos_fixture_child (parent_id, note) VALUES ($1, $2)',
        [parent.rows[0]!.id, 'valid-child'],
      ),
    ).resolves.toBeDefined();
  });

  it('rejects a child row with a NULL parent id (NOT NULL constraint)', async () => {
    await expect(
      db.client.query(
        'INSERT INTO wfos_fixture_child (parent_id, note) VALUES ($1, $2)',
        [null, 'null-parent'],
      ),
    ).rejects.toThrow(/not-null constraint/i);
  });
});
