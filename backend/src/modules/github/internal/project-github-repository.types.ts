/**
 * WORK-026: project ↔ GitHub repository provisioning link types.
 *
 * The /github module already owns the GitHub adapter contract
 * ({@link GitHubAdapter}) for webhook signature verification, repository
 * metadata reads, PR info, and PR merge. WORK-026 extends that surface with
 * repository provisioning capabilities (createRepository, createBranch,
 * createPullRequest, getBranch, health) so the autonomous implementation loop
 * can stand up a GitHub repository for a WorkflowOS project.
 *
 * This file holds the project↔GitHub repo PROVISIONING link types:
 *   - {@link ProjectGitHubRepository} — the persisted link row
 *     (migration 0018: `wfos_project_github_repositories`).
 *   - {@link ProjectGitHubRepositoryRepository} — persistence interface for
 *     that row.
 *   - The write-operation input/result DTOs ({@link CreateRepositoryInput},
 *     {@link CreateRepositoryResult}, {@link CreateBranchInput}, ...,
 *     {@link GetBranchResult}) used by the new GitHubAdapter methods.
 *
 * The GitHubAdapter interface itself is EXTENDED (not duplicated) in
 * `./github.types.ts` with the five new methods whose signatures reference the
 * DTOs defined here. See the EXTENSION comment at the bottom of this file.
 *
 * This file is private to /github (PLAT-AC-02).
 */

// --- Persisted project ↔ GitHub repository link ---

/**
 * A persisted link between a WorkflowOS project and a GitHub repository.
 *
 * One row per (project_id, installation_id, owner, repository) — see migration
 * 0018 (UNIQUE constraint). `linkType='created'` indicates the repo was
 * provisioned by WorkflowOS; `linkType='linked'` indicates an existing repo was
 * attached by the user.
 */
export interface ProjectGitHubRepository {
  readonly id: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly owner: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly linkType: 'created' | 'linked';
  readonly externalRepoId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly linkedAt: Date;
  readonly createdAt: Date;
}

/**
 * Persistence interface for {@link ProjectGitHubRepository} rows
 * (table: `wfos_project_github_repositories`, migration 0018).
 */
export interface ProjectGitHubRepositoryRepository {
  /**
   * Create a project↔GitHub repo link row. Idempotent on the UNIQUE
   * (project_id, installation_id, owner, repository) constraint: re-creating
   * the same link returns the existing row.
   */
  create(input: {
    projectId: string;
    installationId: string;
    owner: string;
    repository: string;
    defaultBranch?: string;
    linkType?: 'created' | 'linked';
    externalRepoId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ProjectGitHubRepository>;

  /** Find the (first) GitHub repo link for a project. Returns null if none. */
  findByProject(projectId: string): Promise<ProjectGitHubRepository | null>;

  /** Find a specific (project, owner, repository) link. Returns null if none. */
  findByProjectAndRepo(
    projectId: string,
    owner: string,
    repository: string,
  ): Promise<ProjectGitHubRepository | null>;

  /** Find a link by its primary key. Returns null if not found. */
  findById(id: string): Promise<ProjectGitHubRepository | null>;

  /** Remove a link by its primary key. No-op if the row does not exist. */
  remove(id: string): Promise<void>;
}

// --- GitHubAdapter write-operation DTOs (referenced by github.types.ts) ---

/** Input for {@link GitHubAdapter.createRepository}. */
export interface CreateRepositoryInput {
  /** GitHub org or user the repo will be created under. */
  owner: string;
  /** Repository name. */
  repository: string;
  visibility: 'public' | 'private';
  description?: string;
  installationId: string;
  /** Defaults to 'main' when omitted. */
  defaultBranch?: string;
}

/** Result of {@link GitHubAdapter.createRepository}. */
export interface CreateRepositoryResult {
  owner: string;
  repository: string;
  /** Canonical GitHub URL: `https://github.com/<owner>/<repository>`. */
  url: string;
  defaultBranch: string;
  installationId: string;
  /** GitHub's numeric repository id, when available. */
  externalRepoId?: string;
}

/** Input for {@link GitHubAdapter.createBranch}. */
export interface CreateBranchInput {
  owner: string;
  repository: string;
  branchName: string;
  /** Source SHA; defaults to the default branch HEAD when omitted. */
  fromSha?: string;
  installationId: string;
}

/** Result of {@link GitHubAdapter.createBranch}. */
export interface CreateBranchResult {
  owner: string;
  repository: string;
  branchName: string;
  /** SHA of the new branch HEAD. */
  sha: string;
}

/** Input for {@link GitHubAdapter.createPullRequest}. */
export interface CreatePullRequestInput {
  owner: string;
  repository: string;
  title: string;
  /** Source branch name. */
  head: string;
  /** Target branch name. */
  base: string;
  body?: string;
  installationId: string;
}

/** Result of {@link GitHubAdapter.createPullRequest}. */
export interface CreatePullRequestResult {
  owner: string;
  repository: string;
  /** PR number assigned by GitHub. */
  number: number;
  /** Canonical GitHub PR URL. */
  url: string;
  /** SHA of the PR head commit. */
  headSha: string;
}

/** Input for {@link GitHubAdapter.getBranch}. */
export interface GetBranchInput {
  owner: string;
  repository: string;
  branchName: string;
  installationId: string;
}

/** Result of {@link GitHubAdapter.getBranch}. */
export interface GetBranchResult {
  owner: string;
  repository: string;
  branchName: string;
  /** Current HEAD SHA of the branch. */
  sha: string;
  /** Whether this branch is the repository's default branch. */
  isDefault: boolean;
}

// --- WORK-038: repository content-read DTOs (existing-project onboarding) ---
//
// WORK-038 (Existing Project Onboarding) needs to read repository file
// content at a PRECISE revision (the baseline commit SHA resolved through
// getBranch) to produce evidence-backed OBSERVED observations. The /github
// authority is the natural home for content-read: it already owns the
// GitHubAdapter contract (the ONLY place that talks to the GitHub API).
// The onboarding domain holds no GitHub credentials and no GitHub SDK — it
// consumes this contract through the /github barrel, then wraps it in a
// thin production RepositoryContentPort (src/onboarding/internal/
// github-content-port.ts).
//
// `ref` accepts a real Git commit SHA (the onboarding invariant — the
// baseline is pinned to an immutable SHA) OR a branch/tag name (for
// ad-hoc reads outside onboarding; the onboarding path always passes the
// resolved SHA). The GitHub getContent API accepts both forms.

/** Input for {@link GitHubAdapter.getFileContent}. */
export interface GetFileContentInput {
  owner: string;
  repository: string;
  /**
   * The precise revision to read at. The onboarding path always passes the
   * immutable baseline commit SHA (resolved through getBranch); a branch
   * name is accepted for ad-hoc reads but is NOT used for baseline identity.
   */
  ref: string;
  /** The repository-relative path of the file to read. */
  path: string;
  installationId: string;
}

/** Result of {@link GitHubAdapter.getFileContent}. */
export interface GetFileContentResult {
  owner: string;
  repository: string;
  ref: string;
  path: string;
  /** The file's text content at the revision. */
  content: string;
  /** sha256 of the content (reproducibility — same content, same digest). */
  contentDigest: string;
}

/** A directory entry at a revision. */
export interface RepoDirEntry {
  readonly name: string;
  readonly type: 'file' | 'dir';
}

/** Input for {@link GitHubAdapter.listDir}. */
export interface ListDirInput {
  owner: string;
  repository: string;
  /** The precise revision (SHA or branch/tag; onboarding passes the SHA). */
  ref: string;
  /** The repository-relative path of the directory to list. */
  path: string;
  installationId: string;
}

/** Result of {@link GitHubAdapter.listDir}. */
export interface ListDirResult {
  owner: string;
  repository: string;
  ref: string;
  path: string;
  /** The directory entries (empty when the directory does not exist). */
  entries: readonly RepoDirEntry[];
}

// --- GitHubAdapter extension (implemented in ./github.types.ts) ---
//
// EXTEND GitHubAdapter with these new methods (the GitHubAdapter interface
// lives in ./github.types.ts; the new methods are added there and reference
// the DTOs defined above):
//
//   createRepository(input: CreateRepositoryInput): Promise<CreateRepositoryResult>;
//   createBranch(input: CreateBranchInput): Promise<CreateBranchResult>;
//   createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult>;
//   getBranch(input: GetBranchInput): Promise<GetBranchResult>;
//   getFileContent(input: GetFileContentInput): Promise<GetFileContentResult | null>;
//   listDir(input: ListDirInput): Promise<ListDirResult>;
//   health(): Promise<'connected' | 'not-configured' | 'error' | 'test-mode'>;
