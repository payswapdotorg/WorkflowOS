import type { DatabaseClient } from '@platform/index.js';
import type {
  ConvergenceSignal,
  ConvergenceSignalRepository,
  SubmitSignalInput,
  SignalProcessingState,
} from './convergence.types.js';
import type { WorkflowState } from './workflow.types.js';

// ===========================================================================
// Convergence signal repository (WORK-017).
//
// Idempotent upsert: UNIQUE(work_item_id, signal_type, source_event_id)
// ensures duplicate signals produce ONE row, not duplicates.
// ===========================================================================

export class PgConvergenceSignalRepository implements ConvergenceSignalRepository {
  constructor(private readonly db: DatabaseClient) {}

  async upsert(input: SubmitSignalInput & { projectId: string; idempotencyKey: string }): Promise<{
    signal: ConvergenceSignal;
    created: boolean;
  }> {
    // ON CONFLICT DO NOTHING — if the signal already exists, re-fetch it.
    const insertResult = await this.db.query<SignalRow>(
      `INSERT INTO wfos_convergence_signals
         (project_id, work_item_id, signal_type, source_event_id,
          idempotency_key, processing_state, payload, execution_id)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
       ON CONFLICT (work_item_id, signal_type, source_event_id) DO NOTHING
       RETURNING id, project_id, work_item_id, signal_type, source_event_id,
                 idempotency_key, processing_state, result_state, error_message,
                 payload, execution_id, created_at, processed_at, updated_at`,
      [
        input.projectId,
        input.workItemId,
        input.signalType,
        input.sourceEventId,
        input.idempotencyKey,
        JSON.stringify(input.payload),
        input.executionId,
      ],
    );
    if (insertResult.rows.length > 0) {
      return { signal: mapSignal(insertResult.rows[0]!), created: true };
    }
    // Signal already existed — re-fetch it.
    const existing = await this.db.query<SignalRow>(
      `SELECT id, project_id, work_item_id, signal_type, source_event_id,
              idempotency_key, processing_state, result_state, error_message,
              payload, execution_id, created_at, processed_at, updated_at
       FROM wfos_convergence_signals
       WHERE work_item_id = $1 AND signal_type = $2 AND source_event_id = $3`,
      [input.workItemId, input.signalType, input.sourceEventId],
    );
    return { signal: mapSignal(existing.rows[0]!), created: false };
  }

  async findById(id: string): Promise<ConvergenceSignal | null> {
    const result = await this.db.query<SignalRow>(
      `SELECT id, project_id, work_item_id, signal_type, source_event_id,
              idempotency_key, processing_state, result_state, error_message,
              payload, execution_id, created_at, processed_at, updated_at
       FROM wfos_convergence_signals WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapSignal(result.rows[0]!);
  }

  async listForWorkItem(workItemId: string): Promise<ConvergenceSignal[]> {
    const result = await this.db.query<SignalRow>(
      `SELECT id, project_id, work_item_id, signal_type, source_event_id,
              idempotency_key, processing_state, result_state, error_message,
              payload, execution_id, created_at, processed_at, updated_at
       FROM wfos_convergence_signals WHERE work_item_id = $1
       ORDER BY created_at DESC`,
      [workItemId],
    );
    return result.rows.map(mapSignal);
  }

  async markProcessed(
    id: string,
    resultState: WorkflowState | null,
    errorMessage?: string | null,
  ): Promise<void> {
    const state: SignalProcessingState = errorMessage ? 'failed' : 'processed';
    await this.db.query(
      `UPDATE wfos_convergence_signals
       SET processing_state = $2, result_state = $3, error_message = $4,
           processed_at = NOW()
       WHERE id = $1`,
      [id, state, resultState, errorMessage ?? null],
    );
  }
}

// ===========================================================================
// Row mapper
// ===========================================================================

interface SignalRow {
  id: string;
  project_id: string;
  work_item_id: string;
  signal_type: string;
  source_event_id: string;
  idempotency_key: string;
  processing_state: string;
  result_state: string | null;
  error_message: string | null;
  payload: unknown;
  execution_id: string;
  created_at: Date;
  processed_at: Date | null;
  updated_at: Date;
}

function mapSignal(row: SignalRow): ConvergenceSignal {
  return {
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    signalType: row.signal_type as ConvergenceSignal['signalType'],
    sourceEventId: row.source_event_id,
    idempotencyKey: row.idempotency_key,
    processingState: row.processing_state as SignalProcessingState,
    resultState: row.result_state as WorkflowState | null,
    errorMessage: row.error_message,
    payload: (row.payload as Record<string, unknown>) ?? {},
    executionId: row.execution_id,
    createdAt: row.created_at,
    processedAt: row.processed_at,
    updatedAt: row.updated_at,
  };
}
