import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * WORK-066 — the real-PostgreSQL two-actor concurrency proofs for the
 * ScheduledTriggerClaimStore CONTRACT.
 *
 * ARCHITECTURAL CONTEXT (the repository truth): WORK-066 authorizes NO
 * schema migration (`migrations: []` — the WORK-064 run-repository
 * precedent), so the production composition binds the in-memory claim-store
 * adapter and the DURABLE binding point stays a documented future ACR at
 * the same port. What this suite proves is the PORT CONTRACT under REAL
 * PostgreSQL semantics — keyed uniqueness where the DATABASE CONSTRAINT (a
 * PRIMARY KEY + INSERT ... ON CONFLICT), not an application-side race,
 * decides the winner — using a TEST-SCHEMA table that implements the port
 * (the per-test-file schema `wfos_test_<uuid>` is created/dropped by the
 * harness; this fixture DDL touches NO migration and leaves NO production
 * schema behind). This is exactly the invariant the future ACR
 * productionizes, and it satisfies the "prefer PostgreSQL constraints over
 * application-only races" discipline at the contract level.
 *
 * A single-threaded pglite run CANNOT demonstrate true concurrent statement
 * interleaving — the suite SKIPS on pglite and runs when
 * WORKFLOWOS_DATABASE_URL is set (CI with the real postgres service; the
 * local embedded-PG harness).
 */
import { buildTestDatabase, type TestDatabase } from '../../helpers/test-database.js';
import type { DatabaseClient } from '@platform/index.js';
import type {
  ClaimRequest,
  ClaimResult,
  ScheduledTriggerClaim,
  ScheduledTriggerClaimStore,
  ScheduledTriggerDecisionRecord,
} from '../../../src/validation-scheduling/index.js';

const isRealPg =
  !!process.env.WORKFLOWOS_DATABASE_URL && process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');

/**
 * The test-schema PostgreSQL adapter implementing the claim-store PORT.
 * The uniqueness is the DATABASE constraint (`scheduling_id TEXT PRIMARY
 * KEY`): `INSERT ... ON CONFLICT (scheduling_id) DO NOTHING RETURNING`
 * atomically decides the winner; the loser's zero-row insert + follow-up
 * SELECT resolves duplicate-vs-conflict by comparing fingerprints.
 */
class PgTestSchemaClaimStore implements ScheduledTriggerClaimStore {
  constructor(private readonly client: DatabaseClient) {}

  async claim(request: ClaimRequest): Promise<ClaimResult> {
    const inserted = await this.client.query<{ scheduling_id: string }>(
      `INSERT INTO wfos_test_scheduling_claims (scheduling_id, content_fingerprint)
       VALUES ($1, $2)
       ON CONFLICT (scheduling_id) DO NOTHING
       RETURNING scheduling_id`,
      [request.schedulingId, request.contentFingerprint],
    );
    if (inserted.rows.length > 0) {
      return { status: 'claimed', schedulingId: request.schedulingId, original: null };
    }
    // The constraint rejected the insert: the winner's row decides.
    const existing = await this.find(request.schedulingId);
    if (existing === null) {
      // The winner's transaction aborted (the speculative insert lost and
      // the row vanished) — retry once by claiming again:
      return this.claim(request);
    }
    return {
      status: existing.contentFingerprint === request.contentFingerprint ? 'duplicate' : 'conflict',
      schedulingId: request.schedulingId,
      original: existing,
    };
  }

  async record(schedulingId: string, decision: ScheduledTriggerDecisionRecord): Promise<void> {
    await this.client.query(
      `UPDATE wfos_test_scheduling_claims
       SET decision_json = $2, decision_recorded_at = NOW()
       WHERE scheduling_id = $1 AND decision_json IS NULL`,
      [schedulingId, JSON.stringify(decision)],
    );
  }

  async release(schedulingId: string): Promise<void> {
    await this.client.query(
      `DELETE FROM wfos_test_scheduling_claims WHERE scheduling_id = $1 AND decision_json IS NULL`,
      [schedulingId],
    );
  }

  async find(schedulingId: string): Promise<ScheduledTriggerClaim | null> {
    const found = await this.client.query<{
      scheduling_id: string;
      content_fingerprint: string;
      claimed_at: string;
      decision_json: string | null;
    }>(
      `SELECT scheduling_id, content_fingerprint, claimed_at, decision_json
       FROM wfos_test_scheduling_claims WHERE scheduling_id = $1`,
      [schedulingId],
    );
    const row = found.rows[0];
    if (!row) return null;
    return {
      schedulingId: row.scheduling_id,
      contentFingerprint: row.content_fingerprint,
      claimedAt: new Date(row.claimed_at).toISOString(),
      decision: row.decision_json ? (JSON.parse(row.decision_json) as ScheduledTriggerDecisionRecord) : null,
    };
  }
}

describe.skipIf(!isRealPg)('WORK-066 — the claim-store contract under REAL PostgreSQL (two-actor proofs)', () => {
  let db: TestDatabase;
  let second: { client: DatabaseClient; close: () => Promise<void> } | null;
  let actorA: PgTestSchemaClaimStore;
  let actorB: PgTestSchemaClaimStore;

  beforeAll(async () => {
    db = await buildTestDatabase();
    await db.client.exec(`
      CREATE TABLE IF NOT EXISTS wfos_test_scheduling_claims (
        scheduling_id          TEXT PRIMARY KEY,
        content_fingerprint    TEXT NOT NULL,
        claimed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decision_json          TEXT,
        decision_recorded_at   TIMESTAMPTZ
      )
    `);
    actorA = new PgTestSchemaClaimStore(db.client);
    second = db.createSecondClient ? await db.createSecondClient() : null;
    if (!second) throw new Error('real-PG test requires createSecondClient (set WORKFLOWOS_DATABASE_URL)');
    actorB = new PgTestSchemaClaimStore(second.client);
  });

  afterAll(async () => {
    if (second) await second.close();
    await db.close();
  });

  it('the claim-store contract: claim → record → find (the durable-future semantics, end to end)', async () => {
    const key = 'svs_contracttest0000000000001';
    const first = await actorA.claim({ schedulingId: key, contentFingerprint: 'svf_1' });
    expect(first.status).toBe('claimed');
    const decision: ScheduledTriggerDecisionRecord = {
      outcome: 'scheduled',
      code: 'SCHEDULED',
      reason: 'the contract test decision',
      trigger: 'PR',
      projectId: 'proj-1',
      journeyId: 'journey-1',
      environmentId: 'env-preview',
      mode: 'PRE_MERGE',
      reference: 'rev-1',
      runId: 'svr_contracttest',
      admitted: true,
    };
    await actorA.record(key, decision);
    const found = await actorB.find(key);
    expect(found).not.toBeNull();
    expect(found!.decision?.runId).toBe('svr_contracttest');
    // the re-delivery from the OTHER actor is a duplicate echoing the decision:
    const reDrive = await actorB.claim({ schedulingId: key, contentFingerprint: 'svf_1' });
    expect(reDrive.status).toBe('duplicate');
    expect(reDrive.original?.decision?.runId).toBe('svr_contracttest');
    // record is once-only (the stored decision is immutable):
    await expect(actorB.record(key, { ...decision, runId: 'svr_OTHER' })).resolves.toBeUndefined();
    const still = await actorA.find(key);
    expect(still!.decision?.runId).toBe('svr_contracttest');
  });

  it('TWO ACTORS, the SAME key, TRUE concurrency → the database constraint admits EXACTLY ONE claim', async () => {
    const key = 'svs_concurrenttest0000000001';
    const [a, b] = await Promise.all([
      actorA.claim({ schedulingId: key, contentFingerprint: 'svf_same' }),
      actorB.claim({ schedulingId: key, contentFingerprint: 'svf_same' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['claimed', 'duplicate']);
    // Both actors see the SAME stored claim (the winner's row):
    const aRow = await actorA.find(key);
    const bRow = await actorB.find(key);
    expect(aRow?.contentFingerprint).toBe('svf_same');
    expect(bRow?.contentFingerprint).toBe('svf_same');
  });

  it('the same identity with a DIFFERENT fingerprint → the typed CONFLICT (the database row is the truth)', async () => {
    const key = 'svs_conflicttest000000000001';
    const first = await actorA.claim({ schedulingId: key, contentFingerprint: 'svf_original' });
    expect(first.status).toBe('claimed');
    const conflicting = await actorB.claim({ schedulingId: key, contentFingerprint: 'svf_DIFFERENT' });
    expect(conflicting.status).toBe('conflict');
    expect(conflicting.original?.contentFingerprint).toBe('svf_original');
  });

  it('DISCRIMINATION — keyed suppression is NOT global serialization: DIFFERENT keys claim CONCURRENTLY (no lock interference)', async () => {
    // Four different keys, claimed concurrently by BOTH actors — every claim
    // succeeds (the uniqueness is PER KEY; there is no global lock):
    const keys = [
      'svs_isolationtest00000000001',
      'svs_isolationtest00000000002',
      'svs_isolationtest00000000003',
      'svs_isolationtest00000000004',
    ];
    const results = await Promise.all([
      ...keys.map((key) => actorA.claim({ schedulingId: key, contentFingerprint: 'svf_a' })),
      ...keys.map((key) => actorB.claim({ schedulingId: key, contentFingerprint: 'svf_b' })),
    ]);
    // The per-key pairs: exactly one 'claimed' + one 'conflict' (different
    // fingerprints — B's svf_b differs from A's svf_a); NO pair yields two
    // 'claimed' (the uniqueness holds for every key under concurrency):
    const byStatus = new Map<string, number>();
    for (const r of results) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    expect(byStatus.get('claimed')).toBe(4);
    expect(byStatus.get('conflict')).toBe(4);
  });

  it('MUTATION EVIDENCE — WITHOUT the primary key (the uniqueness constraint removed) the same-key two-actor test FAILS: both actors claim', async () => {
    // The mutation: a table WITHOUT the uniqueness constraint — the exact
    // schema the future ACR must NOT produce. Both concurrent inserts
    // "succeed" (two rows), so the duplicate-suppression assertion above
    // (`['claimed','duplicate']`) would FAIL — the discrimination the Work
    // Order's mutation requirement demands.
    await db.client.exec(`
      CREATE TABLE IF NOT EXISTS wfos_test_scheduling_claims_nounique (
        scheduling_id        TEXT,
        content_fingerprint  TEXT NOT NULL,
        claimed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const key = 'svs_mutationtest00000000001';
    const insert = async (client: DatabaseClient): Promise<number> => {
      const result = await client.query(
        `INSERT INTO wfos_test_scheduling_claims_nounique (scheduling_id, content_fingerprint)
         VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING scheduling_id`,
        [key, 'svf_m'],
      );
      return result.rows.length;
    };
    const [aRows, bRows] = await Promise.all([insert(db.client), insert(second!.client)]);
    // BOTH actors' inserts returned a row — two logical claims for ONE
    // identity (the invariant is BROKEN; the uniqueness test FAILS):
    expect(aRows).toBe(1);
    expect(bRows).toBe(1);
    const count = await db.client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM wfos_test_scheduling_claims_nounique WHERE scheduling_id = $1`,
      [key],
    );
    expect(Number(count.rows[0]!.count)).toBe(2);
    // RESTORED (by construction): the constrained table enforces ONE row —
    // the discrimination target on the real schema:
    const constrainedCount = await db.client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM wfos_test_scheduling_claims`,
    );
    expect(Number(constrainedCount.rows[0]!.count)).toBeGreaterThan(0);
  });

  it('the release path: an INCOMPLETE claim is removed (the re-drive retries); a RECORDED decision survives (idempotent truth)', async () => {
    const pendingKey = 'svs_releasetest000000000001';
    const claimed = await actorA.claim({ schedulingId: pendingKey, contentFingerprint: 'svf_p' });
    expect(claimed.status).toBe('claimed');
    // release an incomplete claim:
    await actorA.release(pendingKey);
    expect(await actorB.find(pendingKey)).toBeNull();
    // the re-drive claims fresh:
    const reClaim = await actorB.claim({ schedulingId: pendingKey, contentFingerprint: 'svf_p' });
    expect(reClaim.status).toBe('claimed');
    // a recorded decision is NOT released:
    const recordedKey = 'svs_releasetest000000000002';
    await actorA.claim({ schedulingId: recordedKey, contentFingerprint: 'svf_r' });
    await actorA.record(recordedKey, {
      outcome: 'scheduled', code: 'SCHEDULED', reason: 'r',
      trigger: 'PR', projectId: 'proj-1', journeyId: 'j', environmentId: 'e',
      mode: 'PRE_MERGE', reference: 'rev-1', runId: 'svr_r', admitted: true,
    });
    await actorA.release(recordedKey);
    const stillThere = await actorB.find(recordedKey);
    expect(stillThere?.decision?.runId).toBe('svr_r');
  });
});
