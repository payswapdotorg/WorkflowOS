/**
 * WORK-026: PostgreSQL persistence for ImplementationContext revisions.
 *
 * Wraps `wfos_implementation_contexts` (migration 0021). Mirrors the existing
 * {@link PgWorkOrderRepository} / SUB-B {@link PgRuntimeIntegrationRepository}
 * pattern: constant column-list macro, idempotent INSERT (RETURNING *), and a
 * dedicated row mapper that yields the readonly {@link ImplementationContext}
 * interface.
 *
 * This file is private to /work-items (PLAT-AC-02). Cross-module imports are
 * forbidden; callers consume the {@link ImplementationContextRepository}
 * interface exposed by the public barrel.
 *
 * All SQL is parameterized ($1, $2, …) — no string interpolation of user
 * values.
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  ImplementationContext,
  ImplementationContextContent,
  ImplementationContextRepository,
} from './implementation-context.types.js';

interface ImplementationContextRow {
  id: string;
  work_item_id: string;
  revision: number;
  content_json: ImplementationContextContent;
  kind: 'initial' | 'correction';
  created_at: Date;
}

const CONTEXT_COLUMNS =
  'id, work_item_id, revision, content_json, kind, created_at';

function mapContext(row: ImplementationContextRow): ImplementationContext {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    revision: row.revision,
    kind: row.kind,
    content: row.content_json,
    createdAt: row.created_at,
  };
}

export class PgImplementationContextRepository
  implements ImplementationContextRepository
{
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    workItemId: string;
    revision: number;
    kind: 'initial' | 'correction';
    content: ImplementationContextContent;
  }): Promise<ImplementationContext> {
    const result = await this.db.query<ImplementationContextRow>(
      `INSERT INTO wfos_implementation_contexts
         (work_item_id, revision, kind, content_json)
       VALUES ($1, $2, $3, $4)
       RETURNING ${CONTEXT_COLUMNS}`,
      [
        input.workItemId,
        input.revision,
        input.kind,
        JSON.stringify(input.content),
      ],
    );
    return mapContext(result.rows[0]!);
  }

  async findLatestByWorkItem(
    workItemId: string,
  ): Promise<ImplementationContext | null> {
    // idx_implementation_contexts_work_item backs (work_item_id, revision DESC).
    const result = await this.db.query<ImplementationContextRow>(
      `SELECT ${CONTEXT_COLUMNS}
       FROM wfos_implementation_contexts
       WHERE work_item_id = $1
       ORDER BY revision DESC
       LIMIT 1`,
      [workItemId],
    );
    if (result.rows.length === 0) return null;
    return mapContext(result.rows[0]!);
  }

  async findByWorkItem(workItemId: string): Promise<ImplementationContext[]> {
    const result = await this.db.query<ImplementationContextRow>(
      `SELECT ${CONTEXT_COLUMNS}
       FROM wfos_implementation_contexts
       WHERE work_item_id = $1
       ORDER BY revision ASC`,
      [workItemId],
    );
    return result.rows.map(mapContext);
  }

  async findById(id: string): Promise<ImplementationContext | null> {
    const result = await this.db.query<ImplementationContextRow>(
      `SELECT ${CONTEXT_COLUMNS}
       FROM wfos_implementation_contexts
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapContext(result.rows[0]!);
  }
}
