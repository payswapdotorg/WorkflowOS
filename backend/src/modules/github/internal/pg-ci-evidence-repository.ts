import type { DatabaseClient } from '@platform/index.js';
import type {
  CiRunEvidence,
  CiArtifactReference,
  IngestCiEvidenceInput,
  CiEvidenceIngestionRepository,
} from './ci-evidence.types.js';

// ===========================================================================
// CI evidence ingestion repository (GITHUB-006).
//
// Owned by /github. Persists provider-independent CI evidence rows. Idempotent
// on (provider, external_run_id) — re-processing the same GitHub Actions event
// updates the same row, never creates duplicates (UNIQUE constraint at the DB
// level enforces this regardless of app-layer bugs).
// ===========================================================================

export class PgCiEvidenceIngestionRepository implements CiEvidenceIngestionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async upsert(input: IngestCiEvidenceInput): Promise<CiRunEvidence> {
    // ON CONFLICT (provider, external_run_id) DO UPDATE — idempotent.
    // Returns the resulting row regardless of whether it was inserted or
    // updated. This is the GITHUB-004 idempotency rule applied to CI evidence.
    const result = await this.db.query<CiRow>(
      `INSERT INTO wfos_github_ci_evidence
         (project_id, provider, external_run_id, workflow_name, check_name,
          repository_full_name, head_sha, branch, status, conclusion, run_url,
          run_started_at, run_completed_at, artifact_references, provider_metadata,
          webhook_event_id)
       VALUES ($1, 'github', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (provider, external_run_id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         workflow_name = EXCLUDED.workflow_name,
         check_name = EXCLUDED.check_name,
         repository_full_name = EXCLUDED.repository_full_name,
         head_sha = EXCLUDED.head_sha,
         branch = EXCLUDED.branch,
         status = EXCLUDED.status,
         conclusion = EXCLUDED.conclusion,
         run_url = EXCLUDED.run_url,
         run_started_at = EXCLUDED.run_started_at,
         run_completed_at = EXCLUDED.run_completed_at,
         artifact_references = EXCLUDED.artifact_references,
         provider_metadata = EXCLUDED.provider_metadata,
         webhook_event_id = COALESCE(EXCLUDED.webhook_event_id, wfos_github_ci_evidence.webhook_event_id)
       RETURNING id, project_id, provider, external_run_id, workflow_name, check_name,
                 repository_full_name, head_sha, branch, status, conclusion, run_url,
                 run_started_at, run_completed_at, artifact_references, provider_metadata,
                 webhook_event_id, created_at, updated_at`,
      [
        input.projectId,
        input.externalRunId,
        input.workflowName ?? null,
        input.checkName ?? null,
        input.repositoryFullName ?? null,
        input.headSha ?? null,
        input.branch ?? null,
        input.status ?? null,
        input.conclusion ?? null,
        input.runUrl ?? null,
        input.runStartedAt ?? null,
        input.runCompletedAt ?? null,
        JSON.stringify(input.artifactReferences ?? []),
        JSON.stringify(input.providerMetadata ?? {}),
        input.webhookEventId ?? null,
      ],
    );
    return mapCiRow(result.rows[0]!);
  }

  async findById(id: string): Promise<CiRunEvidence | null> {
    const result = await this.db.query<CiRow>(
      `SELECT id, project_id, provider, external_run_id, workflow_name, check_name,
              repository_full_name, head_sha, branch, status, conclusion, run_url,
              run_started_at, run_completed_at, artifact_references, provider_metadata,
              webhook_event_id, created_at, updated_at
       FROM wfos_github_ci_evidence WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapCiRow(result.rows[0]!);
  }

  async findByExternalRunId(provider: string, externalRunId: string): Promise<CiRunEvidence | null> {
    const result = await this.db.query<CiRow>(
      `SELECT id, project_id, provider, external_run_id, workflow_name, check_name,
              repository_full_name, head_sha, branch, status, conclusion, run_url,
              run_started_at, run_completed_at, artifact_references, provider_metadata,
              webhook_event_id, created_at, updated_at
       FROM wfos_github_ci_evidence WHERE provider = $1 AND external_run_id = $2`,
      [provider, externalRunId],
    );
    if (result.rows.length === 0) return null;
    return mapCiRow(result.rows[0]!);
  }

  async listForProject(projectId: string, opts?: { headSha?: string }): Promise<CiRunEvidence[]> {
    const params: unknown[] = [projectId];
    let where = 'project_id = $1';
    if (opts?.headSha) {
      params.push(opts.headSha);
      where += ` AND head_sha = $${params.length}`;
    }
    const result = await this.db.query<CiRow>(
      `SELECT id, project_id, provider, external_run_id, workflow_name, check_name,
              repository_full_name, head_sha, branch, status, conclusion, run_url,
              run_started_at, run_completed_at, artifact_references, provider_metadata,
              webhook_event_id, created_at, updated_at
       FROM wfos_github_ci_evidence WHERE ${where}
       ORDER BY created_at DESC`,
      params,
    );
    return result.rows.map(mapCiRow);
  }
}

// ===========================================================================
// Row mappers
// ===========================================================================

interface CiRow {
  id: string;
  project_id: string;
  provider: string;
  external_run_id: string;
  workflow_name: string | null;
  check_name: string | null;
  repository_full_name: string | null;
  head_sha: string | null;
  branch: string | null;
  status: string | null;
  conclusion: string | null;
  run_url: string | null;
  run_started_at: Date | null;
  run_completed_at: Date | null;
  artifact_references: unknown;
  provider_metadata: unknown;
  webhook_event_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapCiRow(row: CiRow): CiRunEvidence {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    externalRunId: row.external_run_id,
    workflowName: row.workflow_name,
    checkName: row.check_name,
    repositoryFullName: row.repository_full_name,
    headSha: row.head_sha,
    branch: row.branch,
    status: row.status,
    conclusion: row.conclusion,
    runUrl: row.run_url,
    runStartedAt: row.run_started_at,
    runCompletedAt: row.run_completed_at,
    artifactReferences: mapArtifactRefs(row.artifact_references),
    providerMetadata: (row.provider_metadata as Record<string, unknown>) ?? {},
    webhookEventId: row.webhook_event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapArtifactRefs(raw: unknown): CiArtifactReference[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const obj = r as Record<string, unknown>;
    return {
      name: String(obj.name ?? ''),
      contentType: obj.contentType ? String(obj.contentType) : undefined,
      storageKey: obj.storageKey ? String(obj.storageKey) : undefined,
      externalUrl: obj.externalUrl ? String(obj.externalUrl) : undefined,
      sizeBytes: typeof obj.sizeBytes === 'number' ? obj.sizeBytes : undefined,
      metadata: (obj.metadata as Record<string, unknown>) ?? undefined,
    };
  });
}
