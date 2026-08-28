import type { DatabaseClient } from '@platform/index.js';
import type {
  WebhookEvent,
  WebhookEventRepository,
  WebhookProcessingState,
  GitHubAdapter,
  GitHubInstallation,
  GitHubInstallationRepository,
  GitHubRepositoryInfo,
  GitHubPullRequestInfo,
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
} from './project-github-repository.types.js';
import { createHash } from 'node:crypto';
import {
  GitHubRestClient,
  isGitHubApiHttpError,
  normalizePrivateKeyPem,
} from './github-rest-client.js';

// ===========================================================================
// Webhook event repository
// ===========================================================================

export class PgWebhookEventRepository implements WebhookEventRepository {
  constructor(private readonly db: DatabaseClient) {}

  async createReceipt(input: {
    deliveryId: string;
    eventType: string;
    repositoryFullName?: string | null;
    repositoryId?: string | null;
    signatureValid: boolean;
    payload: string;
  }): Promise<WebhookEvent> {
    // ON CONFLICT (delivery_id) DO NOTHING → idempotent. If the delivery
    // already exists, return the existing receipt.
    const result = await this.db.query<EventRow>(
      `INSERT INTO wfos_github_webhook_events
         (delivery_id, event_type, repository_full_name, repository_id,
          signature_valid, payload, processing_state)
       VALUES ($1, $2, $3, $4, $5, $6, 'received')
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING id, delivery_id, event_type, repository_full_name,
                 repository_id, signature_valid, payload, processing_state,
                 error_message, retry_count, processed_at, received_at,
                 created_at, updated_at`,
      [
        input.deliveryId,
        input.eventType,
        input.repositoryFullName ?? null,
        input.repositoryId ?? null,
        input.signatureValid,
        input.payload,
      ],
    );
    if (result.rows.length === 0) {
      // Already exists — fetch the existing receipt (idempotency).
      const existing = await this.findByDeliveryId(input.deliveryId);
      return existing!;
    }
    return mapEvent(result.rows[0]!);
  }

  async findByDeliveryId(deliveryId: string): Promise<WebhookEvent | null> {
    const result = await this.db.query<EventRow>(
      `SELECT id, delivery_id, event_type, repository_full_name, repository_id,
              signature_valid, payload, processing_state, error_message,
              retry_count, processed_at, received_at, created_at, updated_at
       FROM wfos_github_webhook_events WHERE delivery_id = $1`,
      [deliveryId],
    );
    if (result.rows.length === 0) return null;
    return mapEvent(result.rows[0]!);
  }

  async markProcessing(id: string): Promise<WebhookEvent | null> {
    // Atomic transition: mark as processing if currently 'received' or 'failed'.
    // 'failed' is allowed so that retries can re-process a failed event
    // (architect review PR #9 — processing must be retry-safe).
    const result = await this.db.query<EventRow>(
      `UPDATE wfos_github_webhook_events
       SET processing_state = 'processing', updated_at = NOW()
       WHERE id = $1 AND processing_state IN ('received', 'failed')
       RETURNING id, delivery_id, event_type, repository_full_name,
                 repository_id, signature_valid, payload, processing_state,
                 error_message, retry_count, processed_at, received_at,
                 created_at, updated_at`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapEvent(result.rows[0]!);
  }

  async markProcessed(id: string): Promise<WebhookEvent | null> {
    const result = await this.db.query<EventRow>(
      `UPDATE wfos_github_webhook_events
       SET processing_state = 'processed', processed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING id, delivery_id, event_type, repository_full_name,
                 repository_id, signature_valid, payload, processing_state,
                 error_message, retry_count, processed_at, received_at,
                 created_at, updated_at`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapEvent(result.rows[0]!);
  }

  async markFailed(id: string, errorMessage: string): Promise<WebhookEvent | null> {
    const result = await this.db.query<EventRow>(
      `UPDATE wfos_github_webhook_events
       SET processing_state = 'failed', error_message = $1,
           retry_count = retry_count + 1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, delivery_id, event_type, repository_full_name,
                 repository_id, signature_valid, payload, processing_state,
                 error_message, retry_count, processed_at, received_at,
                 created_at, updated_at`,
      [errorMessage, id],
    );
    if (result.rows.length === 0) return null;
    return mapEvent(result.rows[0]!);
  }
}

// ===========================================================================
// GitHub installation repository
// ===========================================================================

export class PgGitHubInstallationRepository implements GitHubInstallationRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: { projectId: string; installationId: string; accountLogin?: string | null; metadata?: Record<string, unknown> }): Promise<GitHubInstallation> {
    const result = await this.db.query<InstallationRow>(
      `INSERT INTO wfos_github_installations (project_id, installation_id, account_login, metadata)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, installation_id) DO UPDATE
         SET account_login = EXCLUDED.account_login,
             metadata = EXCLUDED.metadata
       RETURNING id, project_id, installation_id, account_login, metadata, created_at`,
      [input.projectId, input.installationId, input.accountLogin ?? null, JSON.stringify(input.metadata ?? {})],
    );
    return mapInstallation(result.rows[0]!);
  }

  async findByInstallationId(installationId: string): Promise<GitHubInstallation | null> {
    const result = await this.db.query<InstallationRow>(
      `SELECT id, project_id, installation_id, account_login, metadata, created_at
       FROM wfos_github_installations WHERE installation_id = $1`,
      [installationId],
    );
    if (result.rows.length === 0) return null;
    return mapInstallation(result.rows[0]!);
  }

  async findByProject(projectId: string): Promise<GitHubInstallation[]> {
    const result = await this.db.query<InstallationRow>(
      `SELECT id, project_id, installation_id, account_login, metadata, created_at
       FROM wfos_github_installations WHERE project_id = $1`,
      [projectId],
    );
    return result.rows.map(mapInstallation);
  }
}

// ===========================================================================
// Default GitHub adapter (uses HMAC-SHA256 signature verification)
// ===========================================================================

import { createHmac, timingSafeEqual as safeEqual } from 'node:crypto';

/**
 * Default GitHub adapter. Signature verification uses HMAC-SHA256 with
 * constant-time comparison. The GitHub SDK is NOT imported here — the live
 * REST surface (WORK-051 round 3) speaks the GitHub HTTP API directly through
 * {@link GitHubRestClient} (GitHub App RS256 JWT + installation tokens),
 * keeping this file dependency-free beyond node:crypto + the platform fetch.
 *
 * GitHub credentials are retrieved through the existing SecretStore (SEC-001)
 * conventions: GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (the composition root
 * may also inject them explicitly through the constructor config).
 *
 * PRODUCTION SURFACE (WORK-051 round 3, PR #52 review BLOCKER 1) — the
 * GOVERNED PR boundary is implemented against the REAL GitHub REST API:
 *   - createPullRequest       → POST /repos/{o}/{r}/pulls
 *   - findPullRequestByHead   → GET  /repos/{o}/{r}/pulls?head={o}:{branch}&state=open
 *   - getPullRequestInfo      → GET  /repos/{o}/{r}/pulls/{number}
 *   - getFileContent / listDir → GET /repos/{o}/{r}/contents/{path}?ref={ref}
 * Until credentials are wired the adapter fails CLOSED with the deterministic
 * 'github-not-configured' error — never a silent vacuous result.
 *
 * EXPLICITLY OUT OF THE WORK-051 SCOPE (deterministic 'github-not-configured'
 * until the WORK-026 provisioning / WORK-019 merge follow-ons): createRepository,
 * createBranch, getBranch, mergePullRequest. They are NOT part of the governed
 * checkpoint boundary (no checkpoint gate calls them) and are NOT claimed
 * production-complete by WORK-051.
 */
export interface DefaultGitHubAdapterConfig {
  /** The GitHub App id. Defaults to GITHUB_APP_ID. */
  appId?: string;
  /** The GitHub App private key (PEM; `\n`-escapes accepted). Defaults to GITHUB_APP_PRIVATE_KEY. */
  privateKey?: string;
  /** API base URL. Defaults to GITHUB_API_BASE_URL, then https://api.github.com. */
  apiBaseUrl?: string;
}

export class DefaultGitHubAdapter implements GitHubAdapter {
  readonly name = 'github';

  private readonly restClient: GitHubRestClient | null;

  constructor(config: DefaultGitHubAdapterConfig = {}) {
    const appId = config.appId ?? process.env.GITHUB_APP_ID;
    const rawKey = config.privateKey ?? process.env.GITHUB_APP_PRIVATE_KEY;
    const privateKey = rawKey ? normalizePrivateKeyPem(rawKey) : undefined;
    const apiBaseUrl = (
      config.apiBaseUrl ??
      process.env.GITHUB_API_BASE_URL ??
      'https://api.github.com'
    ).replace(/\/+$/, '');
    // No credentials ⇒ no REST client ⇒ every governed-boundary call fails
    // CLOSED with 'github-not-configured' (never a silent fake result).
    this.restClient =
      appId && privateKey ? new GitHubRestClient({ appId, privateKey, apiBaseUrl }) : null;
  }

  private requireRestClient(): GitHubRestClient {
    if (!this.restClient) {
      throw new Error(
        'github-not-configured: the live GitHub API requires GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY',
      );
    }
    return this.restClient;
  }

  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    if (!signature || !signature.startsWith('sha256=')) return false;
    const expected = signature.slice(7); // remove 'sha256=' prefix
    const computed = createHmac('sha256', secret).update(payload).digest('hex');
    // Constant-time comparison.
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return safeEqual(a, b);
  }

  async getRepositoryMetadata(_installationId: string, owner: string, repo: string): Promise<GitHubRepositoryInfo> {
    // For WORK-008, repository metadata comes from webhook payloads.
    // Live repository-metadata API calls are out of scope (metadata is not
    // part of the WORK-051 governed boundary).
    return {
      externalId: `${owner}/${repo}`,
      fullName: `${owner}/${repo}`,
      canonicalRef: `https://github.com/${owner}/${repo}`,
      defaultBranch: null,
      metadata: {},
    };
  }

  async getPullRequestInfo(_installationId: string, owner: string, repo: string, prNumber: number): Promise<GitHubPullRequestInfo | null> {
    // WORK-051 round 3 (PR #52 review, BLOCKER 3): the LIVE PR read — the
    // external-PR ADOPTION path resolves the PR's AUTHORITATIVE head commit
    // through this call before anything enters the checkpoint or the
    // governed-creation identity. Returns null when the authority holds no
    // such PR (an honest 404 — an unresolvable observation, never a guess).
    const client = this.requireRestClient();
    const pr = await client.requestForInstallation<GhPullRequestJson>({
      method: 'GET',
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
      installationId: _installationId,
    }).catch((err: unknown) => {
      if (isGitHubApiHttpError(err) && err.status === 404) return null;
      throw err;
    });
    if (!pr) return null;
    return mapGhPullRequest(pr);
  }

  async mergePullRequest(input: {
    installationId: string;
    owner: string;
    repo: string;
    prNumber: number;
    commitMessage?: string;
  }): Promise<import('./github.types.js').GitHubMergeResult> {
    // WORK-019 follow-on: the live merge REST call
    // (PUT /repos/{owner}/{repo}/pulls/{number}/merge) is EXPLICITLY out of
    // the WORK-051 governed boundary (no checkpoint gate invokes it). The
    // deterministic 'github-not-configured' error keeps the gap visible
    // until that work item wires it.
    void input;
    throw new Error('github-not-configured: live GitHub merge API is a WORK-019 follow-on (outside the WORK-051 governed boundary)');
  }

  // --- WORK-026: repository provisioning extensions ---

  async createRepository(_input: CreateRepositoryInput): Promise<CreateRepositoryResult> {
    // WORK-026 provisioning follow-on — EXPLICITLY outside the WORK-051
    // governed boundary (no checkpoint gate invokes it).
    throw new Error('github-not-configured: live GitHub repo-provisioning API is a WORK-026 follow-on (outside the WORK-051 governed boundary)');
  }

  async createBranch(_input: CreateBranchInput): Promise<CreateBranchResult> {
    // WORK-026 provisioning follow-on — EXPLICITLY outside the WORK-051
    // governed boundary (no checkpoint gate invokes it).
    throw new Error('github-not-configured: live GitHub repo-provisioning API is a WORK-026 follow-on (outside the WORK-051 governed boundary)');
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    // WORK-051 round 3 (PR #52 review, BLOCKER 1): the LIVE governed CREATE —
    // the actual external mutation of the crash-safe create-or-converge
    // protocol. POST /repos/{owner}/{repo}/pulls; GitHub's 422 surfaces
    // verbatim ("A pull request already exists for…") so a duplicate create
    // fails LOUDLY at the provider boundary instead of minting a second PR.
    const client = this.requireRestClient();
    const pr = await client.requestForInstallation<GhPullRequestJson>({
      method: 'POST',
      path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls`,
      installationId: input.installationId,
      body: {
        title: input.title,
        head: input.head,
        base: input.base,
        ...(input.body !== undefined && input.body !== null ? { body: input.body } : {}),
      },
    });
    return {
      owner: input.owner,
      repository: input.repository,
      number: pr.number,
      url: pr.html_url ?? `https://github.com/${input.owner}/${input.repository}/pull/${pr.number}`,
      headSha: pr.head?.sha ?? '',
    };
  }

  async findPullRequestByHead(input: FindPullRequestByHeadInput): Promise<FindPullRequestByHeadResult | null> {
    // WORK-051 round 3 (PR #52 review, BLOCKER 1): the LIVE CONVERGENCE READ —
    // GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open, the
    // recovery primitive of the crash-safe protocol. A 404/empty result is an
    // honest null ("no open PR for this head"); every other failure throws.
    const client = this.requireRestClient();
    const list = await client.requestForInstallation<GhPullRequestJson[]>({
      method: 'GET',
      path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls`
        + `?head=${encodeURIComponent(`${input.owner}:${input.head}`)}&state=open`,
      installationId: input.installationId,
    });
    // Defensive verification: GitHub filters server-side on the fully
    // qualified head; confirm the head ref matches the convergence marker
    // before treating a row as the governed PR (a mismatched row is ignored
    // — the protocol would then attempt a create and the provider's own
    // duplicate rejection stops a second PR).
    const found = (list ?? []).find(
      (pr) => pr.head?.ref === input.head && pr.state === 'open',
    );
    if (!found) return null;
    return {
      owner: input.owner,
      repository: input.repository,
      number: found.number,
      headSha: found.head?.sha ?? '',
      state: 'open',
    };
  }

  async getBranch(_input: GetBranchInput): Promise<GetBranchResult> {
    // WORK-026 provisioning follow-on — EXPLICITLY outside the WORK-051
    // governed boundary (the checkpoint snapshot binds the caller-declared
    // exact revision; it never resolves branch heads).
    throw new Error('github-not-configured: live GitHub repo-provisioning API is a WORK-026 follow-on (outside the WORK-051 governed boundary)');
  }

  // --- WORK-038 + WORK-051 round 3: the LIVE content-read surface ------------------
  //
  // The exact-revision repository snapshot (the architecture checkpoint's
  // ONLY tree source) reads through these methods. They are implemented
  // against the REAL GitHub contents API
  // (GET /repos/{owner}/{repo}/contents/{path}?ref={ref}) — the EXACT-REF
  // RESOLUTION CONTRACT (PR #52 round 2, HIGH) is preserved verbatim: the
  // requested ref is passed through UNCHANGED and the bytes/entries of
  // exactly that revision (or an honest failure) are returned. There is NO
  // branch/worktree fallback in this implementation — the provider either
  // resolves the exact ref or the caller fails closed.

  async getFileContent(input: GetFileContentInput): Promise<GetFileContentResult | null> {
    const client = this.requireRestClient();
    const entry = await client.requestForInstallation<GhContentEntryJson | GhContentEntryJson[]>({
      method: 'GET',
      path: this.contentsPath(input.owner, input.repository, input.path, input.ref),
      installationId: input.installationId,
    }).catch((err: unknown) => {
      if (isGitHubApiHttpError(err) && err.status === 404) return null;
      throw err;
    });
    if (!entry || Array.isArray(entry)) {
      // null = the path does not exist at this revision. An ARRAY means the
      // path is a DIRECTORY at this revision — a file read of a directory is
      // an inconsistent request, not a missing file: fail loudly (the
      // snapshot walker treats this as a typed read failure).
      if (entry) {
        throw new Error(
          `github-api getFileContent: '${input.path}' is a directory at ref '${input.ref}', not a file (fail closed)`,
        );
      }
      return null;
    }
    if (entry.type && entry.type !== 'file') {
      throw new Error(
        `github-api getFileContent: '${input.path}' is a ${entry.type} at ref '${input.ref}', not a file (fail closed)`,
      );
    }
    if (typeof entry.content !== 'string' || entry.encoding !== 'base64') {
      // GitHub omits `content` for files >1MB — an honest failure, never a
      // substitute revision's bytes.
      throw new Error(
        `github-api getFileContent: '${input.path}' at ref '${input.ref}' has no inline content (too large or unsupported encoding — fail closed)`,
      );
    }
    const content = Buffer.from(entry.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return {
      owner: input.owner,
      repository: input.repository,
      ref: input.ref,
      path: input.path,
      content,
      contentDigest: createHash('sha256').update(content, 'utf8').digest('hex'),
    };
  }

  async listDir(input: ListDirInput): Promise<ListDirResult> {
    const client = this.requireRestClient();
    const entry = await client.requestForInstallation<GhContentEntryJson | GhContentEntryJson[]>({
      method: 'GET',
      path: this.contentsPath(input.owner, input.repository, input.path, input.ref),
      installationId: input.installationId,
    }).catch((err: unknown) => {
      if (isGitHubApiHttpError(err) && err.status === 404) return null;
      throw err;
    });
    // Contract: empty entries when the directory does not exist at the
    // revision — including when the path is a FILE there (a single object
    // response means "no directory at this path").
    const entries = !entry || Array.isArray(entry) ? entry : null;
    return {
      owner: input.owner,
      repository: input.repository,
      ref: input.ref,
      path: input.path,
      entries: (entries ?? []).map((e) => ({
        name: e.name,
        type: e.type === 'dir' ? 'dir' : 'file',
      })),
    };
  }

  /** The encoded contents path with the ref passed through VERBATIM. */
  private contentsPath(owner: string, repository: string, path: string, ref: string): string {
    const encodedPath = path
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${encodedPath}`
      + `?ref=${encodeURIComponent(ref)}`;
  }

  async health(): Promise<'connected' | 'not-configured' | 'error' | 'test-mode'> {
    // No credentials ⇒ the honest 'not-configured'. With credentials, probe
    // the app identity endpoint with the APP JWT (GET /app — the canonical
    // credential liveness check; no installation context needed). Transport
    // or non-2xx ⇒ 'error' — the adapter never claims connectivity it has
    // not demonstrated.
    if (!this.restClient) return 'not-configured';
    try {
      await this.restClient.requestJson<unknown>({
        method: 'GET',
        path: '/app',
        authorization: `Bearer ${this.restClient.appAuthToken()}`,
        timeoutMs: 5000,
      });
      return 'connected';
    } catch {
      return 'error';
    }
  }
}

// --- GitHub REST response shapes (private to the adapter) ----------------------

interface GhPullRequestJson {
  number: number;
  html_url?: string;
  title?: string;
  state?: string;
  merged_at?: string | null;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
}

interface GhContentEntryJson {
  name: string;
  type?: string;
  content?: string;
  encoding?: string;
}

function mapGhPullRequest(pr: GhPullRequestJson): GitHubPullRequestInfo {
  return {
    prNumber: pr.number,
    title: pr.title ?? '',
    state: pr.state === 'closed' ? 'closed' : 'open',
    branch: pr.head?.ref ?? null,
    baseBranch: pr.base?.ref ?? null,
    headCommit: pr.head?.sha ?? null,
    merged: pr.merged_at != null,
  };
}

// ===========================================================================
// Row mappers
// ===========================================================================

interface EventRow {
  id: string;
  delivery_id: string;
  event_type: string;
  repository_full_name: string | null;
  repository_id: string | null;
  signature_valid: boolean;
  payload: string;
  processing_state: string;
  error_message: string | null;
  retry_count: number;
  processed_at: Date | null;
  received_at: Date;
  created_at: Date;
  updated_at: Date;
}
interface InstallationRow {
  id: string;
  project_id: string;
  installation_id: string;
  account_login: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function mapEvent(row: EventRow): WebhookEvent {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    eventType: row.event_type,
    repositoryFullName: row.repository_full_name,
    repositoryId: row.repository_id,
    signatureValid: row.signature_valid,
    payload: row.payload,
    processingState: row.processing_state as WebhookProcessingState,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    processedAt: row.processed_at,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInstallation(row: InstallationRow): GitHubInstallation {
  return {
    id: row.id,
    projectId: row.project_id,
    installationId: row.installation_id,
    accountLogin: row.account_login,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}
