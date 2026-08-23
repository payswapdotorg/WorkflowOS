/**
 * WORK-026: PostgreSQL persistence for the project↔GitHub repository
 * provisioning link (table `wfos_project_github_repositories`, migration 0018).
 *
 * Implements {@link ProjectGitHubRepositoryRepository} against a
 * {@link DatabaseClient}. Mirrors the existing {@link PgGitHubInstallationRepository}
 * pattern (constant column list, idempotent INSERT ... ON CONFLICT, row mapper).
 *
 * This file is private to /github (PLAT-AC-02). Cross-module imports are
 * forbidden; callers consume the {@link ProjectGitHubRepositoryRepository}
 * interface exposed by the public barrel.
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  ProjectGitHubRepository,
  ProjectGitHubRepositoryRepository,
} from './project-github-repository.types.js';

interface ProjectGitHubRepositoryRow {
  id: string;
  project_id: string;
  installation_id: string;
  owner: string;
  repository: string;
  default_branch: string;
  link_type: 'created' | 'linked';
  external_repo_id: string | null;
  metadata: Record<string, unknown>;
  linked_at: Date;
  created_at: Date;
}

const LINK_COLUMNS =
  'id, project_id, installation_id, owner, repository, ' +
  'default_branch, link_type, external_repo_id, metadata, linked_at, created_at';

function mapLink(row: ProjectGitHubRepositoryRow): ProjectGitHubRepository {
  return {
    id: row.id,
    projectId: row.project_id,
    installationId: row.installation_id,
    owner: row.owner,
    repository: row.repository,
    defaultBranch: row.default_branch,
    linkType: row.link_type,
    externalRepoId: row.external_repo_id,
    metadata: row.metadata ?? {},
    linkedAt: row.linked_at,
    createdAt: row.created_at,
  };
}

export class PgProjectGitHubRepositoryRepository
  implements ProjectGitHubRepositoryRepository
{
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    projectId: string;
    installationId: string;
    owner: string;
    repository: string;
    defaultBranch?: string;
    linkType?: 'created' | 'linked';
    externalRepoId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ProjectGitHubRepository> {
    // ON CONFLICT (project_id, installation_id, owner, repository) DO UPDATE
    // makes this idempotent: re-linking the same (project, installation, repo)
    // returns the existing row with refreshed default_branch / external_repo_id
    // / metadata. Matches the existing PgGitHubInstallationRepository pattern.
    const result = await this.db.query<ProjectGitHubRepositoryRow>(
      `INSERT INTO wfos_project_github_repositories
         (project_id, installation_id, owner, repository,
          default_branch, link_type, external_repo_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (project_id, installation_id, owner, repository) DO UPDATE
         SET default_branch  = EXCLUDED.default_branch,
             link_type       = EXCLUDED.link_type,
             external_repo_id = EXCLUDED.external_repo_id,
             metadata        = EXCLUDED.metadata,
             linked_at       = NOW()
       RETURNING ${LINK_COLUMNS}`,
      [
        input.projectId,
        input.installationId,
        input.owner,
        input.repository,
        input.defaultBranch ?? 'main',
        input.linkType ?? 'linked',
        input.externalRepoId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapLink(result.rows[0]!);
  }

  async findByProject(projectId: string): Promise<ProjectGitHubRepository | null> {
    // The (project_id) index (idx_project_github_repositories_project) backs
    // this lookup. We order by linked_at ASC and take the first — there is no
    // UNIQUE(project_id) constraint, so we surface the earliest link.
    const result = await this.db.query<ProjectGitHubRepositoryRow>(
      `SELECT ${LINK_COLUMNS}
       FROM wfos_project_github_repositories
       WHERE project_id = $1
       ORDER BY linked_at ASC
       LIMIT 1`,
      [projectId],
    );
    if (result.rows.length === 0) return null;
    return mapLink(result.rows[0]!);
  }

  async findByProjectAndRepo(
    projectId: string,
    owner: string,
    repository: string,
  ): Promise<ProjectGitHubRepository | null> {
    const result = await this.db.query<ProjectGitHubRepositoryRow>(
      `SELECT ${LINK_COLUMNS}
       FROM wfos_project_github_repositories
       WHERE project_id = $1 AND owner = $2 AND repository = $3
       LIMIT 1`,
      [projectId, owner, repository],
    );
    if (result.rows.length === 0) return null;
    return mapLink(result.rows[0]!);
  }

  async findById(id: string): Promise<ProjectGitHubRepository | null> {
    const result = await this.db.query<ProjectGitHubRepositoryRow>(
      `SELECT ${LINK_COLUMNS}
       FROM wfos_project_github_repositories
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapLink(result.rows[0]!);
  }

  async remove(id: string): Promise<void> {
    await this.db.query(
      'DELETE FROM wfos_project_github_repositories WHERE id = $1',
      [id],
    );
  }
}
