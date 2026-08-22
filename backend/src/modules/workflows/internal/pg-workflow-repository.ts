import type { DatabaseClient } from '@platform/index.js';
import type {
  WorkflowExecution,
  WorkflowExecutionRepository,
  WorkflowTransition,
  WorkflowTransitionRepository,
  WorkflowState,
} from './workflow.types.js';

export class PgWorkflowExecutionRepository implements WorkflowExecutionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findByWorkItem(workItemId: string): Promise<WorkflowExecution | null> {
    const result = await this.db.query<ExecRow>(
      `SELECT id, work_item_id, current_state, version, created_at, updated_at
       FROM wfos_workflow_executions WHERE work_item_id = $1`,
      [workItemId],
    );
    if (result.rows.length === 0) return null;
    return mapExec(result.rows[0]!);
  }

  async create(workItemId: string): Promise<WorkflowExecution> {
    const result = await this.db.query<ExecRow>(
      `INSERT INTO wfos_workflow_executions (work_item_id, current_state, version)
       VALUES ($1, 'draft', 1)
       ON CONFLICT (work_item_id) DO NOTHING
       RETURNING id, work_item_id, current_state, version, created_at, updated_at`,
      [workItemId],
    );
    if (result.rows.length === 0) {
      // Already exists — return the existing one.
      const existing = await this.findByWorkItem(workItemId);
      return existing!;
    }
    return mapExec(result.rows[0]!);
  }

  async transition(
    workItemId: string,
    fromState: WorkflowState,
    toState: WorkflowState,
    expectedVersion: number,
  ): Promise<WorkflowExecution | null> {
    // Optimistic concurrency: UPDATE only if the current state + version match.
    // This is concurrency-safe — two simultaneous transitions from the same
    // state will fail the second one (version mismatch).
    const result = await this.db.query<ExecRow>(
      `UPDATE wfos_workflow_executions
       SET current_state = $1, version = version + 1, updated_at = NOW()
       WHERE work_item_id = $2 AND current_state = $3 AND version = $4
       RETURNING id, work_item_id, current_state, version, created_at, updated_at`,
      [toState, workItemId, fromState, expectedVersion],
    );
    if (result.rows.length === 0) return null;
    return mapExec(result.rows[0]!);
  }
}

export class PgWorkflowTransitionRepository implements WorkflowTransitionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    workflowExecutionId: string;
    workItemId: string;
    fromState: WorkflowState;
    toState: WorkflowState;
    transitionType?: string;
    actor?: string;
    executionId?: string;
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
  }): Promise<WorkflowTransition> {
    const result = await this.db.query<TransRow>(
      `INSERT INTO wfos_workflow_transitions
         (workflow_execution_id, work_item_id, from_state, to_state,
          transition_type, actor, execution_id, idempotency_key, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, workflow_execution_id, work_item_id, from_state, to_state,
                 transition_type, actor, execution_id, idempotency_key, metadata, created_at`,
      [
        input.workflowExecutionId,
        input.workItemId,
        input.fromState,
        input.toState,
        input.transitionType ?? null,
        input.actor ?? null,
        input.executionId ?? null,
        input.idempotencyKey ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapTrans(result.rows[0]!);
  }

  async listForWorkItem(workItemId: string): Promise<WorkflowTransition[]> {
    const result = await this.db.query<TransRow>(
      `SELECT id, workflow_execution_id, work_item_id, from_state, to_state,
              transition_type, actor, execution_id, idempotency_key, metadata, created_at
       FROM wfos_workflow_transitions WHERE work_item_id = $1
       ORDER BY created_at ASC`,
      [workItemId],
    );
    return result.rows.map(mapTrans);
  }

  async findByIdempotencyKey(key: string): Promise<WorkflowTransition | null> {
    const result = await this.db.query<TransRow>(
      `SELECT id, workflow_execution_id, work_item_id, from_state, to_state,
              transition_type, actor, execution_id, idempotency_key, metadata, created_at
       FROM wfos_workflow_transitions WHERE idempotency_key = $1 LIMIT 1`,
      [key],
    );
    if (result.rows.length === 0) return null;
    return mapTrans(result.rows[0]!);
  }
}

interface ExecRow {
  id: string;
  work_item_id: string;
  current_state: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}
interface TransRow {
  id: string;
  workflow_execution_id: string;
  work_item_id: string;
  from_state: string;
  to_state: string;
  transition_type: string | null;
  actor: string | null;
  execution_id: string | null;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function mapExec(row: ExecRow): WorkflowExecution {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    currentState: row.current_state as WorkflowState,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTrans(row: TransRow): WorkflowTransition {
  return {
    id: row.id,
    workflowExecutionId: row.workflow_execution_id,
    workItemId: row.work_item_id,
    fromState: row.from_state as WorkflowState,
    toState: row.to_state as WorkflowState,
    transitionType: row.transition_type,
    actor: row.actor,
    executionId: row.execution_id,
    idempotencyKey: row.idempotency_key,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}
