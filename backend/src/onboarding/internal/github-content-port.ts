/**
 * WORK-038: GitHubRepositoryContentPort — the PRODUCTION wiring of the
 * repository content-read boundary.
 *
 * The onboarding domain's {@link RepositoryContentPort} is the seam for
 * reading file content at a precise repository revision. The PR #42 review
 * identified that this seam had NO production implementation — the analyzer
 * was constructed in app.ts without a `contentPort`, so production
 * onboarding never inspected repository files (only metadata-derived
 * observations); tests injected an in-memory provider and so did not
 * exercise the production wiring.
 *
 * This file is the production wiring: a thin adapter that delegates to the
 * EXISTING /github authority's `GitHubAdapter.getFileContent` /
 * `GitHubAdapter.listDir`. The onboarding domain holds NO GitHub
 * credentials and NO GitHub SDK — it consumes the /github barrel (the
 * GitHubAdapter contract); the adapter is the only SDK caller. The
 * production GitHubAdapter throws `'github-not-configured'` until
 * GITHUB_APP_* credentials are wired (the same gate as the WORK-026
 * provisioning methods); the analyzer's per-candidate try/catch records
 * the failure as evidence and continues (the baseline completes with
 * metadata-only observations; the governed path is still consulted for
 * every candidate read). The FakeGitHubAdapter provides a deterministic
 * in-memory content tree for the integration suite that exercises this
 * wiring end-to-end.
 *
 * Boundary: src/onboarding/internal/ — application capability, NOT a module,
 * NOT an authority. No provider SDKs, no credentials, no DB access. Imports
 * only the /github barrel (the GitHubAdapter TYPE) — never /github internal/.
 */
import { createHash } from 'node:crypto';
import type { GitHubAdapter } from '@modules/github/index.js';
import type { RepositoryContentPort } from '../onboarding.types.js';

/**
 * The production RepositoryContentPort. Delegates file/dir reads at a
 * revision to the /github authority's GitHubAdapter. The `installationId`
 * is resolved by the orchestrator from the project's /github repository
 * link and carried in the AnalysisContext; the analyzer passes it through
 * to the port per-call (the port itself holds no credential state).
 */
export class GitHubRepositoryContentPort implements RepositoryContentPort {
  constructor(private readonly githubAdapter: GitHubAdapter) {}

  async readFile(
    owner: string,
    repository: string,
    commitSha: string,
    path: string,
    installationId: string,
  ): Promise<{ readonly content: string; readonly contentDigest: string } | null> {
    // The onboarding invariant: the baseline is pinned to an immutable commit
    // SHA (resolved through getBranch). We pass that SHA as the GitHubAdapter
    // `ref` (the GitHub getContent API accepts a SHA, branch, or tag — the
    // onboarding path always passes the resolved SHA, never a moving ref).
    const result = await this.githubAdapter.getFileContent({
      owner,
      repository,
      ref: commitSha,
      path,
      installationId,
    });
    if (!result) return null;
    // Defensive: the GitHubAdapter contract returns a digest; trust but
    // verify by re-computing when absent (a missing digest would otherwise
    // break the evidence-row reproducibility fingerprint).
    const contentDigest =
      result.contentDigest && result.contentDigest.length > 0
        ? result.contentDigest
        : createHash('sha256').update(result.content, 'utf8').digest('hex');
    return { content: result.content, contentDigest };
  }

  async listDir(
    owner: string,
    repository: string,
    commitSha: string,
    path: string,
    installationId: string,
  ): Promise<readonly { readonly name: string; readonly type: 'file' | 'dir' }[]> {
    const result = await this.githubAdapter.listDir({
      owner,
      repository,
      ref: commitSha,
      path,
      installationId,
    });
    return result.entries;
  }
}
