import type { DatabaseClient } from '@platform/index.js';
import type {
  Project,
  ProjectRepository,
  ProjectAccess,
  ProjectAccessRepository,
  CreateProjectInput,
  GrantProjectAccessInput,
} from './project.types.js';

/**
 * PostgreSQL-backed {@link ProjectRepository}. Minimal — only what WORK-002
 * needs for tenant-isolation demonstration. WORK-004 expands the project
 * domain (config, repositories, lifecycle).
 */
export class PgProjectRepository implements ProjectRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateProjectInput): Promise<Project> {
    const result = await this.db.query<ProjectRow>(
      'INSERT INTO wfos_projects (organization_id, name) VALUES ($1, $2) RETURNING id, organization_id, name, created_at',
      [input.organizationId, input.name],
    );
    return mapProject(result.rows[0]!);
  }

  async findById(id: string): Promise<Project | null> {
    const result = await this.db.query<ProjectRow>(
      'SELECT id, organization_id, name, created_at FROM wfos_projects WHERE id = $1',
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapProject(result.rows[0]!);
  }
}

/**
 * PostgreSQL-backed {@link ProjectAccessRepository}.
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

interface ProjectRow {
  id: string;
  organization_id: string;
  name: string;
  created_at: Date;
}
interface ProjectAccessRow {
  id: string;
  user_id: string;
  project_id: string;
  role_id: string;
  created_at: Date;
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    createdAt: row.created_at,
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
