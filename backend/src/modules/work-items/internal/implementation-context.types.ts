/**
 * WORK-026: ImplementationContext types.
 *
 * The {@link ImplementationContextBuilder} assembles a self-contained snapshot
 * of everything an autonomous agent needs to implement a Work Item: the work
 * order, resolved requirements + acceptance criteria, dependencies, linked
 * GitHub repository, prior agent runs + review findings, and the immutable
 * instructions every agent must obey. The snapshot is persisted as a numbered
 * revision so each correction cycle produces a fresh, traceable input.
 *
 * This file is private to /work-items (PLAT-AC-02). The public barrel exposes
 * only the four TYPE names — `ImplementationContext`, `ImplementationContextContent`,
 * `ImplementationContextRepository`, `ImplementationContextBuilder`. Concrete
 * implementations live next to this file (`pg-implementation-context-repository.ts`,
 * `implementation-context-builder.ts`) and are constructed only by the
 * composition root (SUB-F).
 *
 * The builder does NOT call the agent gateway / GitHub adapter / Vercel SDK
 * directly — it consumes other modules' public repository interfaces only,
 * plus four OPTIONAL callback resolvers (`repositoryResolver`,
 * `pullRequestResolver`, `agentRunResolver`, `reviewResolver`) that the
 * composition root wires to avoid a hard module cycle between /work-items,
 * /github, /agents, and /verification.
 */

/**
 * The full content payload of an ImplementationContext revision. Persisted
 * verbatim as the `content_json` JSONB column of `wfos_implementation_contexts`.
 */
export interface ImplementationContextContent {
  // --- Core work order data (from the latest Work Order, falling back to
  // the Work Item's own fields when no Work Order exists yet). ---
  objective: string | null;
  scope: string | null;
  outOfScope: string | null;
  architectureConstraints: string | null;

  // --- Linked authoritative data (traceability chain). ---
  projectId: string;
  architectureVersionId: string;
  workItemId: string;
  workOrderId: string | null;

  // --- Requirements + acceptance criteria (resolved from /requirements). ---
  requirements: Array<{
    requirementId: string;
    title: string;
    description: string | null;
    criteria: Array<{ criterionId: string; description: string }>;
  }>;

  // --- Work Item dependencies (resolved to their titles for prompt context). ---
  dependencies: Array<{ workItemId: string; title: string }>;

  // --- Repository context (resolved from /github ProjectGitHubRepositoryRepository
  // via the optional `repositoryResolver` callback). Null when no link exists. ---
  repository: {
    owner: string | null;
    repository: string | null;
    defaultBranch: string | null;
    implementationBranch: string | null;
    currentPullRequest: { number: number; url: string; headSha: string } | null;
  };

  // --- Verification expectations. `expectedTests` is derived from the
  // resolved criteria's `verificationExpectation`; `verificationRequirements`
  // is derived from the latest Work Order's `verificationRequirements`
  // (stringified); `browserTestRequirements` is reserved for future enrichment
  // (E2E / Playwright). ---
  expectedTests: string[];
  verificationRequirements: string[];
  browserTestRequirements: string[];

  // --- Prior runs / reviews (populated on correction cycles via the optional
  // `agentRunResolver` + `reviewResolver` callbacks). ---
  priorAgentRuns: Array<{
    executionId: string;
    provider: string;
    model: string;
    status: string;
    commitRef: string | null;
    pullRequestRef: string | null;
    createdAt: string;
  }>;
  priorReviewFindings: Array<{
    reviewId: string;
    verdict: string;
    summary: string;
    findings: string[];
    createdAt: string;
  }>;

  // --- Instructions the agent MUST obey (constant default set). ---
  instructions: string[];

  // --- Architecture content (inlined for convenience — the agent should not
  // need to fetch the architecture document separately). ---
  architectureContent: string | null;
  architectureName: string | null;
}

/**
 * A persisted ImplementationContext revision. Each call to
 * {@link ImplementationContextBuilder.build} inserts a new row with
 * `revision = max(existing) + 1` and `kind` derived from prior state.
 */
export interface ImplementationContext {
  readonly id: string;
  readonly workItemId: string;
  readonly revision: number;
  readonly kind: 'initial' | 'correction';
  readonly content: ImplementationContextContent;
  readonly createdAt: Date;
}

/**
 * Persistence contract for `wfos_implementation_contexts` (migration 0021).
 * Implemented by {@link PgImplementationContextRepository}.
 */
export interface ImplementationContextRepository {
  create(input: {
    workItemId: string;
    revision: number;
    kind: 'initial' | 'correction';
    content: ImplementationContextContent;
  }): Promise<ImplementationContext>;
  findLatestByWorkItem(workItemId: string): Promise<ImplementationContext | null>;
  findByWorkItem(workItemId: string): Promise<ImplementationContext[]>;
  findById(id: string): Promise<ImplementationContext | null>;
}

/**
 * Builds + persists an ImplementationContext for a Work Item. The builder
 * reads ONLY from public repository interfaces (no agent / GitHub / Vercel
 * direct calls) and is owned by /work-items.
 */
export interface ImplementationContextBuilder {
  build(workItemId: string): Promise<ImplementationContext>;
}
