/**
 * WORK-026: DefaultImplementationContextBuilder.
 *
 * Assembles a self-contained ImplementationContext revision for a Work Item
 * by reading ONLY from public repository interfaces of other modules
 * (`/work-items`, `/architecture`, `/requirements`). Runtime data
 * (GitHub repository link, current PR, prior agent runs, prior review
 * findings) is fetched through four OPTIONAL callback resolvers that the
 * composition root (SUB-F) wires — this avoids a hard module cycle between
 * /work-items, /github, /agents, and /verification.
 *
 * The builder does NOT:
 *   - call the AgentGateway (it only persists the context; submission is
 *     delegated to the route + an optional `startImplementationService`),
 *   - call the GitHub adapter / Vercel SDK directly,
 *   - mutate workflow state (workflow transitions remain the exclusive
 *     authority of /workflows).
 *
 * Determinism contract (mirrors SUB-B FakeDeploymentProvider):
 *   - The persisted revision number is `max(existing revisions) + 1` (or 1
 *     for the first revision). No `Math.random()` / `Date.now()` is used in
 *     the persisted payload — `createdAt` comes from the database
 *     `DEFAULT NOW()` and is read back after INSERT.
 *   - The `kind` is `'correction'` iff (a) a prior ImplementationContext
 *     revision exists for the work item, OR (b) the optional
 *     `reviewResolver` returned at least one finding with verdict
 *     `'REQUEST_CHANGES'`. Otherwise `'initial'`.
 *
 * All SQL is parameterized — but the builder issues NO SQL of its own. It
 * consumes the {@link ImplementationContextRepository} abstraction (which
 * uses parameterized SQL internally).
 */
import type {
  ArchitectureRepository,
  ArchitectureVersionRepository,
} from '@modules/architecture/index.js';
import type {
  RequirementRepository,
  AcceptanceCriterionRepository,
} from '@modules/requirements/index.js';
import type {
  WorkItemRepository,
  WorkOrderRepository,
  WorkItemRequirementRepository,
  WorkItemCriterionRepository,
  WorkItemDependencyRepository,
} from './work-item.types.js';
import type {
  ImplementationContext,
  ImplementationContextBuilder,
  ImplementationContextContent,
  ImplementationContextRepository,
} from './implementation-context.types.js';

/**
 * Optional callback resolvers — the composition root (SUB-F) wires these to
 * the /github, /agents, /verification, and /reviews modules' public
 * interfaces. When omitted, the corresponding ImplementationContextContent
 * fields are populated with safe defaults (empty arrays / null repository).
 *
 * Each resolver is a flat constructor parameter (not a nested object) so the
 * composition root can wire only the resolvers it has without populating an
 * empty object literal.
 */
export type RepositoryResolver = (projectId: string) => Promise<{
  owner: string;
  repository: string;
  defaultBranch: string;
} | null>;

export type PullRequestResolver = (workItemId: string) => Promise<{
  number: number;
  url: string;
  headSha: string;
} | null>;

export type AgentRunResolver = (workItemId: string) => Promise<
  Array<{
    executionId: string;
    provider: string;
    model: string;
    status: string;
    commitRef: string | null;
    pullRequestRef: string | null;
    createdAt: string;
  }>
>;

export type ReviewResolver = (workItemId: string) => Promise<
  Array<{
    reviewId: string;
    verdict: string;
    summary: string;
    findings: string[];
    createdAt: string;
  }>
>;

/**
 * Default implementation of {@link ImplementationContextBuilder}. Constructed
 * only by the composition root (`backend/src/app.ts`).
 */
export class DefaultImplementationContextBuilder
  implements ImplementationContextBuilder
{
  constructor(
    private readonly workItemRepository: WorkItemRepository,
    private readonly workOrderRepository: WorkOrderRepository,
    private readonly workItemRequirementRepository: WorkItemRequirementRepository,
    private readonly workItemCriterionRepository: WorkItemCriterionRepository,
    private readonly workItemDependencyRepository: WorkItemDependencyRepository,
    private readonly requirementRepository: RequirementRepository,
    private readonly acceptanceCriterionRepository: AcceptanceCriterionRepository,
    private readonly architectureVersionRepository: ArchitectureVersionRepository,
    private readonly architectureRepository: ArchitectureRepository,
    private readonly contextRepository: ImplementationContextRepository,
    // Optional resolvers for runtime data — callbacks to avoid module cycle:
    private readonly repositoryResolver?: RepositoryResolver,
    private readonly pullRequestResolver?: PullRequestResolver,
    private readonly agentRunResolver?: AgentRunResolver,
    private readonly reviewResolver?: ReviewResolver,
  ) {}

  async build(workItemId: string): Promise<ImplementationContext> {
    // 1. Load the work item (throw if not found).
    const workItem = await this.workItemRepository.findById(workItemId);
    if (!workItem) {
      throw new Error(
        `ImplementationContextBuilder: work item not found: ${workItemId}`,
      );
    }

    // 2. Load the architecture version + architecture (for content + name).
    const architectureVersion = await this.architectureVersionRepository.findById(
      workItem.architectureVersionId,
    );
    if (!architectureVersion) {
      throw new Error(
        `ImplementationContextBuilder: architecture version not found: ${workItem.architectureVersionId}`,
      );
    }
    const architecture = await this.architectureRepository.findById(
      architectureVersion.architectureId,
    );
    if (!architecture) {
      throw new Error(
        `ImplementationContextBuilder: architecture not found: ${architectureVersion.architectureId}`,
      );
    }

    // 3. Load all work_item_requirements for this work item, then resolve each
    // to its requirement + criteria. Criteria are resolved once and grouped
    // by requirementId to avoid an N+1 query pattern.
    const wiReqAssocs =
      await this.workItemRequirementRepository.listForWorkItem(workItemId);
    const wiCritAssocs =
      await this.workItemCriterionRepository.listForWorkItem(workItemId);

    const resolvedCriteria = await Promise.all(
      wiCritAssocs.map(async (ca) =>
        this.acceptanceCriterionRepository.findById(ca.criterionId),
      ),
    );
    const criteriaByRequirementId = new Map<
      string,
      Array<{ criterionId: string; description: string }>
    >();
    const expectedTests: string[] = [];
    for (const crit of resolvedCriteria) {
      // FK guarantees existence — if find() returns null here, that's a real
      // data-integrity violation, NOT a "skip and continue" situation. The
      // agent must NEVER receive an incomplete context while WorkflowOS
      // believes context generation succeeded.
      if (!crit) {
        throw new Error(
          'implementation-context-criterion-missing: ' +
            'a work_item_criteria association references a criterion id that does not resolve. ' +
            'The implementation context cannot be generated; this is a data-integrity violation.',
        );
      }
      const list = criteriaByRequirementId.get(crit.requirementId) ?? [];
      list.push({ criterionId: crit.id, description: crit.description });
      criteriaByRequirementId.set(crit.requirementId, list);
      if (crit.verificationExpectation) {
        expectedTests.push(crit.verificationExpectation);
      }
    }

    const requirements: ImplementationContextContent['requirements'] = [];
    for (const assoc of wiReqAssocs) {
      const requirement = await this.requirementRepository.findById(
        assoc.requirementId,
      );
      // FK guarantees existence — a missing requirement means a data-integrity
      // violation. The agent must NEVER receive an incomplete context. Fail
      // loudly so the caller can fix the underlying data instead of silently
      // producing instructions that omit a requirement.
      if (!requirement) {
        throw new Error(
          'implementation-context-requirement-missing: ' +
            `a work_item_requirements association references requirement id "${assoc.requirementId}" ` +
            'that does not resolve. The implementation context cannot be generated; ' +
            'this is a data-integrity violation.',
        );
      }
      requirements.push({
        requirementId: requirement.id,
        title: requirement.title,
        description: requirement.description,
        criteria: criteriaByRequirementId.get(requirement.id) ?? [],
      });
    }

    // 4. Load all work_item_dependencies for this work item, then resolve each
    // target work item (title).
    const deps =
      await this.workItemDependencyRepository.listForWorkItem(workItemId);
    const dependencies: ImplementationContextContent['dependencies'] = [];
    for (const dep of deps) {
      const target = await this.workItemRepository.findById(dep.dependsOnId);
      // FK guarantees existence — a missing dependency target means a
      // data-integrity violation. The agent must NEVER receive an incomplete
      // context (missing a dependency means it won't know to wait for it).
      if (!target) {
        throw new Error(
          'implementation-context-dependency-missing: ' +
            `a work_item_dependencies association references target work item id "${dep.dependsOnId}" ` +
            'that does not resolve. The implementation context cannot be generated; ' +
            'this is a data-integrity violation.',
        );
      }
      dependencies.push({ workItemId: target.id, title: target.title });
    }

    // 5. Load the latest work order for this work item (if any) — for
    // objective/scope/outOfScope/architectureConstraints. The Work Order
    // repository returns rows in created_at ASC order, so the LAST entry is
    // the most recent.
    const workOrders =
      await this.workOrderRepository.listForWorkItem(workItemId);
    const workOrder =
      workOrders.length > 0
        ? workOrders[workOrders.length - 1] ?? null
        : null;

    // 6. Compute the next revision number (max existing revision + 1, or 1
    // if none).
    const latestContext =
      await this.contextRepository.findLatestByWorkItem(workItemId);
    const nextRevision = latestContext ? latestContext.revision + 1 : 1;

    // 11. Resolve prior review findings via reviewResolver(workItemId) (if
    // provided). Resolved here so the `kind` determination (step 7) can use it.
    const priorReviewFindings: ImplementationContextContent['priorReviewFindings'] =
      this.reviewResolver ? await this.reviewResolver(workItemId) : [];

    // 7. Determine kind: 'correction' if there are prior review findings with
    // verdict 'REQUEST_CHANGES' OR prior implementation contexts exist; else
    // 'initial'.
    const priorContextsExist = latestContext !== null;
    const hasRequestChanges = priorReviewFindings.some(
      (r) => r.verdict === 'REQUEST_CHANGES',
    );
    const kind: 'initial' | 'correction' =
      priorContextsExist || hasRequestChanges ? 'correction' : 'initial';

    // 8. Resolve repository info via repositoryResolver(projectId) (if provided).
    let repositoryInfo: ImplementationContextContent['repository'] = {
      owner: null,
      repository: null,
      defaultBranch: null,
      implementationBranch: null,
      currentPullRequest: null,
    };
    if (this.repositoryResolver) {
      const repo = await this.repositoryResolver(architecture.projectId);
      if (repo) {
        repositoryInfo = {
          owner: repo.owner,
          repository: repo.repository,
          defaultBranch: repo.defaultBranch,
          // The resolver does not return an implementation branch name. The
          // agent derives a deterministic branch from the work item ID at
          // execution time. Left null here so the agent prompt surfaces the
          // default branch as the merge target.
          implementationBranch: null,
          currentPullRequest: null,
        };
      }
    }

    // 9. Resolve current PR via pullRequestResolver(workItemId) (if provided).
    if (this.pullRequestResolver) {
      const pr = await this.pullRequestResolver(workItemId);
      if (pr) {
        repositoryInfo = { ...repositoryInfo, currentPullRequest: pr };
      }
    }

    // 10. Resolve prior agent runs via agentRunResolver(workItemId) (if provided).
    const priorAgentRuns: ImplementationContextContent['priorAgentRuns'] =
      this.agentRunResolver ? await this.agentRunResolver(workItemId) : [];

    // 12. Construct the ImplementationContextContent with all the above +
    // default instructions. The instructions are a constant default set —
    // every agent run is told the same invariants.
    const content: ImplementationContextContent = {
      objective: workItem.objective,
      scope: workOrder?.scope ?? workItem.scope,
      outOfScope: workOrder?.outOfScope ?? workItem.outOfScope,
      architectureConstraints:
        workOrder?.architectureConstraints ?? workItem.architectureConstraints,
      projectId: architecture.projectId,
      architectureVersionId: workItem.architectureVersionId,
      workItemId: workItem.id,
      workOrderId: workOrder?.id ?? null,
      requirements,
      dependencies,
      repository: repositoryInfo,
      expectedTests,
      verificationRequirements: stringifyVerificationRequirements(
        workOrder?.verificationRequirements,
      ),
      // Reserved for future E2E / Playwright enrichment (no source yet).
      browserTestRequirements: [],
      priorAgentRuns,
      priorReviewFindings,
      instructions: DEFAULT_AGENT_INSTRUCTIONS,
      architectureContent: architectureVersion.contentInline,
      architectureName: architecture.name,
    };

    // 13. Persist via contextRepository.create(...).
    const persisted = await this.contextRepository.create({
      workItemId,
      revision: nextRevision,
      kind,
      content,
    });

    // 14. Return the persisted ImplementationContext.
    return persisted;
  }
}

/**
 * The default instruction set every agent receives. These are invariants,
 * not negotiable.
 */
const DEFAULT_AGENT_INSTRUCTIONS: string[] = [
  'Run the repository test suite.',
  'Run typecheck and lint.',
  'Run browser E2E tests where applicable.',
  'Do not bypass architecture boundaries.',
  'Do not mark verification criteria as PASS.',
  'Commit changes and push the branch.',
  'Open or update the PR when implementation is ready.',
];

/**
 * Convert the Work Order's opaque `verificationRequirements: unknown[]`
 * into a deterministic `string[]`. Strings are kept verbatim; objects with a
 * `description` string field use that; everything else is JSON-stringified.
 * Null / undefined entries are dropped.
 */
function stringifyVerificationRequirements(
  input: unknown[] | undefined,
): string[] {
  if (!input || input.length === 0) return [];
  const out: string[] = [];
  for (const entry of input) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry === 'string') {
      out.push(entry);
      continue;
    }
    if (typeof entry === 'object' && entry !== null) {
      const desc = (entry as { description?: unknown }).description;
      if (typeof desc === 'string') {
        out.push(desc);
        continue;
      }
    }
    out.push(JSON.stringify(entry));
  }
  return out;
}
