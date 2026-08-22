import type { DatabaseClient } from '@platform/index.js';
import type {
  WebhookProcessingService,
} from './github.types.js';
import type { Logger } from '@platform/logger.js';
import type { JobRecord, JobHandler } from '@platform/index.js';
import { PgWebhookEventRepository, PgGitHubInstallationRepository } from './pg-github-repository.js';
import type { ProjectRepositoryAssociationRepository } from '@modules/projects/index.js';
import type { PullRequestAssociationRepository } from '@modules/work-items/index.js';

/**
 * Processes GitHub webhook events asynchronously (GITHUB-002).
 *
 * Called by the worker host. Loads the durable receipt, parses the payload,
 * and performs the domain update (PR sync, repo sync). Safe to retry —
 * duplicate processing produces one effective mutation because:
 * - the delivery_id UNIQUE constraint prevents duplicate receipts;
 * - the processing_state transition (received → processing → processed)
 *   is atomic;
 * - domain updates use upsert/idempotent operations.
 */
export class DefaultWebhookProcessingService implements WebhookProcessingService {
  private readonly eventRepo: PgWebhookEventRepository;
  private readonly installationRepo: PgGitHubInstallationRepository;

  constructor(
    eventRepo: PgWebhookEventRepository,
    installationRepo: PgGitHubInstallationRepository,
    private readonly prAssociationRepo: PullRequestAssociationRepository,
    private readonly projectRepoAssociationRepo: ProjectRepositoryAssociationRepository,
    private readonly logger: Logger,
    private readonly db: DatabaseClient,
  ) {
    this.eventRepo = eventRepo;
    this.installationRepo = installationRepo;
  }

  async processEvent(eventId: string): Promise<void> {
    // Load the durable receipt.
    const event = await this.eventRepo.findByDeliveryId(eventId);
    if (!event) {
      this.logger.warn('webhook.event_not_found', { eventId });
      return;
    }

    // Idempotency: skip if already processed.
    if (event.processingState === 'processed') {
      this.logger.info('webhook.already_processed', { deliveryId: event.deliveryId });
      return;
    }

    // Atomically transition to processing (allows 'received' and 'failed'
    // states — retry-safe per architect review PR #9).
    const processing = await this.eventRepo.markProcessing(event.id);
    if (!processing) {
      // Another worker is processing or the state is unexpected.
      this.logger.info('webhook.skipped', { deliveryId: event.deliveryId, state: event.processingState });
      return;
    }

    try {
      await this.processPayload(processing);
      await this.eventRepo.markProcessed(processing.id);
      this.logger.info('webhook.processed', { deliveryId: event.deliveryId, eventType: event.eventType });
    } catch (err) {
      await this.eventRepo.markFailed(processing.id, (err as Error).message);
      this.logger.error('webhook.processing_failed', {
        deliveryId: event.deliveryId,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  private async processPayload(event: { eventType: string; payload: string; repositoryFullName: string | null }): Promise<void> {
    const payload = JSON.parse(event.payload) as {
      action?: string;
      pull_request?: {
        number: number;
        title: string;
        state: string;
        head?: { ref?: string; sha?: string };
        base?: { ref?: string };
        merged?: boolean;
      };
      repository?: {
        id: number;
        full_name: string;
        default_branch?: string;
      };
      installation?: {
        id: number;
      };
    };

    // Resolve the project from the installation.
    const installationId = payload.installation?.id?.toString();
    let projectId: string | null = null;
    if (installationId) {
      const installation = await this.installationRepo.findByInstallationId(installationId);
      if (installation) {
        projectId = installation.projectId;
      }
    }

    // Process pull_request events.
    if (event.eventType === 'pull_request' && payload.pull_request && payload.repository) {
      if (!projectId) {
        this.logger.warn('webhook.no_project_for_installation', { installationId });
        return;
      }
      await this.syncPullRequest(projectId, payload.repository.full_name, payload.pull_request);
    }

    // Process repository events (repo sync).
    if (event.eventType === 'repository' && payload.repository) {
      if (!projectId) {
        this.logger.warn('webhook.no_project_for_installation', { installationId });
        return;
      }
      await this.syncRepository(projectId, payload.repository);
    }
  }

  private async syncPullRequest(
    projectId: string,
    repoFullName: string,
    pr: {
      number: number;
      title: string;
      state: string;
      head?: { ref?: string; sha?: string };
      base?: { ref?: string };
      merged?: boolean;
    },
  ): Promise<void> {
    const externalPrId = `github:${repoFullName}#${pr.number}`;

    // GitHub PR state → WorkflowOS PR association status mapping:
    //   state='open'              → 'active'
    //   state='closed', merged=false → 'closed'
    //   state='closed', merged=true  → 'merged'
    const newStatus = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'active';

    // Find existing PR associations for this external_pr_id and update their
    // status. This is the minimal PR lifecycle sync: when GitHub says a PR
    // was closed/merged, we update the existing association records.
    const result = await this.db.query<{ id: string; work_item_id: string; status: string }>(
      `SELECT id, work_item_id, status
       FROM wfos_pull_request_associations
       WHERE external_pr_id = $1`,
      [externalPrId],
    );

    for (const row of result.rows) {
      if (row.status !== newStatus) {
        await this.db.query(
          `UPDATE wfos_pull_request_associations
           SET status = $1,
               superseded_at = CASE WHEN $1 != 'active' THEN NOW() ELSE superseded_at END
           WHERE id = $2 AND status != $1`,
          [newStatus, row.id],
        );
      }
    }

    this.logger.info('webhook.pr_synced', {
      projectId,
      externalPrId,
      prNumber: pr.number,
      prState: pr.state,
      prMerged: pr.merged,
      newStatus,
      updatedAssociations: result.rows.length,
    });
    void this.prAssociationRepo;
  }

  private async syncRepository(
    projectId: string,
    repo: { id: number; full_name: string; default_branch?: string },
  ): Promise<void> {
    // Synchronize repository metadata to the existing project repository
    // association model (WORK-004). Upsert the association.
    await this.projectRepoAssociationRepo.associate({
      projectId,
      provider: 'github',
      externalId: repo.full_name,
      canonicalRef: `https://github.com/${repo.full_name}`,
      metadata: {
        repoId: repo.id,
        defaultBranch: repo.default_branch ?? null,
      },
    });
    this.logger.info('webhook.repo_synced', {
      projectId,
      repoFullName: repo.full_name,
      repoId: repo.id,
      defaultBranch: repo.default_branch,
    });
  }
}

/**
 * Job handler for github.webhook jobs. Registered with the existing
 * WorkerHost (WORK-001 Redis-backed queue).
 */
export function createWebhookJobHandler(
  processingService: WebhookProcessingService,
  logger: Logger,
): JobHandler {
  return {
    type: 'github.webhook',
    async handle(job: JobRecord): Promise<void> {
      const payload = job.payload as { deliveryId: string };
      if (!payload?.deliveryId) {
        logger.error('webhook.job.missing_delivery_id', { jobId: job.id });
        return;
      }
      await processingService.processEvent(payload.deliveryId);
    },
  };
}
