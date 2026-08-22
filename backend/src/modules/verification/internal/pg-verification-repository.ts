import type { DatabaseClient } from '@platform/index.js';
import type {
  VerificationRun,
  VerificationRunStatus,
  CreateVerificationRunInput,
  UpdateVerificationRunInput,
  VerificationRunRepository,
  Evidence,
  EvidenceAuthority,
  EvidenceResult,
  CreateEvidenceInput,
  EvidenceRepository,
  CriterionEvidenceMapping,
  MappingRelevance,
  MappingStatus,
  CreateMapInput,
  CriterionEvidenceMappingRepository,
} from './verification.types.js';

// ===========================================================================
// VerificationRun repository (VERIFY-001).
//
// The wfos_check_verification_run_integrity trigger enforces that the run's
// architecture_version_id matches the Work Item's version, and project_id
// matches the architecture version → architecture → project chain. This is
// PERSISTENCE-LEVEL enforcement — a direct INSERT with mismatched IDs is
// rejected by PostgreSQL, not just app logic.
// ===========================================================================

export class PgVerificationRunRepository implements VerificationRunRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateVerificationRunInput): Promise<VerificationRun> {
    const result = await this.db.query<RunRow>(
      `INSERT INTO wfos_verification_runs
         (project_id, work_item_id, work_order_id, architecture_version_id,
          source, source_ref, status, execution_id, started_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NOW(), $8)
       RETURNING id, project_id, work_item_id, work_order_id, architecture_version_id,
                 source, source_ref, status, execution_id, started_at, finished_at,
                 summary, error_metadata, metadata, created_at, updated_at`,
      [
        input.projectId,
        input.workItemId,
        input.workOrderId ?? null,
        input.architectureVersionId,
        input.source,
        input.sourceRef ?? null,
        input.executionId,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapRun(result.rows[0]!);
  }

  async findById(id: string): Promise<VerificationRun | null> {
    const result = await this.db.query<RunRow>(
      `SELECT id, project_id, work_item_id, work_order_id, architecture_version_id,
              source, source_ref, status, execution_id, started_at, finished_at,
              summary, error_metadata, metadata, created_at, updated_at
       FROM wfos_verification_runs WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapRun(result.rows[0]!);
  }

  async listForWorkItem(workItemId: string): Promise<VerificationRun[]> {
    const result = await this.db.query<RunRow>(
      `SELECT id, project_id, work_item_id, work_order_id, architecture_version_id,
              source, source_ref, status, execution_id, started_at, finished_at,
              summary, error_metadata, metadata, created_at, updated_at
       FROM wfos_verification_runs WHERE work_item_id = $1 ORDER BY created_at DESC`,
      [workItemId],
    );
    return result.rows.map(mapRun);
  }

  async update(id: string, input: UpdateVerificationRunInput): Promise<VerificationRun | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    let pIdx = 2;
    if (input.status !== undefined) { sets.push(`status = $${pIdx++}`); params.push(input.status); }
    if (input.startedAt !== undefined) { sets.push(`started_at = $${pIdx++}`); params.push(input.startedAt); }
    if (input.finishedAt !== undefined) { sets.push(`finished_at = $${pIdx++}`); params.push(input.finishedAt); }
    if (input.summary !== undefined) { sets.push(`summary = $${pIdx++}`); params.push(JSON.stringify(input.summary)); }
    if (input.errorMetadata !== undefined) { sets.push(`error_metadata = $${pIdx++}`); params.push(JSON.stringify(input.errorMetadata)); }
    if (input.metadata !== undefined) { sets.push(`metadata = $${pIdx++}`); params.push(JSON.stringify(input.metadata)); }
    if (sets.length === 0) return this.findById(id);
    const result = await this.db.query<RunRow>(
      `UPDATE wfos_verification_runs SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, project_id, work_item_id, work_order_id, architecture_version_id,
                 source, source_ref, status, execution_id, started_at, finished_at,
                 summary, error_metadata, metadata, created_at, updated_at`,
      params,
    );
    if (result.rows.length === 0) return null;
    return mapRun(result.rows[0]!);
  }
}

// ===========================================================================
// Evidence repository (VERIFY-001).
//
// Large artifact BODIES live in ObjectStore; only the storage reference lives
// in the evidence row (DATA3-AC-02).
// ===========================================================================

export class PgEvidenceRepository implements EvidenceRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateEvidenceInput, authority: EvidenceAuthority): Promise<Evidence> {
    // `authority` is a SERVER-SIDE parameter — it is NOT part of
    // CreateEvidenceInput and cannot be supplied by API clients. The
    // VerificationService sets it based on the trusted source path:
    //   - attachEvidence (public/manual) → 'claim'
    //   - attachCiEvidence (trusted /github CI) → 'authoritative'
    // This prevents the verification-authority bypass (PR #14 architect review).
    const result = await this.db.query<EvidenceRow>(
      `INSERT INTO wfos_evidence
         (project_id, verification_run_id, evidence_type, authority, provider,
          external_ref, head_sha, result, content_summary, storage_key,
          storage_provider, artifact_digest, artifact_size_bytes,
          artifact_content_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id, project_id, verification_run_id, evidence_type, authority,
                 provider, external_ref, head_sha, result, content_summary,
                 storage_key, storage_provider, artifact_digest, artifact_size_bytes,
                 artifact_content_type, metadata, created_at, updated_at`,
      [
        input.projectId,
        input.verificationRunId,
        input.evidenceType,
        authority, // SERVER-SIDE — never from client
        input.provider,
        input.externalRef ?? null,
        input.headSha ?? null,
        input.result ?? 'unknown',
        input.contentSummary ?? null,
        input.storageKey ?? null,
        input.storageProvider ?? null,
        input.artifactDigest ?? null,
        input.artifactSizeBytes ?? null,
        input.artifactContentType ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapEvidence(result.rows[0]!);
  }

  async findById(id: string): Promise<Evidence | null> {
    const result = await this.db.query<EvidenceRow>(
      `SELECT id, project_id, verification_run_id, evidence_type, authority,
              provider, external_ref, head_sha, result, content_summary, storage_key,
              storage_provider, artifact_digest, artifact_size_bytes,
              artifact_content_type, metadata, created_at, updated_at
       FROM wfos_evidence WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapEvidence(result.rows[0]!);
  }

  async listForVerificationRun(verificationRunId: string): Promise<Evidence[]> {
    const result = await this.db.query<EvidenceRow>(
      `SELECT id, project_id, verification_run_id, evidence_type, authority,
              provider, external_ref, head_sha, result, content_summary, storage_key,
              storage_provider, artifact_digest, artifact_size_bytes,
              artifact_content_type, metadata, created_at, updated_at
       FROM wfos_evidence WHERE verification_run_id = $1 ORDER BY created_at`,
      [verificationRunId],
    );
    return result.rows.map(mapEvidence);
  }
}

// ===========================================================================
// CriterionEvidenceMapping repository (VERIFY-002).
//
// The wfos_check_criterion_evidence_mapping_integrity trigger enforces:
// - the evidence being mapped belongs to the same verification_run_id;
// - the evidence's project_id matches the mapping's project_id (tenant
//   isolation — cross-tenant mappings are rejected at the DB level).
//
// Idempotency: the UNIQUE(evidence_id, criterion_id) DEFERRABLE constraint
// (initially deferred) allows upsertActive() to detect an existing active
// mapping and return it without creating a duplicate.
// ===========================================================================

export class PgCriterionEvidenceMappingRepository implements CriterionEvidenceMappingRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateMapInput): Promise<CriterionEvidenceMapping> {
    const result = await this.db.query<MappingRow>(
      `INSERT INTO wfos_criterion_evidence_mappings
         (project_id, verification_run_id, evidence_id, criterion_id, relevance,
          mapping_status, source, metadata)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)
       RETURNING id, project_id, verification_run_id, evidence_id, criterion_id,
                 relevance, mapping_status, source, metadata, created_at, updated_at`,
      [
        input.projectId,
        input.verificationRunId,
        input.evidenceId,
        input.criterionId,
        input.relevance ?? 'supports',
        input.source ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapMapping(result.rows[0]!);
  }

  async upsertActive(input: CreateMapInput): Promise<CriterionEvidenceMapping> {
    // Idempotent: if an active mapping for (evidenceId, criterionId) exists,
    // return it without creating a duplicate. This makes repeated processing
    // (e.g. duplicate webhook delivery) idempotent.
    const existing = await this.db.query<MappingRow>(
      `SELECT id, project_id, verification_run_id, evidence_id, criterion_id,
              relevance, mapping_status, source, metadata, created_at, updated_at
       FROM wfos_criterion_evidence_mappings
       WHERE evidence_id = $1 AND criterion_id = $2 AND mapping_status = 'active'`,
      [input.evidenceId, input.criterionId],
    );
    if (existing.rows.length > 0) {
      return mapMapping(existing.rows[0]!);
    }
    return this.create(input);
  }

  async listForVerificationRun(verificationRunId: string): Promise<CriterionEvidenceMapping[]> {
    const result = await this.db.query<MappingRow>(
      `SELECT id, project_id, verification_run_id, evidence_id, criterion_id,
              relevance, mapping_status, source, metadata, created_at, updated_at
       FROM wfos_criterion_evidence_mappings
       WHERE verification_run_id = $1 AND mapping_status = 'active'
       ORDER BY created_at`,
      [verificationRunId],
    );
    return result.rows.map(mapMapping);
  }

  async listForEvidence(evidenceId: string): Promise<CriterionEvidenceMapping[]> {
    const result = await this.db.query<MappingRow>(
      `SELECT id, project_id, verification_run_id, evidence_id, criterion_id,
              relevance, mapping_status, source, metadata, created_at, updated_at
       FROM wfos_criterion_evidence_mappings
       WHERE evidence_id = $1 AND mapping_status = 'active'
       ORDER BY created_at`,
      [evidenceId],
    );
    return result.rows.map(mapMapping);
  }

  async listForCriterion(criterionId: string): Promise<CriterionEvidenceMapping[]> {
    const result = await this.db.query<MappingRow>(
      `SELECT id, project_id, verification_run_id, evidence_id, criterion_id,
              relevance, mapping_status, source, metadata, created_at, updated_at
       FROM wfos_criterion_evidence_mappings
       WHERE criterion_id = $1 AND mapping_status = 'active'
       ORDER BY created_at DESC`,
      [criterionId],
    );
    return result.rows.map(mapMapping);
  }

  async supersede(id: string): Promise<CriterionEvidenceMapping | null> {
    const result = await this.db.query<MappingRow>(
      `UPDATE wfos_criterion_evidence_mappings SET mapping_status = 'superseded'
       WHERE id = $1 AND mapping_status = 'active'
       RETURNING id, project_id, verification_run_id, evidence_id, criterion_id,
                 relevance, mapping_status, source, metadata, created_at, updated_at`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapMapping(result.rows[0]!);
  }
}

// ===========================================================================
// Row mappers
// ===========================================================================

interface RunRow {
  id: string;
  project_id: string;
  work_item_id: string;
  work_order_id: string | null;
  architecture_version_id: string;
  source: string;
  source_ref: string | null;
  status: string;
  execution_id: string;
  started_at: Date | null;
  finished_at: Date | null;
  summary: unknown;
  error_metadata: unknown;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

function mapRun(row: RunRow): VerificationRun {
  return {
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    workOrderId: row.work_order_id,
    architectureVersionId: row.architecture_version_id,
    source: row.source,
    sourceRef: row.source_ref,
    status: row.status as VerificationRunStatus,
    executionId: row.execution_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: (row.summary as Record<string, unknown>) ?? {},
    errorMetadata: (row.error_metadata as Record<string, unknown> | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface EvidenceRow {
  id: string;
  project_id: string;
  verification_run_id: string;
  evidence_type: string;
  authority: string;
  provider: string;
  external_ref: string | null;
  head_sha: string | null;
  result: string;
  content_summary: string | null;
  storage_key: string | null;
  storage_provider: string | null;
  artifact_digest: string | null;
  artifact_size_bytes: number | null;
  artifact_content_type: string | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

function mapEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    projectId: row.project_id,
    verificationRunId: row.verification_run_id,
    evidenceType: row.evidence_type,
    authority: row.authority as EvidenceAuthority,
    provider: row.provider,
    externalRef: row.external_ref,
    headSha: row.head_sha,
    result: row.result as EvidenceResult,
    contentSummary: row.content_summary,
    storageKey: row.storage_key,
    storageProvider: row.storage_provider,
    artifactDigest: row.artifact_digest,
    // PostgreSQL returns BIGINT as a string by default (to avoid JS number
    // precision issues). Parse to number — artifact sizes fit comfortably in
    // a JS number (up to 2^53 - 1 bytes ≈ 9 PB).
    artifactSizeBytes: row.artifact_size_bytes != null ? Number(row.artifact_size_bytes) : null,
    artifactContentType: row.artifact_content_type,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface MappingRow {
  id: string;
  project_id: string;
  verification_run_id: string;
  evidence_id: string;
  criterion_id: string;
  relevance: string;
  mapping_status: string;
  source: string | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

function mapMapping(row: MappingRow): CriterionEvidenceMapping {
  return {
    id: row.id,
    projectId: row.project_id,
    verificationRunId: row.verification_run_id,
    evidenceId: row.evidence_id,
    criterionId: row.criterion_id,
    relevance: row.relevance as MappingRelevance,
    mappingStatus: row.mapping_status as MappingStatus,
    source: row.source,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
