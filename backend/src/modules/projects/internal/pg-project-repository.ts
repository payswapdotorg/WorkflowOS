import type { DatabaseClient } from '@platform/index.js';
import type {
  Project,
  ProjectRepository,
  ProjectAccess,
  ProjectAccessRepository,
  CreateProjectInput,
  UpdateProjectInput,
  ProjectState,
  ProjectLifecycleTransition,
  ProjectRepositoryAssociation,
  ProjectRepositoryAssociationRepository,
  AssociateRepositoryInput,
  GrantProjectAccessInput,
} from './project.types.js';

/**
 * PostgreSQL-backed {@link ProjectRepository}. Evolved from the WORK-002
 * minimal repository to include lifecycle state transitions + metadata.
 */
export class PgProjectRepository implements ProjectRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateProjectInput): Promise<Project> {
    const result = await this.db.query<ProjectRow>(
      `INSERT INTO wfos_projects (organization_id, name, state, metadata)
       VALUES ($1, $2, 'active', $3)
       RETURNING id, organization_id, name, state, metadata, created_at, updated_at`,
      [input.organizationId, input.name, JSON.stringify(input.metadata ?? {})],
    );
    return mapProject(result.rows[0]!);
  }

  async findById(id: string): Promise<Project | null> {
    const result = await this.db.query<ProjectRow>(
      `SELECT id, organization_id, name, state, metadata, created_at, updated_at
       FROM wfos_projects WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapProject(result.rows[0]!);
  }

  async update(id: string, input: UpdateProjectInput): Promise<Project | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    let pIdx = 2;
    if (input.name !== undefined) {
      sets.push(`name = $${pIdx++}`);
      params.push(input.name);
    }
    if (input.metadata !== undefined) {
      sets.push(`metadata = $${pIdx++}`);
      params.push(JSON.stringify(input.metadata));
    }
    if (sets.length === 0) {
      return this.findById(id);
    }
    const result = await this.db.query<ProjectRow>(
      `UPDATE wfos_projects SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, organization_id, name, state, metadata, created_at, updated_at`,
      params,
    );
    if (result.rows.length === 0) return null;
    return mapProject(result.rows[0]!);
  }

  async transitionState(
    id: string,
    to: ProjectState,
  ): Promise<ProjectLifecycleTransition> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query<ProjectRow>(
        'SELECT id, state FROM wfos_projects WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (current.rows.length === 0) {
        throw new Error(`project not found: ${id}`);
      }
      const from = current.rows[0]!.state as ProjectState;
      // Validate the transition (PROJ-AC-03). Minimal legal transitions:
      //   active → archived
      //   archived → active
      // Same-state is a no-op (still returns the transition).
      if (from !== to) {
        const legal: Record<string, ProjectState[]> = {
          active: ['archived'],
          archived: ['active'],
        };
        if (!legal[from]?.includes(to)) {
          throw new Error(`invalid project lifecycle transition: ${from} → ${to}`);
        }
      }
      await tx.query(
        'UPDATE wfos_projects SET state = $1 WHERE id = $2',
        [to, id],
      );
      return { projectId: id, from, to };
    });
  }

  async listForOrganization(organizationId: string): Promise<Project[]> {
    const result = await this.db.query<ProjectRow>(
      `SELECT id, organization_id, name, state, metadata, created_at, updated_at
       FROM wfos_projects WHERE organization_id = $1 ORDER BY created_at`,
      [organizationId],
    );
    return result.rows.map(mapProject);
  }
}

/**
 * PostgreSQL-backed {@link ProjectAccessRepository}. Preserved from WORK-002.
 */
export class PgProjectAccessRepository implements ProjectAccessRepository {
  constructor(private readonly db: DatabaseClient) {}

  async grant(input: GrantProjectAccessInput): Promise<ProjectAccess> {
    const result = await this.db.query<ProjectAccessRow>(
      `INSERT INTO wfos_project_access (user_id, project_id, role_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, project_id) DO UPDATE
         SET role_id = EXCLUDED.role_id
       RETURNING id, user_id, project_id, role_id, created_at`,
      [input.userId, input.projectId, input.roleId],
    );
    return mapAccess(result.rows[0]!);
  }

  async findByUserAndProject(userId: string, projectId: string): Promise<ProjectAccess | null> {
    const result = await this.db.query<ProjectAccessRow>(
      'SELECT id, user_id, project_id, role_id, created_at FROM wfos_project_access WHERE user_id = $1 AND project_id = $2',
      [userId, projectId],
    );
    if (result.rows.length === 0) return null;
    return mapAccess(result.rows[0]!);
  }

  async listForUser(userId: string): Promise<ProjectAccess[]> {
    const result = await this.db.query<ProjectAccessRow>(
      'SELECT id, user_id, project_id, role_id, created_at FROM wfos_project_access WHERE user_id = $1',
      [userId],
    );
    return result.rows.map(mapAccess);
  }
}

/**
 * PostgreSQL-backed {@link ProjectRepositoryAssociationRepository} (PROJ-AC-02).
 * Stores provider-independent repository references; the actual GitHub adapter
 * is WORK-008.
 */
export class PgProjectRepositoryAssociationRepository
  implements ProjectRepositoryAssociationRepository
{
  constructor(private readonly db: DatabaseClient) {}

  async associate(input: AssociateRepositoryInput): Promise<ProjectRepositoryAssociation> {
    const result = await this.db.query<AssociationRow>(
      `INSERT INTO wfos_project_repositories (project_id, provider, external_id, canonical_ref, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, provider, external_id) DO UPDATE
         SET canonical_ref = EXCLUDED.canonical_ref,
             metadata = EXCLUDED.metadata
       RETURNING id, project_id, provider, external_id, canonical_ref, metadata, created_at`,
      [
        input.projectId,
        input.provider,
        input.externalId,
        input.canonicalRef,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapAssociation(result.rows[0]!);
  }

  async listForProject(projectId: string): Promise<ProjectRepositoryAssociation[]> {
    const result = await this.db.query<AssociationRow>(
      `SELECT id, project_id, provider, external_id, canonical_ref, metadata, created_at
       FROM wfos_project_repositories WHERE project_id = $1 ORDER BY created_at`,
      [projectId],
    );
    return result.rows.map(mapAssociation);
  }

  async findById(id: string): Promise<ProjectRepositoryAssociation | null> {
    const result = await this.db.query<AssociationRow>(
      `SELECT id, project_id, provider, external_id, canonical_ref, metadata, created_at
       FROM wfos_project_repositories WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapAssociation(result.rows[0]!);
  }

  async remove(id: string): Promise<void> {
    await this.db.query('DELETE FROM wfos_project_repositories WHERE id = $1', [id]);
  }
}

interface ProjectRow {
  id: string;
  organization_id: string;
  name: string;
  state: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}
interface ProjectAccessRow {
  id: string;
  user_id: string;
  project_id: string;
  role_id: string;
  created_at: Date;
}
interface AssociationRow {
  id: string;
  project_id: string;
  provider: string;
  external_id: string;
  canonical_ref: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    state: row.state as ProjectState,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAccess(row: ProjectAccessRow): ProjectAccess {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    roleId: row.role_id,
    createdAt: row.created_at,
  };
}

function mapAssociation(row: AssociationRow): ProjectRepositoryAssociation {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    externalId: row.external_id,
    canonicalRef: row.canonical_ref,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}
