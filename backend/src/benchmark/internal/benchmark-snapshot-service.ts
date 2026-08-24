/**
 * WORK-032: DefaultBenchmarkSnapshotService — freezes an immutable
 * BenchmarkTaskSnapshot from a template Work Item (§4).
 *
 * The snapshot captures EVERYTHING needed to reproduce the task later:
 *   - project, architecture version, requirements, criteria, work item,
 *     work order, implementation context
 *   - repository + baseline commit (immutable)
 *   - canonical promptDigest + promptVersion (§27 equality key)
 *   - verification requirements
 *   - snapshotHash (§32 integrity) + harness + scoring versions
 *
 * The snapshot is built by:
 *   1. Loading the template Work Item → ArchitectureVersion → Architecture →
 *      Project → organizationId (the canonical traceability chain).
 *   2. Loading the latest Work Order (the active task definition).
 *   3. Building an ImplementationContext (revision-bumped) via the EXISTING
 *      DefaultImplementationContextBuilder (the context authority). The
 *      benchmark does NOT re-implement context building.
 *   4. Running the EXISTING DefaultExecutionPromptBuilder on the context →
 *      canonical markdown + SHA-256 promptDigest. The benchmark does NOT
 *      re-implement prompt building.
 *   5. Resolving the repository + baseCommit via the EXISTING
 *      ProjectGitHubRepositoryRepository (the persisted project↔repo link
 *      owned by /github) + GitHubAdapter.getBranch.
 *   6. Computing snapshotHash = SHA-256 of the canonical snapshot content.
 *   7. Persisting the immutable row (the DB trigger rejects UPDATE/DELETE).
 *
 * Boundary: imports @modules/* public barrels + @platform only. Never
 * internal/. Never pg/@octokit directly.
 */
import type { Logger } from '@platform/logger.js';
import type {
  WorkItemRepository,
  WorkOrderRepository,
  ImplementationContextBuilder,
  ImplementationContextContent,
  ImplementationContextRepository,
  ExecutionPromptBuilder,
} from '@modules/work-items/index.js';
import type {
  ArchitectureRepository,
  ArchitectureVersionRepository,
} from '@modules/architecture/index.js';
import type { ProjectRepository } from '@modules/projects/index.js';
import type {
  GitHubAdapter,
  ProjectGitHubRepositoryRepository,
} from '@modules/github/index.js';
import type {
  BenchmarkTaskSnapshot,
  BenchmarkSnapshotPreview,
  CreateBenchmarkSnapshotInput,
} from '../types.js';
import type {
  BenchmarkRepository,
  BenchmarkSnapshotService,
  BenchmarkSnapshotInsert,
} from './benchmark.types.js';
import {
  BENCHMARK_HARNESS_VERSION,
  BENCHMARK_SCORING_VERSION,
  sha256Hex,
} from './benchmark-helpers.js';

const PROMPT_VERSION = 'work-027-v1'; // mirrors DefaultExecutionPromptBuilder

export interface DefaultBenchmarkSnapshotServiceDeps {
  readonly repository: BenchmarkRepository;
  readonly workItemRepository: WorkItemRepository;
  readonly workOrderRepository: WorkOrderRepository;
  readonly architectureVersionRepository: ArchitectureVersionRepository;
  readonly architectureRepository: ArchitectureRepository;
  readonly projectRepository: ProjectRepository;
  readonly implementationContextBuilder: ImplementationContextBuilder;
  readonly contextRepository: ImplementationContextRepository;
  readonly promptBuilder: ExecutionPromptBuilder;
  readonly projectGitHubRepositoryRepository: ProjectGitHubRepositoryRepository;
  readonly githubAdapter: GitHubAdapter;
  readonly logger: Logger;
}

export class DefaultBenchmarkSnapshotService implements BenchmarkSnapshotService {
  constructor(private readonly deps: DefaultBenchmarkSnapshotServiceDeps) {}

  /**
   * Preview a snapshot WITHOUT persisting (§44 creation flow). Returns the
   * canonical prompt digest + repository + baseline + snapshot hash so the
   * UI can show "SAME TASK SNAPSHOT ✓ / SAME PROMPT DIGEST ✓ / SAME BASELINE ✓"
   * before the user clicks [Create Experiment].
   *
   * READ-ONLY (PR #35 review fix #1): this path MUST NOT write to the
   * database. It calls `implementationContextBuilder.buildPreview()` (which
   * returns the canonical content + computed revision/kind WITHOUT inserting
   * a `wfos_implementation_contexts` row). No ImplementationContext is
   * persisted, no revision row is created, no audit event is emitted.
   * `implementationContextId` in the preview result is `null`.
   */
  async preview(input: { projectId: string; workItemId: string }): Promise<BenchmarkSnapshotPreview> {
    const built = await this.resolveSnapshotData(input.projectId, input.workItemId, { persist: false });
    return {
      projectId: built.projectId,
      workItemId: built.workItemId,
      workItemLabel: built.workItemLabel,
      architectureVersionId: built.architectureVersionId,
      requirementIds: built.requirementIds,
      criterionIds: built.criterionIds,
      repository: built.repository,
      baseCommit: built.baseCommit,
      implementationContextId: built.implementationContextId,
      promptDigest: built.promptDigest,
      promptVersion: built.promptVersion,
      verificationRequirements: built.verificationRequirements,
      snapshotHash: built.snapshotHash,
      harnessVersion: BENCHMARK_HARNESS_VERSION,
      scoringVersion: BENCHMARK_SCORING_VERSION,
      promptExcerpt: built.promptExcerpt,
    };
  }

  async create(input: CreateBenchmarkSnapshotInput): Promise<BenchmarkTaskSnapshot> {
    const built = await this.resolveSnapshotData(input.projectId, input.workItemId, { persist: true });
    // PR #35 review fix #1: when persist === true, resolveSnapshotData calls
    // implementationContextBuilder.build() (which persists exactly ONE row)
    // and returns the persisted id. A null here would indicate a contract
    // violation — fail loudly rather than persisting a snapshot with no
    // ImplementationContext linkage.
    if (!built.implementationContextId) {
      throw new Error('benchmark-snapshot-implementation-context-not-persisted');
    }
    const slug = input.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const insert: BenchmarkSnapshotInsert = {
      organizationId: built.organizationId,
      projectId: built.projectId,
      architectureVersionId: built.architectureVersionId,
      workItemId: built.workItemId,
      workOrderId: built.workOrderId,
      implementationContextId: built.implementationContextId,
      requirementIds: built.requirementIds,
      criterionIds: built.criterionIds,
      repository: built.repository,
      baseCommit: built.baseCommit,
      targetBranchPrefix: input.targetBranchPrefix ?? `benchmark/${slug || 'task'}`,
      promptDigest: built.promptDigest,
      promptVersion: built.promptVersion,
      verificationRequirements: built.verificationRequirements,
      snapshotHash: built.snapshotHash,
      harnessVersion: BENCHMARK_HARNESS_VERSION,
      scoringVersion: BENCHMARK_SCORING_VERSION,
    };
    return this.deps.repository.createSnapshot(insert);
  }

  private async resolveSnapshotData(projectId: string, workItemId: string, opts: { persist: boolean }): Promise<ResolvedSnapshotData> {
    // 1. Load the template work item.
    const workItem = await this.deps.workItemRepository.findById(workItemId);
    if (!workItem) {
      throw new Error('benchmark-snapshot-work-item-not-found');
    }

    // 2. Traceability chain: WorkItem → ArchitectureVersion → Architecture →
    //    Project → organizationId (the canonical resolution path).
    const archVersion = await this.deps.architectureVersionRepository.findById(workItem.architectureVersionId);
    if (!archVersion) {
      throw new Error('benchmark-snapshot-architecture-version-not-found');
    }
    const architecture = await this.deps.architectureRepository.findById(archVersion.architectureId);
    if (!architecture) {
      throw new Error('benchmark-snapshot-architecture-not-found');
    }
    if (architecture.projectId !== projectId) {
      throw new Error('benchmark-snapshot-project-mismatch');
    }
    const project = await this.deps.projectRepository.findById(projectId);
    if (!project) {
      throw new Error('benchmark-snapshot-project-not-found');
    }

    // 3. Load the latest work order (the active task definition).
    const workOrders = await this.deps.workOrderRepository.listForWorkItem(workItemId);
    const latestOrder = workOrders[workOrders.length - 1] ?? null;
    if (!latestOrder) {
      throw new Error('benchmark-snapshot-work-order-not-found');
    }

    // 4. Build the ImplementationContext via the EXISTING builder (the
    //    context authority). The benchmark does NOT re-implement context
    //    building.
    //
    //    PR #35 review fix #1: the preview path MUST NOT persist. `buildPreview()`
    //    returns the canonical content + computed revision/kind WITHOUT
    //    inserting a `wfos_implementation_contexts` row. Only the `create()`
    //    path (opts.persist === true) calls `build()`, which inserts exactly
    //    ONE row. The previous implementation called `build()` (which
    //    persisted) AND then `contextRepository.create()` again — a duplicate
    //    write that made even the read-only preview mutate project state.
    let implementationContextId: string | null;
    let contextContent: ImplementationContextContent;
    if (opts.persist) {
      const context = await this.deps.implementationContextBuilder.build(workItemId);
      implementationContextId = context.id;
      contextContent = context.content;
    } else {
      const previewCtx = await this.deps.implementationContextBuilder.buildPreview(workItemId);
      implementationContextId = null;
      contextContent = previewCtx.content;
    }

    // 5. Run the EXISTING prompt builder → canonical markdown + digest.
    //    The promptDigest is the §27 equality key across all trials that
    //    derive from this snapshot.
    const prompt = this.deps.promptBuilder.build(contextContent, { workItemLabel: workItem.workItemId });

    // 6. Resolve repository + baseCommit via the EXISTING
    //    ProjectGitHubRepositoryRepository (the persisted project↔repo link
    //    owned by /github) + GitHubAdapter.getBranch. The benchmark does
    //    NOT call the GitHub SDK directly.
    const repoLink = await this.deps.projectGitHubRepositoryRepository.findByProject(projectId);
    let repository = '';
    let baseCommit = '';
    if (repoLink) {
      repository = `${repoLink.owner}/${repoLink.repository}`;
      try {
        const branch = await this.deps.githubAdapter.getBranch({
          owner: repoLink.owner,
          repository: repoLink.repository,
          branchName: repoLink.defaultBranch,
          installationId: repoLink.installationId,
        });
        baseCommit = branch.sha;
      } catch (err) {
        this.deps.logger.warn('benchmark-snapshot-branch-resolve-failed', {
          workItemId, error: (err as Error).message,
        });
      }
    }
    if (!baseCommit) {
      throw new Error('benchmark-snapshot-baseline-commit-required');
    }

    // 7. Snapshot hash — SHA-256 of the canonical snapshot content (§32).
    const snapshotContent = JSON.stringify({
      projectId,
      architectureVersionId: workItem.architectureVersionId,
      workItemId,
      workOrderId: latestOrder.id,
      requirementIds: latestOrder.requirementIds,
      criterionIds: latestOrder.criterionIds,
      repository,
      baseCommit,
      promptDigest: prompt.digest,
      promptVersion: PROMPT_VERSION,
      verificationRequirements: latestOrder.verificationRequirements,
      harnessVersion: BENCHMARK_HARNESS_VERSION,
      scoringVersion: BENCHMARK_SCORING_VERSION,
    });
    const snapshotHash = sha256Hex(snapshotContent);

    return {
      organizationId: project.organizationId,
      projectId,
      workItemId,
      workItemLabel: workItem.workItemId,
      architectureVersionId: workItem.architectureVersionId,
      workOrderId: latestOrder.id,
      implementationContextId,
      requirementIds: latestOrder.requirementIds,
      criterionIds: latestOrder.criterionIds,
      repository,
      baseCommit,
      promptDigest: prompt.digest,
      promptVersion: PROMPT_VERSION,
      verificationRequirements: latestOrder.verificationRequirements,
      snapshotHash,
      promptExcerpt: prompt.markdown.slice(0, 400),
    };
  }
}

interface ResolvedSnapshotData {
  readonly organizationId: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly workItemLabel: string;
  readonly architectureVersionId: string;
  readonly workOrderId: string;
  /** null when produced by the read-only preview path; the persisted row id when produced by create(). */
  readonly implementationContextId: string | null;
  readonly requirementIds: readonly string[];
  readonly criterionIds: readonly string[];
  readonly repository: string;
  readonly baseCommit: string;
  readonly promptDigest: string;
  readonly promptVersion: string;
  readonly verificationRequirements: readonly unknown[];
  readonly snapshotHash: string;
  readonly promptExcerpt: string;
}
