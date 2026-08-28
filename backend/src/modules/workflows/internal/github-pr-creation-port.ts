/**
 * WORK-051 round 1 (PR #52 review, BLOCKER 2) + round 2 (BLOCKER 2) — the
 * PRODUCTION PullRequestCreationPort: the actual PR-creation boundary.
 *
 * The governed protocol calls this port ONLY after the pr_conformance
 * checkpoint gate allows progression. The port is BOTH halves of the
 * external boundary:
 *
 *   - findExistingPullRequest — the CONVERGENCE READ: the PR (if any) this
 *     boundary already created for the (work item, implementation revision)
 *     pair, found through /github's findPullRequestByHead on the
 *     DETERMINISTIC head branch (governedHeadBranch below);
 *   - createPullRequest — the CREATE: the real PR creation through the
 *     EXISTING /github authority (GitHubAdapter.createPullRequest), with the
 *     repository coordinates resolved SERVER-SIDE from the project's /github
 *     repository link — the caller (the orchestrator) never supplies them.
 *
 * The head branch is a PURE FUNCTION of the convergence key
 * (workItemId, headRevision): the same key always maps to the same branch,
 * so a crashed create attempt (external PR exists, durable record lost) is
 * found again by the retry through the same branch — and GitHub itself
 * refuses a second open PR for the same head, making the create idempotent
 * at the provider boundary.
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

/**
 * PR #52 round 2 (BLOCKER 2) — the DETERMINISTIC CONVERGENCE MARKER.
 *
 * The governed PR's head branch, derived as a pure function of the
 * convergence key (logical Work Item + EXACT implementation revision):
 *
 *   - a crash/retry/duplicate re-drive of the SAME (work item, revision)
 *     derives the SAME branch → the convergence read finds the PR the
 *     crashed attempt created → converge, no second PR;
 *   - a NEW implementation revision (e.g. a correction cycle) derives a
 *     DIFFERENT branch → a genuinely new PR, exactly as the lifecycle
 *     requires.
 */
export function governedHeadBranch(workItemId: string, headRevision: string): string {
  return `wfos/wi-${workItemId.slice(0, 12)}/rev-${headRevision.slice(0, 12)}`;
}

export class GithubBackedPullRequestCreationPort implements PullRequestCreationPort {
  constructor(
    private readonly projectGitHubRepositoryRepository: ProjectGitHubRepositoryRepository,
    private readonly githubAdapter: GitHubAdapter,
  ) {}

  async findExistingPullRequest(input: {
    projectId: string;
    workItemId: string;
    headRevision: string;
  }): Promise<CreatedPullRequest | null> {
    // SERVER-SIDE repository resolution — the same authority the create
    // path resolves through. Fail closed: no link ⇒ typed error (the
    // governed protocol surfaces the failure and leaves the work item
    // IMPLEMENTING; a silent null would falsely imply "no existing PR").
    const link = await this.projectGitHubRepositoryRepository.findByProject(input.projectId);
    if (!link) {
      throw new Error(
        `pr-creation convergence read: project ${input.projectId} has no linked GitHub repository — cannot look up the governed PR (fail closed)`,
      );
    }
    const head = governedHeadBranch(input.workItemId, input.headRevision);
    const found = await this.githubAdapter.findPullRequestByHead({
      owner: link.owner,
      repository: link.repository,
      head,
      installationId: link.installationId,
    });
    if (!found) return null;
    return {
      externalPrId: `github:${link.owner}/${link.repository}#${found.number}`,
      headCommit: found.headSha ?? null,
    };
  }

  async createPullRequest(input: {
    projectId: string;
    workItemId: string;
    headRevision: string;
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
    // The DETERMINISTIC head branch — the convergence marker for this
    // (work item, implementation revision) pair. GitHub's one-open-PR-per-
    // head semantics makes a duplicate create fail loudly instead of
    // silently minting a second PR.
    const head = governedHeadBranch(input.workItemId, input.headRevision);
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
