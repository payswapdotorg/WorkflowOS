import type { DatabaseClient } from '@platform/index.js';
import type {
  ArchitectureService,
  ArchitectureVersion,
  ArchitectureChangeRequest,
  ArchitectureVersionState,
} from './architecture.types.js';

/**
 * Default {@link ArchitectureService} (ARCH-004, ARCH4-AC-03).
 *
 * Orchestrates the architecture change process: an approved Change Request
 * creates a replacement ArchitectureVersion while superseding the previous
 * frozen version. This is ATOMIC — a single transaction (ARCH4-AC-03).
 *
 * Only an APPROVED Change Request may initiate replacement-version creation.
 * Unapproved/rejected requests cannot create versions (ARCH4-AC-02).
 *
 * The new version starts in DRAFT; the previous frozen version becomes
 * SUPERSEDED. The previous version's content is preserved unchanged
 * (immutability trigger enforces this at the persistence level, ARCH2-AC-02).
 *
 * NOTE: the service inlines its SQL within a single transaction rather than
 * delegating to the repositories' `transaction` methods, because the
 * repositories open their own transactions and a `DatabaseTx` is not a
 * `DatabaseClient` (it has no `transaction` method). This keeps the
 * approve+create+supersede atomic without nested-transaction support.
 */
export class DefaultArchitectureService implements ArchitectureService {
  constructor(private readonly db: DatabaseClient) {}

  async freezeVersion(
    versionId: string,
    frozenBy: string,
    options?: { allowEmptyAssertionSet?: boolean },
  ): Promise<ArchitectureVersion> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query<{ id: string; state: string }>(
        'SELECT id, state FROM wfos_architecture_versions WHERE id = $1 FOR UPDATE',
        [versionId],
      );
      if (current.rows.length === 0) {
        throw new Error(`architecture version not found: ${versionId}`);
      }
      const from = current.rows[0]!.state as ArchitectureVersionState;
      if (from !== 'frozen') {
        if (from !== 'draft') {
          throw new Error(`invalid architecture version lifecycle transition: ${from} → frozen`);
        }
        // WORK-051 round 1 (HIGH — empty-set semantics): the assertion set
        // closes at freeze. An EMPTY set requires the EXPLICIT
        // allowEmptyAssertionSet declaration; with it, the durable
        // assertionSetPolicy marker is written in the SAME UPDATE as the
        // freeze (the version-metadata immutability trigger permits this
        // write because OLD.state is still 'draft').
        const assertionCount = await tx.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM wfos_architecture_assertions WHERE architecture_version_id = $1',
          [versionId],
        );
        const count = Number(assertionCount.rows[0]?.count ?? '0');
        if (count === 0 && options?.allowEmptyAssertionSet !== true) {
          throw new Error(
            `architecture version ${versionId} has no architecture assertions — ` +
              'freezing an assertion-less version requires the explicit ' +
              'allowEmptyAssertionSet declaration (otherwise every governed ' +
              'checkpoint against it fails closed: an empty rule set can ' +
              'never prove conformance)',
          );
        }
        const metadataUpdate =
          count === 0 && options?.allowEmptyAssertionSet === true
            ? `, metadata = COALESCE(metadata, '{}'::jsonb) || '{"assertionSetPolicy":"none-declared"}'::jsonb`
            : '';
        await tx.query(
          `UPDATE wfos_architecture_versions
           SET state = 'frozen', frozen_at = NOW(), frozen_by = $1${metadataUpdate}
           WHERE id = $2`,
          [frozenBy, versionId],
        );
      }
      const result = await tx.query<VersionRow>(
        `SELECT id, architecture_id, version_number, state, content_inline,
                storage_key, storage_provider, content_length, content_type,
                digest_sha256, metadata, frozen_at, frozen_by, created_at, updated_at
         FROM wfos_architecture_versions WHERE id = $1`,
        [versionId],
      );
      return mapVersion(result.rows[0]!);
    });
  }

  async approveChangeAndCreateReplacement(
    changeRequestId: string,
    approverId: string,
    newVersionContent: {
      contentInline?: string;
      storageKey?: string;
      storageProvider?: string;
      contentLength?: number;
      contentType?: string;
      digestSha256?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ newVersion: ArchitectureVersion; changeRequest: ArchitectureChangeRequest }> {
    // The entire operation is a single transaction so the Change Request
    // approval, replacement-version creation, and previous-version supersession
    // are atomic. If any step fails, all roll back (ARCH4-AC-03).
    return this.db.transaction(async (tx) => {
      // 1. Lock + approve the Change Request (validates it's in 'requested' state).
      const crCurrent = await tx.query<{
        id: string; status: string; architecture_id: string; affected_version_id: string | null;
      }>(
        'SELECT id, status, architecture_id, affected_version_id FROM wfos_architecture_change_requests WHERE id = $1 FOR UPDATE',
        [changeRequestId],
      );
      if (crCurrent.rows.length === 0) {
        throw new Error(`change request not found: ${changeRequestId}`);
      }
      if (crCurrent.rows[0]!.status !== 'requested') {
        throw new Error(`change request ${changeRequestId} is not in requested state (current: ${crCurrent.rows[0]!.status})`);
      }
      const affectedVersionId = crCurrent.rows[0]!.affected_version_id;
      const architectureId = crCurrent.rows[0]!.architecture_id;
      if (!affectedVersionId) {
        throw new Error('approved change request has no affected version');
      }

      // 2. Lock the affected version + verify it's frozen.
      const affected = await tx.query<{ id: string; state: string; version_number: number }>(
        'SELECT id, state, version_number FROM wfos_architecture_versions WHERE id = $1 FOR UPDATE',
        [affectedVersionId],
      );
      if (affected.rows.length === 0) {
        throw new Error(`affected version not found: ${affectedVersionId}`);
      }
      if (affected.rows[0]!.state !== 'frozen') {
        throw new Error(`affected version ${affectedVersionId} is not frozen (current: ${affected.rows[0]!.state})`);
      }

      // 3. Compute the next version number (atomically within the same tx).
      const maxResult = await tx.query<{ max_version: number | null }>(
        'SELECT MAX(version_number) AS max_version FROM wfos_architecture_versions WHERE architecture_id = $1',
        [architectureId],
      );
      const nextVersion = (maxResult.rows[0]?.max_version ?? 0) + 1;

      // 4. Create the replacement version (starts in DRAFT).
      const newVersionResult = await tx.query<VersionRow>(
        `INSERT INTO wfos_architecture_versions
           (architecture_id, version_number, state, content_inline, storage_key,
            storage_provider, content_length, content_type, digest_sha256, metadata)
         VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, architecture_id, version_number, state, content_inline,
                   storage_key, storage_provider, content_length, content_type,
                   digest_sha256, metadata, frozen_at, frozen_by, created_at, updated_at`,
        [
          architectureId,
          nextVersion,
          newVersionContent.contentInline ?? null,
          newVersionContent.storageKey ?? null,
          newVersionContent.storageProvider ?? null,
          newVersionContent.contentLength ?? 0,
          newVersionContent.contentType ?? null,
          newVersionContent.digestSha256 ?? null,
          JSON.stringify(newVersionContent.metadata ?? {}),
        ],
      );
      const newVersion = mapVersion(newVersionResult.rows[0]!);

      // 5. Supersede the previous frozen version (FROZEN → SUPERSEDED).
      //    The immutability trigger allows state changes but protects content.
      await tx.query(
        `UPDATE wfos_architecture_versions SET state = 'superseded' WHERE id = $1`,
        [affectedVersionId],
      );

      // 6. Approve the Change Request + link the replacement version.
      await tx.query(
        `UPDATE wfos_architecture_change_requests
         SET status = 'approved', approver_id = $1, approved_at = NOW(), replacement_version_id = $2
         WHERE id = $3`,
        [approverId, newVersion.id, changeRequestId],
      );

      // 7. Fetch the final Change Request state.
      const crResult = await tx.query<CrRow>(
        `SELECT id, architecture_id, affected_version_id, requester_id, reason,
                requested_change, status, approver_id, approved_at, replacement_version_id,
                created_at, updated_at
         FROM wfos_architecture_change_requests WHERE id = $1`,
        [changeRequestId],
      );

      return { newVersion, changeRequest: mapCr(crResult.rows[0]!) };
    });
  }

  async rejectChangeRequest(changeRequestId: string, approverId: string): Promise<ArchitectureChangeRequest> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query<{ id: string; status: string }>(
        'SELECT id, status FROM wfos_architecture_change_requests WHERE id = $1 FOR UPDATE',
        [changeRequestId],
      );
      if (current.rows.length === 0) {
        throw new Error(`change request not found: ${changeRequestId}`);
      }
      if (current.rows[0]!.status !== 'requested') {
        throw new Error(`change request ${changeRequestId} is not in requested state (current: ${current.rows[0]!.status})`);
      }
      await tx.query(
        `UPDATE wfos_architecture_change_requests
         SET status = 'rejected', approver_id = $1
         WHERE id = $2`,
        [approverId, changeRequestId],
      );
      const result = await tx.query<CrRow>(
        `SELECT id, architecture_id, affected_version_id, requester_id, reason,
                requested_change, status, approver_id, approved_at, replacement_version_id,
                created_at, updated_at
         FROM wfos_architecture_change_requests WHERE id = $1`,
        [changeRequestId],
      );
      return mapCr(result.rows[0]!);
    });
  }
}

// Row mappers (duplicated from pg-architecture-repository to avoid coupling
// the service to the repository's internal row types).
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

function mapCr(row: CrRow): ArchitectureChangeRequest {
  return {
    id: row.id,
    architectureId: row.architecture_id,
    affectedVersionId: row.affected_version_id,
    requesterId: row.requester_id,
    reason: row.reason,
    requestedChange: row.requested_change,
    status: row.status as ArchitectureChangeRequest['status'],
    approverId: row.approver_id,
    approvedAt: row.approved_at,
    replacementVersionId: row.replacement_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
