import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * WORK-069 — the real-PostgreSQL two-actor concurrency proofs for the
 * ProgressiveReleaseDecisionRepository CONTRACT.
 *
 * ARCHITECTURAL CONTEXT (the repository truth): WORK-069 authorizes NO
 * schema migration (`migrations: []` — the Work Order's own declaration;
 * the WORK-064 run-repository / WORK-066 claim-store / WORK-067
 * signal-repository precedent), so the production composition binds the
 * in-memory decision-repository adapter and the DURABLE binding point
 * stays a documented future ACR at the same port. What this suite proves
 * is the PORT CONTRACT under REAL PostgreSQL semantics — keyed
 * uniqueness where the DATABASE CONSTRAINT (a `decision_id` PRIMARY KEY
 * + an `identity_fingerprint` UNIQUE), not an application-side race,
 * decides the winner — using a TEST-SCHEMA table that implements the
 * port (the per-test-file schema is created/dropped by the harness; this
 * fixture DDL touches NO migration and leaves NO production schema
 * behind). This is exactly the invariant the future ACR
 * productionizes, and it satisfies the "prefer PostgreSQL constraints
 * over application-only races" discipline at the contract level.
 *
 * A single-threaded pglite run CANNOT demonstrate true concurrent
 * statement interleaving — the suite SKIPS on pglite and runs when
 * WORKFLOWOS_DATABASE_URL is set (CI with the real postgres service; the
 * local embedded-PG harness).
 */
import { buildTestDatabase, type TestDatabase } from '../../helpers/test-database.js';
import type { DatabaseClient } from '@platform/index.js';
import {
  deriveDecisionIdentity,
  deriveContentFingerprint,
  DefaultProgressiveReleaseService,
  ProgressiveReleaseError,
  type ProgressiveReleaseDecisionRecord,
  type ProgressiveReleaseDecisionRepository,
} from '../../../src/progressive-release/index.js';
import {
  DefaultContinuousValidationService,
  InMemoryValidationRunRepository,
} from '../../../src/continuous-validation/index.js';
import {
  DefaultEngineeringSignalService,
  InMemoryEngineeringSignalRepository,
} from '../../../src/engineering-signals/index.js';
import { FakeRuntimeObservationReader, RecordingAuditWriter, fixedClock, completedPostReleaseRun } from '../../progressive-release/helpers.js';

const isRealPg =
  !!process.env.WORKFLOWOS_DATABASE_URL && process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');

/**
 * The test-schema PostgreSQL adapter implementing the decision-repository
 * PORT. The uniqueness is the DATABASE constraint (`decision_id TEXT
 * PRIMARY KEY` + `identity_fingerprint TEXT NOT NULL UNIQUE`):
 * `INSERT ... ON CONFLICT DO NOTHING` atomically decides the winner; the
 * loser's zero-row insert + follow-up SELECT + the fingerprint-equality
 * check decide the semantics (a same-id/different-fingerprint save is
 * the typed PR_DECISION_IDENTITY_CONFLICT — never a silent rewrite).
 */
class PgTestSchemaDecisionRepository implements ProgressiveReleaseDecisionRepository {
  constructor(private readonly client: DatabaseClient) {}

  async save(record: ProgressiveReleaseDecisionRecord): Promise<ProgressiveReleaseDecisionRecord> {
    // Bare ON CONFLICT DO NOTHING — NO arbiter target — is load-bearing
    // (the WORK-067 claim-store reasoning carried forward): the save's
    // tuple conflicts on BOTH unique indexes under the true two-actor
    // same-logical-identity interleaving; ANY unique conflict means the
    // winner exists, and the follow-up SELECT + fingerprint-equality
    // check decide the semantics while the DATABASE constraint remains
    // the arbiter.
    const inserted = await this.client.query<{ decision_id: string }>(
      `INSERT INTO wfos_test_progressive_decisions
         (decision_id, identity_fingerprint, content_fingerprint, tenant_id, project_id, environment_id,
          release_ref, rollout_stage, validation_run_id, runtime_observation_json, decision, reason,
          explanation, signal_outcomes_json, rollback_json, validation_outcome_kind, policy_version, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT DO NOTHING
       RETURNING decision_id`,
      [
        record.decisionId,
        record.identityFingerprint,
        record.contentFingerprint,
        record.tenantId,
        record.projectId,
        record.environmentId,
        record.releaseRef,
        record.rolloutStage,
        record.validationRunId,
        JSON.stringify(record.runtimeObservation),
        record.decision,
        record.reason,
        record.explanation,
        JSON.stringify(record.signalOutcomes),
        JSON.stringify(record.rollback),
        record.validationOutcomeKind,
        record.policyVersion,
        record.decidedAt,
      ],
    );
    if (inserted.rows.length > 0) return record;
    // The constraint rejected the insert: the winner's row decides.
    const existing = await this.findById(record.decisionId);
    if (existing === null) {
      // The winner's transaction aborted — retry once:
      return this.save(record);
    }
    if (existing.identityFingerprint !== record.identityFingerprint) {
      throw new ProgressiveReleaseError(
        'PR_DECISION_IDENTITY_CONFLICT',
        `decision ${record.decisionId} is recorded with identity fingerprint ${existing.identityFingerprint} but the save carries ${record.identityFingerprint} (the same id cannot carry two logical decisions)`,
      );
    }
    // The winner's record decides (the insert-or-converge contract):
    return existing;
  }

  async findById(decisionId: string): Promise<ProgressiveReleaseDecisionRecord | null> {
    const found = await this.client.query<Row>(
      `SELECT * FROM wfos_test_progressive_decisions WHERE decision_id = $1`,
      [decisionId],
    );
    const row = found.rows[0];
    return row === undefined ? null : rowToRecord(row);
  }

  async listForRollout(
    tenantId: string,
    projectId: string,
    releaseRef: string,
  ): Promise<readonly ProgressiveReleaseDecisionRecord[]> {
    const found = await this.client.query<Row>(
      `SELECT * FROM wfos_test_progressive_decisions
       WHERE tenant_id = $1 AND project_id = $2 AND release_ref = $3
       ORDER BY decided_at ASC, decision_id ASC`,
      [tenantId, projectId, releaseRef],
    );
    return found.rows.map(rowToRecord);
  }
}

interface Row {
  decision_id: string;
  identity_fingerprint: string;
  content_fingerprint: string;
  tenant_id: string;
  project_id: string;
  environment_id: string;
  release_ref: string;
  rollout_stage: string;
  validation_run_id: string;
  runtime_observation_json: string;
  decision: string;
  reason: string;
  explanation: string;
  signal_outcomes_json: string;
  rollback_json: string;
  validation_outcome_kind: string | null;
  policy_version: string;
  decided_at: string;
}

function rowToRecord(row: Row): ProgressiveReleaseDecisionRecord {
  return {
    decisionId: row.decision_id,
    identityFingerprint: row.identity_fingerprint,
    contentFingerprint: row.content_fingerprint,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    releaseRef: row.release_ref,
    rolloutStage: row.rollout_stage as ProgressiveReleaseDecisionRecord['rolloutStage'],
    validationRunId: row.validation_run_id,
    runtimeObservation: JSON.parse(row.runtime_observation_json),
    decision: row.decision as ProgressiveReleaseDecisionRecord['decision'],
    reason: row.reason as ProgressiveReleaseDecisionRecord['reason'],
    explanation: row.explanation,
    signalOutcomes: JSON.parse(row.signal_outcomes_json),
    rollback: JSON.parse(row.rollback_json),
    validationOutcomeKind: row.validation_outcome_kind,
    policyVersion: row.policy_version,
    decidedAt: new Date(row.decided_at).toISOString(),
  };
}

/** A minimal decision-record factory for the concurrency proofs. */
function decisionVersion(
  input: {
    tenantId: string;
    projectId: string;
    releaseRef: string;
    rolloutStage: 'canary' | 'partial' | 'full';
    validationRunId: string;
    runtimeObservationRef: string;
  },
  decision: 'continue' | 'halt',
): ProgressiveReleaseDecisionRecord {
  const { decisionId, identityFingerprint } = deriveDecisionIdentity(input);
  const reason =
    decision === 'continue' ? 'CONTINUE_VALIDATION_HEALTHY_RUNTIME_READY' : 'HALT_VALIDATION_FAILURE';
  const contentFingerprint = deriveContentFingerprint({
    identityFingerprint,
    decision,
    reason,
    policyVersion: 'work-069-progressive-release-policy-1',
    validationOutcomeKind: decision === 'continue' ? 'healthy' : 'validation_failure',
  });
  return {
    decisionId,
    identityFingerprint,
    contentFingerprint,
    tenantId: input.tenantId,
    projectId: input.projectId,
    environmentId: 'env-prod-rollout',
    releaseRef: input.releaseRef,
    rolloutStage: input.rolloutStage,
    validationRunId: input.validationRunId,
    runtimeObservation: {
      kind: 'deployment',
      deploymentId: 'dpl-rollout-1',
      deploymentStatus: 'ready',
    },
    decision,
    reason,
    explanation: 'concurrency-proof decision',
    signalOutcomes: [],
    rollback: null,
    validationOutcomeKind: decision === 'continue' ? 'healthy' : 'validation_failure',
    policyVersion: 'work-069-progressive-release-policy-1',
    decidedAt: '2026-09-02T00:00:00.000Z',
  };
}

const COLUMN_LIST = `(decision_id, identity_fingerprint, content_fingerprint, tenant_id, project_id, environment_id,
          release_ref, rollout_stage, validation_run_id, runtime_observation_json, decision, reason,
          explanation, signal_outcomes_json, rollback_json, validation_outcome_kind, policy_version, decided_at)`;

const VALUE_LIST = `($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`;

describe.skipIf(!isRealPg)('WORK-069 — the decision-repository contract under REAL PostgreSQL (two-actor proofs)', () => {
  let db: TestDatabase;
  let second: { client: DatabaseClient; close: () => Promise<void> } | null;
  let actorA: PgTestSchemaDecisionRepository;
  let actorB: PgTestSchemaDecisionRepository;

  beforeAll(async () => {
    db = await buildTestDatabase();
    await db.client.exec(`
      CREATE TABLE IF NOT EXISTS wfos_test_progressive_decisions (
        decision_id            TEXT PRIMARY KEY,
        identity_fingerprint   TEXT NOT NULL UNIQUE,
        content_fingerprint    TEXT NOT NULL,
        tenant_id              TEXT NOT NULL,
        project_id             TEXT NOT NULL,
        environment_id         TEXT NOT NULL,
        release_ref            TEXT NOT NULL,
        rollout_stage          TEXT NOT NULL,
        validation_run_id      TEXT NOT NULL,
        runtime_observation_json TEXT NOT NULL,
        decision               TEXT NOT NULL,
        reason                 TEXT NOT NULL,
        explanation            TEXT NOT NULL,
        signal_outcomes_json   TEXT NOT NULL,
        rollback_json          TEXT NOT NULL,
        validation_outcome_kind TEXT,
        policy_version         TEXT NOT NULL,
        decided_at             TIMESTAMPTZ NOT NULL
      )
    `);
    actorA = new PgTestSchemaDecisionRepository(db.client);
    second = db.createSecondClient ? await db.createSecondClient() : null;
    if (!second) throw new Error('real-PG test requires createSecondClient (set WORKFLOWOS_DATABASE_URL)');
    actorB = new PgTestSchemaDecisionRepository(second.client);
  });

  afterAll(async () => {
    if (second) await second.close();
    await db.close();
  });

  it('the repository contract: save → find → idempotent re-save → the rollout history (the durable-future semantics, end to end)', async () => {
    await db.client.exec(`DELETE FROM wfos_test_progressive_decisions`);
    const record = decisionVersion(
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        releaseRef: 'release-e2e',
        rolloutStage: 'canary',
        validationRunId: 'run-e2e-1',
        runtimeObservationRef: 'runtime-observation:deployment:dpl-rollout-1:2026-09-01T12:10:00Z',
      },
      'continue',
    );
    const saved = await actorA.save(record);
    expect(saved.decisionId).toBe(record.decisionId);
    const found = await actorA.findById(record.decisionId);
    expect(found).not.toBeNull();
    expect(found!.decision).toBe('continue');
    // The same save again — idempotent convergence:
    const reSaved = await actorA.save(record);
    expect(reSaved.decisionId).toBe(record.decisionId);
    const rows = await db.client.query<{ decision_id: string }>(
      `SELECT decision_id FROM wfos_test_progressive_decisions`,
    );
    expect(rows.rows).toHaveLength(1);
    // The rollout history lists the decision:
    const history = await actorA.listForRollout('tenant-1', 'project-1', 'release-e2e');
    expect(history).toHaveLength(1);
    expect(history[0]!.decisionId).toBe(record.decisionId);
  });

  it('TRUE two-actor concurrency: the SAME logical decision saved concurrently → ONE decision row (the PRIMARY KEY + ON CONFLICT decide the winner; the loser converges)', async () => {
    await db.client.exec(`DELETE FROM wfos_test_progressive_decisions`);
    const input = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      releaseRef: 'release-concurrent',
      rolloutStage: 'canary' as const,
      validationRunId: 'run-concurrent-1',
      runtimeObservationRef: 'runtime-observation:deployment:dpl-rollout-1:2026-09-01T12:10:00Z',
    };
    const a = decisionVersion(input, 'continue');
    // Actor B saves a byte-identical logical decision (a different object):
    const b = decisionVersion(input, 'continue');
    expect(b.decisionId).toBe(a.decisionId);
    const [, resultB] = await Promise.all([actorA.save(a), actorB.save(b)]);
    // Exactly ONE decision row (the DATABASE constraint decided):
    const rows = await db.client.query<{ decision_id: string }>(
      `SELECT decision_id FROM wfos_test_progressive_decisions`,
    );
    expect(rows.rows).toHaveLength(1);
    // …and actor B (the loser of the insert race) received the converged
    // record (the winner's row):
    expect(resultB.decisionId).toBe(a.decisionId);
    expect(resultB.decision).toBe('continue');
  });

  it('the full-service two-actor proof: the SAME decision request delivered concurrently through TWO service instances over two connections → ONE recorded decision', async () => {
    await db.client.exec(`DELETE FROM wfos_test_progressive_decisions`);
    const clock = fixedClock('2026-09-02T00:00:00Z');
    // Each actor is a FULL service instance (the real WORK-064 + WORK-067
    // authorities, the deterministic ports) whose ONLY shared state is the
    // PG-backed decision table — the true two-connection delivery:
    const buildService = (repo: ProgressiveReleaseDecisionRepository, withFailedRun: boolean) => {
      const continuousValidationService = new DefaultContinuousValidationService({
        runRepository: new InMemoryValidationRunRepository(),
        verificationService: new FakeVerificationBoundaryForPg(),
      });
      return {
        service: new DefaultProgressiveReleaseService({
          continuousValidationService,
          engineeringSignalService: new DefaultEngineeringSignalService({
            signalRepository: new InMemoryEngineeringSignalRepository(),
            continuousValidationService,
            now: clock,
          }),
          runtimeObservationReader: new FakeRuntimeObservationReader({
            kind: 'deployment',
            deploymentId: 'dpl-rollout-1',
            deploymentStatus: 'ready',
            observedAt: '2026-09-01T12:10:00Z',
          }),
          rollbackAuthority: undefined,
          decisionRepository: repo,
          auditWriter: new RecordingAuditWriter(),
          now: clock,
        }),
        continuousValidationService,
        withFailedRun,
      };
    };
    const actorAStack = buildService(actorA, true);
    const actorBStack = buildService(actorB, true);
    // Both actors see the same recorded facts (the same completed healthy
    // POST_RELEASE run of the same release):
    for (const stack of [actorAStack, actorBStack]) {
      await completedPostReleaseRun(stack.continuousValidationService, {
        runId: 'run-pg-healthy',
        releaseRef: 'release-pg',
        outcome: 'healthy',
      });
    }
    const request = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      environmentId: 'env-prod-rollout',
      releaseRef: 'release-pg',
      rolloutStage: 'canary',
      validationRunId: 'run-pg-healthy',
    } as const;
    const [resultA, resultB] = await Promise.all([
      actorAStack.service.decideProgressiveRelease({ ...request }),
      actorBStack.service.decideProgressiveRelease({ ...request }),
    ]);
    // The DATABASE constraint decided: exactly ONE decision row:
    const rows = await db.client.query<{ decision_id: string }>(
      `SELECT decision_id FROM wfos_test_progressive_decisions`,
    );
    expect(rows.rows).toHaveLength(1);
    // Both actors' results converge on the same recorded decision:
    expect(resultA.decision.decisionId).toBe(resultB.decision.decisionId);
    expect(resultA.decision.decision).toBe('continue');
    expect(resultB.decision.decision).toBe('continue');
    // …and the rollout history (read through either connection) records
    // exactly ONE decision for the release:
    const historyA = await actorA.listForRollout('tenant-1', 'project-1', 'release-pg');
    const historyB = await actorB.listForRollout('tenant-1', 'project-1', 'release-pg');
    expect(historyA).toHaveLength(1);
    expect(historyB).toHaveLength(1);
    expect(historyA[0]!.decisionId).toBe(historyB[0]!.decisionId);
  });

  it('the identity conflict: the same decision id with a DIFFERENT identity fingerprint is the typed conflict (fail closed)', async () => {
    await db.client.exec(`DELETE FROM wfos_test_progressive_decisions`);
    const record = decisionVersion(
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        releaseRef: 'release-conflict',
        rolloutStage: 'canary',
        validationRunId: 'run-conflict-1',
        runtimeObservationRef: 'runtime-observation:deployment:dpl-rollout-1:2026-09-01T12:10:00Z',
      },
      'continue',
    );
    await actorA.save(record);
    // A same-id/different-fingerprint save (a forged logical identity):
    const forged: ProgressiveReleaseDecisionRecord = {
      ...record,
      identityFingerprint: 'forged-fingerprint',
      validationRunId: 'run-OTHER',
    };
    await expect(actorB.save(forged)).rejects.toThrowError(/cannot carry two logical decisions/);
  });

  it('the keyed-not-global discrimination: concurrent saves for DIFFERENT rollouts do NOT serialize on each other (both persist)', async () => {
    await db.client.exec(`DELETE FROM wfos_test_progressive_decisions`);
    const a = decisionVersion(
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        releaseRef: 'release-k1',
        rolloutStage: 'canary',
        validationRunId: 'run-k1',
        runtimeObservationRef: 'runtime-observation:deployment:dpl-rollout-1:2026-09-01T12:10:00Z',
      },
      'continue',
    );
    const b = decisionVersion(
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        releaseRef: 'release-k2',
        rolloutStage: 'canary',
        validationRunId: 'run-k2',
        runtimeObservationRef: 'runtime-observation:deployment:dpl-rollout-1:2026-09-01T12:10:00Z',
      },
      'continue',
    );
    await Promise.all([actorA.save(a), actorB.save(b)]);
    const rows = await db.client.query<{ decision_id: string }>(
      `SELECT decision_id FROM wfos_test_progressive_decisions`,
    );
    expect(rows.rows).toHaveLength(2);
  });

  it('MUTATION PROOF: without the keyed constraint the same-key concurrent save produces TWO rows — the duplicate invariant FAILS (the constraint is load-bearing; restored after)', async () => {
    // The mutation: a constraint-free table (the decision-identity
    // uniqueness enforcement REMOVED). The same concurrent same-key save
    // now forks the logical decision — exactly the failure the
    // keyed-constraint suite above proves impossible.
    await db.client.exec(`DROP TABLE IF EXISTS wfos_test_progressive_decisions_nouniq`);
    await db.client.exec(`
      CREATE TABLE wfos_test_progressive_decisions_nouniq (
        decision_id            TEXT,
        identity_fingerprint   TEXT,
        content_fingerprint    TEXT NOT NULL,
        tenant_id              TEXT NOT NULL,
        project_id             TEXT NOT NULL,
        environment_id         TEXT NOT NULL,
        release_ref            TEXT NOT NULL,
        rollout_stage          TEXT NOT NULL,
        validation_run_id      TEXT NOT NULL,
        runtime_observation_json TEXT NOT NULL,
        decision               TEXT NOT NULL,
        reason                 TEXT NOT NULL,
        explanation            TEXT NOT NULL,
        signal_outcomes_json   TEXT NOT NULL,
        rollback_json          TEXT NOT NULL,
        validation_outcome_kind TEXT,
        policy_version         TEXT NOT NULL,
        decided_at             TIMESTAMPTZ NOT NULL
      )
    `);
    const insert = async (client: DatabaseClient, record: ProgressiveReleaseDecisionRecord) => {
      await client.query(
        `INSERT INTO wfos_test_progressive_decisions_nouniq
         ${COLUMN_LIST}
         VALUES ${VALUE_LIST}`,
        [
          record.decisionId,
          record.identityFingerprint,
          record.contentFingerprint,
          record.tenantId,
          record.projectId,
          record.environmentId,
          record.releaseRef,
          record.rolloutStage,
          record.validationRunId,
          JSON.stringify(record.runtimeObservation),
          record.decision,
          record.reason,
          record.explanation,
          JSON.stringify(record.signalOutcomes),
          JSON.stringify(record.rollback),
          record.validationOutcomeKind,
          record.policyVersion,
          record.decidedAt,
        ],
      );
    };
    const input = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      releaseRef: 'release-mutation',
      rolloutStage: 'canary' as const,
      validationRunId: 'run-mutation-1',
      runtimeObservationRef: 'runtime-observation:deployment:dpl-rollout-1:2026-09-01T12:10:00Z',
    };
    const a = decisionVersion(input, 'continue');
    const b = decisionVersion(input, 'continue');
    await Promise.all([insert(db.client, a), insert(second!.client, b)]);
    const rows = await db.client.query<{ decision_id: string }>(
      `SELECT decision_id FROM wfos_test_progressive_decisions_nouniq`,
    );
    // THE MUTATION EXPOSED: two rows for one logical decision (the
    // duplicate invariant FAILS without the constraint):
    expect(rows.rows.length).toBe(2);
    // Restore (the mutation is test-schema-local; the canonical table is untouched):
    await db.client.exec(`DROP TABLE wfos_test_progressive_decisions_nouniq`);
  });
});

/** The fake verification boundary (the evidence mapping is NOT exercised by WORK-069). */
class FakeVerificationBoundaryForPg {
  async attachEvidence(): Promise<never> {
    throw new Error('WORK-069 must never attach verification evidence');
  }
  async findOrchestrationRun(): Promise<never> {
    throw new Error('not used by WORK-069');
  }
  async recordOrchestrationRun(): Promise<never> {
    throw new Error('not used by WORK-069');
  }
  async createRun(): Promise<never> {
    throw new Error('not used by WORK-069');
  }
  async findRun(): Promise<never> {
    throw new Error('not used by WORK-069');
  }
  async attachCiEvidence(): Promise<never> {
    throw new Error('not used by WORK-069');
  }
  async mapEvidenceToCriterion(): Promise<never> {
    throw new Error('not used by WORK-069');
  }
  async evaluateCriterion(): Promise<never> {
    throw new Error('not used by WORK-069');
  }
  async evaluateForRun(): Promise<never> {
    throw new Error('not used by WORK-069');
  }
  async persistEvaluations(): Promise<never> {
    throw new Error('not used by WORK-069');
  }
  async listRunsForWorkItem(): Promise<never> {
    throw new Error('not used by WORK-069');
  }
  async listRunsForProject(): Promise<never> {
    throw new Error('not used by WORK-069');
  }
  async listEvidenceForRun(): Promise<never> {
    throw new Error('not used by WORK-069');
  }
  async listMappingsForRun(): Promise<never> {
    throw new Error('not used by WORK-069');
  }
  async finalizeOrchestrationRun(): Promise<never> {
    throw new Error('not used by WORK-069');
  }
}
