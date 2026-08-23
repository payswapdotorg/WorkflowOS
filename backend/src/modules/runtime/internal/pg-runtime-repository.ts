/**
 * WORK-026: PostgreSQL persistence for the /runtime module.
 *
 * Two repositories live here:
 *   - {@link PgRuntimeIntegrationRepository} — wraps `wfos_runtime_integrations`
 *     (one row per (project, deployment-provider) integration link).
 *   - {@link PgDeploymentRepository} — wraps `wfos_deployments` (per-commit
 *     deployment records). `findLatestForProject` joins via
 *     `wfos_runtime_integrations` to filter by project_id, so callers never
 *     need to know the integration id ahead of time.
 *
 * This file is private to /runtime (PLAT-AC-02). Cross-module imports of this
 * file are forbidden; callers consume the repository interfaces exposed by
 * the public barrel (`@modules/runtime/index.js`) or via DI.
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  RuntimeIntegration,
  RuntimeIntegrationRepository,
  Deployment,
  DeploymentRepository,
  DeploymentStatus,
  CreateProjectDeploymentInput,
} from './runtime.types.js';

// ===========================================================================
// RuntimeIntegration repository (wfos_runtime_integrations)
// ===========================================================================

interface RuntimeIntegrationRow {
  id: string;
  project_id: string;
  provider: string;
  project_external_id: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const RUNTIME_INTEGRATION_COLUMNS =
  'id, project_id, provider, project_external_id, metadata, created_at, updated_at';

function mapRuntimeIntegration(row: RuntimeIntegrationRow): RuntimeIntegration {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    projectExternalId: row.project_external_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgRuntimeIntegrationRepository implements RuntimeIntegrationRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateProjectDeploymentInput): Promise<RuntimeIntegration> {
    const result = await this.db.query<RuntimeIntegrationRow>(
      `INSERT INTO wfos_runtime_integrations
         (project_id, provider, project_external_id, metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING ${RUNTIME_INTEGRATION_COLUMNS}`,
      [
        input.projectId,
        input.provider,
        input.projectExternalId,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapRuntimeIntegration(result.rows[0]!);
  }

  async findByProject(projectId: string): Promise<RuntimeIntegration[]> {
    const result = await this.db.query<RuntimeIntegrationRow>(
      `SELECT ${RUNTIME_INTEGRATION_COLUMNS}
       FROM wfos_runtime_integrations
       WHERE project_id = $1
       ORDER BY created_at ASC`,
      [projectId],
    );
    return result.rows.map(mapRuntimeIntegration);
  }

  async findByProjectAndProvider(
    projectId: string,
    provider: string,
  ): Promise<RuntimeIntegration | null> {
    const result = await this.db.query<RuntimeIntegrationRow>(
      `SELECT ${RUNTIME_INTEGRATION_COLUMNS}
       FROM wfos_runtime_integrations
       WHERE project_id = $1 AND provider = $2
       LIMIT 1`,
      [projectId, provider],
    );
    if (result.rows.length === 0) return null;
    return mapRuntimeIntegration(result.rows[0]!);
  }

  async findById(id: string): Promise<RuntimeIntegration | null> {
    const result = await this.db.query<RuntimeIntegrationRow>(
      `SELECT ${RUNTIME_INTEGRATION_COLUMNS}
       FROM wfos_runtime_integrations
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapRuntimeIntegration(result.rows[0]!);
  }

  async update(
    id: string,
    patch: { projectExternalId?: string; metadata?: Record<string, unknown> },
  ): Promise<RuntimeIntegration | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    let pIdx = 2;
    if (patch.projectExternalId !== undefined) {
      sets.push(`project_external_id = $${pIdx++}`);
      params.push(patch.projectExternalId);
    }
    if (patch.metadata !== undefined) {
      sets.push(`metadata = $${pIdx++}`);
      params.push(JSON.stringify(patch.metadata));
    }
    if (sets.length === 0) return this.findById(id);
    sets.push(`updated_at = NOW()`);
    const result = await this.db.query<RuntimeIntegrationRow>(
      `UPDATE wfos_runtime_integrations
         SET ${sets.join(', ')}
       WHERE id = $1
       RETURNING ${RUNTIME_INTEGRATION_COLUMNS}`,
      params,
    );
    if (result.rows.length === 0) return null;
    return mapRuntimeIntegration(result.rows[0]!);
  }

  async remove(id: string): Promise<void> {
    await this.db.query(
      'DELETE FROM wfos_runtime_integrations WHERE id = $1',
      [id],
    );
  }
}

// ===========================================================================
// Deployment repository (wfos_deployments)
// ===========================================================================

interface DeploymentRow {
  id: string;
  integration_id: string;
  external_id: string;
  status: string;
  preview_url: string | null;
  commit_sha: string | null;
  branch: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const DEPLOYMENT_COLUMNS =
  'id, integration_id, external_id, status, preview_url, commit_sha, branch, metadata, created_at, updated_at';

function mapDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    integrationId: row.integration_id,
    externalId: row.external_id,
    status: row.status as DeploymentStatus,
    previewUrl: row.preview_url,
    commitSha: row.commit_sha,
    branch: row.branch,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgDeploymentRepository implements DeploymentRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    integrationId: string;
    externalId: string;
    status: DeploymentStatus;
    previewUrl?: string;
    commitSha?: string;
    branch?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Deployment> {
    const result = await this.db.query<DeploymentRow>(
      `INSERT INTO wfos_deployments
         (integration_id, external_id, status, preview_url, commit_sha, branch, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${DEPLOYMENT_COLUMNS}`,
      [
        input.integrationId,
        input.externalId,
        input.status,
        input.previewUrl ?? null,
        input.commitSha ?? null,
        input.branch ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapDeployment(result.rows[0]!);
  }

  async findByIntegration(integrationId: string): Promise<Deployment[]> {
    const result = await this.db.query<DeploymentRow>(
      `SELECT ${DEPLOYMENT_COLUMNS}
       FROM wfos_deployments
       WHERE integration_id = $1
       ORDER BY created_at DESC`,
      [integrationId],
    );
    return result.rows.map(mapDeployment);
  }

  async findLatestForProject(projectId: string): Promise<Deployment | null> {
    // JOIN wfos_runtime_integrations to filter by project_id — callers never
    // need to know the integration id ahead of time. Uses the index
    // idx_deployments_integration (integration_id, created_at DESC) for the
    // ORDER BY scan.
    const result = await this.db.query<DeploymentRow>(
      `SELECT d.id, d.integration_id, d.external_id, d.status, d.preview_url,
              d.commit_sha, d.branch, d.metadata, d.created_at, d.updated_at
       FROM wfos_deployments d
       JOIN wfos_runtime_integrations ri ON ri.id = d.integration_id
       WHERE ri.project_id = $1
       ORDER BY d.created_at DESC
       LIMIT 1`,
      [projectId],
    );
    if (result.rows.length === 0) return null;
    return mapDeployment(result.rows[0]!);
  }

  async findById(id: string): Promise<Deployment | null> {
    const result = await this.db.query<DeploymentRow>(
      `SELECT ${DEPLOYMENT_COLUMNS}
       FROM wfos_deployments
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapDeployment(result.rows[0]!);
  }

  async updateStatus(
    id: string,
    status: DeploymentStatus,
    patch?: { previewUrl?: string; commitSha?: string; metadata?: Record<string, unknown> },
  ): Promise<Deployment | null> {
    const sets: string[] = [`status = $2`, `updated_at = NOW()`];
    const params: unknown[] = [id, status];
    let pIdx = 3;
    if (patch?.previewUrl !== undefined) {
      sets.push(`preview_url = $${pIdx++}`);
      params.push(patch.previewUrl);
    }
    if (patch?.commitSha !== undefined) {
      sets.push(`commit_sha = $${pIdx++}`);
      params.push(patch.commitSha);
    }
    if (patch?.metadata !== undefined) {
      sets.push(`metadata = $${pIdx++}`);
      params.push(JSON.stringify(patch.metadata));
    }
    const result = await this.db.query<DeploymentRow>(
      `UPDATE wfos_deployments
         SET ${sets.join(', ')}
       WHERE id = $1
       RETURNING ${DEPLOYMENT_COLUMNS}`,
      params,
    );
    if (result.rows.length === 0) return null;
    return mapDeployment(result.rows[0]!);
  }
}
