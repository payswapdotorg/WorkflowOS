/**
 * WORK-032: DefaultBenchmarkTrialOrchestrator — runs a single trial (§8).
 *
 * The orchestrator CONSUMES the existing ExecutionService (owned by /agents)
 * for both native and external execution. There is NO second execution engine
 * (§34 static check enforces this).
 *
 * Per-trial flow (§6 trial isolation):
 *   1. Load the snapshot (immutable baseline).
 *   2. Clone the template work item → a FRESH work item in the same project,
 *      referencing the same architecture version + requirements + criteria +
 *      dependencies. Independent workflow state (§6).
 *   3. Create a new Work Order on the cloned work item with the same
 *      scope / outOfScope / architectureConstraints / verificationRequirements
 *      as the snapshot's template work order.
 *   4. Initialize the cloned work item's workflow to 'ready' (via the existing
 *      workflowEngine.getOrCreate + transition).
 *   5. Create an isolated trial branch from the baseline commit (§6) via the
 *      existing GitHubAdapter.createBranch.
 *   6. Build the ExecutionTask via the existing ExecutionTaskService.build()
 *      (owned by /work-items). This constructs a fresh ImplementationContext
 *      (revision 1, kind 'initial') from the cloned work item — same
 *      authoritative inputs → same promptDigest (§27 invariant).
 *   7. Verify promptDigest equality (§27): if the cloned task's digest does
 *      NOT match the snapshot's digest, the trial is invalid — mark it failed
 *      with failure_kind='infrastructure'.
 *   8. Submit through ExecutionService.submit(task) — native or external.
 *      The orchestrator does NOT drive post-execution lifecycle (workflow →
 *      pr_open → verifying → review → merged → verified); that is driven by
 *      the existing workflow orchestrator + GitHub webhooks in production, or
 *      by a deterministic lifecycle driver in CI (§37/§38).
 *   9. Record the executionId / agentRunId / externalSessionRef on the trial.
 *  10. Mark the trial 'running' (BOTH native + external — execution done,
 *      awaiting delivery phase). If the native execution itself FAILED at
 *      submit time, mark the trial 'failed' terminal immediately (there is
 *      no delivery to await for a failed execution).
 *
 * Cross-trial contamination (§7): each trial gets its own cloned work item +
 * own branch. One trial's code/prompt changes/conversation/review findings
 * cannot reach another trial's work item.
 *
 * Boundary: imports @modules/* public barrels + @platform only.
 */
import type { Logger } from '@platform/logger.js';
import type { BenchmarkTrial } from '../types.js';
import type {
  BenchmarkRepository,
  BenchmarkTrialOrchestrator,
} from './benchmark.types.js';
import type {
  ExecutionService,
  AgentRunRepository,
} from '@modules/agents/index.js';
import type {
  WorkItemRepository,
  WorkOrderRepository,
  WorkItemRequirementRepository,
  WorkItemCriterionRepository,
  WorkItemDependencyRepository,
  ExecutionTaskService,
} from '@modules/work-items/index.js';
import type { WorkflowEngine } from '@modules/workflows/index.js';
import type { GitHubAdapter, ProjectGitHubRepositoryRepository } from '@modules/github/index.js';
import { generateExecutionId } from '@platform/index.js';
import { buildTrialBranchName, sha256Hex } from './benchmark-helpers.js';

export interface DefaultBenchmarkTrialOrchestratorDeps {
  readonly repository: BenchmarkRepository;
  readonly executionService: ExecutionService;
  readonly executionTaskService: ExecutionTaskService;
  readonly agentRunRepository: AgentRunRepository;
  readonly workItemRepository: WorkItemRepository;
  readonly workOrderRepository: WorkOrderRepository;
  readonly workItemRequirementRepository: WorkItemRequirementRepository;
  readonly workItemCriterionRepository: WorkItemCriterionRepository;
  readonly workItemDependencyRepository: WorkItemDependencyRepository;
  readonly workflowEngine: WorkflowEngine;
  readonly projectGitHubRepositoryRepository: ProjectGitHubRepositoryRepository;
  readonly githubAdapter: GitHubAdapter;
  readonly logger: Logger;
}

export class DefaultBenchmarkTrialOrchestrator implements BenchmarkTrialOrchestrator {
  constructor(private readonly deps: DefaultBenchmarkTrialOrchestratorDeps) {}

  async runTrial(trial: BenchmarkTrial): Promise<BenchmarkTrial> {
    // Mark the trial running.
    let current = await this.deps.repository.updateTrial(trial.id, {
      status: 'running',
      startedAt: new Date(),
    });
    if (!current) throw new Error('benchmark-trial-not-found');

    // 1. Load the snapshot (immutable baseline).
    const snapshot = await this.deps.repository.getSnapshot(trial.benchmarkTaskSnapshotId);
    if (!snapshot) {
      return this.failTrial(trial.id, 'infrastructure', 'snapshot-not-found');
    }

    try {
      // 2. Clone the template work item.
      const template = await this.deps.workItemRepository.findById(snapshot.workItemId);
      if (!template) {
        return this.failTrial(trial.id, 'infrastructure', 'template-work-item-not-found');
      }
      // Give the cloned work item a unique label derived from the trial id
      // (the DB has a UNIQUE constraint on (architecture_version_id,
      // work_item_id), so the label must be globally unique within the
      // architecture version). Using the trial id guarantees uniqueness
      // across experiments.
      const clonedLabel = `${template.workItemId}-bench-${trial.id.slice(0, 8)}`;
      const cloned = await this.deps.workItemRepository.create({
        architectureVersionId: template.architectureVersionId,
        workItemId: clonedLabel,
        title: template.title,
        objective: template.objective ?? undefined,
        scope: template.scope ?? undefined,
        outOfScope: template.outOfScope ?? undefined,
        architectureConstraints: template.architectureConstraints ?? undefined,
        assignee: template.assignee ?? undefined,
        executionMetadata: { ...template.executionMetadata, benchmarkTrialId: trial.id },
        metadata: { ...template.metadata, benchmarkTrialId: trial.id, baselineCommit: snapshot.baseCommit },
      });

      // 3. Link the same requirements + criteria + dependencies.
      const templateReqs = await this.deps.workItemRequirementRepository.listForWorkItem(snapshot.workItemId);
      for (const assoc of templateReqs) {
        await this.deps.workItemRequirementRepository.associate(cloned.id, assoc.requirementId);
      }
      const templateCrits = await this.deps.workItemCriterionRepository.listForWorkItem(snapshot.workItemId);
      for (const assoc of templateCrits) {
        await this.deps.workItemCriterionRepository.associate(cloned.id, assoc.criterionId);
      }
      const templateDeps = await this.deps.workItemDependencyRepository.listForWorkItem(snapshot.workItemId);
      for (const dep of templateDeps) {
        // PR #35 review fix #3: trial isolation requires the EXACT dependency
        // graph from the snapshot (§6). If a dependency edge cannot be
        // replicated (cycle, missing target, FK violation), the trial
        // CANNOT have the same task as the snapshot → fail loudly. Never
        // submit execution with an incomplete dependency graph (the agent
        // would receive an incomplete task, violating §6 trial isolation).
        try {
          await this.deps.workItemDependencyRepository.add(cloned.id, dep.dependsOnId);
        } catch (err) {
          this.deps.logger.error('benchmark-trial-dependency-replication-failed', {
            trialId: trial.id, clonedWorkItemId: cloned.id, dependsOnId: dep.dependsOnId, error: (err as Error).message,
          });
          const failed = await this.deps.repository.updateTrial(trial.id, {
            workItemId: cloned.id,
            status: 'failed',
            failureKind: 'infrastructure',
            failureReason: `dependency-replication-failed: dependsOnId=${dep.dependsOnId} error=${(err as Error).message}`,
            completedAt: new Date(),
          });
          if (!failed) throw new Error(`benchmark-trial-not-found: ${trial.id}`);
          return failed;
        }
      }

      // 4. Create a new Work Order with the same scope/constraints/verification.
      const templateOrders = await this.deps.workOrderRepository.listForWorkItem(snapshot.workItemId);
      const templateOrder = templateOrders[templateOrders.length - 1] ?? null;
      if (!templateOrder) {
        return this.failTrial(trial.id, 'infrastructure', 'template-work-order-not-found');
      }
      const newOrder = await this.deps.workOrderRepository.create({
        workItemId: cloned.id,
        projectId: snapshot.projectId,
        architectureVersionId: snapshot.architectureVersionId,
        requirementIds: templateOrder.requirementIds,
        criterionIds: templateOrder.criterionIds,
        architectureConstraints: templateOrder.architectureConstraints ?? undefined,
        implementationContext: templateOrder.implementationContext,
        scope: templateOrder.scope ?? undefined,
        outOfScope: templateOrder.outOfScope ?? undefined,
        verificationRequirements: templateOrder.verificationRequirements,
      });

      // 5. Initialize workflow to 'ready'.
      const wfExec = await this.deps.workflowEngine.getOrCreate(cloned.id);
      if (wfExec.currentState === 'draft') {
        await this.deps.workflowEngine.transition({
          workItemId: cloned.id,
          toState: 'ready',
          transitionType: 'benchmark-trial-init',
          actor: 'benchmark-orchestrator',
        });
      }

      // 6. Create the isolated trial branch from the baseline commit.
      // PR #35 review fix #3: §6 trial isolation requires each trial to run
      // on its OWN branch cut from the snapshot's baseline commit. If the
      // branch cannot be created, the trial CANNOT be isolated → fail
      // loudly. Never submit execution without the isolated branch (the
      // agent would push to an unprotected/shared branch, violating §6 +
      // corrupting cross-trial isolation).
      //
      // PR #35 review fix v2 / Blocker C: a snapshot can outlive its
      // project↔GitHub repository link (the link row may be removed after
      // the snapshot was frozen). When `repoLink` is null/undefined, branch
      // creation is IMPOSSIBLE → fail CLOSED. Never silently skip branch
      // creation + proceed to submit (that would push to NO isolated
      // branch, violating §6 + corrupting cross-trial state).
      const repoLink = await this.deps.projectGitHubRepositoryRepository.findByProject(snapshot.projectId);
      if (!repoLink) {
        this.deps.logger.error('benchmark-trial-repository-link-missing', {
          trialId: trial.id, projectId: snapshot.projectId,
        });
        return this.failTrial(trial.id, 'infrastructure', 'repository-link-missing');
      }
      try {
        await this.deps.githubAdapter.createBranch({
          owner: repoLink.owner,
          repository: repoLink.repository,
          branchName: trial.trialBranch,
          fromSha: trial.baselineCommit,
          installationId: repoLink.installationId,
        });
      } catch (err) {
        this.deps.logger.error('benchmark-trial-branch-create-failed', {
          trialId: trial.id, branch: trial.trialBranch, error: (err as Error).message,
        });
        const failed = await this.deps.repository.updateTrial(trial.id, {
          workItemId: cloned.id,
          workOrderId: newOrder.id,
          status: 'failed',
          failureKind: 'infrastructure',
          failureReason: `branch-creation-failed: branch=${trial.trialBranch} error=${(err as Error).message}`,
          completedAt: new Date(),
        });
        if (!failed) throw new Error(`benchmark-trial-not-found: ${trial.id}`);
        return failed;
      }

      // 7. Build the ExecutionTask (fresh ImplementationContext from the clone).
      const executionId = generateExecutionId();
      const built = await this.deps.executionTaskService.build({
        workItemId: cloned.id,
        mode: trial.executionMode,
        provider: trial.provider,
        model: trial.model,
        executionId,
      });

      // 8. Verify promptDigest equality (§27 invariant).
      // The prompt builder includes the work item LABEL in the prompt header
      // (`# Implementation Instructions — <label>`). Each trial clones the
      // template work item with a UNIQUE label (DB UNIQUE constraint on
      // (architecture_version_id, work_item_id) requires this), so the
      // clone's prompt header differs from the template's. To verify the §27
      // invariant (identical promptDigest across trials for the same task),
      // we recompute the digest using the TEMPLATE's label (replacing the
      // clone's label in the prompt markdown). The semantic content
      // (objective, scope, requirements, criteria, etc.) is byte-identical
      // because the clone references the same architecture version +
      // requirements + criteria + work order content.
      const canonicalPrompt = built.task.prompt.replace(
        `# Implementation Instructions — ${cloned.workItemId}`,
        `# Implementation Instructions — ${template.workItemId}`,
      );
      const canonicalDigest = sha256Hex(canonicalPrompt);
      if (canonicalDigest !== snapshot.promptDigest) {
        await this.deps.repository.updateTrial(trial.id, {
          workItemId: cloned.id,
          workOrderId: newOrder.id,
          implementationContextId: built.implementationContext.id,
          executionId,
        });
        return this.failTrial(
          trial.id,
          'infrastructure',
          `prompt-digest-mismatch: snapshot=${snapshot.promptDigest.slice(0, 12)} canonical=${canonicalDigest.slice(0, 12)}`,
        );
      }

      // 9. Submit through the ExecutionService boundary.
      const result = await this.deps.executionService.submit(built.task);

      // 10. Record linkage + mark the trial. Build the patch object once
      //     (BenchmarkTrialPatch fields are readonly).
      const agentRun = trial.executionMode === 'native'
        ? await this.deps.agentRunRepository.findByExecutionId(executionId)
        : null;
      const now = new Date();
      const basePatch: Record<string, unknown> = {
        workItemId: cloned.id,
        workOrderId: newOrder.id,
        implementationContextId: built.implementationContext.id,
        executionId: result.executionId,
      };
      if (trial.executionMode === 'native') {
        // PR #35 review fix v2 / Blocker B: native execution completes
        // synchronously inside `executionService.submit` — the AgentRun +
        // commit are persisted by the time `submit` returns. HOWEVER, the
        // trial does NOT mark itself `completed` here. The benchmark
        // measures COMPLETED SOFTWARE (PR → CI → Verification → Review →
        // Merge → VERIFIED), NOT completed execution. The orchestrator
        // records the linkage + sets status='running' (execution done,
        // awaiting the delivery phase). The trial is finalized to
        // 'completed' ONLY when `workflowEngine.getState(workItemId)`
        // returns `verified` — driven by the WorkflowEngine
        // `onTransition` composition hook (event-driven, no polling).
        //
        // Exception: if the native execution itself FAILED (the provider
        // returned `result.status === 'failed'`), the trial is terminal
        // 'failed' immediately — there is no delivery to await for a
        // failed execution.
        basePatch.agentRunId = agentRun?.id ?? null;
        if (result.status === 'failed') {
          basePatch.status = 'failed';
          basePatch.failureKind = 'engineering';
          basePatch.failureReason = 'native-execution-failed';
          basePatch.completedAt = now;
        } else {
          // 'completed' OR any non-terminal ExecutionState → trial
          // 'running' (awaiting delivery). The job handler will read the
          // authoritative execution record / workflow state to advance.
          basePatch.status = 'running';
        }
        // §18 native mode metadata.
        basePatch.adapterVersion = 'work-027-v1';
        basePatch.modelConfigurationVersion = 'work-027-v1';
      } else {
        // External: status is 'handoff_ready' — the companion extension
        // drives the rest. The orchestrator marks the trial 'running'.
        basePatch.status = 'running';
        basePatch.handoffIssuedAt = now;
        basePatch.externalSessionRef = null; // populated when the companion reports
        // §17 external mode metadata.
        basePatch.companionVersion = 'work-028-v1';
        basePatch.providerAdapterVersion = 'work-031-v1';
        basePatch.providerSurface = trial.provider;
      }
      current = await this.deps.repository.updateTrial(trial.id, basePatch as Parameters<typeof this.deps.repository.updateTrial>[1]);
      return current ?? trial;
    } catch (err) {
      this.deps.logger.error('benchmark-trial-orchestration-failed', {
        trialId: trial.id,
        error: (err as Error).message,
      });
      return this.failTrial(trial.id, 'infrastructure', (err as Error).message);
    }
  }

  private async failTrial(
    trialId: string,
    failureKind: 'infrastructure' | 'engineering' | 'configuration',
    reason: string,
  ): Promise<BenchmarkTrial> {
    const updated = await this.deps.repository.updateTrial(trialId, {
      status: 'failed',
      failureKind,
      failureReason: reason,
      completedAt: new Date(),
    });
    if (!updated) throw new Error(`benchmark-trial-not-found: ${trialId}`);
    return updated;
  }
}

/** Re-exported for the barrel. */
export { buildTrialBranchName };
