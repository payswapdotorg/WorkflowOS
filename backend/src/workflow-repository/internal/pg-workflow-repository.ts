/**
 * V2-002 — the PostgreSQL workflow-repository persistence layer.
 *
 * Durable repository data ONLY (migration 0060):
 *   wfos_v2_workflows            (durable identity + visibility + provenance)
 *   wfos_v2_workflow_versions    (IMMUTABLE, content-addressed)
 *   wfos_v2_workflow_installations (tenant + pinned exact version)
 *
 * Immutability is enforced by PostgreSQL itself (migration 0060 guard
 * triggers): this repository has NO update/delete path for versions and NO
 * pin-mutating path for installations. "Editing" is always INSERT of a new
 * immutable version row.
 *
 * Concurrency/convergence:
 *   - create-or-converge everywhere: INSERT ... ON CONFLICT <logical key>
 *     DO NOTHING + re-read — concurrent duplicate submissions converge on
 *     the winner's row (no divergent duplicates);
 *   - version-number allocation is `MAX(version_number)+1` inside the
 *     insert transaction; a concurrent allocation race surfaces as the
 *     UNIQUE (workflow_id, version_number) violation, which the service
 *     retries (deterministic convergence — never a lost row).
 *
 * The version `content` document is opaque here (V2-003 owns semantics);
 * `content_digest` is the CONTENT digest, never the semantic digest.
 */
import type { DatabaseClient, DatabaseTx } from '@platform/index.js';
import type {
  Workflow,
  WorkflowInstallation,
  WorkflowInstallationDetail,
  WorkflowVersion,
  WorkflowVersionProtocolDescriptor,
  WorkflowVisibility,
} from '../types.js';

/** db or tx — anything with `query`. */
interface Queryable {
  query<R extends { [column: string]: unknown } = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Prefer the given handle (a transaction); fall back to the client. */
function on(q: Queryable | undefined, db: DatabaseClient): Queryable {
  return q ?? db;
}

export type WorkflowRepositoryTx = DatabaseTx;

export interface WorkflowRow {
  [column: string]: unknown;
  id: string;
  organization_id: string;
  owner_user_id: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: WorkflowVisibility;
  head_version_id: string | null;
  forked_from_workflow_id: string | null;
  forked_from_version_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface VersionRow {
  [column: string]: unknown;
  id: string;
  workflow_id: string;
  version_number: number;
  content_digest: string;
  content: Record<string, unknown>;
  protocol: { irSchemaVersion?: unknown };
  parent_version_id: string | null;
  created_by_user_id: string;
  created_at: Date;
}

export interface InstallationRow {
  [column: string]: unknown;
  id: string;
  organization_id: string;
  workflow_id: string;
  version_id: string;
  installed_by_user_id: string;
  status: WorkflowInstallation['status'];
  installed_at: Date;
  updated_at: Date;
}

const WORKFLOW_COLUMNS = `id, organization_id, owner_user_id, slug, name, description,
  visibility, head_version_id, forked_from_workflow_id, forked_from_version_id,
  created_at, updated_at`;
const VERSION_COLUMNS = `id, workflow_id, version_number, content_digest, content, protocol,
  parent_version_id, created_by_user_id, created_at`;

export interface InsertWorkflowRow {
  readonly id: string;
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly visibility: WorkflowVisibility;
  readonly forkedFromWorkflowId: string | null;
  readonly forkedFromVersionId: string | null;
}

export interface InsertVersionRow {
  readonly id: string;
  readonly workflowId: string;
  readonly contentDigest: string;
  readonly content: Record<string, unknown>;
  readonly protocol: WorkflowVersionProtocolDescriptor;
  readonly parentVersionId: string | null;
  readonly createdByUserId: string;
}

export interface InsertInstallationRow {
  readonly id: string;
  readonly organizationId: string;
  readonly workflowId: string;
  readonly versionId: string;
  readonly installedByUserId: string;
}

export class PgWorkflowRepository {
  constructor(private readonly db: DatabaseClient) {}

  // --- workflows ------------------------------------------------------------

  /**
   * Create-or-converge a workflow keyed by (organization, slug). Concurrent
   * same-key creators serialize through the UNIQUE constraint; the loser
   * converges on the winner's row. Returns { row, created }.
   */
  async insertWorkflowOrConverge(
    tx: Queryable,
    row: InsertWorkflowRow,
  ): Promise<{ row: WorkflowRow; created: boolean }> {
    const inserted = await tx.query<WorkflowRow>(
      `INSERT INTO wfos_v2_workflows
         (id, organization_id, owner_user_id, slug, name, description, visibility,
          forked_from_workflow_id, forked_from_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (organization_id, slug) DO NOTHING
       RETURNING ${WORKFLOW_COLUMNS}`,
      [
        row.id,
        row.organizationId,
        row.ownerUserId,
        row.slug,
        row.name,
        row.description,
        row.visibility,
        row.forkedFromWorkflowId,
        row.forkedFromVersionId,
      ],
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
    const existing = await tx.query<WorkflowRow>(
      `SELECT ${WORKFLOW_COLUMNS} FROM wfos_v2_workflows
       WHERE organization_id = $1 AND slug = $2`,
      [row.organizationId, row.slug],
    );
    if (!existing.rows[0]) {
      throw new Error(
        `workflow-repository: converged workflow (${row.organizationId}, ${row.slug}) disappeared`,
      );
    }
    return { row: existing.rows[0], created: false };
  }

  /**
   * Read one workflow by durable identity. Pass a transaction handle to read
   * inside the SAME atomic unit that just wrote it.
   */
  async findWorkflowById(id: string, q?: Queryable): Promise<WorkflowRow | null> {
    const result = await on(q, this.db).query<WorkflowRow>(
      `SELECT ${WORKFLOW_COLUMNS} FROM wfos_v2_workflows WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The tenant's workflows visible to `userId`: every non-private workflow
   * plus the user's own private ones. Stable slug order.
   */
  async listWorkflowsInOrganization(
    organizationId: string,
    userId: string,
    q?: Queryable,
  ): Promise<WorkflowRow[]> {
    const result = await on(q, this.db).query<WorkflowRow>(
      `SELECT ${WORKFLOW_COLUMNS} FROM wfos_v2_workflows
       WHERE organization_id = $1 AND (visibility <> 'private' OR owner_user_id = $2)
       ORDER BY slug ASC, id ASC`,
      [organizationId, userId],
    );
    return result.rows;
  }

  /** Update repository metadata ONLY (name/description/visibility). */
  async updateWorkflowMetadata(
    id: string,
    patch: { name?: string; description?: string | null; visibility?: WorkflowVisibility },
    q?: Queryable,
  ): Promise<WorkflowRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      params.push(patch.name);
      sets.push(`name = $${params.length}`);
    }
    if (patch.description !== undefined) {
      params.push(patch.description);
      sets.push(`description = $${params.length}`);
    }
    if (patch.visibility !== undefined) {
      params.push(patch.visibility);
      sets.push(`visibility = $${params.length}`);
    }
    if (sets.length === 0) {
      return this.findWorkflowById(id, q);
    }
    sets.push('updated_at = NOW()');
    params.push(id);
    const result = await on(q, this.db).query<WorkflowRow>(
      `UPDATE wfos_v2_workflows SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING ${WORKFLOW_COLUMNS}`,
      params,
    );
    return result.rows[0] ?? null;
  }

  /**
   * Advance the head pointer to a NEWLY created version (never backwards).
   * ATOMIC with the version insert: pass the SAME transaction handle the
   * version was inserted through.
   */
  async setHeadVersion(q: Queryable, workflowId: string, versionId: string): Promise<void> {
    await q.query(
      `UPDATE wfos_v2_workflows SET head_version_id = $1, updated_at = NOW() WHERE id = $2`,
      [versionId, workflowId],
    );
  }

  // --- versions (INSERT only — the rows are immutable by trigger) -----------

  /**
   * Create-or-converge an immutable version. The identity is the
   * deterministic id (content-addressed per workflow): duplicate content
   * converges on the existing row. The version number is allocated from
   * durable state (MAX+1) in the same statement.
   *
   * `isVersionNumberRace(err)` on the caller side detects the concurrent
   * allocation race (UNIQUE (workflow_id, version_number)) for retry.
   */
  async insertVersionOrConverge(
    tx: Queryable,
    row: InsertVersionRow,
  ): Promise<{ row: VersionRow; created: boolean }> {
    const inserted = await tx.query<VersionRow>(
      `INSERT INTO wfos_v2_workflow_versions
         (id, workflow_id, version_number, content_digest, content, protocol,
          parent_version_id, created_by_user_id)
       SELECT $1, $2, COALESCE(MAX(v.version_number), 0) + 1, $3, $4::jsonb, $5::jsonb, $6, $7
         FROM wfos_v2_workflow_versions v
        WHERE v.workflow_id = $2
       ON CONFLICT (id) DO NOTHING
       RETURNING ${VERSION_COLUMNS}`,
      [
        row.id,
        row.workflowId,
        row.contentDigest,
        JSON.stringify(row.content),
        JSON.stringify(row.protocol),
        row.parentVersionId,
        row.createdByUserId,
      ],
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
    const existing = await tx.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM wfos_v2_workflow_versions WHERE id = $1`,
      [row.id],
    );
    if (!existing.rows[0]) {
      throw new Error(`workflow-repository: converged version ${row.id} disappeared`);
    }
    return { row: existing.rows[0], created: false };
  }

  async findVersionById(id: string, q?: Queryable): Promise<VersionRow | null> {
    const result = await on(q, this.db).query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM wfos_v2_workflow_versions WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  /** The workflow's born version (version_number = 1). */
  async findInitialVersion(workflowId: string, q?: Queryable): Promise<VersionRow | null> {
    const result = await on(q, this.db).query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM wfos_v2_workflow_versions
       WHERE workflow_id = $1 AND version_number = 1`,
      [workflowId],
    );
    return result.rows[0] ?? null;
  }

  async listVersionsByWorkflow(workflowId: string, q?: Queryable): Promise<VersionRow[]> {
    const result = await on(q, this.db).query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM wfos_v2_workflow_versions
       WHERE workflow_id = $1 ORDER BY version_number ASC, id ASC`,
      [workflowId],
    );
    return result.rows;
  }

  // --- installations ---------------------------------------------------------

  /**
   * Create-or-converge an installation keyed by (organization, version).
   * A converged row in 'uninstalled' state is re-enabled (re-install).
   */
  async insertInstallationOrConverge(
    row: InsertInstallationRow,
    q?: Queryable,
  ): Promise<{ row: InstallationRow; created: boolean }> {
    const handle = on(q, this.db);
    const inserted = await handle.query<InstallationRow>(
      `INSERT INTO wfos_v2_workflow_installations
         (id, organization_id, workflow_id, version_id, installed_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, version_id) DO NOTHING
       RETURNING id, organization_id, workflow_id, version_id, installed_by_user_id,
         status, installed_at, updated_at`,
      [row.id, row.organizationId, row.workflowId, row.versionId, row.installedByUserId],
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
    const existing = await handle.query<InstallationRow>(
      `SELECT id, organization_id, workflow_id, version_id, installed_by_user_id,
         status, installed_at, updated_at
       FROM wfos_v2_workflow_installations WHERE organization_id = $1 AND version_id = $2`,
      [row.organizationId, row.versionId],
    );
    const converged = existing.rows[0];
    if (!converged) {
      throw new Error(
        `workflow-repository: converged installation (${row.organizationId}, ${row.versionId}) disappeared`,
      );
    }
    if (converged.status === 'uninstalled') {
      // Re-install: the SAME durable installation identity, re-enabled.
      const reEnabled = await handle.query<InstallationRow>(
        `UPDATE wfos_v2_workflow_installations
           SET status = 'enabled', updated_at = NOW()
         WHERE id = $1
         RETURNING id, organization_id, workflow_id, version_id, installed_by_user_id,
           status, installed_at, updated_at`,
        [converged.id],
      );
      return { row: reEnabled.rows[0] ?? converged, created: false };
    }
    return { row: converged, created: false };
  }

  async findInstallationById(id: string, q?: Queryable): Promise<InstallationRow | null> {
    const result = await on(q, this.db).query<InstallationRow>(
      `SELECT id, organization_id, workflow_id, version_id, installed_by_user_id,
         status, installed_at, updated_at
       FROM wfos_v2_workflow_installations WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async listInstallationsByOrganization(
    organizationId: string,
    q?: Queryable,
  ): Promise<InstallationRow[]> {
    const result = await on(q, this.db).query<InstallationRow>(
      `SELECT i.id, i.organization_id, i.workflow_id, i.version_id,
         i.installed_by_user_id, i.status, i.installed_at, i.updated_at
       FROM wfos_v2_workflow_installations i
       WHERE i.organization_id = $1
       ORDER BY i.installed_at ASC, i.id ASC`,
      [organizationId],
    );
    return result.rows;
  }

  /** The ONLY sanctioned installation mutation: the lifecycle status. */
  async updateInstallationStatus(
    id: string,
    status: WorkflowInstallation['status'],
    q?: Queryable,
  ): Promise<InstallationRow | null> {
    const result = await on(q, this.db).query<InstallationRow>(
      `UPDATE wfos_v2_workflow_installations
         SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, organization_id, workflow_id, version_id, installed_by_user_id,
         status, installed_at, updated_at`,
      [status, id],
    );
    return result.rows[0] ?? null;
  }

  // --- run in a transaction ---------------------------------------------------

  transaction<R>(fn: (tx: DatabaseTx) => Promise<R>): Promise<R> {
    return this.db.transaction(fn);
  }
}

// --- row → domain mapping -------------------------------------------------

export function mapWorkflowRow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    ownerUserId: row.owner_user_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    headVersionId: row.head_version_id,
    forkedFromWorkflowId: row.forked_from_workflow_id,
    forkedFromVersionId: row.forked_from_version_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function mapVersionRow(row: VersionRow): WorkflowVersion {
  const irSchemaVersion = row.protocol?.irSchemaVersion;
  if (typeof irSchemaVersion !== 'string') {
    throw new Error(
      `workflow-repository: version ${row.id} has a corrupt protocol descriptor`,
    );
  }
  return {
    id: row.id,
    workflowId: row.workflow_id,
    versionNumber: row.version_number,
    contentDigest: row.content_digest,
    content: row.content,
    protocol: { irSchemaVersion },
    parentVersionId: row.parent_version_id,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at),
  };
}

export function mapInstallationRow(row: InstallationRow): WorkflowInstallation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workflowId: row.workflow_id,
    versionId: row.version_id,
    installedByUserId: row.installed_by_user_id,
    status: row.status,
    installedAt: new Date(row.installed_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function mapInstallationDetailRow(
  installation: InstallationRow,
  version: VersionRow,
): WorkflowInstallationDetail {
  return {
    installation: mapInstallationRow(installation),
    pinnedVersion: {
      id: version.id,
      workflowId: version.workflow_id,
      versionNumber: version.version_number,
      contentDigest: version.content_digest,
      protocol: mapVersionRow(version).protocol,
    },
  };
}

/**
 * Detect the concurrent version-number allocation race (UNIQUE
 * (workflow_id, version_number) violation) so the caller can retry the
 * allocation deterministically.
 */
export function isVersionNumberRace(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('wfos_v2_workflow_versions_number_uidx') ||
    (message.includes('duplicate key') && message.includes('wfos_v2_workflow_versions'))
  );
}
