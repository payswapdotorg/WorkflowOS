import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * WORK-069 — the real-PostgreSQL two-actor concurrency proofs for the
 * ProgressiveReleaseDecisionRepository CONTRACT — including the CONSEQUENCE
 * DURABILITY PROTOCOL (the PR #108 architect-review correction): the
 * decision record is RESERVED (insert-only) BEFORE any governed
 * consequence executes, so a concurrent delivery or a crash can never
 * re-execute a non-idempotent consequence (a signal emission, a rollback
 * invocation) for a decision identity that is already durable.
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
 * decides the reservation winner — using a TEST-SCHEMA table that
 * implements the port (the per-test-file schema is created/dropped by
 * the harness; this fixture DDL touches NO migration and leaves NO
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
import {
  deriveDecisionIdentity,
  deriveContentFingerprint,
  DefaultProgressiveReleaseService,
  ProgressiveReleaseError,
  type DecisionConsequenceOutcomes,
  type DecisionReservation,
  type ProgressiveReleaseDecisionRecord,
  type ProgressiveReleaseDecisionRepository,
  type ProgressiveReleaseService,
} from '../../../src/progressive-release/index.js';
import {
  DefaultContinuousValidationService,
  InMemoryValidationRunRepository,
} from '../../../src/continuous-validation/index.js';
import {
  DefaultEngineeringSignalService,
  InMemoryEngineeringSignalRepository,
} from '../../../src/engineering-signals/index.js';
import {
  FakeRuntimeObservationReader,
  RecordingAuditWriter,
  RecordingRollbackAuthority,
  fixedClock,
  completedPostReleaseRun,
  invokedRollback,
} from '../../progressive-release/helpers.js';

const isRealPg =
  !!process.env.WORKFLOWOS_DATABASE_URL && process.env.WORKFLOWOS_DATABASE_URL.startsWith('postgres');

/**
 * The test-schema PostgreSQL adapter implementing the decision-repository
 * PORT (the reserve → completeDecision consequence-durability protocol).
 * The uniqueness is the DATABASE constraint (`decision_id TEXT PRIMARY
 * KEY` + `identity_fingerprint TEXT NOT NULL UNIQUE`):
 * `INSERT ... ON CONFLICT DO NOTHING` atomically decides the reservation
 * winner; the loser's zero-row insert + follow-up SELECT + the
 * fingerprint-equality check decide the semantics (a same-id/different-
 * fingerprint reserve is the typed PR_DECISION_IDENTITY_CONFLICT — never
 * a silent rewrite).
 */
class PgTestSchemaDecisionRepository implements ProgressiveReleaseDecisionRepository {
  constructor(private readonly client: DatabaseClient) {}

  async reserve(record: ProgressiveReleaseDecisionRecord): Promise<DecisionReservation> {
    // Bare ON CONFLICT DO NOTHING — NO arbiter target — is load-bearing
    // (the WORK-067 claim-store reasoning carried forward): the reserve's
    // tuple conflicts on BOTH unique indexes under the true two-actor
    // same-logical-identity interleaving; ANY unique conflict means the
    // winner exists, and the follow-up SELECT + fingerprint-equality
    // check decide the semantics while the DATABASE constraint remains
    // the arbiter.
    const inserted = await this.client.query<{ decision_id: string }>(
      `INSERT INTO wfos_test_progressive_decisions
         (decision_id, identity_fingerprint, content_fingerprint, tenant_id, project_id, environment_id,
          release_ref, rollout_stage, validation_run_id, runtime_observation_json, decision, reason,
          explanation, signal_outcomes_json, rollback_json, consequence_phase, validation_outcome_kind, policy_version, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
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
        record.consequencePhase,
        record.validationOutcomeKind,
        record.policyVersion,
        record.decidedAt,
      ],
    );
    if (inserted.rows.length > 0) return { status: 'reserved', record };
    // The constraint rejected the insert: the winner's row decides.
    const existing = await this.findById(record.decisionId);
    if (existing === null) {
      // The winner's transaction aborted — retry once:
      return this.reserve(record);
    }
    if (existing.identityFingerprint !== record.identityFingerprint) {
      throw new ProgressiveReleaseError(
        'PR_DECISION_IDENTITY_CONFLICT',
        `decision ${record.decisionId} is recorded with identity fingerprint ${existing.identityFingerprint} but the reserve carries ${record.identityFingerprint} (the same id cannot carry two logical decisions)`,
      );
    }
    // The winner's record decides (the insert-or-converge contract): the
    // loser of the reservation race executes NO consequence.
    return { status: 'converged', record: existing };
  }

  async completeDecision(
    decisionId: string,
    outcomes: DecisionConsequenceOutcomes,
  ): Promise<ProgressiveReleaseDecisionRecord> {
    const updated = await this.client.query<Row>(
      `UPDATE wfos_test_progressive_decisions
         SET consequence_phase = 'executed',
             signal_outcomes_json = $2,
             rollback_json = $3
       WHERE decision_id = $1 AND consequence_phase = 'pending'
       RETURNING *`,
      [decisionId, JSON.stringify(outcomes.signalOutcomes), JSON.stringify(outcomes.rollback)],
    );
    if (updated.rows.length > 0) return rowToRecord(updated.rows[0]!);
    const existing = await this.findById(decisionId);
    if (existing === null) {
      throw new ProgressiveReleaseError(
        'PR_DECISION_COMPLETION_REJECTED',
        `decision ${decisionId} cannot be completed: no reserved record exists (the completion follows a reservation — never a bare write)`,
      );
    }
    // Already executed (or raced to executed by the owner's retry) — the
    // stored record decides (idempotent convergence).
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
  consequence_phase: string;
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
    consequencePhase: row.consequence_phase as ProgressiveReleaseDecisionRecord['consequencePhase'],
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
  consequencePhase: 'pending' | 'executed' = 'executed',
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
    consequencePhase,
    validationOutcomeKind: decision === 'continue' ? 'healthy' : 'validation_failure',
    policyVersion: 'work-069-progressive-release-policy-1',
    decidedAt: '2026-09-02T00:00:00.000Z',
  };
}

const COLUMN_LIST = `(decision_id, identity_fingerprint, content_fingerprint, tenant_id, project_id, environment_id,
          release_ref, rollout_stage, validation_run_id, runtime_observation_json, decision, reason,
          explanation, signal_outcomes_json, rollback_json, consequence_phase, validation_outcome_kind, policy_version, decided_at)`;

const VALUE_LIST = `($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`;

describe.skipIf(!isRealPg)('WORK-069 — the decision-repository contract under REAL PostgreSQL (two-actor proofs)', () => {
  let db: TestDatabase;
  let second: { client: DatabaseClient; close: () => Promise<void> } | null;
  let actorA: PgTestSchemaDecisionRepository;
  let actorB: PgTestSchemaDecisionRepository;

  beforeAll(async () => {
    db = await buildTestDatabase();
    // The consequence-durability protocol widened the TEST schema (the
    // consequence_phase column): drop the per-run stale shape first (the
    // fixture DDL is test-schema-local — NO production migration).
    await db.client.exec(`DROP TABLE IF EXISTS wfos_test_progressive_decisions`);
    await db.client.exec(`
      CREATE TABLE wfos_test_progressive_decisions (
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
        consequence_phase      TEXT NOT NULL,
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

  it('the repository contract: reserve → find → idempotent converged re-reserve → completion → the rollout history (the durable-future semantics, end to end)', async () => {
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
    const reserved = await actorA.reserve(record);
    expect(reserved.status).toBe('reserved');
    expect(reserved.record.decisionId).toBe(record.decisionId);
    const found = await actorA.findById(record.decisionId);
    expect(found).not.toBeNull();
    expect(found!.decision).toBe('continue');
    // The same reserve again — idempotent convergence (the loser's view):
    const reReserved = await actorA.reserve(record);
    expect(reReserved.status).toBe('converged');
    expect(reReserved.record.decisionId).toBe(record.decisionId);
    const rows = await db.client.query<{ decision_id: string }>(
      `SELECT decision_id FROM wfos_test_progressive_decisions`,
    );
    expect(rows.rows).toHaveLength(1);
    // The rollout history lists the decision:
    const history = await actorA.listForRollout('tenant-1', 'project-1', 'release-e2e');
    expect(history).toHaveLength(1);
    expect(history[0]!.decisionId).toBe(record.decisionId);
    // …and the completion contract on a PENDING reservation: the
    // pending → executed transition records the real outcomes:
    const pending = decisionVersion(
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        releaseRef: 'release-e2e-halt',
        rolloutStage: 'partial',
        validationRunId: 'run-e2e-halt',
        runtimeObservationRef: 'runtime-observation:deployment:dpl-rollout-1:2026-09-01T12:10:00Z',
      },
      'halt',
      'pending',
    );
    await actorA.reserve(pending);
    const readBack = await actorA.findById(pending.decisionId);
    expect(readBack!.consequencePhase).toBe('pending');
    const completed = await actorA.completeDecision(pending.decisionId, {
      signalOutcomes: [
        {
          signalId: 'sig-pg-1',
          occurrenceId: 'occ-pg-1',
          outcome: 'signal-created',
          logicalFailureKey: 'validation:journey:step:expectation',
        },
      ],
      rollback: null,
    });
    expect(completed.consequencePhase).toBe('executed');
    expect(completed.signalOutcomes).toHaveLength(1);
    // A re-completion converges idempotently (the stored record decides):
    const reCompleted = await actorA.completeDecision(pending.decisionId, {
      signalOutcomes: [],
      rollback: null,
    });
    expect(reCompleted.consequencePhase).toBe('executed');
    expect(reCompleted.signalOutcomes).toHaveLength(1);
    // …and completing a never-reserved record is the typed rejection:
    await expect(
      actorA.completeDecision('prd_never_reserved', { signalOutcomes: [], rollback: null }),
    ).rejects.toThrowError(/\[PR_DECISION_COMPLETION_REJECTED\]/);
  });

  it('TRUE two-actor concurrency: the SAME logical decision reserved concurrently → ONE decision row (the PRIMARY KEY + ON CONFLICT decide the winner; the loser converges and owns NO consequence execution)', async () => {
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
    // Actor B reserves a byte-identical logical decision (a different object):
    const b = decisionVersion(input, 'continue');
    expect(b.decisionId).toBe(a.decisionId);
    const [resultA, resultB] = await Promise.all([actorA.reserve(a), actorB.reserve(b)]);
    // Exactly ONE decision row (the DATABASE constraint decided):
    const rows = await db.client.query<{ decision_id: string }>(
      `SELECT decision_id FROM wfos_test_progressive_decisions`,
    );
    expect(rows.rows).toHaveLength(1);
    // …and BOTH actors can tell who owns the consequence execution:
    const statuses = [resultA.status, resultB.status].sort();
    expect(statuses).toEqual(['converged', 'reserved']);
    // …the loser (converged) received the winner's row:
    const loser = resultA.status === 'converged' ? resultA : resultB;
    expect(loser.record.decisionId).toBe(a.decisionId);
    expect(loser.record.decision).toBe('continue');
  });

  it('the full-service two-actor proof (continue): the SAME decision request delivered concurrently through TWO service instances over two connections → ONE recorded decision (a continue reserves atomically final; the loser converges to a duplicate)', async () => {
    await db.client.exec(`DELETE FROM wfos_test_progressive_decisions`);
    const clock = fixedClock('2026-09-02T00:00:00Z');
    // Each actor is a FULL service instance (the real WORK-064 + WORK-067
    // authorities, the deterministic ports) whose ONLY shared state is the
    // PG-backed decision table — the true two-connection delivery:
    const buildService = (repo: ProgressiveReleaseDecisionRepository) => {
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
      };
    };
    const actorAStack = buildService(actorA);
    const actorBStack = buildService(actorB);
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
    // Both actors' results converge on the same recorded decision (the
    // continue carries no governed consequences, so the loser converges
    // to the atomically-final executed record — the duplicate):
    const outcomes = [resultA.outcome, resultB.outcome].sort();
    expect(outcomes).toEqual(['decided', 'duplicate']);
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

  it('ARCHITECT-REGRESSION (PR #108) — the full-service two-actor HALT: concurrent deliveries of the same halt identity → the consequences execute EXACTLY ONCE (ONE decision row, ONE audit event; the loser NEVER re-executes)', async () => {
    await db.client.exec(`DELETE FROM wfos_test_progressive_decisions`);
    const clock = fixedClock('2026-09-02T00:00:00Z');
    // ONE shared audit writer — the discriminating consequence counter
    // (only the reservation owner reaches the audit write; a duplicate or
    // a rejected pending re-delivery emits NOTHING):
    const sharedAudit = new RecordingAuditWriter();
    const buildService = (repo: ProgressiveReleaseDecisionRepository) => {
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
          auditWriter: sharedAudit,
          now: clock,
        }),
        continuousValidationService,
      };
    };
    const actorAStack = buildService(actorA);
    const actorBStack = buildService(actorB);
    // Both actors see the same recorded facts (the same completed FAILED
    // POST_RELEASE run — a halt at the partial stage):
    for (const stack of [actorAStack, actorBStack]) {
      await completedPostReleaseRun(stack.continuousValidationService, {
        runId: 'run-pg-failed',
        releaseRef: 'release-pg-halt',
        outcome: 'validation_failure',
      });
    }
    const request = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      environmentId: 'env-prod-rollout',
      releaseRef: 'release-pg-halt',
      rolloutStage: 'partial',
      validationRunId: 'run-pg-failed',
    } as const;
    const settled = await Promise.allSettled([
      actorAStack.service.decideProgressiveRelease({ ...request }),
      actorBStack.service.decideProgressiveRelease({ ...request }),
    ]);
    // Exactly ONE decided outcome; the other delivery either failed
    // closed with the typed pending tombstone or (if it arrived after the
    // completion) is the idempotent duplicate — in EVERY interleaving the
    // consequences execute exactly once:
    const decided = settled.filter(
      (s) => s.status === 'fulfilled' && s.value.outcome === 'decided',
    );
    expect(decided).toHaveLength(1);
    for (const s of settled) {
      if (s === decided[0]) continue;
      if (s.status === 'fulfilled') {
        expect(s.value.outcome).toBe('duplicate');
      } else {
        expect(String(s.reason)).toMatch(/\[PR_DECISION_CONSEQUENCES_PENDING\]/);
      }
    }
    // The ONE recorded decision row carries the executed consequences:
    const rows = await db.client.query<Row>(
      `SELECT * FROM wfos_test_progressive_decisions WHERE release_ref = 'release-pg-halt'`,
    );
    expect(rows.rows).toHaveLength(1);
    const row = rowToRecord(rows.rows[0]!);
    expect(row.decision).toBe('halt');
    expect(row.consequencePhase).toBe('executed');
    expect(row.signalOutcomes).toHaveLength(1);
    // …and the shared audit writer observed EXACTLY ONE decided event
    // (the loser never reached the audit write):
    const events = sharedAudit.events.filter((e) => e.eventType === 'PROGRESSIVE_RELEASE_DECISION');
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ signalsEmitted: 1 });
  });

  it('ARCHITECT-REGRESSION (PR #108) — the full-service two-actor RECOVER with the rollback authority BOUND: concurrent deliveries → the rollback is invoked EXACTLY ONCE (ONE decision row; the loser NEVER re-invokes)', async () => {
    await db.client.exec(`DELETE FROM wfos_test_progressive_decisions`);
    const clock = fixedClock('2026-09-02T00:00:00Z');
    // ONE shared rollback authority — the NON-IDEMPOTENT consequence
    // counter (the recording fake has NO dedup; exactly one invocation is
    // the protocol's own guarantee, not the authority's):
    const sharedRollback = new RecordingRollbackAuthority(invokedRollback);
    const buildService = (repo: ProgressiveReleaseDecisionRepository) => {
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
          rollbackAuthority: sharedRollback,
          decisionRepository: repo,
          auditWriter: new RecordingAuditWriter(),
          now: clock,
        }),
        continuousValidationService,
      };
    };
    const actorAStack = buildService(actorA);
    const actorBStack = buildService(actorB);
    // Both actors see the same recorded facts (the same completed FAILED
    // POST_RELEASE run — a canary recover: the exposure is contained, the
    // rollback is the cheap safe recovery):
    for (const stack of [actorAStack, actorBStack]) {
      await completedPostReleaseRun(stack.continuousValidationService, {
        runId: 'run-pg-recover',
        releaseRef: 'release-pg-recover',
        outcome: 'validation_failure',
      });
    }
    const request = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      environmentId: 'env-prod-rollout',
      releaseRef: 'release-pg-recover',
      rolloutStage: 'canary',
      validationRunId: 'run-pg-recover',
    } as const;
    const settled = await Promise.allSettled([
      actorAStack.service.decideProgressiveRelease({ ...request }),
      actorBStack.service.decideProgressiveRelease({ ...request }),
    ]);
    // Exactly ONE decided outcome; the loser either failed closed with
    // the typed pending tombstone or is the idempotent duplicate:
    const decided = settled.filter(
      (s) => s.status === 'fulfilled' && s.value.outcome === 'decided',
    );
    expect(decided).toHaveLength(1);
    const decidedResult = decided[0] as { status: 'fulfilled'; value: Awaited<ReturnType<ProgressiveReleaseService['decideProgressiveRelease']>> };
    expect(decidedResult.value.decision.decision).toBe('recover');
    for (const s of settled) {
      if (s === decided[0]) continue;
      if (s.status === 'fulfilled') {
        expect(s.value.outcome).toBe('duplicate');
      } else {
        expect(String(s.reason)).toMatch(/\[PR_DECISION_CONSEQUENCES_PENDING\]/);
      }
    }
    // THE LOAD-BEARING ASSERTION: the rollback authority was invoked
    // EXACTLY ONCE — the pre-correction implementation would invoke it
    // once per racing delivery (a repeated rollback for the same decision
    // identity under the crash/concurrency window):
    expect(sharedRollback.invocations).toHaveLength(1);
    expect(sharedRollback.invocations[0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      releaseRef: 'release-pg-recover',
      rolloutStage: 'canary',
      reason: 'RECOVER_CANARY_VALIDATION_FAILURE',
    });
    // …and the ONE recorded decision row carries the executed rollback:
    const rows = await db.client.query<Row>(
      `SELECT * FROM wfos_test_progressive_decisions WHERE release_ref = 'release-pg-recover'`,
    );
    expect(rows.rows).toHaveLength(1);
    const row = rowToRecord(rows.rows[0]!);
    expect(row.decision).toBe('recover');
    expect(row.consequencePhase).toBe('executed');
    expect(row.rollback).toMatchObject({ invoked: true });
  });

  it('ARCHITECT-REGRESSION (PR #108) — the crash window: a completion that fails after the consequences executed leaves a DURABLE pending record; the re-delivery fails closed (typed) and re-executes NOTHING', async () => {
    await db.client.exec(`DELETE FROM wfos_test_progressive_decisions`);
    const clock = fixedClock('2026-09-02T00:00:00Z');
    const sharedRollback = new RecordingRollbackAuthority(invokedRollback);
    // The crash simulation: the completion write FAILS (the process died
    // between the consequence execution and the completion persistence).
    // The reservation itself succeeded — the record is durable:
    const crashingCompletion = {
      reserve: actorA.reserve.bind(actorA),
      completeDecision: async () => {
        throw new Error('simulated crash: the completion write did not happen');
      },
      findById: actorA.findById.bind(actorA),
      listForRollout: actorA.listForRollout.bind(actorA),
    } as unknown as ProgressiveReleaseDecisionRepository;
    const continuousValidationService = new DefaultContinuousValidationService({
      runRepository: new InMemoryValidationRunRepository(),
      verificationService: new FakeVerificationBoundaryForPg(),
    });
    const service = new DefaultProgressiveReleaseService({
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
      rollbackAuthority: sharedRollback,
      decisionRepository: crashingCompletion,
      auditWriter: new RecordingAuditWriter(),
      now: clock,
    });
    await completedPostReleaseRun(continuousValidationService, {
      runId: 'run-pg-crash',
      releaseRef: 'release-pg-crash',
      outcome: 'validation_failure',
    });
    const request = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      environmentId: 'env-prod-rollout',
      releaseRef: 'release-pg-crash',
      rolloutStage: 'canary',
      validationRunId: 'run-pg-crash',
    } as const;
    // The first delivery: the consequences executed (the rollback was
    // invoked), then the "crash":
    await expect(service.decideProgressiveRelease({ ...request })).rejects.toThrowError(
      /simulated crash/,
    );
    // …but the decision record IS durable (the reservation preceded the
    // consequences — the PR #108 correction):
    const input = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      releaseRef: 'release-pg-crash',
      rolloutStage: 'canary' as const,
      validationRunId: 'run-pg-crash',
      runtimeObservationRef: 'runtime-observation:deployment:dpl-rollout-1:2026-09-01T12:10:00Z',
    };
    const { decisionId } = deriveDecisionIdentity(input);
    const durable = await actorA.findById(decisionId);
    expect(durable).not.toBeNull();
    expect(durable!.consequencePhase).toBe('pending');
    expect(durable!.decision).toBe('recover');
    // The re-delivery (a NEW service instance over the honest adapter):
    // it finds the durable-but-unresolved reservation and fails CLOSED —
    // it does NOT re-execute the consequences:
    const reDelivery = new DefaultProgressiveReleaseService({
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
      rollbackAuthority: sharedRollback,
      decisionRepository: actorA,
      auditWriter: new RecordingAuditWriter(),
      now: clock,
    });
    await expect(reDelivery.decideProgressiveRelease({ ...request })).rejects.toThrowError(
      /\[PR_DECISION_CONSEQUENCES_PENDING\]/,
    );
    // …and the side effects were NOT repeated (exactly ONE rollback
    // invocation — from the first, crashed delivery only):
    expect(sharedRollback.invocations).toHaveLength(1);
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
    await actorA.reserve(record);
    // A same-id/different-fingerprint reserve (a forged logical identity):
    const forged: ProgressiveReleaseDecisionRecord = {
      ...record,
      identityFingerprint: 'forged-fingerprint',
      validationRunId: 'run-OTHER',
    };
    await expect(actorB.reserve(forged)).rejects.toThrowError(/cannot carry two logical decisions/);
  });

  it('the keyed-not-global discrimination: concurrent reserves for DIFFERENT rollouts do NOT serialize on each other (both persist)', async () => {
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
    await Promise.all([actorA.reserve(a), actorB.reserve(b)]);
    const rows = await db.client.query<{ decision_id: string }>(
      `SELECT decision_id FROM wfos_test_progressive_decisions`,
    );
    expect(rows.rows).toHaveLength(2);
  });

  it('MUTATION PROOF: without the keyed constraint the same-key concurrent reserve produces TWO rows — the duplicate invariant FAILS (the constraint is load-bearing; restored after)', async () => {
    // The mutation: a constraint-free table (the decision-identity
    // uniqueness enforcement REMOVED). The same concurrent same-key
    // reserve now forks the logical decision — exactly the failure the
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
        consequence_phase      TEXT NOT NULL,
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
          record.consequencePhase,
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
