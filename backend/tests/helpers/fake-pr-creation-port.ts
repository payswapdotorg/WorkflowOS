import type { CreatedPullRequest, PullRequestCreationPort } from '../../src/modules/workflows/internal/convergence.types.js';

/**
 * WORK-051 round 1 (PR #52 review, BLOCKER 2) — the deterministic test double
 * for the PR-creation boundary. RECORDS every createPullRequest call so
 * regressions can prove the ORDER (gate first, creation after) and the
 * COUNT (zero creations under a blocking violation).
 *
 * The default PR identity mimics the legacy fake-agent behavior
 * ('github:owner/repo#1') so pre-existing lifecycle assertions on PR
 * associations keep passing in the allow-all-gate harnesses.
 */
export class FakePullRequestCreationPort implements PullRequestCreationPort {
  readonly calls: Array<{
    projectId: string;
    workItemId: string;
    headRevision: string;
    branch: string | null;
    title: string;
  }> = [];

  private nextExternalPrId: string | null = null;
  private nextHeadCommit: string | null = null;

  /** Deterministic PR identity for the next creation (default 'github:owner/repo#1'). */
  setNextResult(externalPrId: string, headCommit: string | null = null): void {
    this.nextExternalPrId = externalPrId;
    this.nextHeadCommit = headCommit;
  }

  async createPullRequest(input: {
    projectId: string;
    workItemId: string;
    headRevision: string;
    branch: string | null;
    title: string;
    body?: string | null;
  }): Promise<CreatedPullRequest> {
    this.calls.push({
      projectId: input.projectId,
      workItemId: input.workItemId,
      headRevision: input.headRevision,
      branch: input.branch,
      title: input.title,
    });
    return {
      externalPrId: this.nextExternalPrId ?? 'github:owner/repo#1',
      headCommit: this.nextHeadCommit ?? input.headRevision,
    };
  }
}
