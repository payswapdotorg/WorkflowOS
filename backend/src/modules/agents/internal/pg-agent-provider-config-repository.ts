/**
 * WORK-026: PostgreSQL persistence for per-project agent provider configs.
 *
 * Wraps the `wfos_agent_provider_configs` table (migration 0022). Stores NO
 * secret values — only a `secret_ref` (a SecretStore key name) + readiness
 * metadata. The actual secret value lives in EnvSecretStore or a future
 * Vault-backed SecretStore (SEC-001).
 *
 * This file is private to /agents (PLAT-AC-02). Cross-module imports of this
 * file are forbidden; callers consume the repository interface exposed by
 * the public barrel (`@modules/agents/index.js`) or via DI.
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  AgentProviderConfigRecord,
  AgentProviderConfigRepository,
} from './agent-provider-registry.types.js';

interface AgentProviderConfigRow {
  id: string;
  project_id: string;
  provider: string;
  model: string;
  secret_ref: string;
  metadata: Record<string, unknown>;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

const AGENT_PROVIDER_CONFIG_COLUMNS =
  'id, project_id, provider, model, secret_ref, metadata, is_default, created_at, updated_at';

function mapAgentProviderConfig(row: AgentProviderConfigRow): AgentProviderConfigRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    model: row.model,
    secretRef: row.secret_ref,
    metadata: row.metadata ?? {},
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgAgentProviderConfigRepository implements AgentProviderConfigRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    projectId: string;
    provider: string;
    model: string;
    secretRef: string;
    metadata?: Record<string, unknown>;
    isDefault?: boolean;
  }): Promise<AgentProviderConfigRecord> {
    const metadata = JSON.stringify(input.metadata ?? {});
    const isDefault = input.isDefault ?? false;

    // When promoting this row to default, atomically clear any prior default
    // for the same project inside a single transaction. The partial unique
    // index `uq_agent_provider_configs_default` enforces at-most-one default
    // at the DB level — we use the UPDATE+INSERT transaction to avoid the
    // race where two concurrent inserts would both fail on the unique
    // constraint instead of one replacing the other.
    if (isDefault) {
      return this.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE wfos_agent_provider_configs
             SET is_default = false, updated_at = NOW()
           WHERE project_id = $1 AND is_default = true`,
          [input.projectId],
        );
        const result = await tx.query<AgentProviderConfigRow>(
          `INSERT INTO wfos_agent_provider_configs
             (project_id, provider, model, secret_ref, metadata, is_default)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${AGENT_PROVIDER_CONFIG_COLUMNS}`,
          [
            input.projectId,
            input.provider,
            input.model,
            input.secretRef,
            metadata,
            true,
          ],
        );
        return mapAgentProviderConfig(result.rows[0]!);
      });
    }

    const result = await this.db.query<AgentProviderConfigRow>(
      `INSERT INTO wfos_agent_provider_configs
         (project_id, provider, model, secret_ref, metadata, is_default)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${AGENT_PROVIDER_CONFIG_COLUMNS}`,
      [
        input.projectId,
        input.provider,
        input.model,
        input.secretRef,
        metadata,
        false,
      ],
    );
    return mapAgentProviderConfig(result.rows[0]!);
  }

  async findByProject(projectId: string): Promise<AgentProviderConfigRecord[]> {
    const result = await this.db.query<AgentProviderConfigRow>(
      `SELECT ${AGENT_PROVIDER_CONFIG_COLUMNS}
       FROM wfos_agent_provider_configs
       WHERE project_id = $1
       ORDER BY created_at ASC`,
      [projectId],
    );
    return result.rows.map(mapAgentProviderConfig);
  }

  async findDefaultByProject(projectId: string): Promise<AgentProviderConfigRecord | null> {
    const result = await this.db.query<AgentProviderConfigRow>(
      `SELECT ${AGENT_PROVIDER_CONFIG_COLUMNS}
       FROM wfos_agent_provider_configs
       WHERE project_id = $1 AND is_default = true
       LIMIT 1`,
      [projectId],
    );
    if (result.rows.length === 0) return null;
    return mapAgentProviderConfig(result.rows[0]!);
  }

  async findByProjectProviderModel(
    projectId: string,
    provider: string,
    model: string,
  ): Promise<AgentProviderConfigRecord | null> {
    const result = await this.db.query<AgentProviderConfigRow>(
      `SELECT ${AGENT_PROVIDER_CONFIG_COLUMNS}
       FROM wfos_agent_provider_configs
       WHERE project_id = $1 AND provider = $2 AND model = $3
       LIMIT 1`,
      [projectId, provider, model],
    );
    if (result.rows.length === 0) return null;
    return mapAgentProviderConfig(result.rows[0]!);
  }

  async findById(id: string): Promise<AgentProviderConfigRecord | null> {
    const result = await this.db.query<AgentProviderConfigRow>(
      `SELECT ${AGENT_PROVIDER_CONFIG_COLUMNS}
       FROM wfos_agent_provider_configs
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapAgentProviderConfig(result.rows[0]!);
  }

  async remove(id: string): Promise<void> {
    await this.db.query(
      'DELETE FROM wfos_agent_provider_configs WHERE id = $1',
      [id],
    );
  }
}
