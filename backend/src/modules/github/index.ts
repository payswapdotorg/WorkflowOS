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
 *
 * WORK-015: extends /github with provider-independent CI evidence ingestion
 * (GITHUB-006). Translates GitHub Actions check_run / workflow_run webhook
 * events into provider-independent CiRunEvidence rows. /github OWNS the
 * ingestion + translation; it does NOT evaluate acceptance criteria (that's
 * /verification — GH6-AC-02 enforced by a static architecture check).
 *
 * WORK-026: extends the GitHubAdapter contract with repository provisioning
 * methods (createRepository / createBranch / createPullRequest / getBranch /
 * health) and exposes the project↔GitHub repository provisioning link types
 * (ProjectGitHubRepository + ProjectGitHubRepositoryRepository + the
 * Create/Get input/result DTOs).
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type {
  WebhookEvent,
  WebhookProcessingState,
  WebhookEventRepository,
  GitHubAdapter,
  GitHubRepositoryInfo,
  GitHubPullRequestInfo,
  GitHubMergeResult,
  GitHubInstallation,
  GitHubInstallationRepository,
  WebhookProcessingService,
} from './internal/github.types.js';
// WORK-015: CI evidence ingestion contracts (GITHUB-006).
export type {
  CiArtifactReference,
  CiRunEvidence,
  IngestCiEvidenceInput,
  CiEvidenceIngestionRepository,
  CiEvidenceIngestionService,
} from './internal/ci-evidence.types.js';
// WORK-026: project↔GitHub repository provisioning link contracts.
export type {
  ProjectGitHubRepository,
  ProjectGitHubRepositoryRepository,
  CreateRepositoryInput,
  CreateRepositoryResult,
  CreateBranchInput,
  CreateBranchResult,
  CreatePullRequestInput,
  CreatePullRequestResult,
  GetBranchInput,
  GetBranchResult,
} from './internal/project-github-repository.types.js';

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
