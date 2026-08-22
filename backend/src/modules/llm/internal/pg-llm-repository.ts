import type { DatabaseClient } from '@platform/index.js';
import type {
  LlmExecutionRecord,
  LlmExecutionRecordRepository,
  LlmExecutionStatus,
  LlmErrorType,
  LlmUsage,
} from './llm.types.js';

export class PgLlmExecutionRecordRepository implements LlmExecutionRecordRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    executionId: string;
    workItemId?: string;
    provider: string;
    model: string;
    requestMetadata?: Record<string, unknown>;
    maxRetries?: number;
  }): Promise<LlmExecutionRecord> {
    const result = await this.db.query<Row>(
      `INSERT INTO wfos_llm_execution_records
         (execution_id, work_item_id, provider, model, request_metadata,
          status, max_retries)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       RETURNING id, execution_id, work_item_id, provider, model,
                 request_metadata, response_content, usage_metadata, status,
                 error_type, error_message, retry_count, max_retries,
                 started_at, completed_at, created_at, updated_at`,
      [
        input.executionId,
        input.workItemId ?? null,
        input.provider,
        input.model,
        JSON.stringify(input.requestMetadata ?? {}),
        input.maxRetries ?? 3,
      ],
    );
    return mapRow(result.rows[0]!);
  }

  async findById(id: string): Promise<LlmExecutionRecord | null> {
    const result = await this.db.query<Row>(
      `SELECT id, execution_id, work_item_id, provider, model,
              request_metadata, response_content, usage_metadata, status,
              error_type, error_message, retry_count, max_retries,
              started_at, completed_at, created_at, updated_at
       FROM wfos_llm_execution_records WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]!);
  }

  async findByExecutionId(executionId: string): Promise<LlmExecutionRecord | null> {
    const result = await this.db.query<Row>(
      `SELECT id, execution_id, work_item_id, provider, model,
              request_metadata, response_content, usage_metadata, status,
              error_type, error_message, retry_count, max_retries,
              started_at, completed_at, created_at, updated_at
       FROM wfos_llm_execution_records WHERE execution_id = $1`,
      [executionId],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]!);
  }

  async findByWorkItem(workItemId: string): Promise<LlmExecutionRecord[]> {
    const result = await this.db.query<Row>(
      `SELECT id, execution_id, work_item_id, provider, model,
              request_metadata, response_content, usage_metadata, status,
              error_type, error_message, retry_count, max_retries,
              started_at, completed_at, created_at, updated_at
       FROM wfos_llm_execution_records WHERE work_item_id = $1
       ORDER BY created_at DESC`,
      [workItemId],
    );
    return result.rows.map(mapRow);
  }

  async updateSuccess(id: string, responseContent: string, usage: LlmUsage): Promise<LlmExecutionRecord | null> {
    const result = await this.db.query<Row>(
      `UPDATE wfos_llm_execution_records
       SET status = 'success', response_content = $1,
           usage_metadata = $2, completed_at = NOW(), updated_at = NOW()
       WHERE id = $3
       RETURNING id, execution_id, work_item_id, provider, model,
                 request_metadata, response_content, usage_metadata, status,
                 error_type, error_message, retry_count, max_retries,
                 started_at, completed_at, created_at, updated_at`,
      [responseContent, JSON.stringify(usage), id],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]!);
  }

  async updateFailed(id: string, errorType: LlmErrorType, errorMessage: string, retryCount: number): Promise<LlmExecutionRecord | null> {
    const result = await this.db.query<Row>(
      `UPDATE wfos_llm_execution_records
       SET status = 'failed', error_type = $1, error_message = $2,
           retry_count = $3, completed_at = NOW(), updated_at = NOW()
       WHERE id = $4
       RETURNING id, execution_id, work_item_id, provider, model,
                 request_metadata, response_content, usage_metadata, status,
                 error_type, error_message, retry_count, max_retries,
                 started_at, completed_at, created_at, updated_at`,
      [errorType, errorMessage, retryCount, id],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]!);
  }
}

interface Row {
  id: string;
  execution_id: string;
  work_item_id: string | null;
  provider: string;
  model: string;
  request_metadata: Record<string, unknown>;
  response_content: string | null;
  usage_metadata: Record<string, unknown>;
  status: string;
  error_type: string | null;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  started_at: Date;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: Row): LlmExecutionRecord {
  return {
    id: row.id,
    executionId: row.execution_id,
    workItemId: row.work_item_id,
    provider: row.provider,
    model: row.model,
    requestMetadata: row.request_metadata ?? {},
    responseContent: row.response_content,
    usageMetadata: row.usage_metadata ?? {},
    status: row.status as LlmExecutionStatus,
    errorType: row.error_type,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
