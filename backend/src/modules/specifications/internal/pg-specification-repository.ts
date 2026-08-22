import type { DatabaseClient } from '@platform/index.js';
import type {
  Specification,
  SpecificationRepository,
  SpecificationVersion,
  SpecificationVersionRepository,
  CreateSpecificationInput,
  UpdateSpecificationInput,
  SpecificationState,
  SpecificationLifecycleTransition,
  CreateSpecificationVersionInput,
} from './specification.types.js';

/**
 * PostgreSQL-backed {@link SpecificationRepository}.
 *
 * PostgreSQL is authoritative for specification metadata + lifecycle (SPEC-001).
 * Large content bodies are stored via the existing ObjectStore abstraction
 * (DATA-003); only the opaque storage_key + metadata live here.
 */
export class PgSpecificationRepository implements SpecificationRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateSpecificationInput): Promise<Specification> {
    const result = await this.db.query<SpecRow>(
      `INSERT INTO wfos_specifications (project_id, slug, title, state, current_version)
       VALUES ($1, $2, $3, 'draft', 0)
       RETURNING id, project_id, slug, title, state, current_version, created_at, updated_at`,
      [input.projectId, input.slug, input.title],
    );
    return mapSpec(result.rows[0]!);
  }

  async findById(id: string): Promise<Specification | null> {
    const result = await this.db.query<SpecRow>(
      `SELECT id, project_id, slug, title, state, current_version, created_at, updated_at
       FROM wfos_specifications WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapSpec(result.rows[0]!);
  }

  async findByProjectAndSlug(projectId: string, slug: string): Promise<Specification | null> {
    const result = await this.db.query<SpecRow>(
      `SELECT id, project_id, slug, title, state, current_version, created_at, updated_at
       FROM wfos_specifications WHERE project_id = $1 AND slug = $2`,
      [projectId, slug],
    );
    if (result.rows.length === 0) return null;
    return mapSpec(result.rows[0]!);
  }

  async update(id: string, input: UpdateSpecificationInput): Promise<Specification | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    let pIdx = 2;
    if (input.title !== undefined) {
      sets.push(`title = $${pIdx++}`);
      params.push(input.title);
    }
    if (sets.length === 0) return this.findById(id);
    const result = await this.db.query<SpecRow>(
      `UPDATE wfos_specifications SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, project_id, slug, title, state, current_version, created_at, updated_at`,
      params,
    );
    if (result.rows.length === 0) return null;
    return mapSpec(result.rows[0]!);
  }

  async transitionState(
    id: string,
    to: SpecificationState,
  ): Promise<SpecificationLifecycleTransition> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query<SpecRow>(
        'SELECT id, state FROM wfos_specifications WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (current.rows.length === 0) {
        throw new Error(`specification not found: ${id}`);
      }
      const from = current.rows[0]!.state as SpecificationState;
      // Validate the transition (SPEC-AC-02). Legal transitions:
      //   draft → published
      //   published → archived
      //   archived → draft (revive)
      // Same-state is a no-op.
      if (from !== to) {
        const legal: Record<string, SpecificationState[]> = {
          draft: ['published'],
          published: ['archived', 'draft'],
          archived: ['draft'],
        };
        if (!legal[from]?.includes(to)) {
          throw new Error(`invalid specification lifecycle transition: ${from} → ${to}`);
        }
      }
      await tx.query(
        'UPDATE wfos_specifications SET state = $1 WHERE id = $2',
        [to, id],
      );
      return { specificationId: id, from, to };
    });
  }

  async listForProject(projectId: string): Promise<Specification[]> {
    const result = await this.db.query<SpecRow>(
      `SELECT id, project_id, slug, title, state, current_version, created_at, updated_at
       FROM wfos_specifications WHERE project_id = $1 ORDER BY created_at`,
      [projectId],
    );
    return result.rows.map(mapSpec);
  }
}

/**
 * PostgreSQL-backed {@link SpecificationVersionRepository} (SPEC-AC-03).
 */
export class PgSpecificationVersionRepository implements SpecificationVersionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateSpecificationVersionInput): Promise<SpecificationVersion> {
    return this.db.transaction(async (tx) => {
      // Atomically increment the current_version and insert the new version row.
      const spec = await tx.query<{ current_version: number }>(
        'SELECT current_version FROM wfos_specifications WHERE id = $1 FOR UPDATE',
        [input.specificationId],
      );
      if (spec.rows.length === 0) {
        throw new Error(`specification not found: ${input.specificationId}`);
      }
      const nextVersion = spec.rows[0]!.current_version + 1;
      const result = await tx.query<SpecVersionRow>(
        `INSERT INTO wfos_specification_versions
           (specification_id, version_number, storage_key, storage_provider,
            content_inline, content_length, content_type, digest_sha256, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, specification_id, version_number, storage_key, storage_provider,
                   content_inline, content_length, content_type, digest_sha256, created_by, created_at`,
        [
          input.specificationId,
          nextVersion,
          input.storageKey ?? null,
          input.storageProvider ?? null,
          input.contentInline ?? null,
          input.contentLength,
          input.contentType ?? null,
          input.digestSha256 ?? null,
          input.createdBy ?? null,
        ],
      );
      await tx.query(
        'UPDATE wfos_specifications SET current_version = $1 WHERE id = $2',
        [nextVersion, input.specificationId],
      );
      return mapVersion(result.rows[0]!);
    });
  }

  async findLatest(specificationId: string): Promise<SpecificationVersion | null> {
    const result = await this.db.query<SpecVersionRow>(
      `SELECT id, specification_id, version_number, storage_key, storage_provider,
              content_inline, content_length, content_type, digest_sha256, created_by, created_at
       FROM wfos_specification_versions
       WHERE specification_id = $1
       ORDER BY version_number DESC LIMIT 1`,
      [specificationId],
    );
    if (result.rows.length === 0) return null;
    return mapVersion(result.rows[0]!);
  }

  async findBySpecAndVersion(
    specificationId: string,
    versionNumber: number,
  ): Promise<SpecificationVersion | null> {
    const result = await this.db.query<SpecVersionRow>(
      `SELECT id, specification_id, version_number, storage_key, storage_provider,
              content_inline, content_length, content_type, digest_sha256, created_by, created_at
       FROM wfos_specification_versions
       WHERE specification_id = $1 AND version_number = $2`,
      [specificationId, versionNumber],
    );
    if (result.rows.length === 0) return null;
    return mapVersion(result.rows[0]!);
  }

  async listForSpecification(specificationId: string): Promise<SpecificationVersion[]> {
    const result = await this.db.query<SpecVersionRow>(
      `SELECT id, specification_id, version_number, storage_key, storage_provider,
              content_inline, content_length, content_type, digest_sha256, created_by, created_at
       FROM wfos_specification_versions
       WHERE specification_id = $1
       ORDER BY version_number ASC`,
      [specificationId],
    );
    return result.rows.map(mapVersion);
  }
}

interface SpecRow {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  state: string;
  current_version: number;
  created_at: Date;
  updated_at: Date;
}
interface SpecVersionRow {
  id: string;
  specification_id: string;
  version_number: number;
  storage_key: string | null;
  storage_provider: string | null;
  content_inline: string | null;
  content_length: string;
  content_type: string | null;
  digest_sha256: string | null;
  created_by: string | null;
  created_at: Date;
}

function mapSpec(row: SpecRow): Specification {
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    title: row.title,
    state: row.state as SpecificationState,
    currentVersion: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: SpecVersionRow): SpecificationVersion {
  return {
    id: row.id,
    specificationId: row.specification_id,
    versionNumber: row.version_number,
    storageKey: row.storage_key,
    storageProvider: row.storage_provider,
    contentInline: row.content_inline,
    contentLength: Number(row.content_length),
    contentType: row.content_type,
    digestSha256: row.digest_sha256,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
