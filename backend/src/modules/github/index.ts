/**
 * github module — public interface.
 *
 * Canonical name: /github
 * Responsibility (spec/architecture.md): GitHub App, GitHub webhooks, Pull
 * Requests, CI integration.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-008: implements GitHub integration boundary — webhook signature
 * validation, durable event receipts (PostgreSQL), idempotent async
 * processing (Redis worker), provider-independent repository/PR contracts.
 * GitHub SDK/provider code stays inside internal/.
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type {
  WebhookEvent,
  WebhookProcessingState,
  WebhookEventRepository,
  GitHubAdapter,
  GitHubRepositoryInfo,
  GitHubPullRequestInfo,
  GitHubInstallation,
  GitHubInstallationRepository,
  WebhookProcessingService,
} from './internal/github.types.js';

/**
 * Public capabilities exposed by the /github module to other modules.
 */
export interface GithubModuleApi {
  // future: additional GitHub-domain methods consumed by other modules
}

/**
 * Frozen module contract for /github.
 */
export const githubModule: ModuleContract & GithubModuleApi = {
  name: '/github',
};

export default githubModule;
