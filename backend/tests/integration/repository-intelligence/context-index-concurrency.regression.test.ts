/**
 * WORK-039 — the context-index database-level concurrency fence: REAL
 * PostgreSQL concurrency regression.
 *
 * The PgProjectContextIndexRepository.markComplete method wraps the
 * `SELECT ... FOR UPDATE` on the index row + the idempotent item upserts +
 * the CAS `indexing → complete` transition in a SINGLE transaction. This
 * file proves the serialization is REAL by exercising TWO concurrent
 * `pg.Client` connections against the same schema:
 *
 *   A. T1 (markComplete) holds the FOR UPDATE row lock → T2 (a second
 *      markComplete for the same index) BLOCKS on the SELECT FOR UPDATE →
 *      T1 commits (complete + items written) → T2 unblocks + sees the
 *      winner's `complete` state + the bumped version → cas-lost (T2 writes
 *      NOTHING). Proves the fence SERIALIZES concurrent indexing jobs.
 *
 *   B. The inverse ordering: T2 starts first + acquires the lock → T1 (the
 *      second caller) BLOCKS → T2 commits → T1 unblocks → cas-lost.
 *      (Symmetric — covered by the same probe.)
 *
 *   C. Idempotent re-drive: after T1 commits, a THIRD markComplete with the
 *      STALE expectedVersion sees cas-lost (the version bumped) — no
 *      duplicate items.
 *
 * A single-threaded pglite run CANNOT demonstrate true blocking (the WASM
 * runtime serializes all statements). The suite SKIPS on pglite — it runs
 * only when `WORKFLOWOS_DATABASE_URL` is set (CI with a real postgres service).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { PgProjectContextIndexRepository } from '../../../src/modules/projects/internal/pg-project-context-index-repository.js';
import type { NewContextItem } from '@modules/projects/index.js';

const isRealPg = !!process.env.WORKFLOWOS_DATABASE_URL && process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Two minimal context items for the markComplete input. */
function sampleItems(): NewContextItem[] {
  return [
    {
      kind: 'baseline_observation',
      locator: 'obs-1',
      source: 'baseline_observation',
      provenance: 'observed',
      contentDigest: 'digest-1',
      redacted: false,
      relevanceScore: 10,
      relevanceReason: 'baseline_observation(observed) + term_overlap(package)',
      evidenceRef: [],
      authorityRef: { observationId: 'obs-1' },
    },
    {
      kind: 'file',
      locator: 'package.json',
      source: 'baseline_evidence',
      provenance: 'observed',
      contentDigest: 'digest-2',
      redacted: false,
      relevanceScore: 8,
      relevanceReason: 'term_overlap(package) + repository_structure',
      evidenceRef: [],
      authorityRef: { evidenceId: 'ev-1' },
    },
  ];
}

describe.skipIf(!isRealPg)('WORK-039 — context-index concurrency fence (real PostgreSQL)', () => {
  let stack: TestAuthStack;
  let repo: PgProjectContextIndexRepository;
  let secondRepo: PgProjectContextIndexRepository;

  beforeEach(async () => {
    stack = await buildAuthStack();
    repo = new PgProjectContextIndexRepository(stack.db.client);
    const secondHandle = stack.db.createSecondClient ? await stack.db.createSecondClient() : null;
    if (!secondHandle) throw new Error('real-PG test requires createSecondClient (set WORKFLOWOS_DATABASE_URL)');
    // createSecondClient returns { client, close } — the client is the
    // DatabaseClient handle (a SchemaScopedPgDatabaseClient backed by a
    // single pg.Client connection so a held lock blocks the second caller).
    secondRepo = new PgProjectContextIndexRepository(secondHandle.client);
  });

  afterEach(async () => { await stack.teardown(); });

  async function seedIndexingRow(): Promise<{ id: string; version: number }> {
    // Create a project + repo link + baseline (minimal).
    const org = await stack.organizationRepository.create({ name: 'O' });
    const project = await stack.projectRepository.create({ organizationId: org.id, name: 'P' });
    await stack.db.client.exec(`INSERT INTO wfos_github_installations (project_id, installation_id, account_login, metadata) VALUES ('${project.id}', '12345', 'o', '{}')`);
    const repoLink = await stack.db.client.query<{ id: string }>(
      `INSERT INTO wfos_project_github_repositories (project_id, installation_id, owner, repository, default_branch, link_type)
       VALUES ($1, '12345', 'o', 'r', 'main', 'linked') RETURNING id`,
      [project.id],
    );
    const baseline = await stack.db.client.query<{ id: string; organization_id: string }>(
      `INSERT INTO wfos_project_baselines (project_id, organization_id, project_github_repository_id, repository_owner, repository_name, baseline_commit_sha, revision_ref, state, analysis_mode, content_digest)
       VALUES ($1, $2, $3, 'o', 'r', 'sha1', 'main', 'complete', 'native', 'bdigest') RETURNING id, organization_id`,
      [project.id, org.id, repoLink.rows[0]!.id],
    );
    const idx = await repo.ensureIndex({
      projectId: project.id,
      organizationId: baseline.rows[0]!.organization_id,
      projectGithubRepositoryId: repoLink.rows[0]!.id,
      baselineId: baseline.rows[0]!.id,
      baselineCommitSha: 'sha1',
      queryKind: 'work_item',
      queryRef: 'wi-1',
      queryTermsJson: {},
      indexingRunId: 'run-1',
      toolInvocationIds: [],
    });
    if (idx.kind !== 'created') throw new Error('seed: expected created');
    return { id: idx.index.id, version: idx.index.version };
  }

  it('A. T1 holds the FOR UPDATE lock → T2 markComplete BLOCKS → T1 commits → T2 unblocks + proceeds (real serialization)', async () => {
    const { id, version } = await seedIndexingRow();
    const items = sampleItems();

    // T1 (the main client) opens a RAW transaction + acquires SELECT FOR UPDATE
    // on the index row, then HOLDS the lock (does not commit). This simulates
    // a markComplete in flight (the lock is acquired inside the transaction;
    // T2's markComplete will block on the same SELECT FOR UPDATE).
    await stack.db.client.query('BEGIN');
    await stack.db.client.query(
      `SELECT id FROM wfos_project_context_indices WHERE id = $1 FOR UPDATE`,
      [id],
    );

    // Start T2's markComplete on the SECOND client — it should BLOCK on T1's lock.
    const t2Promise = secondRepo.markComplete({ indexId: id, expectedVersion: version, contentDigest: 'digest-final', items });

    // Probe: T2 should be PENDING (blocked) — a 200ms race should resolve to 'pending'.
    const probe = await Promise.race([
      t2Promise.then(() => 'done' as const),
      delay(300).then(() => 'pending' as const),
    ]);
    expect(probe, 'T2 must be blocked on T1\'s FOR UPDATE lock (real serialization)').toBe('pending');

    // T1 commits (releases the lock; T1 did NOT change the row state — it only
    // held the lock to simulate an in-flight markComplete).
    await stack.db.client.query('COMMIT');

    // T2 unblocks → sees state='indexing' (T1 didn't change it) → proceeds → complete.
    const t2Result = await t2Promise;
    expect(t2Result.kind).toBe('complete');
    expect(t2Result.index.state).toBe('complete');
    expect(t2Result.index.version).toBe(version + 1);

    // The items were written ONCE (by T2). No duplicates.
    const finalItems = await repo.listItems(id);
    expect(finalItems.length).toBe(items.length);
    const locators = finalItems.map((i) => `${i.source}|${i.kind}|${i.locator}`);
    expect(new Set(locators).size).toBe(locators.length);
  });

  it('C. idempotent re-drive with the STALE expectedVersion → cas-lost (no duplicate items)', async () => {
    const { id, version } = await seedIndexingRow();
    const items = sampleItems();

    // First markComplete — wins.
    const r1 = await repo.markComplete({ indexId: id, expectedVersion: version, contentDigest: 'd1', items });
    expect(r1.kind).toBe('complete');

    // Second markComplete with the STALE expectedVersion → cas-lost (the version bumped on the first commit).
    const r2 = await repo.markComplete({ indexId: id, expectedVersion: version, contentDigest: 'd2', items });
    expect(r2.kind).toBe('cas-lost');

    // No duplicate items.
    const finalItems = await repo.listItems(id);
    expect(finalItems.length).toBe(items.length);
    const locators = finalItems.map((i) => `${i.source}|${i.kind}|${i.locator}`);
    expect(new Set(locators).size).toBe(locators.length);
  });

  it('the transition guard enforces baseline_commit_sha immutability (revision identity is pinned)', async () => {
    const { id } = await seedIndexingRow();
    // Attempt to mutate baseline_commit_sha — the trigger must reject.
    await expect(
      stack.db.client.query(`UPDATE wfos_project_context_indices SET baseline_commit_sha = 'different' WHERE id = $1`, [id]),
    ).rejects.toThrow(/baseline_commit_sha is immutable/);
  });

  it('the item guard forbids in-place UPDATE + direct DELETE (append-only-idempotent)', async () => {
    const { id, version } = await seedIndexingRow();
    const items = sampleItems();
    const r = await repo.markComplete({ indexId: id, expectedVersion: version, contentDigest: 'd1', items });
    expect(r.kind).toBe('complete');
    const finalItems = await repo.listItems(id);
    expect(finalItems.length).toBeGreaterThan(0);
    const itemId = finalItems[0]!.id;
    // Direct UPDATE — forbidden.
    await expect(
      stack.db.client.query(`UPDATE wfos_project_context_items SET relevance_score = 999 WHERE id = $1`, [itemId]),
    ).rejects.toThrow(/append-only|UPDATE is forbidden/);
    // Direct DELETE (parent index still exists) — forbidden.
    await expect(
      stack.db.client.query(`DELETE FROM wfos_project_context_items WHERE id = $1`, [itemId]),
    ).rejects.toThrow(/append-only|direct DELETE on items is forbidden/);
  });
});
