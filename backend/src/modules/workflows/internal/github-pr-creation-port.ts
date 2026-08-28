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
import type {
  CreatedPullRequest,
  PullRequestCreationPort,
  ResolvedExternalPullRequest,
} from './convergence.types.js';
import { createHash } from 'node:crypto';

/**
 * PR #52 round 2 (BLOCKER 2) + round 3 (BLOCKER 2) — the DETERMINISTIC,
 * COLLISION-RESISTANT CONVERGENCE MARKER.
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
 *
 * PR #52 round 3 (review BLOCKER 2): the identity is a CRYPTOGRAPHIC DIGEST
 * of the COMPLETE logical key — sha256 over the canonical JSON encoding of
 * (workItemId, headRevision) — NOT a composition of truncated components.
 * The round-2 `wi-<id[:12]>/rev-<rev[:12]>` form left a collision domain:
 * two distinct logical keys sharing 12-character prefixes would map to the
 * SAME Git branch, and a collision would converge one Work Item/revision
 * onto ANOTHER Work Item's PR. The digest carries the complete identity of
 * both components (256 bits); the encoding is injective, so distinct keys
 * map to distinct branches with cryptographic certainty.
 */
export function governedHeadBranch(workItemId: string, headRevision: string): string {
  const canonicalKey = JSON.stringify([workItemId, headRevision]);
  const digest = createHash('sha256').update(canonicalKey, 'utf8').digest('hex');
  return `wfos/governed/${digest}`;
}

/**
 * PR #52 round 3 (review, BLOCKER 3) — parse a canonical external PR
 * reference (`github:owner/repo#12`). Malformed references throw (fail
 * closed): an unparseable observation can never be resolved to an exact
 * revision, so it must never enter the checkpoint or the governed identity.
 */
function parseExternalPrRef(ref: string): { owner: string; repository: string; number: number } {
  const match = /^github:([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(ref.trim());
  if (!match) {
    throw new Error(
      `pr-adoption: '${ref}' is not a canonical GitHub PR reference (github:owner/repo#number) — ` +
        'the authoritative head commit cannot be resolved (fail closed)',
    );
  }
  return { owner: match[1]!, repository: match[2]!, number: Number(match[3]) };
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

  async resolveExternalPullRequest(input: {
    projectId: string;
    externalPrRef: string;
  }): Promise<ResolvedExternalPullRequest | null> {
    // PR #52 round 3 (review, BLOCKER 3) — a raw external PR reference is
    // NOT an implementation revision. Resolve the PR's AUTHORITATIVE
    // identity (head commit SHA, state, merged) through /github BEFORE
    // anything enters the checkpoint binding or the governed-creation
    // identity. Fail closed on every unresolvable shape.

    // (1) The reference must be a canonical PR identity (throws when
    // malformed — an unparseable observation is unresolvable by
    // construction).
    const parsed = parseExternalPrRef(input.externalPrRef);

    // (2) SERVER-SIDE repository resolution — same authority as the
    // convergence read and the create. No link ⇒ typed failure (a silent
    // null would falsely imply "resolvable but absent").
    const link = await this.projectGitHubRepositoryRepository.findByProject(input.projectId);
    if (!link) {
      throw new Error(
        `pr-adoption: project ${input.projectId} has no linked GitHub repository — cannot resolve the external PR (fail closed)`,
      );
    }

    // (3) The observed PR must belong to the project's OWN repository — a
    // reference into a different repository is a cross-project observation,
    // never an adoptable implementation of this project's work item.
    if (link.owner !== parsed.owner || link.repository !== parsed.repository) {
      throw new Error(
        `pr-adoption: external PR ${input.externalPrRef} belongs to ${parsed.owner}/${parsed.repository}, ` +
          `not the project's linked repository ${link.owner}/${link.repository} (fail closed)`,
      );
    }

    // (4) The AUTHORITATIVE PR read through /github. null = the authority
    // holds no such PR (an honest 404 — unresolvable); a transport failure
    // throws (fail closed).
    const info = await this.githubAdapter.getPullRequestInfo(
      link.installationId,
      link.owner,
      link.repository,
      parsed.number,
    );
    if (!info) return null;
    return {
      externalPrId: `github:${link.owner}/${link.repository}#${info.prNumber}`,
      headCommit: info.headCommit,
      state: info.state,
      merged: info.merged,
    };
  }
}
