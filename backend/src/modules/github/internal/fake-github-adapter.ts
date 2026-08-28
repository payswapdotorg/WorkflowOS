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
 *   - `getFileContent({ owner, repository, ref, path })` → the content set
 *     via `setFile(owner, repository, ref, path, content)` (sha256 digest);
 *     `null` when no file was set for that exact key (the path "does not
 *     exist at that revision"). Deterministic given the setup.
 *   - `listDir({ owner, repository, ref, path })` → the entries set via
 *     `setDir(owner, repository, ref, path, entries)`; `[]` when no dir was
 *     set for that exact key. Deterministic given the setup.
 *   - `health()` → `'test-mode'`.
 *
 * No `Math.random`, no `Date.now` — fully deterministic (stateful content
 * storage is deterministic given the same setup). This file is private to
 * /github (PLAT-AC-02).
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
  FindPullRequestByHeadInput,
  FindPullRequestByHeadResult,
  GetBranchInput,
  GetBranchResult,
  GetFileContentInput,
  GetFileContentResult,
  ListDirInput,
  ListDirResult,
  RepoDirEntry,
} from './project-github-repository.types.js';
import { createHash } from 'node:crypto';

/**
 * Pads a string's first 8 characters with trailing '0' to exactly 8 chars.
 * Used to derive deterministic 8-hex SHAs from arbitrary input names.
 */
function sha8(input: string): string {
  return input.slice(0, 8).padEnd(8, '0');
}

export class FakeGitHubAdapter implements GitHubAdapter {
  readonly name = 'github-fake';

  // --- WORK-038: in-memory content tree for content-read tests ---
  //
  // Keyed by `${owner}/${repository}/${ref}/${path}` so the same (owner, repo,
  // ref, path) tuple deterministically yields the same content/entries across
  // calls. Setters are used by tests that exercise the production
  // RepositoryContentPort wiring end-to-end (the port delegates to the
  // GitHubAdapter; the fake provides the deterministic content the port
  // reads through). No Math.random / Date.now — fully deterministic given
  // the setup.
  private files = new Map<string, string>();
  private dirs = new Map<string, RepoDirEntry[]>();

  // --- WORK-051 round 2 (PR #52 review, BLOCKER 2): the open-PR registry ---
  //
  // Mirrors GitHub's own identity semantics: at most ONE OPEN pull request
  // per (owner, repository, head) triple. A second createPullRequest for the
  // same head while its PR is open FAILS exactly like GitHub's HTTP 422
  // ("A pull request already exists for...") — the fake never silently opens
  // a duplicate. This is what makes the crash/retry convergence regressions
  // honest: a converged retry cannot accidentally mint a second PR.
  private openPullRequests = new Map<string, {
    owner: string;
    repository: string;
    number: number;
    head: string;
    headSha: string;
  }>();
  private nextPrNumber = 1;

  /**
   * PR #52 round 4 (review, BLOCKER 3) — the BRANCH-HEAD registry: models a
   * pushed branch pointing at an exact commit (what the WORK-026 governed
   * branch provisioning does in production). `createPullRequest` reports the
   * REGISTERED head SHA for the branch — mirroring GitHub, where a created
   * PR's head is whatever commit the branch actually points at — so the
   * production port's authoritative-head-SHA validation exercises real
   * semantics (match ⇒ converge; mismatch ⇒ typed fail-closed).
   */
  private readonly branchHeads = new Map<string, string>();

  /**
   * PR #52 round 4: register a branch's head commit (a pushed branch). Tests
   * seed the GOVERNED branch (governedHeadBranch(workItemId, headRevision))
   * at the exact gated revision before driving the governed create path.
   */
  setBranchHead(owner: string, repository: string, branch: string, sha: string): this {
    this.branchHeads.set(`${owner}/${repository}/${branch}`, sha);
    return this;
  }

  /**
   * WORK-051 round 3 (PR #52 review, BLOCKER 3): when set, an unregistered
   * PR number resolves to an HONEST null (a 404 at the authority) instead of
   * the legacy synthetic info — the adoption fail-closed regressions use
   * this to prove an unresolvable observation can never enter the checkpoint.
   */
  strictPullRequestLookup = false;

  /**
   * WORK-051 round 3: seed an EXTERNAL pull request (a PR opened by a human
   * or an out-of-band tool — NOT the governed boundary). The adoption
   * resolution path reads its authoritative identity (number, head SHA,
   * state) through getPullRequestInfo.
   */
  seedExternalPullRequest(input: {
    owner: string;
    repository: string;
    number: number;
    head: string;
    headSha: string;
    state?: 'open' | 'closed';
    merged?: boolean;
  }): this {
    this.externalPullRequests.push({ ...input, state: input.state ?? 'open', merged: input.merged ?? false });
    return this;
  }
  private readonly externalPullRequests: Array<{
    owner: string;
    repository: string;
    number: number;
    head: string;
    headSha: string;
    state: 'open' | 'closed';
    merged: boolean;
  }> = [];

  /** Operation counters (provider-side counting for the governed PR-creation regressions). */
  readonly createPullRequestCalls: string[] = [];
  readonly findPullRequestByHeadCalls: string[] = [];

  /** sha256 hex of text (reproducibility — matches the production digest). */
  private static digest(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }

  /** Compose the content-tree key for a (owner, repo, ref, path) tuple. */
  private static contentKey(owner: string, repository: string, ref: string, path: string): string {
    return `${owner}/${repository}/${ref}/${path}`;
  }

  /**
   * Set a file's content at a precise (owner, repo, ref, path) tuple. The
   * content-read surfaces (`getFileContent`) return this content (sha256
   * digest) until cleared. Used by tests that exercise the production
   * RepositoryContentPort wiring against the fake adapter.
   */
  setFile(owner: string, repository: string, ref: string, path: string, content: string): this {
    this.files.set(FakeGitHubAdapter.contentKey(owner, repository, ref, path), content);
    return this;
  }

  /**
   * Set a directory's entries at a precise (owner, repo, ref, path) tuple.
   * The listDir surface returns these entries until cleared.
   */
  setDir(owner: string, repository: string, ref: string, path: string, entries: RepoDirEntry[]): this {
    this.dirs.set(FakeGitHubAdapter.contentKey(owner, repository, ref, path), entries);
    return this;
  }

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
  ): Promise<GitHubPullRequestInfo | null> {
    // WORK-051 round 3 (PR #52 review, BLOCKER 3): the two PR registries are
    // AUTHORITATIVE when they hold the PR — the adoption path resolves REAL
    // registered PRs to their authoritative identity (number, head SHA,
    // state, merged) through this read. Unregistered numbers keep the legacy
    // synthetic behavior (backward compatibility for the pre-existing
    // suites) unless strictPullRequestLookup is set (the adoption
    // fail-closed regressions need an honest 404 → null).
    const external = this.externalPullRequests.find(
      (pr) => pr.owner === owner && pr.repository === repo && pr.number === prNumber,
    );
    if (external) {
      return {
        prNumber,
        title: `Fake PR #${prNumber} for ${owner}/${repo}`,
        state: external.state,
        branch: external.head,
        baseBranch: 'main',
        headCommit: external.headSha,
        merged: external.merged,
      };
    }
    for (const pr of this.openPullRequests.values()) {
      if (pr.owner === owner && pr.repository === repo && pr.number === prNumber) {
        return {
          prNumber,
          title: `Fake PR #${prNumber} for ${owner}/${repo}`,
          state: 'open',
          branch: pr.head,
          baseBranch: 'main',
          headCommit: pr.headSha,
          merged: false,
        };
      }
    }
    if (this.strictPullRequestLookup) return null;
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
    this.createPullRequestCalls.push(input.head);
    const key = `${input.owner}/${input.repository}/${input.head}`;
    if (this.openPullRequests.has(key)) {
      // GitHub's real semantics (HTTP 422): at most one OPEN PR per
      // (head, base). A governed-path duplicate create is a BUG — the
      // convergence protocol must find + adopt the existing PR instead.
      throw new Error(
        `github-fake: a pull request already exists for head '${input.head}' ` +
          `in ${input.owner}/${input.repository} (GitHub rejects duplicate open PRs for the same head)`,
      );
    }
    const number = this.nextPrNumber++;
    // Round 4 (BLOCKER 3): the created PR's head SHA is the commit the
    // branch POINTS AT (the registered branch head) — falling back to the
    // legacy deterministic SHA for unregistered branches (backward
    // compatibility with the pre-round-4 suites).
    const headSha = this.branchHeads.get(`${input.owner}/${input.repository}/${input.head}`)
      ?? `fakesha${sha8(input.head)}`;
    this.openPullRequests.set(key, {
      owner: input.owner,
      repository: input.repository,
      number,
      head: input.head,
      headSha,
    });
    return {
      owner: input.owner,
      repository: input.repository,
      number,
      url: `https://github.com/${input.owner}/${input.repository}/pull/${number}`,
      headSha,
    };
  }

  async findPullRequestByHead(
    input: FindPullRequestByHeadInput,
  ): Promise<FindPullRequestByHeadResult | null> {
    this.findPullRequestByHeadCalls.push(input.head);
    const found = this.openPullRequests.get(
      `${input.owner}/${input.repository}/${input.head}`,
    );
    if (!found) return null;
    return {
      owner: found.owner,
      repository: found.repository,
      number: found.number,
      headSha: found.headSha,
      state: 'open',
    };
  }

  async getBranch(input: GetBranchInput): Promise<GetBranchResult> {
    const baseSha = `fakesha${sha8(input.branchName)}`;
    // WORK-039: when the SHA nonce is bumped (via advanceSha), prepend the
    // nonce so subsequent getBranch calls return a DIFFERENT SHA (for the
    // stale-detection + distinct-revisions tests). When nonce=0 (the default),
    // the SHA is unchanged (backward compatible with every WORK-038 test).
    const sha = this.shaNonce > 0 ? `${baseSha}-nonce${this.shaNonce}` : baseSha;
    return {
      owner: input.owner,
      repository: input.repository,
      branchName: input.branchName,
      sha,
      isDefault: input.branchName === 'main',
    };
  }

  /**
   * WORK-039: bump the SHA nonce so subsequent getBranch calls return a
   * different SHA. Used by the repository-intelligence stale-detection +
   * distinct-revisions tests to simulate the repo HEAD advancing past the
   * baseline's pinned commit. Default nonce=0 (backward compatible — the
   * SHA matches the WORK-038 deterministic scheme).
   */
  private shaNonce = 0;
  advanceSha(): void {
    this.shaNonce += 1;
  }

  // --- WORK-038: repository content-read methods (in-memory content tree) ---

  async getFileContent(input: GetFileContentInput): Promise<GetFileContentResult | null> {
    const key = FakeGitHubAdapter.contentKey(
      input.owner,
      input.repository,
      input.ref,
      input.path,
    );
    const content = this.files.get(key);
    if (content === undefined) return null; // the path "does not exist at that revision"
    return {
      owner: input.owner,
      repository: input.repository,
      ref: input.ref,
      path: input.path,
      content,
      contentDigest: FakeGitHubAdapter.digest(content),
    };
  }

  async listDir(input: ListDirInput): Promise<ListDirResult> {
    const key = FakeGitHubAdapter.contentKey(
      input.owner,
      input.repository,
      input.ref,
      input.path,
    );
    const entries = this.dirs.get(key) ?? [];
    return {
      owner: input.owner,
      repository: input.repository,
      ref: input.ref,
      path: input.path,
      entries,
    };
  }

  async health(): Promise<'connected' | 'not-configured' | 'error' | 'test-mode'> {
    return 'test-mode';
  }
}
