import type { DatabaseClient } from '@platform/index.js';
import type {
  AgentRun,
  AgentRunRepository,
  AgentStatus,
  AgentExecutionResult,
  AgentError,
  AgentTestReport,
  AgentBlockerReport,
} from './agent.types.js';

export class PgAgentRunRepository implements AgentRunRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    executionId: string;
    workItemId: string;
    workOrderId: string;
    architectureVersionId?: string;
    provider: string;
    configuration?: Record<string, unknown>;
    repositoryRef?: string;
    branch?: string;
    maxRetries?: number;
  }): Promise<AgentRun> {
    const result = await this.db.query<Row>(
      `INSERT INTO wfos_agent_runs
         (execution_id, work_item_id, work_order_id, architecture_version_id,
          provider, configuration, repository_ref, branch, status, max_retries)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
       RETURNING id, execution_id, work_item_id, work_order_id,
                 architecture_version_id, provider, configuration,
                 repository_ref, branch, status, output, output_storage_key,
                 output_storage_provider, commit_ref, pull_request_ref,
                 reported_tests, reported_blockers, execution_metadata,
                 error_type, error_message, retry_count, max_retries,
                 started_at, completed_at, created_at, updated_at`,
      [
        input.executionId, input.workItemId, input.workOrderId,
        input.architectureVersionId ?? null, input.provider,
        JSON.stringify(input.configuration ?? {}),
        input.repositoryRef ?? null, input.branch ?? null,
        input.maxRetries ?? 3,
      ],
    );
    return mapRow(result.rows[0]!);
  }

  async findById(id: string): Promise<AgentRun | null> {
    const result = await this.db.query<Row>(
      `SELECT * FROM wfos_agent_runs WHERE id = $1`, [id]);
    return result.rows.length ? mapRow(result.rows[0]!) : null;
  }

  async findByExecutionId(executionId: string): Promise<AgentRun | null> {
    const result = await this.db.query<Row>(
      `SELECT * FROM wfos_agent_runs WHERE execution_id = $1`, [executionId]);
    return result.rows.length ? mapRow(result.rows[0]!) : null;
  }

  async findByWorkItem(workItemId: string): Promise<AgentRun[]> {
    const result = await this.db.query<Row>(
      `SELECT * FROM wfos_agent_runs WHERE work_item_id = $1 ORDER BY created_at DESC`,
      [workItemId]);
    return result.rows.map(mapRow);
  }

  async updateSuccess(id: string, result: AgentExecutionResult): Promise<AgentRun | null> {
    const r = await this.db.query<Row>(
      `UPDATE wfos_agent_runs SET
         status = 'success', output = $1, commit_ref = $2,
         pull_request_ref = $3, reported_tests = $4, reported_blockers = $5,
         execution_metadata = $6, completed_at = NOW(), updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      // PR #52 round 2 (BLOCKER 1): the execution contract is PR-incapable —
      // a gateway-recorded success can NEVER set pull_request_ref (the
      // column is reserved for external PR observations ingested through the
      // execution-event/webhook boundary, never provider reports).
      [result.output, result.commitRef, null,
       JSON.stringify(result.reportedTests), JSON.stringify(result.reportedBlockers),
       JSON.stringify(result.metadata), id]);
    return r.rows.length ? mapRow(r.rows[0]!) : null;
  }

  async updateFailed(id: string, error: AgentError, retryCount: number): Promise<AgentRun | null> {
    const r = await this.db.query<Row>(
      `UPDATE wfos_agent_runs SET
         status = 'failed', error_type = $1, error_message = $2,
         retry_count = $3, completed_at = NOW(), updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [error.type, error.message, retryCount, id]);
    return r.rows.length ? mapRow(r.rows[0]!) : null;
  }
}

interface Row {
  id: string; execution_id: string; work_item_id: string; work_order_id: string | null;
  architecture_version_id: string | null; provider: string; configuration: Record<string, unknown>;
  repository_ref: string | null; branch: string | null; status: string; output: string | null;
  output_storage_key: string | null; output_storage_provider: string | null;
  commit_ref: string | null; pull_request_ref: string | null;
  reported_tests: AgentTestReport[]; reported_blockers: AgentBlockerReport[];
  execution_metadata: Record<string, unknown>; error_type: string | null; error_message: string | null;
  retry_count: number; max_retries: number; started_at: Date; completed_at: Date | null;
  created_at: Date; updated_at: Date;
}

function mapRow(row: Row): AgentRun {
  return {
    id: row.id, executionId: row.execution_id, workItemId: row.work_item_id,
    workOrderId: row.work_order_id, architectureVersionId: row.architecture_version_id,
    provider: row.provider, configuration: row.configuration ?? {},
    repositoryRef: row.repository_ref, branch: row.branch,
    status: row.status as AgentStatus, output: row.output,
    outputStorageKey: row.output_storage_key, outputStorageProvider: row.output_storage_provider,
    commitRef: row.commit_ref, pullRequestRef: row.pull_request_ref,
    reportedTests: row.reported_tests ?? [], reportedBlockers: row.reported_blockers ?? [],
    executionMetadata: row.execution_metadata ?? {},
    errorType: row.error_type, errorMessage: row.error_message,
    retryCount: row.retry_count, maxRetries: row.max_retries,
    startedAt: row.started_at, completedAt: row.completed_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
