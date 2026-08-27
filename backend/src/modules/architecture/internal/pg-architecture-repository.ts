import type { DatabaseClient } from '@platform/index.js';
import type {
  Architecture,
  ArchitectureRepository,
  CreateArchitectureInput,
  ArchitectureVersion,
  ArchitectureVersionRepository,
  ArchitectureVersionState,
  CreateArchitectureVersionInput,
  ArchitectureAssertion,
  ArchitectureAssertionRepository,
  ArchitectureAssertionReader,
  ArchitectureAssertionSeverity,
  ArchitectureAssertionScope,
  CreateArchitectureAssertionInput,
  ArchitectureDecisionRecord,
  ArchitectureDecisionRepository,
  CreateAdrInput,
  ArchitectureChangeRequest,
  ArchitectureChangeRequestRepository,
  ChangeRequestStatus,
  CreateChangeRequestInput,
} from './architecture.types.js';

// ===========================================================================
// Architecture root repository
// ===========================================================================

export class PgArchitectureRepository implements ArchitectureRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateArchitectureInput): Promise<Architecture> {
    const result = await this.db.query<ArchRow>(
      `INSERT INTO wfos_architectures (project_id, name, description)
       VALUES ($1, $2, $3)
       RETURNING id, project_id, name, description, created_at, updated_at`,
      [input.projectId, input.name, input.description ?? null],
    );
    return mapArch(result.rows[0]!);
  }

  async findById(id: string): Promise<Architecture | null> {
    const result = await this.db.query<ArchRow>(
      `SELECT id, project_id, name, description, created_at, updated_at
       FROM wfos_architectures WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapArch(result.rows[0]!);
  }

  async findByProject(projectId: string): Promise<Architecture[]> {
    const result = await this.db.query<ArchRow>(
      `SELECT id, project_id, name, description, created_at, updated_at
       FROM wfos_architectures WHERE project_id = $1 ORDER BY created_at`,
      [projectId],
    );
    return result.rows.map(mapArch);
  }
}

// ===========================================================================
// ArchitectureVersion repository
// ===========================================================================

export class PgArchitectureVersionRepository implements ArchitectureVersionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateArchitectureVersionInput): Promise<ArchitectureVersion> {
    return this.db.transaction(async (tx) => {
      // Atomically compute the next version number.
      const maxResult = await tx.query<{ max_version: number | null }>(
        'SELECT MAX(version_number) AS max_version FROM wfos_architecture_versions WHERE architecture_id = $1',
        [input.architectureId],
      );
      const nextVersion = (maxResult.rows[0]?.max_version ?? 0) + 1;
      const result = await tx.query<VersionRow>(
        `INSERT INTO wfos_architecture_versions
           (architecture_id, version_number, state, content_inline, storage_key,
            storage_provider, content_length, content_type, digest_sha256, metadata)
         VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, architecture_id, version_number, state, content_inline,
                   storage_key, storage_provider, content_length, content_type,
                   digest_sha256, metadata, frozen_at, frozen_by, created_at, updated_at`,
        [
          input.architectureId,
          nextVersion,
          input.contentInline ?? null,
          input.storageKey ?? null,
          input.storageProvider ?? null,
          input.contentLength ?? 0,
          input.contentType ?? null,
          input.digestSha256 ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      return mapVersion(result.rows[0]!);
    });
  }

  async findById(id: string): Promise<ArchitectureVersion | null> {
    const result = await this.db.query<VersionRow>(
      `SELECT id, architecture_id, version_number, state, content_inline,
              storage_key, storage_provider, content_length, content_type,
              digest_sha256, metadata, frozen_at, frozen_by, created_at, updated_at
       FROM wfos_architecture_versions WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapVersion(result.rows[0]!);
  }

  async findByArchitecture(architectureId: string): Promise<ArchitectureVersion[]> {
    const result = await this.db.query<VersionRow>(
      `SELECT id, architecture_id, version_number, state, content_inline,
              storage_key, storage_provider, content_length, content_type,
              digest_sha256, metadata, frozen_at, frozen_by, created_at, updated_at
       FROM wfos_architecture_versions WHERE architecture_id = $1
       ORDER BY version_number ASC`,
      [architectureId],
    );
    return result.rows.map(mapVersion);
  }

  async findLatest(architectureId: string): Promise<ArchitectureVersion | null> {
    const result = await this.db.query<VersionRow>(
      `SELECT id, architecture_id, version_number, state, content_inline,
              storage_key, storage_provider, content_length, content_type,
              digest_sha256, metadata, frozen_at, frozen_by, created_at, updated_at
       FROM wfos_architecture_versions WHERE architecture_id = $1
       ORDER BY version_number DESC LIMIT 1`,
      [architectureId],
    );
    if (result.rows.length === 0) return null;
    return mapVersion(result.rows[0]!);
  }

  async transitionState(
    id: string,
    to: ArchitectureVersionState,
    frozenBy?: string,
  ): Promise<ArchitectureVersion> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query<VersionRow>(
        'SELECT id, state FROM wfos_architecture_versions WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (current.rows.length === 0) {
        throw new Error(`architecture version not found: ${id}`);
      }
      const from = current.rows[0]!.state as ArchitectureVersionState;
      // Validate the transition (ARCH-AC-02). Legal transitions:
      //   draft → frozen
      //   frozen → superseded
      // Same-state is a no-op (returns the current row).
      if (from !== to) {
        const legal: Record<string, ArchitectureVersionState[]> = {
          draft: ['frozen'],
          frozen: ['superseded'],
          superseded: [],
        };
        if (!legal[from]?.includes(to)) {
          throw new Error(`invalid architecture version lifecycle transition: ${from} → ${to}`);
        }
      }
      const frozenByVal = to === 'frozen' ? (frozenBy ?? null) : null;
      // The trigger protects content columns; state/frozen_at/frozen_by/updated_at
      // are allowed to change. frozen_at is set by the DB default/NOW() when
      // transitioning to frozen; for other transitions it is preserved.
      await tx.query(
        `UPDATE wfos_architecture_versions
         SET state = $1,
             frozen_at = ${to === 'frozen' ? 'NOW()' : 'frozen_at'},
             frozen_by = $2
         WHERE id = $3`,
        [to, frozenByVal, id],
      );
      const result = await tx.query<VersionRow>(
        `SELECT id, architecture_id, version_number, state, content_inline,
                storage_key, storage_provider, content_length, content_type,
                digest_sha256, metadata, frozen_at, frozen_by, created_at, updated_at
         FROM wfos_architecture_versions WHERE id = $1`,
        [id],
      );
      return mapVersion(result.rows[0]!);
    });
  }
}

// ===========================================================================
// Architecture Assertions repository (WORK-051)
// ===========================================================================

/**
 * Append-only assertion store (migration 0052). There is deliberately NO
 * update() and NO delete() method — assertion rows are immutable facts, and
 * the PostgreSQL BEFORE UPDATE OR DELETE trigger rejects direct SQL mutation
 * even if this contract were bypassed. Creation is trigger-gated to DRAFT
 * versions (the assertion set is immutable with its ArchitectureVersion).
 *
 * PR #52 round 1 (BLOCKER 3): create() runs in a SINGLE transaction that
 * takes a FOR SHARE lock on the target ArchitectureVersion row BEFORE the
 * insert, serializing against version freezing (freezeVersion/
 * transitionState update the same row under FOR UPDATE). An assertion can
 * never commit after the version becomes frozen: the attach either observes
 * the committed freeze (rejected below AND by the trigger) or holds the row
 * against the freeze until the attach commits (serialized before it).
 */
export class PgArchitectureAssertionRepository
  implements ArchitectureAssertionRepository, ArchitectureAssertionReader
{
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateArchitectureAssertionInput): Promise<ArchitectureAssertion> {
    return this.db.transaction(async (tx) => {
      // Locking read — the serialization boundary shared with version
      // freezing. The persistence-layer trigger (which takes the same FOR
      // SHARE lock) remains the authoritative gate for every other insert
      // path; this typed pre-check gives a clean error for repository
      // callers.
      const version = await tx.query<{ state: string }>(
        'SELECT state FROM wfos_architecture_versions WHERE id = $1 FOR SHARE',
        [input.architectureVersionId],
      );
      if (version.rows.length === 0) {
        throw new Error(
          `architecture assertion: architecture version ${input.architectureVersionId} not found`,
        );
      }
      const state = version.rows[0]!.state;
      if (state !== 'draft') {
        throw new Error(
          `architecture assertion: cannot attach to ${state} version ${input.architectureVersionId} — ` +
            'the assertion set is immutable with a frozen/superseded version; ' +
            'use the Architecture Change Request path',
        );
      }
      const result = await tx.query<AssertionRow>(
        `INSERT INTO wfos_architecture_assertions
           (architecture_version_id, assertion_id, severity, scope, statement,
            detector_kind, detector_config)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, architecture_version_id, assertion_id, severity, scope,
                   statement, detector_kind, detector_config, created_at`,
        [
          input.architectureVersionId,
          input.assertionId,
          input.severity,
          input.scope,
          input.statement,
          input.detectorKind,
          JSON.stringify(input.detectorConfig ?? {}),
        ],
      );
      return mapAssertion(result.rows[0]!);
    });
  }

  async findById(id: string): Promise<ArchitectureAssertion | null> {
    const result = await this.db.query<AssertionRow>(
      `SELECT id, architecture_version_id, assertion_id, severity, scope,
              statement, detector_kind, detector_config, created_at
       FROM wfos_architecture_assertions WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapAssertion(result.rows[0]!);
  }

  async listForVersion(architectureVersionId: string): Promise<ArchitectureAssertion[]> {
    const result = await this.db.query<AssertionRow>(
      `SELECT id, architecture_version_id, assertion_id, severity, scope,
              statement, detector_kind, detector_config, created_at
       FROM wfos_architecture_assertions
       WHERE architecture_version_id = $1
       ORDER BY assertion_id`,
      [architectureVersionId],
    );
    return result.rows.map(mapAssertion);
  }
}

// ===========================================================================
// Architecture Decision Records repository
// ===========================================================================

export class PgArchitectureDecisionRepository implements ArchitectureDecisionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateAdrInput): Promise<ArchitectureDecisionRecord> {
    return this.db.transaction(async (tx) => {
      // Atomically compute the next ADR number within the version.
      const maxResult = await tx.query<{ max_adr: number | null }>(
        'SELECT MAX(adr_number) AS max_adr FROM wfos_architecture_decisions WHERE version_id = $1',
        [input.versionId],
      );
      const nextAdr = (maxResult.rows[0]?.max_adr ?? 0) + 1;
      const result = await tx.query<AdrRow>(
        `INSERT INTO wfos_architecture_decisions
           (version_id, adr_number, title, content, status, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, version_id, adr_number, title, content, status, metadata, created_at`,
        [
          input.versionId,
          nextAdr,
          input.title,
          input.content,
          input.status ?? 'proposed',
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      return mapAdr(result.rows[0]!);
    });
  }

  async findById(id: string): Promise<ArchitectureDecisionRecord | null> {
    const result = await this.db.query<AdrRow>(
      `SELECT id, version_id, adr_number, title, content, status, metadata, created_at
       FROM wfos_architecture_decisions WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapAdr(result.rows[0]!);
  }

  async listForVersion(versionId: string): Promise<ArchitectureDecisionRecord[]> {
    const result = await this.db.query<AdrRow>(
      `SELECT id, version_id, adr_number, title, content, status, metadata, created_at
       FROM wfos_architecture_decisions WHERE version_id = $1
       ORDER BY adr_number ASC`,
      [versionId],
    );
    return result.rows.map(mapAdr);
  }
}

// ===========================================================================
// Architecture Change Requests repository
// ===========================================================================

export class PgArchitectureChangeRequestRepository implements ArchitectureChangeRequestRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateChangeRequestInput): Promise<ArchitectureChangeRequest> {
    const result = await this.db.query<CrRow>(
      `INSERT INTO wfos_architecture_change_requests
         (architecture_id, affected_version_id, requester_id, reason, requested_change, status)
       VALUES ($1, $2, $3, $4, $5, 'requested')
       RETURNING id, architecture_id, affected_version_id, requester_id, reason,
                 requested_change, status, approver_id, approved_at, replacement_version_id,
                 created_at, updated_at`,
      [
        input.architectureId,
        input.affectedVersionId ?? null,
        input.requesterId ?? null,
        input.reason,
        input.requestedChange,
      ],
    );
    return mapCr(result.rows[0]!);
  }

  async findById(id: string): Promise<ArchitectureChangeRequest | null> {
    const result = await this.db.query<CrRow>(
      `SELECT id, architecture_id, affected_version_id, requester_id, reason,
              requested_change, status, approver_id, approved_at, replacement_version_id,
              created_at, updated_at
       FROM wfos_architecture_change_requests WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapCr(result.rows[0]!);
  }

  async listForArchitecture(architectureId: string): Promise<ArchitectureChangeRequest[]> {
    const result = await this.db.query<CrRow>(
      `SELECT id, architecture_id, affected_version_id, requester_id, reason,
              requested_change, status, approver_id, approved_at, replacement_version_id,
              created_at, updated_at
       FROM wfos_architecture_change_requests WHERE architecture_id = $1
       ORDER BY created_at`,
      [architectureId],
    );
    return result.rows.map(mapCr);
  }

  async approve(id: string, approverId: string): Promise<ArchitectureChangeRequest> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query<CrRow>(
        'SELECT id, status FROM wfos_architecture_change_requests WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (current.rows.length === 0) {
        throw new Error(`change request not found: ${id}`);
      }
      if (current.rows[0]!.status !== 'requested') {
        throw new Error(`change request ${id} is not in requested state (current: ${current.rows[0]!.status})`);
      }
      await tx.query(
        `UPDATE wfos_architecture_change_requests
         SET status = 'approved', approver_id = $1, approved_at = NOW()
         WHERE id = $2`,
        [approverId, id],
      );
      const result = await tx.query<CrRow>(
        `SELECT id, architecture_id, affected_version_id, requester_id, reason,
                requested_change, status, approver_id, approved_at, replacement_version_id,
                created_at, updated_at
         FROM wfos_architecture_change_requests WHERE id = $1`,
        [id],
      );
      return mapCr(result.rows[0]!);
    });
  }

  async reject(id: string, approverId: string): Promise<ArchitectureChangeRequest> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query<CrRow>(
        'SELECT id, status FROM wfos_architecture_change_requests WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (current.rows.length === 0) {
        throw new Error(`change request not found: ${id}`);
      }
      if (current.rows[0]!.status !== 'requested') {
        throw new Error(`change request ${id} is not in requested state (current: ${current.rows[0]!.status})`);
      }
      await tx.query(
        `UPDATE wfos_architecture_change_requests
         SET status = 'rejected', approver_id = $1
         WHERE id = $2`,
        [approverId, id],
      );
      const result = await tx.query<CrRow>(
        `SELECT id, architecture_id, affected_version_id, requester_id, reason,
                requested_change, status, approver_id, approved_at, replacement_version_id,
                created_at, updated_at
         FROM wfos_architecture_change_requests WHERE id = $1`,
        [id],
      );
      return mapCr(result.rows[0]!);
    });
  }

  async linkReplacement(id: string, replacementVersionId: string): Promise<ArchitectureChangeRequest> {
    const result = await this.db.query<CrRow>(
      `UPDATE wfos_architecture_change_requests
       SET replacement_version_id = $1
       WHERE id = $2
       RETURNING id, architecture_id, affected_version_id, requester_id, reason,
                 requested_change, status, approver_id, approved_at, replacement_version_id,
                 created_at, updated_at`,
      [replacementVersionId, id],
    );
    return mapCr(result.rows[0]!);
  }
}

// ===========================================================================
// Row mappers
// ===========================================================================

interface ArchRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}
interface VersionRow {
  id: string;
  architecture_id: string;
  version_number: number;
  state: string;
  content_inline: string | null;
  storage_key: string | null;
  storage_provider: string | null;
  content_length: string;
  content_type: string | null;
  digest_sha256: string | null;
  metadata: Record<string, unknown>;
  frozen_at: Date | null;
  frozen_by: string | null;
  created_at: Date;
  updated_at: Date;
}
interface AssertionRow {
  id: string;
  architecture_version_id: string;
  assertion_id: string;
  severity: string;
  scope: string;
  statement: string;
  detector_kind: string;
  detector_config: Record<string, unknown>;
  created_at: Date;
}

interface AdrRow {
  id: string;
  version_id: string;
  adr_number: number;
  title: string;
  content: string;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}
interface CrRow {
  id: string;
  architecture_id: string;
  affected_version_id: string | null;
  requester_id: string | null;
  reason: string;
  requested_change: string;
  status: string;
  approver_id: string | null;
  approved_at: Date | null;
  replacement_version_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapArch(row: ArchRow): Architecture {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: VersionRow): ArchitectureVersion {
  return {
    id: row.id,
    architectureId: row.architecture_id,
    versionNumber: row.version_number,
    state: row.state as ArchitectureVersionState,
    contentInline: row.content_inline,
    storageKey: row.storage_key,
    storageProvider: row.storage_provider,
    contentLength: Number(row.content_length),
    contentType: row.content_type,
    digestSha256: row.digest_sha256,
    metadata: row.metadata ?? {},
    frozenAt: row.frozen_at,
    frozenBy: row.frozen_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAssertion(row: AssertionRow): ArchitectureAssertion {
  return {
    id: row.id,
    architectureVersionId: row.architecture_version_id,
    assertionId: row.assertion_id,
    severity: row.severity as ArchitectureAssertionSeverity,
    scope: row.scope as ArchitectureAssertionScope,
    statement: row.statement,
    detectorKind: row.detector_kind,
    detectorConfig: row.detector_config ?? {},
    createdAt: row.created_at,
  };
}

function mapAdr(row: AdrRow): ArchitectureDecisionRecord {
  return {
    id: row.id,
    versionId: row.version_id,
    adrNumber: row.adr_number,
    title: row.title,
    content: row.content,
    status: row.status,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

function mapCr(row: CrRow): ArchitectureChangeRequest {
  return {
    id: row.id,
    architectureId: row.architecture_id,
    affectedVersionId: row.affected_version_id,
    requesterId: row.requester_id,
    reason: row.reason,
    requestedChange: row.requested_change,
    status: row.status as ChangeRequestStatus,
    approverId: row.approver_id,
    approvedAt: row.approved_at,
    replacementVersionId: row.replacement_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
