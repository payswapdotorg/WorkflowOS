import type { CreatedPullRequest, PullRequestCreationPort } from '../../src/modules/workflows/internal/convergence.types.js';

/**
 * WORK-051 round 2 (PR #52 review, BLOCKER 2) — the deterministic test double
 * for the PR-creation boundary. RECORDS every convergence read and every
 * createPullRequest call so regressions can prove the ORDER (gate first,
 * creation after), the COUNT (zero creations under a blocking violation),
 * and the CONVERGENCE (a completed key never creates again).
 *
 * The default PR identity mimics the legacy fake-agent behavior
 * ('github:owner/repo#1') so pre-existing lifecycle assertions on PR
 * associations keep passing in the allow-all-gate harnesses.
 *
 * Mirrors the external authority's identity semantics: one PR per
 * (workItemId, headRevision) convergence key — a duplicate create for the
 * same key throws (GitHub rejects duplicate open PRs for the same head).
 */
export class FakePullRequestCreationPort implements PullRequestCreationPort {
  readonly calls: Array<{
    projectId: string;
    workItemId: string;
    headRevision: string;
    title: string;
  }> = [];
  readonly findCalls: Array<{
    projectId: string;
    workItemId: string;
    headRevision: string;
  }> = [];

  private readonly createdKeys = new Map<string, CreatedPullRequest>();
  private nextExternalPrId: string | null = null;
  private nextHeadCommit: string | null = null;

  /** Deterministic PR identity for the next creation (default 'github:owner/repo#1'). */
  setNextResult(externalPrId: string, headCommit: string | null = null): void {
    this.nextExternalPrId = externalPrId;
    this.nextHeadCommit = headCommit;
  }

  private static key(workItemId: string, headRevision: string): string {
    return `${workItemId}::${headRevision}`;
  }

  async findExistingPullRequest(input: {
    projectId: string;
    workItemId: string;
    headRevision: string;
  }): Promise<CreatedPullRequest | null> {
    this.findCalls.push({
      projectId: input.projectId,
      workItemId: input.workItemId,
      headRevision: input.headRevision,
    });
    return this.createdKeys.get(FakePullRequestCreationPort.key(input.workItemId, input.headRevision)) ?? null;
  }

  async createPullRequest(input: {
    projectId: string;
    workItemId: string;
    headRevision: string;
    title: string;
    body?: string | null;
  }): Promise<CreatedPullRequest> {
    const key = FakePullRequestCreationPort.key(input.workItemId, input.headRevision);
    if (this.createdKeys.has(key)) {
      // Mirrors GitHub: at most one open PR per head — a governed-path
      // duplicate create is a BUG (the convergence protocol must find +
      // adopt the existing PR instead).
      throw new Error(
        `fake-pr-creation: a pull request already exists for (${input.workItemId}, ${input.headRevision}) — duplicate governed create`,
      );
    }
    this.calls.push({
      projectId: input.projectId,
      workItemId: input.workItemId,
      headRevision: input.headRevision,
      title: input.title,
    });
    const created: CreatedPullRequest = {
      externalPrId: this.nextExternalPrId ?? 'github:owner/repo#1',
      headCommit: this.nextHeadCommit ?? input.headRevision,
    };
    this.createdKeys.set(key, created);
    return created;
  }
}
