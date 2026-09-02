/**
 * V2-005 — the PostgreSQL workflow-runs persistence layer.
 *
 * Durable run data ONLY (migration 0061 — the wfos_v2_run_* tables). The
 * merged V2-002 repository tables are NEVER referenced here (the repository
 * service's public barrel is the only version/pin resolution path — pinned at
 * source level by the module-boundary battery).
 *
 * CONCURRENCY DISCIPLINE (the work order's "explicit concurrency boundaries"):
 *
 *   - CREATE-OR-CONVERGE everywhere: INSERT ... ON CONFLICT DO NOTHING +
 *     re-read. Deterministic identities make duplicate submissions converge
 *     structurally — divergent duplicate rows are unrepresentable.
 *   - LIFECYCLE TRANSITIONS are single guarded CAS statements
 *     (`UPDATE ... SET state = $to WHERE id = $1 AND state = $from`): the
 *     UPDATE itself is the serialization point (the row lock + the WHERE
 *     guard + the migration's state-machine trigger — a stale writer either
 *     matches 0 rows or is rejected by the trigger; ordering is decided by
 *     the DATABASE boundary, never by caller luck).
 *   - The DURABLE single-use replay state for V2-014 attestation nonces is
 *     the wfos_v2_run_attestations row itself (UNIQUE attestation_id +
 *     UNIQUE (run, attempt, nonce)) — the INSERT is the consumption.
 *   - Multi-statement commands are deliberately NOT wrapped in one SQL
 *     transaction: every statement is independently convergent (idempotent
 *     writes + deterministic identities), so a crash between statements
 *     leaves a reconstructable partial state that the command log replays
 *     deterministically (crash recovery). The command row itself is claimed
 *     with a single autocommit INSERT before any side effect runs — the
 *     exactly-once boundary.
 *
 * Timestamps cross the wire as fixed-format UTC strings and are normalized
 * back with the pure formatter (no Date API in this module).
 */
import type { DatabaseClient } from '@platform/index.js';
import { toUtcIsoString } from './run-clock.js';
import type {
  RunAttempt,
  RunAttemptState,
  RunAttestationBinding,
  RunAttestationRejection,
  RunCapabilityInvocation,
  RunCommandRecord,
  RunCommandType,
  RunEvidenceRecord,
  RunInvocationOutcome,
  RunStepExecution,
  RunStepStatus,
  RunTimelineEntry,
  RunTimelineEventName,
  WorkflowRun,
  WorkflowRunState,
} from '../types.js';

// ============================================================================
// Row shapes (snake_case in PostgreSQL, mapped to the typed records)
// ============================================================================

export interface RunRow {
  [column: string]: unknown;
  id: string;
  organization_id: string;
  workflow_id: string;
  version_id: string;
  version_content_digest: string;
  version_semantic_digest: string;
  installation_id: string | null;
  trigger_type: string;
  trigger_id: string;
  triggered_by_user_id: string | null;
  input_commitments: unknown[];
  input_digest: string;
  state: WorkflowRunState;
  created_at: unknown;
  updated_at: unknown;
}

export interface AttemptRow {
  [column: string]: unknown;
  id: string;
  run_id: string;
  attempt_number: number;
  state: RunAttemptState;
  node_id: string | null;
  paused_at_step_id: string | null;
  started_at: unknown;
  ended_at: unknown;
}

export interface StepRow {
  [column: string]: unknown;
  id: string;
  run_id: string;
  attempt_number: number;
  step_id: string;
  status: RunStepStatus;
  input_commitments: unknown[];
  output_commitments: unknown[];
  outcome: RunInvocationOutcome | null;
  started_at: unknown;
  completed_at: unknown;
  seq: string | number;
}

export interface InvocationRow {
  [column: string]: unknown;
  id: string;
  run_id: string;
  attempt_number: number;
  step_id: string | null;
  capability: string;
  execution_class: string;
  input_commitments: unknown[];
  output_commitments: unknown[];
  outcome: RunInvocationOutcome | null;
  requested_at: unknown;
  completed_at: unknown;
  seq: string | number;
}

export interface EvidenceRow {
  [column: string]: unknown;
  id: string;
  run_id: string;
  attempt_number: number | null;
  step_id: string | null;
  evidence_class: string;
  producer_kind: string;
  producer_id: string;
  content_commitment: string;
  description: string | null;
  recorded_at: unknown;
}

export interface AttestationBindingRow {
  [column: string]: unknown;
  attestation_id: string;
  run_id: string;
  attempt_number: number;
  step_id: string | null;
  execution_digest: string;
  attester_key_id: string;
  assurance: string;
  nonce: string;
  statement: Record<string, unknown>;
  verified_at: unknown;
  attached_at: unknown;
}

export interface RejectionRow {
  [column: string]: unknown;
  id: string;
  run_id: string;
  attestation_id: string | null;
  failure_code: string;
  detail: string;
  rejected_at: unknown;
}

export interface EventRow {
  [column: string]: unknown;
  id: string;
  run_id: string;
  attempt_number: number | null;
  step_id: string | null;
  event_name: RunTimelineEventName;
  occurred_at: unknown;
  seq: string | number;
  detail: Record<string, unknown> | null;
}

export interface CommandRow {
  [column: string]: unknown;
  id: string;
  organization_id: string;
  run_id: string | null;
  command_id: string;
  correlation_id: string;
  causation_id: string | null;
  command_type: RunCommandType;
  payload_digest: string;
  result: Record<string, unknown> | null;
  executed_at: unknown;
}

const RUN_COLUMNS = `id, organization_id, workflow_id, version_id, version_content_digest,
  version_semantic_digest, installation_id, trigger_type, trigger_id, triggered_by_user_id,
  input_commitments, input_digest, state, created_at, updated_at`;
const ATTEMPT_COLUMNS = `id, run_id, attempt_number, state, node_id, paused_at_step_id,
  started_at, ended_at`;
const STEP_COLUMNS = `id, run_id, attempt_number, step_id, status, input_commitments,
  output_commitments, outcome, started_at, completed_at, seq`;
const INVOCATION_COLUMNS = `id, run_id, attempt_number, step_id, capability, execution_class,
  input_commitments, output_commitments, outcome, requested_at, completed_at, seq`;
const EVIDENCE_COLUMNS = `id, run_id, attempt_number, step_id, evidence_class, producer_kind,
  producer_id, content_commitment, description, recorded_at`;
const BINDING_COLUMNS = `attestation_id, run_id, attempt_number, step_id, execution_digest,
  attester_key_id, assurance, nonce, statement, verified_at, attached_at`;
const REJECTION_COLUMNS = `id, run_id, attestation_id, failure_code, detail, rejected_at`;
const EVENT_COLUMNS = `id, run_id, attempt_number, step_id, event_name, occurred_at, seq, detail`;
const COMMAND_COLUMNS = `id, organization_id, run_id, command_id, correlation_id, causation_id,
  command_type, payload_digest, result, executed_at`;

/** The typed result JSON stored in the command log. */
export type CommandResultJson =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

export class PgWorkflowRunStore {
  constructor(private readonly db: DatabaseClient) {}

  // --- commands (the exactly-once log) ---------------------------------------

  /** Claim the command (create-or-converge on (organization, command_id)). */
  async insertCommandOrConverge(row: {
    readonly id: string;
    readonly organizationId: string;
    readonly runId: string | null;
    readonly commandId: string;
    readonly correlationId: string;
    readonly causationId: string | null;
    readonly commandType: RunCommandType;
    readonly payloadDigest: string;
    readonly executedAt: string;
  }): Promise<{ row: CommandRow; created: boolean }> {
    const inserted = await this.db.query<CommandRow>(
      `INSERT INTO wfos_v2_run_commands
         (id, organization_id, run_id, command_id, correlation_id, causation_id,
          command_type, payload_digest, result, executed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9)
       ON CONFLICT (organization_id, command_id) DO NOTHING
       RETURNING ${COMMAND_COLUMNS}`,
      [
        row.id,
        row.organizationId,
        row.runId,
        row.commandId,
        row.correlationId,
        row.causationId,
        row.commandType,
        row.payloadDigest,
        row.executedAt,
      ],
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
    const existing = await this.findCommand(row.organizationId, row.commandId);
    if (!existing) {
      throw new Error(
        `workflow-runs: converged command (${row.organizationId}, ${row.commandId}) disappeared`,
      );
    }
    return { row: existing, created: false };
  }

  async findCommand(organizationId: string, commandId: string): Promise<CommandRow | null> {
    const result = await this.db.query<CommandRow>(
      `SELECT ${COMMAND_COLUMNS} FROM wfos_v2_run_commands
       WHERE organization_id = $1 AND command_id = $2`,
      [organizationId, commandId],
    );
    return result.rows[0] ?? null;
  }

  /** The single sanctioned UPDATE: fill the typed result (fill-once). */
  async fillCommandResult(commandRowId: string, result: CommandResultJson): Promise<void> {
    await this.db.query(
      `UPDATE wfos_v2_run_commands SET result = $2 WHERE id = $1 AND result IS NULL`,
      [commandRowId, JSON.stringify(result)],
    );
  }

  async listCommandsForRun(runId: string): Promise<CommandRow[]> {
    const result = await this.db.query<CommandRow>(
      `SELECT ${COMMAND_COLUMNS} FROM wfos_v2_run_commands
       WHERE run_id = $1 ORDER BY executed_at ASC, command_id ASC`,
      [runId],
    );
    return result.rows;
  }

  // --- runs -------------------------------------------------------------------

  async findRunById(runId: string): Promise<RunRow | null> {
    const result = await this.db.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM wfos_v2_runs WHERE id = $1`,
      [runId],
    );
    return result.rows[0] ?? null;
  }

  async listRunsInOrganization(organizationId: string): Promise<RunRow[]> {
    const result = await this.db.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM wfos_v2_runs
       WHERE organization_id = $1 ORDER BY created_at ASC, id ASC`,
      [organizationId],
    );
    return result.rows;
  }

  /** Create-or-converge on the deterministic trigger-surface identity. */
  async insertRunOrConverge(row: {
    readonly id: string;
    readonly organizationId: string;
    readonly workflowId: string;
    readonly versionId: string;
    readonly versionContentDigest: string;
    readonly versionSemanticDigest: string;
    readonly installationId: string | null;
    readonly triggerType: string;
    readonly triggerId: string;
    readonly triggeredByUserId: string | null;
    readonly inputCommitments: readonly string[];
    readonly inputDigest: string;
    readonly createdAt: string;
  }): Promise<{ row: RunRow; created: boolean }> {
    const inserted = await this.db.query<RunRow>(
      `INSERT INTO wfos_v2_runs
         (id, organization_id, workflow_id, version_id, version_content_digest,
          version_semantic_digest, installation_id, trigger_type, trigger_id,
          triggered_by_user_id, input_commitments, input_digest, state,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
               'requested', $13, $13)
       ON CONFLICT (organization_id, workflow_id, version_id, trigger_type, trigger_id, input_digest)
       DO NOTHING
       RETURNING ${RUN_COLUMNS}`,
      [
        row.id,
        row.organizationId,
        row.workflowId,
        row.versionId,
        row.versionContentDigest,
        row.versionSemanticDigest,
        row.installationId,
        row.triggerType,
        row.triggerId,
        row.triggeredByUserId,
        JSON.stringify(row.inputCommitments),
        row.inputDigest,
        row.createdAt,
      ],
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
    const existing = await this.db.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM wfos_v2_runs
       WHERE organization_id = $1 AND workflow_id = $2 AND version_id = $3
         AND trigger_type = $4 AND trigger_id = $5 AND input_digest = $6`,
      [
        row.organizationId,
        row.workflowId,
        row.versionId,
        row.triggerType,
        row.triggerId,
        row.inputDigest,
      ],
    );
    if (!existing.rows[0]) {
      throw new Error(
        `workflow-runs: converged run (${row.organizationId}, ${row.triggerId}) disappeared`,
      );
    }
    return { row: existing.rows[0], created: false };
  }

  /**
   * The lifecycle CAS: the UPDATE is the serialization point. `null` = the
   * guard missed (the state moved between the caller's read and this write).
   */
  async transitionRunState(
    runId: string,
    from: WorkflowRunState,
    to: WorkflowRunState,
    updatedAt: string,
  ): Promise<RunRow | null> {
    const result = await this.db.query<RunRow>(
      `UPDATE wfos_v2_runs SET state = $3, updated_at = $4
       WHERE id = $1 AND state = $2
       RETURNING ${RUN_COLUMNS}`,
      [runId, from, to, updatedAt],
    );
    return result.rows[0] ?? null;
  }

  // --- attempts ---------------------------------------------------------------

  async findLatestAttempt(runId: string): Promise<AttemptRow | null> {
    const result = await this.db.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM wfos_v2_run_attempts
       WHERE run_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
      [runId],
    );
    return result.rows[0] ?? null;
  }

  async findAttempt(runId: string, attemptNumber: number): Promise<AttemptRow | null> {
    const result = await this.db.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM wfos_v2_run_attempts
       WHERE run_id = $1 AND attempt_number = $2`,
      [runId, attemptNumber],
    );
    return result.rows[0] ?? null;
  }

  async listAttempts(runId: string): Promise<AttemptRow[]> {
    const result = await this.db.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM wfos_v2_run_attempts
       WHERE run_id = $1 ORDER BY attempt_number ASC`,
      [runId],
    );
    return result.rows;
  }

  async insertAttemptOrConverge(row: {
    readonly id: string;
    readonly runId: string;
    readonly attemptNumber: number;
    readonly state: RunAttemptState;
    readonly nodeId: string | null;
    readonly startedAt: string;
  }): Promise<{ row: AttemptRow; created: boolean }> {
    const inserted = await this.db.query<AttemptRow>(
      `INSERT INTO wfos_v2_run_attempts
         (id, run_id, attempt_number, state, node_id, paused_at_step_id, started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, NULL)
       ON CONFLICT (run_id, attempt_number) DO NOTHING
       RETURNING ${ATTEMPT_COLUMNS}`,
      [row.id, row.runId, row.attemptNumber, row.state, row.nodeId, row.startedAt],
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
    const existing = await this.findAttempt(row.runId, row.attemptNumber);
    if (!existing) {
      throw new Error(
        `workflow-runs: converged attempt (${row.runId}, ${row.attemptNumber}) disappeared`,
      );
    }
    return { row: existing, created: false };
  }

  /** Pause: suspend the attempt AT the recorded step (explicit overwrite). */
  async suspendAttempt(
    attemptRowId: string,
    patch: { readonly pausedAtStepId: string | null; readonly nodeId?: string | null },
  ): Promise<AttemptRow | null> {
    const result = await this.db.query<AttemptRow>(
      `UPDATE wfos_v2_run_attempts SET
         state = 'suspended', paused_at_step_id = $2,
         node_id = COALESCE($3, node_id)
       WHERE id = $1
       RETURNING ${ATTEMPT_COLUMNS}`,
      [attemptRowId, patch.pausedAtStepId, patch.nodeId ?? null],
    );
    return result.rows[0] ?? null;
  }

  /** Resume in place: clear the resume point, keep/replace the node. */
  async continueAttempt(
    attemptRowId: string,
    patch: { readonly nodeId?: string | null },
  ): Promise<AttemptRow | null> {
    const result = await this.db.query<AttemptRow>(
      `UPDATE wfos_v2_run_attempts SET
         state = 'running', paused_at_step_id = NULL,
         node_id = COALESCE($2, node_id)
       WHERE id = $1
       RETURNING ${ATTEMPT_COLUMNS}`,
      [attemptRowId, patch.nodeId ?? null],
    );
    return result.rows[0] ?? null;
  }

  /** End the attempt (declared interruption or run terminal). */
  async endAttempt(
    attemptRowId: string,
    state: 'interrupted' | 'ended',
    endedAt: string,
  ): Promise<AttemptRow | null> {
    const result = await this.db.query<AttemptRow>(
      `UPDATE wfos_v2_run_attempts SET state = $2, ended_at = $3
       WHERE id = $1
       RETURNING ${ATTEMPT_COLUMNS}`,
      [attemptRowId, state, endedAt],
    );
    return result.rows[0] ?? null;
  }

  // --- steps ------------------------------------------------------------------

  async findStep(runId: string, attemptNumber: number, stepId: string): Promise<StepRow | null> {
    const result = await this.db.query<StepRow>(
      `SELECT ${STEP_COLUMNS} FROM wfos_v2_run_steps
       WHERE run_id = $1 AND attempt_number = $2 AND step_id = $3`,
      [runId, attemptNumber, stepId],
    );
    return result.rows[0] ?? null;
  }

  async listSteps(runId: string): Promise<StepRow[]> {
    const result = await this.db.query<StepRow>(
      `SELECT ${STEP_COLUMNS} FROM wfos_v2_run_steps
       WHERE run_id = $1 ORDER BY seq ASC`,
      [runId],
    );
    return result.rows;
  }

  async insertStepOrConverge(row: {
    readonly id: string;
    readonly runId: string;
    readonly attemptNumber: number;
    readonly stepId: string;
    readonly inputCommitments: readonly string[];
    readonly startedAt: string;
  }): Promise<{ row: StepRow; created: boolean }> {
    const inserted = await this.db.query<StepRow>(
      `INSERT INTO wfos_v2_run_steps
         (id, run_id, attempt_number, step_id, status, input_commitments,
          output_commitments, outcome, started_at, completed_at)
       VALUES ($1, $2, $3, $4, 'started', $5::jsonb, '[]'::jsonb, NULL, $6, NULL)
       ON CONFLICT (run_id, attempt_number, step_id) DO NOTHING
       RETURNING ${STEP_COLUMNS}`,
      [
        row.id,
        row.runId,
        row.attemptNumber,
        row.stepId,
        JSON.stringify(row.inputCommitments),
        row.startedAt,
      ],
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
    const existing = await this.findStep(row.runId, row.attemptNumber, row.stepId);
    if (!existing) {
      throw new Error(
        `workflow-runs: converged step (${row.runId}, ${row.stepId}) disappeared`,
      );
    }
    return { row: existing, created: false };
  }

  /** Completion fields only (guarded on the started status). */
  async updateStepCompletion(
    stepRowId: string,
    patch: {
      readonly status: RunStepStatus;
      readonly outcome: RunInvocationOutcome;
      readonly outputCommitments: readonly string[];
      readonly completedAt: string;
    },
  ): Promise<StepRow | null> {
    const result = await this.db.query<StepRow>(
      `UPDATE wfos_v2_run_steps SET
         status = $2, outcome = $3, output_commitments = $4::jsonb, completed_at = $5
       WHERE id = $1 AND status = 'started'
       RETURNING ${STEP_COLUMNS}`,
      [stepRowId, patch.status, patch.outcome, JSON.stringify(patch.outputCommitments), patch.completedAt],
    );
    return result.rows[0] ?? null;
  }

  // --- invocations --------------------------------------------------------------

  async findInvocation(runId: string, invocationId: string): Promise<InvocationRow | null> {
    const result = await this.db.query<InvocationRow>(
      `SELECT ${INVOCATION_COLUMNS} FROM wfos_v2_run_invocations
       WHERE run_id = $1 AND id = $2`,
      [runId, invocationId],
    );
    return result.rows[0] ?? null;
  }

  async listInvocations(runId: string): Promise<InvocationRow[]> {
    const result = await this.db.query<InvocationRow>(
      `SELECT ${INVOCATION_COLUMNS} FROM wfos_v2_run_invocations
       WHERE run_id = $1 ORDER BY seq ASC`,
      [runId],
    );
    return result.rows;
  }

  async insertInvocationOrConverge(row: {
    readonly id: string;
    readonly runId: string;
    readonly attemptNumber: number;
    readonly stepId: string | null;
    readonly capability: string;
    readonly executionClass: string;
    readonly inputCommitments: readonly string[];
    readonly requestedAt: string;
  }): Promise<{ row: InvocationRow; created: boolean }> {
    const inserted = await this.db.query<InvocationRow>(
      `INSERT INTO wfos_v2_run_invocations
         (id, run_id, attempt_number, step_id, capability, execution_class,
          input_commitments, output_commitments, outcome, requested_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, '[]'::jsonb, NULL, $8, NULL)
       ON CONFLICT (id) DO NOTHING
       RETURNING ${INVOCATION_COLUMNS}`,
      [
        row.id,
        row.runId,
        row.attemptNumber,
        row.stepId,
        row.capability,
        row.executionClass,
        JSON.stringify(row.inputCommitments),
        row.requestedAt,
      ],
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
    const existing = await this.findInvocation(row.runId, row.id);
    if (!existing) {
      throw new Error(
        `workflow-runs: converged invocation (${row.runId}, ${row.id}) disappeared`,
      );
    }
    return { row: existing, created: false };
  }

  async updateInvocationCompletion(
    invocationRowId: string,
    patch: {
      readonly outcome: RunInvocationOutcome;
      readonly outputCommitments: readonly string[];
      readonly completedAt: string;
    },
  ): Promise<InvocationRow | null> {
    const result = await this.db.query<InvocationRow>(
      `UPDATE wfos_v2_run_invocations SET
         outcome = $2, output_commitments = $3::jsonb, completed_at = $4
       WHERE id = $1 AND outcome IS NULL
       RETURNING ${INVOCATION_COLUMNS}`,
      [invocationRowId, patch.outcome, JSON.stringify(patch.outputCommitments), patch.completedAt],
    );
    return result.rows[0] ?? null;
  }

  // --- evidence -----------------------------------------------------------------

  async listEvidence(runId: string): Promise<EvidenceRow[]> {
    const result = await this.db.query<EvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS} FROM wfos_v2_run_evidence
       WHERE run_id = $1 ORDER BY recorded_at ASC, id ASC`,
      [runId],
    );
    return result.rows;
  }

  async findEvidenceById(evidenceId: string): Promise<EvidenceRow | null> {
    const result = await this.db.query<EvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS} FROM wfos_v2_run_evidence WHERE id = $1`,
      [evidenceId],
    );
    return result.rows[0] ?? null;
  }

  async insertEvidenceOrConverge(row: {
    readonly id: string;
    readonly runId: string;
    readonly attemptNumber: number | null;
    readonly stepId: string | null;
    readonly evidenceClass: string;
    readonly producerKind: string;
    readonly producerId: string;
    readonly contentCommitment: string;
    readonly description: string | null;
    readonly recordedAt: string;
  }): Promise<{ row: EvidenceRow; created: boolean }> {
    const inserted = await this.db.query<EvidenceRow>(
      `INSERT INTO wfos_v2_run_evidence
         (id, run_id, attempt_number, step_id, evidence_class, producer_kind,
          producer_id, content_commitment, description, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (run_id, evidence_class, producer_kind, producer_id, content_commitment)
       DO NOTHING
       RETURNING ${EVIDENCE_COLUMNS}`,
      [
        row.id,
        row.runId,
        row.attemptNumber,
        row.stepId,
        row.evidenceClass,
        row.producerKind,
        row.producerId,
        row.contentCommitment,
        row.description,
        row.recordedAt,
      ],
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
    const existing = await this.findEvidenceById(row.id);
    if (!existing) {
      throw new Error(
        `workflow-runs: converged evidence (${row.runId}, ${row.id}) disappeared`,
      );
    }
    return { row: existing, created: false };
  }

  // --- attestation bindings (the DURABLE single-use replay state) ---------------

  async listAttestationBindings(runId: string): Promise<AttestationBindingRow[]> {
    const result = await this.db.query<AttestationBindingRow>(
      `SELECT ${BINDING_COLUMNS} FROM wfos_v2_run_attestations
       WHERE run_id = $1 ORDER BY attached_at ASC, attestation_id ASC`,
      [runId],
    );
    return result.rows;
  }

  async findBindingByAttestation(
    runId: string,
    attestationId: string,
  ): Promise<AttestationBindingRow | null> {
    const result = await this.db.query<AttestationBindingRow>(
      `SELECT ${BINDING_COLUMNS} FROM wfos_v2_run_attestations
       WHERE run_id = $1 AND attestation_id = $2`,
      [runId, attestationId],
    );
    return result.rows[0] ?? null;
  }

  /** The consumed nonce surface for a run: `runId:attempt:nonce` keys. */
  async loadConsumedNonces(runId: string): Promise<Set<string>> {
    const result = await this.db.query<{ run_id: string; attempt_number: number; nonce: string }>(
      `SELECT run_id, attempt_number, nonce FROM wfos_v2_run_attestations WHERE run_id = $1`,
      [runId],
    );
    const keys = new Set<string>();
    for (const row of result.rows) {
      keys.add(`${row.run_id}:${row.attempt_number}:${row.nonce}`);
    }
    return keys;
  }

  /**
   * The durable single-use consumption: the INSERT is the consumption
   * (UNIQUE attestation_id + UNIQUE (run, attempt, nonce)). `row: null` =
   * the consumption already exists (a concurrent or prior winner) — the
   * caller surfaces that as a durable replay rejection.
   */
  async insertBindingOrConverge(row: {
    readonly attestationId: string;
    readonly runId: string;
    readonly attemptNumber: number;
    readonly stepId: string | null;
    readonly executionDigest: string;
    readonly attesterKeyId: string;
    readonly assurance: string;
    readonly nonce: string;
    readonly statement: Record<string, unknown>;
    readonly verifiedAt: string;
    readonly attachedAt: string;
  }): Promise<{ row: AttestationBindingRow | null; created: boolean }> {
    const inserted = await this.db.query<AttestationBindingRow>(
      `INSERT INTO wfos_v2_run_attestations
         (attestation_id, run_id, attempt_number, step_id, execution_digest,
          attester_key_id, assurance, nonce, statement, verified_at, attached_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       ON CONFLICT (attestation_id) DO NOTHING
       RETURNING ${BINDING_COLUMNS}`,
      [
        row.attestationId,
        row.runId,
        row.attemptNumber,
        row.stepId,
        row.executionDigest,
        row.attesterKeyId,
        row.assurance,
        row.nonce,
        JSON.stringify(row.statement),
        row.verifiedAt,
        row.attachedAt,
      ],
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
    const existing = await this.findBindingByAttestation(row.runId, row.attestationId);
    return { row: existing, created: false };
  }

  // --- attestation rejections (append-only audit) --------------------------------

  async listRejections(runId: string): Promise<RejectionRow[]> {
    const result = await this.db.query<RejectionRow>(
      `SELECT ${REJECTION_COLUMNS} FROM wfos_v2_run_attestation_rejections
       WHERE run_id = $1 ORDER BY rejected_at ASC, id ASC`,
      [runId],
    );
    return result.rows;
  }

  async insertRejection(row: {
    readonly id: string;
    readonly runId: string;
    readonly attestationId: string | null;
    readonly failureCode: string;
    readonly detail: string;
    readonly rejectedAt: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO wfos_v2_run_attestation_rejections
         (id, run_id, attestation_id, failure_code, detail, rejected_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.runId, row.attestationId, row.failureCode, row.detail, row.rejectedAt],
    );
  }

  // --- the timeline (append-only; the reconstruction source) ----------------------

  async listTimeline(runId: string): Promise<EventRow[]> {
    const result = await this.db.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM wfos_v2_run_events
       WHERE run_id = $1 ORDER BY seq ASC`,
      [runId],
    );
    return result.rows;
  }

  async insertTimelineEvent(row: {
    readonly id: string;
    readonly runId: string;
    readonly attemptNumber: number | null;
    readonly stepId: string | null;
    readonly eventName: RunTimelineEventName;
    readonly occurredAt: string;
    readonly detail: Record<string, unknown> | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO wfos_v2_run_events
         (id, run_id, attempt_number, step_id, event_name, occurred_at, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        row.id,
        row.runId,
        row.attemptNumber,
        row.stepId,
        row.eventName,
        row.occurredAt,
        row.detail === null ? null : JSON.stringify(row.detail),
      ],
    );
  }
}

// ============================================================================
// Row → typed-record mappers (pure; timestamps normalized to fixed UTC)
// ============================================================================

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function commitments(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => str(item)) : [];
}

export function mapRunRow(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workflowId: row.workflow_id,
    versionId: row.version_id,
    versionContentDigest: row.version_content_digest,
    versionSemanticDigest: row.version_semantic_digest,
    installationId: row.installation_id,
    trigger: { type: row.trigger_type as WorkflowRun['trigger']['type'], id: row.trigger_id },
    triggeredByUserId: row.triggered_by_user_id,
    inputCommitments: commitments(row.input_commitments),
    inputDigest: row.input_digest,
    state: row.state,
    createdAt: toUtcIsoString(row.created_at),
    updatedAt: toUtcIsoString(row.updated_at),
  };
}

export function mapAttemptRow(row: AttemptRow): RunAttempt {
  return {
    id: row.id,
    runId: row.run_id,
    attemptNumber: num(row.attempt_number),
    state: row.state,
    nodeId: row.node_id,
    pausedAtStepId: row.paused_at_step_id,
    startedAt: toUtcIsoString(row.started_at),
    endedAt: row.ended_at === null ? null : toUtcIsoString(row.ended_at),
  };
}

export function mapStepRow(row: StepRow): RunStepExecution {
  return {
    id: row.id,
    runId: row.run_id,
    attemptNumber: num(row.attempt_number),
    stepId: row.step_id,
    status: row.status,
    inputCommitments: commitments(row.input_commitments),
    outputCommitments: commitments(row.output_commitments),
    outcome: row.outcome,
    startedAt: toUtcIsoString(row.started_at),
    completedAt: row.completed_at === null ? null : toUtcIsoString(row.completed_at),
  };
}

export function mapInvocationRow(row: InvocationRow): RunCapabilityInvocation {
  return {
    id: row.id,
    runId: row.run_id,
    attemptNumber: num(row.attempt_number),
    stepId: row.step_id,
    capability: row.capability,
    executionClass: row.execution_class as RunCapabilityInvocation['executionClass'],
    inputCommitments: commitments(row.input_commitments),
    outputCommitments: commitments(row.output_commitments),
    outcome: row.outcome,
    requestedAt: toUtcIsoString(row.requested_at),
    completedAt: row.completed_at === null ? null : toUtcIsoString(row.completed_at),
  };
}

export function mapEvidenceRow(row: EvidenceRow): RunEvidenceRecord {
  return {
    id: row.id,
    runId: row.run_id,
    attemptNumber: numOrNull(row.attempt_number),
    stepId: row.step_id,
    evidenceClass: row.evidence_class as RunEvidenceRecord['evidenceClass'],
    producerKind: row.producer_kind,
    producerId: row.producer_id,
    contentCommitment: row.content_commitment,
    description: row.description,
    recordedAt: toUtcIsoString(row.recorded_at),
  };
}

export function mapBindingRow(row: AttestationBindingRow): RunAttestationBinding {
  return {
    attestationId: row.attestation_id,
    runId: row.run_id,
    attemptNumber: num(row.attempt_number),
    stepId: row.step_id,
    executionDigest: row.execution_digest,
    attesterKeyId: row.attester_key_id,
    assurance: row.assurance,
    nonce: row.nonce,
    statement: row.statement,
    verifiedAt: toUtcIsoString(row.verified_at),
    attachedAt: toUtcIsoString(row.attached_at),
  };
}

export function mapRejectionRow(row: RejectionRow): RunAttestationRejection {
  return {
    id: row.id,
    runId: row.run_id,
    attestationId: row.attestation_id,
    failureCode: row.failure_code,
    detail: row.detail,
    rejectedAt: toUtcIsoString(row.rejected_at),
  };
}

export function mapEventRow(row: EventRow): RunTimelineEntry {
  return {
    id: row.id,
    runId: row.run_id,
    attemptNumber: numOrNull(row.attempt_number),
    stepId: row.step_id,
    eventName: row.event_name,
    occurredAt: toUtcIsoString(row.occurred_at),
    sequence: num(row.seq),
    detail: row.detail,
  };
}

export function mapCommandRow(row: CommandRow): RunCommandRecord {
  const raw = row.result;
  let result: RunCommandRecord['result'];
  if (raw !== null && raw.ok === true) {
    result = { ok: true, value: raw.value ?? null };
  } else if (raw !== null && raw.ok === false) {
    result = { ok: false, code: str(raw.code), message: str(raw.message) };
  } else {
    // A claimed-but-unfilled command (the crash window between the claim and
    // the result fill) — surfaced honestly as in-flight, never fabricated as
    // success; replaying the command converges it.
    result = {
      ok: false,
      code: 'RUN_COMMAND_IN_FLIGHT',
      message:
        'the command was claimed but its outcome is not durably recorded yet (crash window) — replaying the command converges it',
    };
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    commandId: row.command_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    commandType: row.command_type,
    payloadDigest: row.payload_digest,
    result,
    executedAt: toUtcIsoString(row.executed_at),
  };
}
