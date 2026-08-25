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
  GetBranchInput,
  GetBranchResult,
  GetFileContentInput,
  GetFileContentResult,
  ListDirInput,
  ListDirResult,
} from './project-github-repository.types.js';

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
 * constant-time comparison. The GitHub SDK is NOT imported here — for
 * WORK-008, repository/PR data comes from webhook payloads (no live API
 * calls). Future work items can add the Octokit adapter behind this interface.
 *
 * GitHub credentials are retrieved through the existing SecretStore (SEC-001).
 */
export class DefaultGitHubAdapter implements GitHubAdapter {
  readonly name = 'github';

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
    // Live GitHub API calls are out of scope (future work).
    return {
      externalId: `${owner}/${repo}`,
      fullName: `${owner}/${repo}`,
      canonicalRef: `https://github.com/${owner}/${repo}`,
      defaultBranch: null,
      metadata: {},
    };
  }

  async getPullRequestInfo(_installationId: string, _owner: string, _repo: string, _prNumber: number): Promise<GitHubPullRequestInfo> {
    // For WORK-008, PR data comes from webhook payloads.
    throw new Error('getPullRequestInfo: live GitHub API calls not implemented in WORK-008');
  }

  async mergePullRequest(input: {
    installationId: string;
    owner: string;
    repo: string;
    prNumber: number;
    commitMessage?: string;
  }): Promise<import('./github.types.js').GitHubMergeResult> {
    // WORK-019: live GitHub merge API call.
    // For WORK-019 we provide a deterministic default implementation that
    // records the merge request. The actual Octokit call will be added when
    // GitHub credentials are wired into the production environment.
    //
    // In tests, a FakeGitHubAdapter overrides this with deterministic behavior.
    void input;
    throw new Error('mergePullRequest: live GitHub API calls not implemented — use a FakeGitHubAdapter for tests');
  }

  // --- WORK-026: repository provisioning extensions ---

  async createRepository(_input: CreateRepositoryInput): Promise<CreateRepositoryResult> {
    // Live GitHub REST write call. Production wiring (GITHUB_APP_PRIVATE_KEY
    // + GITHUB_APP_ID + installation token minting via fetch) is a follow-on
    // step. Until then, the write surface throws a deterministic error so
    // callers can distinguish "not configured" from a runtime failure.
    throw new Error('github-not-configured: live GitHub write API requires GITHUB_APP_PRIVATE_KEY');
  }

  async createBranch(_input: CreateBranchInput): Promise<CreateBranchResult> {
    throw new Error('github-not-configured: live GitHub write API requires GITHUB_APP_PRIVATE_KEY');
  }

  async createPullRequest(_input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    throw new Error('github-not-configured: live GitHub write API requires GITHUB_APP_PRIVATE_KEY');
  }

  async getBranch(_input: GetBranchInput): Promise<GetBranchResult> {
    throw new Error('github-not-configured: live GitHub write API requires GITHUB_APP_PRIVATE_KEY');
  }

  // --- WORK-038: repository content-read extensions ---
  //
  // These are the production content-read surfaces consumed by the
  // existing-project-onboarding capability (through the production
  // RepositoryContentPort at src/onboarding/internal/github-content-port.ts).
  // The onboarding domain holds NO GitHub SDK — it consumes these methods
  // through the /github barrel; the adapter is the only SDK caller.
  //
  // The live GitHub REST getContent API call (fetch against
  // /repos/{owner}/{repo}/contents/{path}?ref={ref}) is a follow-on step
  // gated on GITHUB_APP_* credentials being wired (same as the WORK-026
  // provisioning methods). Until then, the production adapter throws a
  // deterministic 'github-not-configured' error so the analyzer's per-candidate
  // try/catch records the failure as evidence + continues (the baseline
  // completes with metadata-only observations; the governed path is still
  // consulted for every candidate read). The FakeGitHubAdapter provides a
  // deterministic in-memory content tree for the integration suite that
  // exercises the production content-port wiring end-to-end.

  async getFileContent(_input: GetFileContentInput): Promise<GetFileContentResult | null> {
    throw new Error('github-not-configured: live GitHub content-read API requires GITHUB_APP_PRIVATE_KEY');
  }

  async listDir(_input: ListDirInput): Promise<ListDirResult> {
    // Same credential gate as getFileContent — a soft return of [] would
    // falsely imply the directory is empty. The analyzer's per-candidate
    // try/catch records the failure as evidence + continues.
    throw new Error('github-not-configured: live GitHub content-read API requires GITHUB_APP_PRIVATE_KEY');
  }

  async health(): Promise<'connected' | 'not-configured' | 'error' | 'test-mode'> {
    // No credentials are wired into the production adapter yet — production
    // wiring (GITHUB_APP_PRIVATE_KEY + GITHUB_APP_ID + GITHUB_INSTALLATION_ID)
    // is a follow-on WORK-026 step. Until then, the adapter reports
    // 'not-configured' so the runtime status endpoint surfaces the gap
    // without throwing.
    return 'not-configured';
  }
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
