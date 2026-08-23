/**
 * WORK-026: Deterministic fake GitHub adapter for tests/CI.
 *
 * Implements the FULL {@link GitHubAdapter} interface (the 4 existing methods
 * + the 5 new repository-provisioning methods added by WORK-026) without
 * making any network calls. Produces deterministic outputs so the autonomous
 * implementation loop can be exercised end-to-end in tests.
 *
 * The composition root wires this adapter in non-production roles (CI, dev,
 * tests). It MUST NOT be used in production roles — production always wires
 * {@link DefaultGitHubAdapter} (which throws until GitHub credentials are
 * wired, but exposes the same interface).
 *
 * Determinism contract:
 *   - `verifyWebhookSignature(...)` → `true` (permissive; tests don't compute
 *     HMAC signatures for the fake adapter).
 *   - `getRepositoryMetadata(owner, repo)` → synthetic metadata
 *     `{ externalId: '<owner>/<repo>', fullName: '<owner>/<repo>',
 *        canonicalRef: 'https://github.com/<owner>/<repo>',
 *        defaultBranch: 'main', metadata: { fake: true } }`.
 *   - `getPullRequestInfo(_, _, _, prNumber)` → synthetic open PR with
 *     `prNumber` echoed + head commit `fakesha00000000`.
 *   - `mergePullRequest({ prNumber })` → success result with merge commit SHA
 *     `fakemerge<prNumber padded to 8>` (deterministic).
 *   - `createRepository({ owner, repository, defaultBranch, installationId })`
 *     → `externalRepoId: 'fake-repo-<repository>'`, url
 *     `'https://github.com/<owner>/<repository>'`, defaultBranch defaults to
 *     'main'.
 *   - `createBranch({ branchName })` → `sha: 'fakesha' + branchName[0:8].padEnd(8,'0')`.
 *   - `createPullRequest({ head })` → `number: 1`, `headSha: 'fakesha' + head[0:8].padEnd(8,'0')`.
 *   - `getBranch({ branchName })` → same sha scheme as createBranch,
 *     `isDefault: branchName === 'main'`.
 *   - `health()` → `'test-mode'`.
 *
 * No `Math.random`, no `Date.now` — fully deterministic. This file is private
 * to /github (PLAT-AC-02).
 */
import type {
  GitHubAdapter,
  GitHubMergeResult,
  GitHubPullRequestInfo,
  GitHubRepositoryInfo,
} from './github.types.js';
import type {
  CreateBranchInput,
  CreateBranchResult,
  CreatePullRequestInput,
  CreatePullRequestResult,
  CreateRepositoryInput,
  CreateRepositoryResult,
  GetBranchInput,
  GetBranchResult,
} from './project-github-repository.types.js';

/**
 * Pads a string's first 8 characters with trailing '0' to exactly 8 chars.
 * Used to derive deterministic 8-hex SHAs from arbitrary input names.
 */
function sha8(input: string): string {
  return input.slice(0, 8).padEnd(8, '0');
}

export class FakeGitHubAdapter implements GitHubAdapter {
  readonly name = 'github-fake';

  // --- Existing GitHubAdapter methods (synthetic for tests) ---

  verifyWebhookSignature(
    _payload: string,
    _signature: string,
    _secret: string,
  ): boolean {
    // Permissive: tests using the fake adapter do not compute HMAC.
    return true;
  }

  async getRepositoryMetadata(
    _installationId: string,
    owner: string,
    repo: string,
  ): Promise<GitHubRepositoryInfo> {
    return {
      externalId: `${owner}/${repo}`,
      fullName: `${owner}/${repo}`,
      canonicalRef: `https://github.com/${owner}/${repo}`,
      defaultBranch: 'main',
      metadata: { fake: true },
    };
  }

  async getPullRequestInfo(
    _installationId: string,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GitHubPullRequestInfo> {
    return {
      prNumber,
      title: `Fake PR #${prNumber} for ${owner}/${repo}`,
      state: 'open',
      branch: 'fake-head',
      baseBranch: 'main',
      headCommit: 'fakesha00000000',
      merged: false,
    };
  }

  async mergePullRequest(input: {
    installationId: string;
    owner: string;
    repo: string;
    prNumber: number;
    commitMessage?: string;
  }): Promise<GitHubMergeResult> {
    void input.owner;
    void input.repo;
    return {
      merged: true,
      prNumber: input.prNumber,
      // Deterministic merge commit SHA derived from the PR number.
      mergeCommitSha: `fakemerge${String(input.prNumber).padStart(8, '0')}`,
      error: null,
    };
  }

  // --- WORK-026 new GitHubAdapter methods (repository provisioning) ---

  async createRepository(
    input: CreateRepositoryInput,
  ): Promise<CreateRepositoryResult> {
    const defaultBranch = input.defaultBranch ?? 'main';
    return {
      owner: input.owner,
      repository: input.repository,
      url: `https://github.com/${input.owner}/${input.repository}`,
      defaultBranch,
      installationId: input.installationId,
      externalRepoId: `fake-repo-${input.repository}`,
    };
  }

  async createBranch(input: CreateBranchInput): Promise<CreateBranchResult> {
    return {
      owner: input.owner,
      repository: input.repository,
      branchName: input.branchName,
      sha: `fakesha${sha8(input.branchName)}`,
    };
  }

  async createPullRequest(
    input: CreatePullRequestInput,
  ): Promise<CreatePullRequestResult> {
    return {
      owner: input.owner,
      repository: input.repository,
      number: 1,
      url: `https://github.com/${input.owner}/${input.repository}/pull/1`,
      headSha: `fakesha${sha8(input.head)}`,
    };
  }

  async getBranch(input: GetBranchInput): Promise<GetBranchResult> {
    return {
      owner: input.owner,
      repository: input.repository,
      branchName: input.branchName,
      sha: `fakesha${sha8(input.branchName)}`,
      isDefault: input.branchName === 'main',
    };
  }

  async health(): Promise<'connected' | 'not-configured' | 'error' | 'test-mode'> {
    return 'test-mode';
  }
}
