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
 */

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

  /** Get PR metadata (provider-independent). */
  getPullRequestInfo(installationId: string, owner: string, repo: string, prNumber: number): Promise<GitHubPullRequestInfo>;
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
