/**
 * GitHub integration domain types (GITHUB-001..003).
 *
 * The /github module owns GitHub-specific behavior: webhook signature
 * validation, durable event receipts, idempotent async processing, and
 * provider-independent repository/PR synchronization contracts.
 *
 * GitHub SDK/provider code stays inside /github internal/. Other modules
 * consume only the provider-independent interfaces (GitHubAdapter,
 * WebhookEventRepository, WebhookProcessingService).
 *
 * WORK-026 extends {@link GitHubAdapter} with repository provisioning methods
 * (createRepository / createBranch / createPullRequest / getBranch / health).
 * The input/result DTOs for those methods live in
 * `./project-github-repository.types.ts` and are imported below.
 */
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
} from './project-github-repository.types.js';

// --- Webhook event receipt ---

export type WebhookProcessingState = 'received' | 'processing' | 'processed' | 'failed';

export interface WebhookEvent {
  readonly id: string;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly repositoryFullName: string | null;
  readonly repositoryId: string | null;
  readonly signatureValid: boolean;
  readonly payload: string;
  readonly processingState: WebhookProcessingState;
  readonly errorMessage: string | null;
  readonly retryCount: number;
  readonly processedAt: Date | null;
  readonly receivedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WebhookEventRepository {
  /** Persist a webhook receipt. Idempotent on delivery_id (UNIQUE constraint). */
  createReceipt(input: {
    deliveryId: string;
    eventType: string;
    repositoryFullName?: string | null;
    repositoryId?: string | null;
    signatureValid: boolean;
    payload: string;
  }): Promise<WebhookEvent>;
  /** Find by delivery_id. Returns the existing receipt for idempotency. */
  findByDeliveryId(deliveryId: string): Promise<WebhookEvent | null>;
  /** Mark as processing (atomic transition received → processing). */
  markProcessing(id: string): Promise<WebhookEvent | null>;
  /** Mark as processed. */
  markProcessed(id: string): Promise<WebhookEvent | null>;
  /** Mark as failed with error message + increment retry count. */
  markFailed(id: string, errorMessage: string): Promise<WebhookEvent | null>;
}

// --- GitHub adapter (provider-independent interface) ---

/**
 * Provider-independent GitHub adapter. The concrete implementation uses the
 * GitHub SDK; tests use a fake. Other modules never see GitHub SDK types.
 */
export interface GitHubAdapter {
  readonly name: string;

  /** Verify a GitHub webhook signature (constant-time comparison). */
  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean;

  /** Get repository metadata (provider-independent). */
  getRepositoryMetadata(installationId: string, owner: string, repo: string): Promise<GitHubRepositoryInfo>;

  /**
   * Get PR metadata (provider-independent).
   *
   * WORK-051 round 3 (PR #52 review, BLOCKER 3): returns null when the
   * authority holds no such pull request (an honest 404). The external-PR
   * ADOPTION path resolves the PR's AUTHORITATIVE head commit through this
   * read BEFORE anything enters the checkpoint binding or the governed
   * creation identity — a raw external PR reference is never treated as an
   * implementation revision.
   */
  getPullRequestInfo(installationId: string, owner: string, repo: string, prNumber: number): Promise<GitHubPullRequestInfo | null>;

  /**
   * Merge a pull request through the GitHub provider boundary (WORK-019).
   *
   * This is the provider-independent merge operation that /workflows calls
   * via the /github public contract. It does NOT set canonical workflow
   * state — it performs the actual GitHub merge and returns the result.
   *
   * The caller (/workflows orchestrator) is responsible for checking merge
   * gates before calling this method, and for transitioning workflow state
   * to MERGED only after authoritative GitHub state confirms the merge.
   */
  mergePullRequest(input: {
    installationId: string;
    owner: string;
    repo: string;
    prNumber: number;
    commitMessage?: string;
  }): Promise<GitHubMergeResult>;

  // --- WORK-026: repository provisioning extensions ---

  /**
   * Create a new GitHub repository under `input.owner`.
   *
   * WORK-026: used by the project runtime provisioning flow to stand up the
   * GitHub repository for a WorkflowOS project. The concrete impl
   * ({@link DefaultGitHubAdapter}) throws `'github-not-configured'` until
   * GitHub App credentials are wired; tests use {@link FakeGitHubAdapter}.
   */
  createRepository(input: CreateRepositoryInput): Promise<CreateRepositoryResult>;

  /**
   * Create a new branch on an existing repository.
   *
   * WORK-026: used by the autonomous implementation loop to create the
   * implementation branch the agent will push commits to.
   */
  createBranch(input: CreateBranchInput): Promise<CreateBranchResult>;

  /**
   * Open a pull request on an existing repository.
   *
   * WORK-026: used by the autonomous implementation loop to open the PR
   * that carries the agent's implementation commits into the default branch.
   *
   * PR #52 round 2 (BLOCKER 2): adapters implementing this method MUST
   * mirror GitHub's own identity semantics — at most ONE OPEN pull request
   * per (head, base) pair. A second create for the same head while an open
   * PR exists fails (GitHub: HTTP 422 "A pull request already exists"); it
   * must NEVER silently open a duplicate. The governed PR-creation
   * protocol relies on this + {@link findPullRequestByHead} for crash-safe
   * exactly-once PR creation.
   */
  createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult>;

  /**
   * Find the OPEN pull request for a head branch — the CONVERGENCE READ
   * (WORK-051 round 2, PR #52 review BLOCKER 2).
   *
   * Returns null when no open PR exists for that head branch. The governed
   * PR-creation boundary calls this BEFORE creating: after a crash between
   * the external create and the durable record, the retry CONVERGES on the
   * PR the crashed attempt already created (identified by the deterministic
   * head branch) instead of opening a second one.
   */
  findPullRequestByHead(input: FindPullRequestByHeadInput): Promise<FindPullRequestByHeadResult | null>;

  /**
   * Look up a branch's current HEAD SHA + whether it is the default branch.
   *
   * WORK-026: used to resolve the `fromSha` for `createBranch` and to
   * detect whether a branch has moved since the last poll.
   */
  getBranch(input: GetBranchInput): Promise<GetBranchResult>;

  /**
   * Read a file's text content at a precise revision (WORK-038).
   *
   * Returns `null` when the path does not exist at that revision (a 404 from
   * the GitHub getContent API). The returned `contentDigest` is sha256 of
   * the content (reproducibility — same content, same digest).
   *
   * WORK-038: used by the existing-project-onboarding capability to produce
   * evidence-backed OBSERVED observations (package.json fields, CI config,
   * Dockerfile, etc.) at the immutable baseline commit SHA. The onboarding
   * domain holds no GitHub credentials and no GitHub SDK — it consumes this
   * method through the /github barrel, wrapped in a thin production
   * `RepositoryContentPort` (src/onboarding/internal/github-content-port.ts).
   *
   * `ref` accepts a real Git commit SHA (the onboarding invariant — the
   * baseline is pinned to an immutable SHA) OR a branch/tag name (for ad-hoc
   * reads outside onboarding; the onboarding path always passes the resolved
   * SHA). The GitHub getContent API accepts both forms.
   *
   * EXACT-REF RESOLUTION CONTRACT (WORK-051 round 2, PR #52 review HIGH —
   * pinned as a static invariant): an adapter MUST resolve EXACTLY the
   * requested `ref` — it passes the ref through to the provider API
   * VERBATIM and returns the content that ref resolves to, or `null`/throws
   * when that ref cannot be resolved. An adapter MUST NEVER silently fall
   * back to the default branch, to a moved branch head, or to any working
   * tree: a caller that pinned an immutable commit SHA (the architecture
   * checkpoint snapshot, the onboarding baseline) receives the bytes of
   * EXACTLY that revision or an honest failure — never the bytes of some
   * other revision. A revision-bound snapshot built on this contract is
   * therefore bound to the revision it claims, at the provider boundary.
   */
  getFileContent(input: GetFileContentInput): Promise<GetFileContentResult | null>;

  /**
   * List a directory's entries at a precise revision (WORK-038).
   *
   * Returns an empty `entries` array when the directory does not exist at
   * that revision. Used by onboarding to enumerate candidate paths (e.g.
   * `.github/workflows` for CI discovery) without reading each file.
   *
   * EXACT-REF RESOLUTION CONTRACT: same guarantee as
   * {@link getFileContent} — the listing is of EXACTLY the requested `ref`
   * (verbatim pass-through; no branch/worktree fallback, no substitution),
   * or an honest failure/empty-for-missing-path. Never a listing of some
   * other revision.
   */
  listDir(input: ListDirInput): Promise<ListDirResult>;

  /**
   * Adapter readiness probe.
   *
   * - `'connected'`     — adapter has live credentials and can reach GitHub.
   * - `'not-configured'` — credentials are not wired (production default
   *                       until WORK-026 follow-on wires GITHUB_APP_*).
   * - `'error'`         — credentials present but the provider call failed.
   * - `'test-mode'`     — fake/test adapter (no live GitHub calls).
   */
  health(): Promise<'connected' | 'not-configured' | 'error' | 'test-mode'>;
}

/**
 * Result of a GitHub merge operation (WORK-019).
 */
export interface GitHubMergeResult {
  /** Whether the merge succeeded. */
  readonly merged: boolean;
  /** The PR number that was merged. */
  readonly prNumber: number;
  /** The merge commit SHA (if the merge succeeded). */
  readonly mergeCommitSha: string | null;
  /** Error message if the merge failed. */
  readonly error: string | null;
}

export interface GitHubRepositoryInfo {
  readonly externalId: string;
  readonly fullName: string;
  readonly canonicalRef: string;
  readonly defaultBranch: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface GitHubPullRequestInfo {
  readonly prNumber: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly headCommit: string | null;
  readonly merged: boolean;
}

// --- GitHub installation ---

export interface GitHubInstallation {
  readonly id: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly accountLogin: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface GitHubInstallationRepository {
  create(input: { projectId: string; installationId: string; accountLogin?: string | null; metadata?: Record<string, unknown> }): Promise<GitHubInstallation>;
  findByInstallationId(installationId: string): Promise<GitHubInstallation | null>;
  findByProject(projectId: string): Promise<GitHubInstallation[]>;
}

// --- Webhook processing service ---

/**
 * Processes webhook events asynchronously. Called by the worker host.
 */
export interface WebhookProcessingService {
  /**
   * Process a webhook event idempotently. Loads the durable receipt,
   * parses the payload, and performs the domain update (PR sync, repo sync).
   * Safe to retry — duplicate processing produces one effective mutation.
   */
  processEvent(eventId: string): Promise<void>;
}
