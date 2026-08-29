/**
 * WORK-047 — the READ-ONLY historical-evidence repository.
 *
 * This repository aggregates the EXISTING authoritative stores — it owns NO
 * tables of its own (no migration; the "no second historical-data store"
 * rule) and performs SELECT queries ONLY (pinned by static invariants: no
 * INSERT/UPDATE/DELETE/CREATE anywhere in this domain):
 *
 *   1. wfos_executions — the /agents execution-record authority: terminal
 *      outcomes per (provider, model, mode), scoped by project_id (the
 *      authoritative tenant column on the row itself).
 *   2. wfos_delegation_plans/units/attempts — the WORK-046 coordination
 *      ledger (migration 0057, the W046-AC10 structured state): terminal
 *      attempt outcomes per (role, provider, mode), scoped to the project
 *      through the AUTHORITATIVE work-item → architecture-version →
 *      architecture → project chain (the same chain every route uses to
 *      resolve a work item's project — the delegation tables carry no
 *      denormalized project column, so the scope is derived from the
 *      authorities, never guessed).
 *
 * Terminal semantics (mirroring the WORK-046 attempt observation):
 *   succeeded = the execution record reached 'completed';
 *   failed    = a failed terminal state ('failed' | 'cancelled' | 'expired');
 *   delegation attempts additionally carry 'unresolved' (counted as an
 *   attempt, NOT a success — conservative).
 *
 * The observation window (first/last observed) rides every cell: stale
 * evidence is surfaced by the callers, never hidden, and the aggregation is
 * recency-independent (deterministic scoring).
 */

import type { DatabaseClient } from '@platform/index.js';
import type { AgentRoleId } from '../../agent-roles/index.js';
import type {
  DelegationRoleHistoryCell,
  ExecutionHistoryCell,
} from '../types.js';

interface Queryable {
  query<R extends { [column: string]: unknown } = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface PgAgentIntelligenceRepositoryDeps {
  readonly db: DatabaseClient;
}

export class PgAgentIntelligenceRepository {
  constructor(private readonly deps: PgAgentIntelligenceRepositoryDeps) {}

  /**
   * Terminal execution outcomes per (provider, model, mode) for the project —
   * a READ-ONLY aggregate over wfos_executions (the /agents authority rows).
   */
  async collectExecutionHistory(projectId: string): Promise<readonly ExecutionHistoryCell[]> {
    const db: Queryable = this.deps.db;
    // SELECT-only: the observed terminal outcome picture of the project's
    // executions. Non-terminal rows (created/queued/running/handoff_ready/
    // submitted) are excluded — only decided outcomes are evidence.
    const result = await db.query<ExecAggregateRow>(
      `SELECT provider,
              model,
              mode,
              COUNT(*)::int AS attempts,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS succeeded,
              COUNT(*) FILTER (WHERE status IN ('failed', 'cancelled', 'expired'))::int AS failed,
              MIN(created_at) AS first_observed_at,
              MAX(COALESCE(completed_at, updated_at, created_at)) AS last_observed_at,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY (EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000))
                FILTER (WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL) AS median_duration_ms
         FROM wfos_executions
        WHERE project_id = $1
          AND status IN ('completed', 'failed', 'cancelled', 'expired')
        GROUP BY provider, model, mode
        ORDER BY provider ASC, model ASC, mode ASC`,
      [projectId],
    );
    return result.rows.map((row) => {
      const attempts = Number(row.attempts);
      const succeeded = Number(row.succeeded);
      const failed = Number(row.failed);
      return {
        provider: row.provider,
        model: row.model ?? null,
        mode: row.mode === 'external' ? 'external' : 'native',
        attempts,
        succeeded,
        failed,
        successRate: attempts > 0 ? succeeded / attempts : null,
        medianDurationMs: row.median_duration_ms == null ? null : Math.round(Number(row.median_duration_ms)),
        firstObservedAt: new Date(row.first_observed_at),
        lastObservedAt: new Date(row.last_observed_at),
      };
    });
  }

  /**
   * Terminal delegation attempt outcomes per (role, provider, mode) for the
   * project — a READ-ONLY aggregate over the WORK-046 coordination ledger
   * (the W046-AC10 structured state), scoped through the AUTHORITATIVE
   * work-item → architecture-version → architecture → project chain.
   */
  async collectDelegationRoleHistory(projectId: string): Promise<readonly DelegationRoleHistoryCell[]> {
    const db: Queryable = this.deps.db;
    const result = await db.query<RoleAggregateRow>(
      `SELECT u.role_id,
              u.role_revision,
              u.provider,
              u.mode,
              COUNT(*)::int AS attempts,
              COUNT(*) FILTER (WHERE a.outcome = 'succeeded')::int AS succeeded,
              COUNT(*) FILTER (WHERE a.outcome = 'failed')::int AS failed,
              COUNT(*) FILTER (WHERE a.outcome = 'unresolved')::int AS unresolved,
              MIN(a.created_at) AS first_observed_at,
              MAX(a.updated_at) AS last_observed_at
         FROM wfos_delegation_attempts a
         JOIN wfos_delegation_units u ON u.id = a.unit_id
         JOIN wfos_delegation_plans p ON p.id = u.plan_id
         JOIN wfos_work_items wi ON wi.id = p.work_item_id
         JOIN wfos_architecture_versions av ON av.id = wi.architecture_version_id
         JOIN wfos_architectures ar ON ar.id = av.architecture_id
        WHERE ar.project_id = $1
          AND a.outcome IS NOT NULL
        GROUP BY u.role_id, u.role_revision, u.provider, u.mode
        ORDER BY u.role_id ASC, u.provider ASC, u.mode ASC`,
      [projectId],
    );
    return result.rows.map((row) => {
      const attempts = Number(row.attempts);
      const succeeded = Number(row.succeeded);
      return {
        roleId: row.role_id as AgentRoleId,
        roleRevision: row.role_revision,
        provider: row.provider,
        mode: row.mode === 'external' ? 'external' : 'native',
        attempts,
        succeeded,
        failed: Number(row.failed),
        unresolved: Number(row.unresolved),
        successRate: attempts > 0 ? succeeded / attempts : null,
        firstObservedAt: new Date(row.first_observed_at),
        lastObservedAt: new Date(row.last_observed_at),
      };
    });
  }
}

interface ExecAggregateRow {
  provider: string;
  model: string | null;
  mode: string;
  attempts: number | string;
  succeeded: number | string;
  failed: number | string;
  first_observed_at: Date | string;
  last_observed_at: Date | string;
  median_duration_ms: number | string | null;
  [column: string]: unknown;
}

interface RoleAggregateRow {
  role_id: string;
  role_revision: string;
  provider: string;
  mode: string;
  attempts: number | string;
  succeeded: number | string;
  failed: number | string;
  unresolved: number | string;
  first_observed_at: Date | string;
  last_observed_at: Date | string;
  [column: string]: unknown;
}
