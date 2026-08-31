import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * WORK-067 — the real-PostgreSQL two-actor concurrency proofs for the
 * EngineeringSignalRepository CONTRACT.
 *
 * ARCHITECTURAL CONTEXT (the repository truth): WORK-067 authorizes NO
 * schema migration (`migrations: []` — the WORK-064 run-repository /
 * WORK-066 claim-store precedent), so the production composition binds
 * the in-memory signal-repository adapter and the DURABLE binding point
 * stays a documented future ACR at the same port. What this suite proves
 * is the PORT CONTRACT under REAL PostgreSQL semantics — keyed
 * uniqueness where the DATABASE CONSTRAINT (a PRIMARY KEY + a UNIQUE
 * identity fingerprint), not an application-side race, decides the
 * winner — using a TEST-SCHEMA table that implements the port (the
 * per-test-file schema `wfos_test_<uuid>` is created/dropped by the
 * harness; this fixture DDL touches NO migration and leaves NO
 * production schema behind). This is exactly the invariant the future
 * ACR productionizes, and it satisfies the "prefer PostgreSQL
 * constraints over application-only races" discipline at the contract
 * level.
 *
 * A single-threaded pglite run CANNOT demonstrate true concurrent
 * statement interleaving — the suite SKIPS on pglite and runs when
 * WORKFLOWOS_DATABASE_URL is set (CI with the real postgres service; the
 * local embedded-PG harness).
 */
import { buildTestDatabase, type TestDatabase } from '../../helpers/test-database.js';
import type { DatabaseClient } from '@platform/index.js';
import type {
  EngineeringSignal,
  EngineeringSignalRepository,
  ReleaseCorrelationEntry,
  RegressionAssessment,
  SignalOccurrence,
} from '../../../src/engineering-signals/index.js';
import { EngineeringSignalError, deriveSignalIdentity, compareOccurrences } from '../../../src/engineering-signals/index.js';

const isRealPg =
  !!process.env.WORKFLOWOS_DATABASE_URL && process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');

/**
 * The test-schema PostgreSQL adapter implementing the signal-repository
 * PORT. The uniqueness is the DATABASE constraint (`signal_id TEXT
 * PRIMARY KEY` + `identity_fingerprint TEXT NOT NULL UNIQUE`):
 * `INSERT ... ON CONFLICT DO NOTHING` atomically decides the winner; the
 * loser's zero-row insert + follow-up SELECT + merge-UPDATE converges the
 * occurrence union (the deterministic order).
 */
class PgTestSchemaSignalRepository implements EngineeringSignalRepository {
  constructor(private readonly client: DatabaseClient) {}

  async save(signal: EngineeringSignal): Promise<EngineeringSignal> {
    const inserted = await this.client.query<{ signal_id: string }>(
      `INSERT INTO wfos_test_engineering_signals
         (signal_id, identity_fingerprint, tenant_id, project_id, environment_id, logical_failure_key, occurrences_json, correlation_json, regression_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (signal_id) DO NOTHING
       RETURNING signal_id`,
      [
        signal.signalId,
        signal.identityFingerprint,
        signal.tenantId,
        signal.projectId,
        signal.environmentId,
        signal.logicalFailureKey,
        JSON.stringify(signal.occurrences),
        JSON.stringify(signal.releaseCorrelation),
        JSON.stringify(signal.regression),
        signal.createdAt,
        signal.updatedAt,
      ],
    );
    if (inserted.rows.length > 0) return signal;
    // The constraint rejected the insert: the winner's row decides.
    const existing = await this.findById(signal.signalId);
    if (existing === null) {
      // The winner's transaction aborted (the speculative insert lost and
      // the row vanished) — retry once by saving again:
      return this.save(signal);
    }
    if (existing.identityFingerprint !== signal.identityFingerprint) {
      throw new EngineeringSignalError(
        'SIGNAL_IDENTITY_CONFLICT',
        `signal ${signal.signalId} is recorded with identity fingerprint ${existing.identityFingerprint} but the save carries ${signal.identityFingerprint} (the same id cannot carry two logical identities)`,
      );
    }
    // The occurrence union (append-only, deterministic order) + the later
    // correlation/assessment state (re-derivable).
    const merged = mergeSignals(existing, signal);
    await this.client.query(
      `UPDATE wfos_test_engineering_signals
       SET occurrences_json = $2, correlation_json = $3, regression_json = $4, updated_at = $5
       WHERE signal_id = $1`,
      [
        signal.signalId,
        JSON.stringify(merged.occurrences),
        JSON.stringify(merged.releaseCorrelation),
        JSON.stringify(merged.regression),
        merged.updatedAt,
      ],
    );
    return merged;
  }

  async findById(signalId: string): Promise<EngineeringSignal | null> {
    const found = await this.client.query<Row>(rowQuery('signal_id'), [signalId]);
    const row = found.rows[0];
    return row === undefined ? null : rowToSignal(row);
  }

  async findByIdentityFingerprint(fingerprint: string): Promise<EngineeringSignal | null> {
    const found = await this.client.query<Row>(rowQuery('identity_fingerprint'), [fingerprint]);
    const row = found.rows[0];
    return row === undefined ? null : rowToSignal(row);
  }

  async listByProject(projectId: string): Promise<readonly EngineeringSignal[]> {
    const found = await this.client.query<Row>(rowQuery('project_id'), [projectId]);
    return found.rows.map(rowToSignal);
  }
}

interface Row {
  signal_id: string;
  identity_fingerprint: string;
  tenant_id: string;
  project_id: string;
  environment_id: string;
  logical_failure_key: string;
  occurrences_json: string;
  correlation_json: string;
  regression_json: string;
  created_at: string;
  updated_at: string;
}

function rowQuery(where: string): string {
  return `SELECT signal_id, identity_fingerprint, tenant_id, project_id, environment_id, logical_failure_key, occurrences_json, correlation_json, regression_json, created_at, updated_at FROM wfos_test_engineering_signals WHERE ${where} = $1`;
}

function rowToSignal(row: Row): EngineeringSignal {
  const occurrences = JSON.parse(row.occurrences_json) as SignalOccurrence[];
  return {
    signalId: row.signal_id,
    identityFingerprint: row.identity_fingerprint,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    logicalFailureKey: row.logical_failure_key,
    occurrences: [...occurrences].sort(compareOccurrences),
    releaseCorrelation: JSON.parse(row.correlation_json) as ReleaseCorrelationEntry[],
    regression: JSON.parse(row.regression_json) as RegressionAssessment,
    sources: [...new Set(occurrences.map((o) => o.source))],
    firstObservedAt: occurrences[0]?.observedAt ?? '',
    lastObservedAt: occurrences[occurrences.length - 1]?.observedAt ?? '',
    latestSeverity: occurrences[occurrences.length - 1]?.severity ?? 'low',
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** The deterministic two-version merge (the port contract). */
function mergeSignals(a: EngineeringSignal, b: EngineeringSignal): EngineeringSignal {
  const byId = new Map<string, SignalOccurrence>();
  for (const occurrence of [...a.occurrences, ...b.occurrences]) {
    if (!byId.has(occurrence.occurrenceId)) byId.set(occurrence.occurrenceId, occurrence);
  }
  const occurrences = [...byId.values()].sort(compareOccurrences);
  const later = a.updatedAt !== b.updatedAt ? (a.updatedAt > b.updatedAt ? a : b) : JSON.stringify(a) >= JSON.stringify(b) ? a : b;
  return { ...later, occurrences };
}

/** A minimal signal record factory for the concurrency proofs. */
function signalVersion(
  scope: { tenantId: string; projectId: string; environmentId: string; logicalFailureKey: string },
  occurrence: { occurrenceId: string; observedAt: string; source?: 'validation' | 'ci' },
  updatedAt: string,
): EngineeringSignal {
  const identity = deriveSignalIdentity(scope);
  const occ: SignalOccurrence = {
    occurrenceId: occurrence.occurrenceId,
    source: occurrence.source ?? 'validation',
    observedAt: occurrence.observedAt,
    severity: 'high',
    observationRef: { kind: 'validation-run', ref: `run-${occurrence.occurrenceId}` },
    raw: { note: occurrence.occurrenceId },
    releaseRef: null,
    recordedAt: updatedAt,
    convergenceReason: 'concurrency-proof occurrence',
  };
  return {
    ...identity,
    ...scope,
    sources: [occ.source ?? 'validation'],
    occurrences: [occ],
    firstObservedAt: occ.observedAt,
    lastObservedAt: occ.observedAt,
    latestSeverity: 'high',
    releaseCorrelation: [],
    regression: { status: 'unavailable', reason: 'concurrency proof', perRelease: [], likelyRegression: null },
    createdAt: updatedAt,
    updatedAt,
  };
}

describe.skipIf(!isRealPg)('WORK-067 — the signal-repository contract under REAL PostgreSQL (two-actor proofs)', () => {
  let db: TestDatabase;
  let second: { client: DatabaseClient; close: () => Promise<void> } | null;
  let actorA: PgTestSchemaSignalRepository;
  let actorB: PgTestSchemaSignalRepository;

  beforeAll(async () => {
    db = await buildTestDatabase();
    await db.client.exec(`
      CREATE TABLE IF NOT EXISTS wfos_test_engineering_signals (
        signal_id              TEXT PRIMARY KEY,
        identity_fingerprint   TEXT NOT NULL UNIQUE,
        tenant_id              TEXT NOT NULL,
        project_id             TEXT NOT NULL,
        environment_id         TEXT NOT NULL,
        logical_failure_key    TEXT NOT NULL,
        occurrences_json       TEXT NOT NULL,
        correlation_json       TEXT NOT NULL,
        regression_json        TEXT NOT NULL,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    actorA = new PgTestSchemaSignalRepository(db.client);
    second = db.createSecondClient ? await db.createSecondClient() : null;
    if (!second) throw new Error('real-PG test requires createSecondClient (set WORKFLOWOS_DATABASE_URL)');
    actorB = new PgTestSchemaSignalRepository(second.client);
  });

  afterAll(async () => {
    if (second) await second.close();
    await db.close();
  });

  it('the repository contract: save → find → merge (the durable-future semantics, end to end)', async () => {
    await db.client.exec(`DELETE FROM wfos_test_engineering_signals`);
    const scope = { tenantId: 'tenant-1', projectId: 'project-1', environmentId: 'env-1', logicalFailureKey: 'failure-e2e' };
    const v1 = signalVersion(scope, { occurrenceId: 'occ_e2e_1', observedAt: '2026-09-01T12:00:00Z' }, '2026-09-01T12:00:05Z');
    const saved = await actorA.save(v1);
    expect(saved.signalId).toBe(v1.signalId);
    const found = await actorA.findById(v1.signalId);
    expect(found).not.toBeNull();
    expect(found!.occurrences).toHaveLength(1);
    // The same save again — idempotent:
    await actorA.save(v1);
    const foundAgain = await actorA.findById(v1.signalId);
    expect(foundAgain!.occurrences).toHaveLength(1);
    // The fingerprint lookup (the dedup read path):
    const byFingerprint = await actorA.findByIdentityFingerprint(v1.identityFingerprint);
    expect(byFingerprint!.signalId).toBe(v1.signalId);
  });

  it('TRUE two-actor concurrency: the SAME logical observation saved concurrently → ONE signal (the PRIMARY KEY + ON CONFLICT decide the winner)', async () => {
    await db.client.exec(`DELETE FROM wfos_test_engineering_signals`);
    const scope = { tenantId: 'tenant-1', projectId: 'project-1', environmentId: 'env-1', logicalFailureKey: 'failure-concurrent' };
    const a = signalVersion(scope, { occurrenceId: 'occ_same', observedAt: '2026-09-01T12:00:00Z' }, '2026-09-01T12:00:05Z');
    // Actor B saves a byte-identical logical version (a different object):
    const b = signalVersion(scope, { occurrenceId: 'occ_same', observedAt: '2026-09-01T12:00:00Z' }, '2026-09-01T12:00:05Z');
    const [, resultB] = await Promise.all([actorA.save(a), actorB.save(b)]);
    // Exactly ONE logical signal:
    const rows = await db.client.query<{ signal_id: string }>(`SELECT signal_id FROM wfos_test_engineering_signals`);
    expect(rows.rows).toHaveLength(1);
    // …and actor B (the loser of the insert race) received the converged
    // record (the merged view):
    expect(resultB.signalId).toBe(a.signalId);
    const final = await actorA.findById(a.signalId);
    expect(final!.occurrences).toHaveLength(1);
  });

  it('TRUE two-actor concurrency: the same logical failure at DIFFERENT occurrences, saved concurrently → ONE signal with BOTH occurrences (the union merge)', async () => {
    await db.client.exec(`DELETE FROM wfos_test_engineering_signals`);
    const scope = { tenantId: 'tenant-1', projectId: 'project-1', environmentId: 'env-1', logicalFailureKey: 'failure-union' };
    const a = signalVersion(scope, { occurrenceId: 'occ_union_a', observedAt: '2026-09-01T12:00:00Z' }, '2026-09-01T12:00:05Z');
    const b = signalVersion(scope, { occurrenceId: 'occ_union_b', observedAt: '2026-09-01T15:00:00Z' }, '2026-09-01T15:00:05Z');
    await Promise.all([actorA.save(a), actorB.save(b)]);
    const rows = await db.client.query<{ signal_id: string }>(`SELECT signal_id FROM wfos_test_engineering_signals`);
    expect(rows.rows).toHaveLength(1);
    const final = await actorA.findById(a.signalId);
    expect(final!.occurrences).toHaveLength(2);
    expect(final!.occurrences.map((o) => o.occurrenceId).sort()).toEqual(['occ_union_a', 'occ_union_b']);
  });

  it('the fingerprint conflict: the same signal id with a DIFFERENT identity fingerprint is the typed conflict (fail closed)', async () => {
    await db.client.exec(`DELETE FROM wfos_test_engineering_signals`);
    const scope = { tenantId: 'tenant-1', projectId: 'project-1', environmentId: 'env-1', logicalFailureKey: 'failure-conflict' };
    const original = signalVersion(scope, { occurrenceId: 'occ_c1', observedAt: '2026-09-01T12:00:00Z' }, '2026-09-01T12:00:05Z');
    await actorA.save(original);
    // A same-id/different-fingerprint save (a forged logical identity):
    const forged: EngineeringSignal = {
      ...original,
      identityFingerprint: 'sgf_forged',
      logicalFailureKey: 'failure-OTHER',
    };
    await expect(actorB.save(forged)).rejects.toThrowError(/cannot carry two logical identities/);
  });

  it('the keyed-not-global discrimination: concurrent saves for DIFFERENT logical failures do NOT serialize on each other (both persist)', async () => {
    await db.client.exec(`DELETE FROM wfos_test_engineering_signals`);
    const scopeA = { tenantId: 'tenant-1', projectId: 'project-1', environmentId: 'env-1', logicalFailureKey: 'failure-k1' };
    const scopeB = { tenantId: 'tenant-1', projectId: 'project-1', environmentId: 'env-1', logicalFailureKey: 'failure-k2' };
    const a = signalVersion(scopeA, { occurrenceId: 'occ_k1', observedAt: '2026-09-01T12:00:00Z' }, '2026-09-01T12:00:05Z');
    const b = signalVersion(scopeB, { occurrenceId: 'occ_k2', observedAt: '2026-09-01T12:00:00Z' }, '2026-09-01T12:00:05Z');
    await Promise.all([actorA.save(a), actorB.save(b)]);
    const rows = await db.client.query<{ signal_id: string }>(`SELECT signal_id FROM wfos_test_engineering_signals`);
    expect(rows.rows).toHaveLength(2);
  });

  it('MUTATION PROOF: without the keyed constraint the same-key concurrent save produces TWO rows — the duplicate test FAILS (the constraint is load-bearing; restored after)', async () => {
    // The mutation: a constraint-free table (the dedup identity/uniqueness
    // enforcement REMOVED). The same concurrent same-key save now forks the
    // logical signal — exactly the failure the keyed-constraint suite above
    // proves impossible.
    await db.client.exec(`DROP TABLE IF EXISTS wfos_test_engineering_signals_nouniq`);
    await db.client.exec(`
      CREATE TABLE wfos_test_engineering_signals_nouniq (
        signal_id              TEXT,
        identity_fingerprint   TEXT,
        tenant_id              TEXT NOT NULL,
        project_id             TEXT NOT NULL,
        environment_id         TEXT NOT NULL,
        logical_failure_key    TEXT NOT NULL,
        occurrences_json       TEXT NOT NULL,
        correlation_json       TEXT NOT NULL,
        regression_json        TEXT NOT NULL,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const insert = async (client: DatabaseClient, signal: EngineeringSignal) => {
      await client.query(
        `INSERT INTO wfos_test_engineering_signals_nouniq
           (signal_id, identity_fingerprint, tenant_id, project_id, environment_id, logical_failure_key, occurrences_json, correlation_json, regression_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          signal.signalId,
          signal.identityFingerprint,
          signal.tenantId,
          signal.projectId,
          signal.environmentId,
          signal.logicalFailureKey,
          JSON.stringify(signal.occurrences),
          JSON.stringify(signal.releaseCorrelation),
          JSON.stringify(signal.regression),
          signal.createdAt,
          signal.updatedAt,
        ],
      );
    };
    const scope = { tenantId: 'tenant-1', projectId: 'project-1', environmentId: 'env-1', logicalFailureKey: 'failure-mutation' };
    const a = signalVersion(scope, { occurrenceId: 'occ_m1', observedAt: '2026-09-01T12:00:00Z' }, '2026-09-01T12:00:05Z');
    const b = signalVersion(scope, { occurrenceId: 'occ_m1', observedAt: '2026-09-01T12:00:00Z' }, '2026-09-01T12:00:05Z');
    await Promise.all([insert(db.client, a), insert(second!.client, b)]);
    const rows = await db.client.query<{ signal_id: string }>(
      `SELECT signal_id FROM wfos_test_engineering_signals_nouniq`,
    );
    // THE MUTATION EXPOSED: two rows for one logical signal (the duplicate
    // invariant FAILS without the constraint):
    expect(rows.rows.length).toBe(2);
    // Restore (the mutation is test-schema-local; the canonical table is untouched):
    await db.client.exec(`DROP TABLE wfos_test_engineering_signals_nouniq`);
  });
});
