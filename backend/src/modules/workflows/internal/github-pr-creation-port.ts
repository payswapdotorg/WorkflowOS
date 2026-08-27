/**
 * WORK-051 round 1 (PR #52 review, BLOCKER 2) — the PRODUCTION
 * PullRequestCreationPort: the actual PR-creation boundary.
 *
 * The orchestrator calls this port ONLY after the pr_conformance checkpoint
 * gate allows progression. The port performs the real PR creation through
 * the EXISTING /github authority (GitHubAdapter.createPullRequest) with the
 * repository coordinates resolved SERVER-SIDE from the project's /github
 * repository link — the caller (the orchestrator) never supplies them.
 *
 * Boundary: /workflows internal, but it holds NO GitHub SDK and NO
 * credentials — it consumes the /github public barrel only (the GitHubAdapter
 * contract), exactly like the orchestrator's existing mergePullRequest usage.
 * Fail closed: no repository link, or any adapter failure ⇒ a typed error —
 * the orchestrator leaves the work item IMPLEMENTING (no PR association, no
 * PR_OPEN transition).
 */

import type {
  GitHubAdapter,
  ProjectGitHubRepositoryRepository,
} from '@modules/github/index.js';
import type { CreatedPullRequest, PullRequestCreationPort } from './convergence.types.js';

export class GithubBackedPullRequestCreationPort implements PullRequestCreationPort {
  constructor(
    private readonly projectGitHubRepositoryRepository: ProjectGitHubRepositoryRepository,
    private readonly githubAdapter: GitHubAdapter,
  ) {}

  async createPullRequest(input: {
    projectId: string;
    workItemId: string;
    headRevision: string;
    branch: string | null;
    title: string;
    body?: string | null;
  }): Promise<CreatedPullRequest> {
    // SERVER-SIDE repository resolution — the same authority the workspace
    // baseline and the snapshot reader resolve through.
    const link = await this.projectGitHubRepositoryRepository.findByProject(input.projectId);
    if (!link) {
      throw new Error(
        `pr-creation: project ${input.projectId} has no linked GitHub repository — the governed PR cannot be created (fail closed)`,
      );
    }
    const head =
      input.branch ??
      // Deterministic implementation branch when the agent did not report
      // one: the work item's governed implementation branch.
      `wfos/${input.workItemId.slice(0, 12)}`;
    const result = await this.githubAdapter.createPullRequest({
      owner: link.owner,
      repository: link.repository,
      title: input.title,
      head,
      base: link.defaultBranch || 'main',
      body: input.body ?? undefined,
      installationId: link.installationId,
    });
    return {
      externalPrId: `github:${link.owner}/${link.repository}#${result.number}`,
      headCommit: result.headSha ?? null,
    };
  }
}
