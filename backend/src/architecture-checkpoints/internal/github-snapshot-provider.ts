/**
 * WORK-051 round 1 (PR #52 review, BLOCKER 1) — the production
 * RepositorySnapshotReader: EXACT-REVISION snapshots over the EXISTING
 * /github authority's content reads.
 *
 * Boundary: src/architecture-checkpoints/internal/ — application capability,
 * NOT a module, NOT a new source authority. The repository coordinates
 * (owner/name/installation) are resolved SERVER-SIDE from the project's
 * /github repository link (PgProjectGitHubRepositoryRepository.findByProject
 * — the existing authority row); the content itself comes from the existing
 * GitHubAdapter.getFileContent / listDir content-read contract (the same
 * exact-revision reads the WORK-038 onboarding path consumes). This file
 * holds NO credentials, NO GitHub SDK, and NO filesystem access — it is a
 * thin read-only delegation.
 *
 * Fail-closed semantics:
 * - no /github repository link for the project → openSnapshot returns null
 *   (the checkpoint treats repository-backed assertions as inconclusive);
 * - any adapter read failure surfaces as a typed SnapshotReadError (the
 *   detectors translate it to 'inconclusive', never a vacuous pass);
 * - a revision whose tree cannot be observed (empty root listing — e.g. an
 *   unresolvable ref) fails the walk's root-existence proof → inconclusive.
 *
 * Snapshots are LAZY: constructing one performs only the link resolution;
 * the per-path reads happen when detectors walk the tree. Every read is
 * pinned to `revision` — there is NO fallback to any working tree.
 */

import type {
  GitHubAdapter,
  ProjectGitHubRepositoryRepository,
} from '@modules/github/index.js';
import type {
  RepositorySnapshot,
  RepositorySnapshotReader,
  SnapshotDirEntry,
} from '../types.js';
import { SnapshotReadError } from '../types.js';

/** Normalize a repository-relative path: trim separators, drop './' segments. */
function normalizePath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (trimmed === '' || trimmed === '.') return '';
  return trimmed
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
}

/** The /github-backed exact-revision snapshot (read-only, lazy). */
export class GithubRepositorySnapshot implements RepositorySnapshot {
  readonly revision: string;
  readonly repository: string;

  constructor(
    private readonly adapter: GitHubAdapter,
    private readonly owner: string,
    repository: string,
    private readonly installationId: string,
    revision: string,
  ) {
    this.repository = repository;
    this.revision = revision;
  }

  async listDir(path: string): Promise<readonly SnapshotDirEntry[]> {
    const p = normalizePath(path);
    try {
      const result = await this.adapter.listDir({
        owner: this.owner,
        repository: this.repository,
        ref: this.revision,
        path: p,
        installationId: this.installationId,
      });
      return result.entries.map((e) => ({ name: e.name, type: e.type }));
    } catch (err) {
      throw new SnapshotReadError(
        'unreadable',
        `directory '${p || '/'}' could not be read at revision ${this.revision} of ${this.owner}/${this.repository}: ${(err as Error).message}`,
      );
    }
  }

  async readFile(path: string): Promise<string | null> {
    const p = normalizePath(path);
    if (p === '') return null;
    try {
      const result = await this.adapter.getFileContent({
        owner: this.owner,
        repository: this.repository,
        ref: this.revision,
        path: p,
        installationId: this.installationId,
      });
      return result === null ? null : result.content;
    } catch (err) {
      throw new SnapshotReadError(
        'unreadable',
        `file '${p}' could not be read at revision ${this.revision} of ${this.owner}/${this.repository}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Parent-chain-verified existence: walk each path component from the
   * repository root, confirming the next segment is present as a directory
   * in the current listing. A confirmed-absent component → false; a read
   * failure → SnapshotReadError (fail closed).
   */
  async dirExists(path: string): Promise<boolean> {
    const p = normalizePath(path);
    if (p === '') return true; // the repository root itself
    const components = p.split('/');
    let current = '';
    for (const component of components) {
      const entries = await this.listDir(current);
      const found = entries.find((e) => e.name === component && e.type === 'dir');
      if (!found) return false;
      current = current === '' ? component : `${current}/${component}`;
    }
    return true;
  }
}

/**
 * The production snapshot reader. Resolves the project's repository link
 * SERVER-SIDE and opens the exact-revision snapshot over the /github
 * adapter's content reads.
 */
export class GithubRepositorySnapshotProvider implements RepositorySnapshotReader {
  constructor(
    private readonly projectGitHubRepositoryRepository: ProjectGitHubRepositoryRepository,
    private readonly githubAdapter: GitHubAdapter,
  ) {}

  async openSnapshot(projectId: string, revision: string): Promise<RepositorySnapshot | null> {
    if (!revision) {
      throw new SnapshotReadError('unreadable', 'openSnapshot requires a non-empty revision');
    }
    // SERVER-SIDE repository resolution — the caller never supplies coordinates.
    const link = await this.projectGitHubRepositoryRepository.findByProject(projectId);
    if (!link) {
      // Fail closed: no linked repository ⇒ no revision-bound snapshot.
      return null;
    }
    return new GithubRepositorySnapshot(
      this.githubAdapter,
      link.owner,
      link.repository,
      link.installationId,
      revision,
    );
  }
}
