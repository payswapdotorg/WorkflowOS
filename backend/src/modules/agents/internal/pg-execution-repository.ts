/**
 * WORK-027: PostgreSQL persistence for the execution provider abstraction.
 *
 * Three repositories (mirroring migration 0023):
 *   - PgExecutionRecordRepository   → wfos_executions
 *   - PgExecutionEventRepository    → wfos_execution_events
 *   - PgExecutionHandoffRepository  → wfos_execution_handoffs
 *
 * The repositories are pure persistence — they contain no business rules.
 * State transitions of execution records are decided by the services
 * (DefaultExecutionService / DefaultExecutionEventIngestionService /
 * DefaultExecutionHandoffService), never by SQL defaults beyond 'created'.
 *
 * This file is private to /agents (PLAT-AC-02).
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  ExecutionRecord,
  ExecutionRecordRepository,
  CreateExecutionRecordInput,
  UpdateExecutionStatusInput,
  TransitionModeInput,
  ExecutionEventRecord,
  ExecutionEventRepository,
  AppendExecutionEventInput,
  ExecutionHandoffRecord,
  ExecutionHandoffRepository,
  ExternalExecutionPackage,
  ExecutionState,
  ExecutionMode,
  ExecutionCallbackRecord,
  ExecutionCallbackRepository,
} from './execution.types.js';

const RECORD_COLUMNS = `
  id, execution_id, project_id, work_item_id, work_order_id,
  implementation_context_id, mode, provider, model, status, agent_run_id,
  external_session_ref, repository_ref, branch, prompt, prompt_digest,
  package_json, benchmark_metadata, started_at, completed_at, expires_at,
  created_at, updated_at
`;

interface ExecutionRow {
  id: string;
  execution_id: string;
  project_id: string;
  work_item_id: string;
  work_order_id: string;
  implementation_context_id: string;
  mode: string;
  provider: string;
  model: string | null;
  status: string;
  agent_run_id: string | null;
  external_session_ref: string | null;
  repository_ref: string | null;
  branch: string | null;
  prompt: string;
  prompt_digest: string;
  package_json: unknown;
  benchmark_metadata: Record<string, unknown> | null;
  started_at: Date | null;
  completed_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToRecord(row: ExecutionRow): ExecutionRecord {
  return {
    id: row.id,
    executionId: row.execution_id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    workOrderId: row.work_order_id,
    implementationContextId: row.implementation_context_id,
    mode: row.mode as ExecutionMode,
    provider: row.provider,
    model: row.model,
    status: row.status as ExecutionState,
    agentRunId: row.agent_run_id,
    externalSessionRef: row.external_session_ref,
    repositoryRef: row.repository_ref,
    branch: row.branch,
    prompt: row.prompt,
    promptDigest: row.prompt_digest,
    packageValue: (row.package_json as ExternalExecutionPackage | null) ?? null,
    benchmarkMetadata: row.benchmark_metadata ?? {},
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgExecutionRecordRepository implements ExecutionRecordRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateExecutionRecordInput): Promise<ExecutionRecord> {
    const result = await this.db.query<ExecutionRow>(
      `INSERT INTO wfos_executions
         (execution_id, project_id, work_item_id, work_order_id,
          implementation_context_id, mode, provider, model, repository_ref,
          branch, prompt, prompt_digest, benchmark_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${RECORD_COLUMNS}`,
      [
        input.executionId,
        input.projectId,
        input.workItemId,
        input.workOrderId,
        input.implementationContextId,
        input.mode,
        input.provider,
        input.model ?? null,
        input.repositoryRef ?? null,
        input.branch ?? null,
        input.prompt,
        input.promptDigest,
        JSON.stringify(input.benchmarkMetadata ?? {}),
      ],
    );
    return rowToRecord(result.rows[0]!);
  }

  async findById(id: string): Promise<ExecutionRecord | null> {
    const result = await this.db.query<ExecutionRow>(
      `SELECT ${RECORD_COLUMNS} FROM wfos_executions WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async findByExecutionId(executionId: string): Promise<ExecutionRecord | null> {
    const result = await this.db.query<ExecutionRow>(
      `SELECT ${RECORD_COLUMNS} FROM wfos_executions WHERE execution_id = $1`,
      [executionId],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async listForWorkItem(workItemId: string): Promise<ExecutionRecord[]> {
    const result = await this.db.query<ExecutionRow>(
      `SELECT ${RECORD_COLUMNS} FROM wfos_executions
       WHERE work_item_id = $1 ORDER BY created_at DESC`,
      [workItemId],
    );
    return result.rows.map(rowToRecord);
  }

  async updateStatus(
    id: string,
    input: UpdateExecutionStatusInput,
  ): Promise<ExecutionRecord | null> {
    const current = await this.findById(id);
    if (!current) return null;
    const result = await this.db.query<ExecutionRow>(
      `UPDATE wfos_executions SET
         status = $2,
         agent_run_id = COALESCE($3, agent_run_id),
         external_session_ref = COALESCE($4, external_session_ref),
         package_json = COALESCE($5::jsonb, package_json),
         benchmark_metadata = $6::jsonb,
         started_at = COALESCE($7, started_at),
         completed_at = COALESCE($8, completed_at),
         expires_at = COALESCE($9, expires_at),
         updated_at = NOW()
       WHERE id = $1
       RETURNING ${RECORD_COLUMNS}`,
      [
        id,
        input.status,
        input.agentRunId ?? null,
        input.externalSessionRef ?? null,
        input.packageValue !== undefined && input.packageValue !== null
          ? JSON.stringify(input.packageValue)
          : null,
        JSON.stringify({
          ...current.benchmarkMetadata,
          ...(input.benchmarkMetadata ?? {}),
        }),
        input.startedAt ?? null,
        input.completedAt ?? null,
        input.expiresAt ?? null,
      ],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  /**
   * WORK-042: transition an existing execution record's `mode` + `status` +
   * the mode-specific authoritative fields (provider/model/package/agent_run/
   * external_session/expires_at/benchmark_metadata). Used ONLY by the cross-
   * mode handoff service to preserve the SAME execution identity across a
   * native <-> external transition. Unspecified fields keep their current
   * value (COALESCE) so native->external can set package_json + expires_at
   * without clearing agent_run_id, and external->native can set agent_run_id
   * without clearing package_json. The benchmark_metadata is MERGED with the
   * current row (mirrors {@link updateStatus}).
   */
  async transitionMode(
    id: string,
    input: TransitionModeInput,
  ): Promise<ExecutionRecord | null> {
    const current = await this.findById(id);
    if (!current) return null;
    // benchmark_metadata: MERGE with the current row (mirrors updateStatus —
    // a transition never wipes the prior benchmark metadata; the cross-mode
    // handoff enriches it with the new phase's metadata).
    const mergedBenchmark = JSON.stringify({
      ...current.benchmarkMetadata,
      ...(input.benchmarkMetadata ?? {}),
    });
    const result = await this.db.query<ExecutionRow>(
      `UPDATE wfos_executions SET
         mode = $2,
         status = $3,
         provider = COALESCE($4, provider),
         model = COALESCE($5, model),
         package_json = COALESCE($6::jsonb, package_json),
         agent_run_id = COALESCE($7, agent_run_id),
         external_session_ref = COALESCE($8, external_session_ref),
         expires_at = COALESCE($9, expires_at),
         benchmark_metadata = $10::jsonb,
         updated_at = NOW()
       WHERE id = $1
       RETURNING ${RECORD_COLUMNS}`,
      [
        id,
        input.mode,
        input.status,
        input.provider ?? null,
        input.model ?? null,
        input.packageValue !== undefined && input.packageValue !== null
          ? JSON.stringify(input.packageValue)
          : null,
        input.agentRunId ?? null,
        input.externalSessionRef ?? null,
        input.expiresAt ?? null,
        mergedBenchmark,
      ],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }
}

interface EventRow {
  id: string;
  execution_record_id: string;
  event_type: string;
  commit_ref: string | null;
  branch: string | null;
  pull_request_ref: string | null;
  test_summary: Record<string, unknown> | null;
  output: string | null;
  external_session_ref: string | null;
  idempotency_key: string | null;
  received_at: Date;
}

function rowToEvent(row: EventRow): ExecutionEventRecord {
  return {
    id: row.id,
    executionRecordId: row.execution_record_id,
    eventType: row.event_type as ExecutionEventRecord['eventType'],
    commitRef: row.commit_ref,
    branch: row.branch,
    pullRequestRef: row.pull_request_ref,
    testSummary: row.test_summary ?? null,
    output: row.output,
    externalSessionRef: row.external_session_ref,
    idempotencyKey: row.idempotency_key,
    receivedAt: row.received_at,
  };
}

export class PgExecutionEventRepository implements ExecutionEventRepository {
  constructor(private readonly db: DatabaseClient) {}

  async append(input: AppendExecutionEventInput): Promise<ExecutionEventRecord> {
    const result = await this.db.query<EventRow>(
      `INSERT INTO wfos_execution_events
         (execution_record_id, event_type, commit_ref, branch,
          pull_request_ref, test_summary, output, external_session_ref,
          idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, execution_record_id, event_type, commit_ref, branch,
                 pull_request_ref, test_summary, output, external_session_ref,
                 idempotency_key, received_at`,
      [
        input.executionRecordId,
        input.eventType,
        input.commitRef ?? null,
        input.branch ?? null,
        input.pullRequestRef ?? null,
        input.testSummary ? JSON.stringify(input.testSummary) : null,
        input.output ?? null,
        input.externalSessionRef ?? null,
        input.idempotencyKey ?? null,
      ],
    );
    return rowToEvent(result.rows[0]!);
  }

  async listForExecution(executionRecordId: string): Promise<ExecutionEventRecord[]> {
    const result = await this.db.query<EventRow>(
      `SELECT id, execution_record_id, event_type, commit_ref, branch,
              pull_request_ref, test_summary, output, external_session_ref,
              idempotency_key, received_at
       FROM wfos_execution_events
       WHERE execution_record_id = $1 ORDER BY received_at ASC`,
      [executionRecordId],
    );
    return result.rows.map(rowToEvent);
  }

  async findByIdempotencyKey(key: string): Promise<ExecutionEventRecord | null> {
    const result = await this.db.query<EventRow>(
      `SELECT id, execution_record_id, event_type, commit_ref, branch,
              pull_request_ref, test_summary, output, external_session_ref,
              idempotency_key, received_at
       FROM wfos_execution_events WHERE idempotency_key = $1`,
      [key],
    );
    return result.rows[0] ? rowToEvent(result.rows[0]) : null;
  }
}

interface HandoffRow {
  id: string;
  execution_record_id: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

function rowToHandoff(row: HandoffRow): ExecutionHandoffRecord {
  return {
    id: row.id,
    executionRecordId: row.execution_record_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

export class PgExecutionHandoffRepository implements ExecutionHandoffRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    executionRecordId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<ExecutionHandoffRecord> {
    const result = await this.db.query<HandoffRow>(
      `INSERT INTO wfos_execution_handoffs
         (execution_record_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, execution_record_id, token_hash, expires_at, consumed_at, created_at`,
      [input.executionRecordId, input.tokenHash, input.expiresAt],
    );
    return rowToHandoff(result.rows[0]!);
  }

  async findLatestByHash(tokenHash: string): Promise<ExecutionHandoffRecord | null> {
    const result = await this.db.query<HandoffRow>(
      `SELECT id, execution_record_id, token_hash, expires_at, consumed_at, created_at
       FROM wfos_execution_handoffs
       WHERE token_hash = $1
       ORDER BY created_at DESC LIMIT 1`,
      [tokenHash],
    );
    return result.rows[0] ? rowToHandoff(result.rows[0]) : null;
  }

  async consume(id: string, consumedAt: Date): Promise<ExecutionHandoffRecord | null> {
    const result = await this.db.query<HandoffRow>(
      `UPDATE wfos_execution_handoffs
       SET consumed_at = $2
       WHERE id = $1 AND consumed_at IS NULL
       RETURNING id, execution_record_id, token_hash, expires_at, consumed_at, created_at`,
      [id, consumedAt],
    );
    return result.rows[0] ? rowToHandoff(result.rows[0]) : null;
  }
}

// ---------------------------------------------------------------------------
// WORK-027 (PR #30 review fix #2): scoped execution callback credentials.
// ---------------------------------------------------------------------------

interface CallbackRow {
  id: string;
  execution_record_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
}

function rowToCallback(row: CallbackRow): ExecutionCallbackRecord {
  return {
    id: row.id,
    executionRecordId: row.execution_record_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export class PgExecutionCallbackRepository implements ExecutionCallbackRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    executionRecordId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<ExecutionCallbackRecord> {
    const result = await this.db.query<CallbackRow>(
      `INSERT INTO wfos_execution_callbacks
         (execution_record_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, execution_record_id, token_hash, expires_at, created_at`,
      [input.executionRecordId, input.tokenHash, input.expiresAt],
    );
    return rowToCallback(result.rows[0]!);
  }

  async findLatestByHash(tokenHash: string): Promise<ExecutionCallbackRecord | null> {
    const result = await this.db.query<CallbackRow>(
      `SELECT id, execution_record_id, token_hash, expires_at, created_at
       FROM wfos_execution_callbacks
       WHERE token_hash = $1
       ORDER BY created_at DESC LIMIT 1`,
      [tokenHash],
    );
    return result.rows[0] ? rowToCallback(result.rows[0]) : null;
  }
}
