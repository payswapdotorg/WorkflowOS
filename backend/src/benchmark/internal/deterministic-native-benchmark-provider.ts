/**
 * WORK-032 §38: DeterministicNativeBenchmarkProvider — an ExecutionProvider
 * implementation that produces KNOWN variants for CI parity, WITHOUT calling
 * a real LLM provider.
 *
 * Variants (selected by the `variant` constructor option):
 *   - 'perfect-first-pass'   → native execution succeeds; commit + PR reported.
 *   - 'one-correction'       → first run succeeds; the lifecycle driver
 *                               then drives a REQUEST_CHANGES review + a
 *                               second execution that also succeeds.
 *   - 'ci-failure'           → execution succeeds but CI evidence will be
 *                               ingested with a failing conclusion.
 *   - 'verification-failure' → execution succeeds but the verification run
 *                               will report a failing criterion.
 *
 * The provider implements the /agents ExecutionProvider boundary (mode='native').
 * It creates an AgentRun directly via the AgentRunRepository (the same
 * repository the real NativeExecutionProvider uses through the AgentGateway)
 * and finalizes it with a synthetic success result. No real LLM is called.
 *
 * The post-execution lifecycle (workflow transitions, PR association, CI
 * evidence, verification, review) is driven by the test fixture's lifecycle
 * driver — NOT by this provider. This keeps the provider focused on the
 * execution step (§8: "A trial invokes the existing ExecutionService").
 *
 * Boundary: implements @modules/agents ExecutionProvider. Imports
 * AgentRunRepository from the /agents public barrel.
 */
import type {
  ExecutionProvider,
  ExecutionTask,
  ExecutionSubmission,
  AgentRunRepository,
} from '@modules/agents/index.js';

export type DeterministicNativeVariant =
  | 'perfect-first-pass'
  | 'one-correction'
  | 'ci-failure'
  | 'verification-failure';

export interface DeterministicNativeBenchmarkProviderOptions {
  readonly variant: DeterministicNativeVariant;
  readonly agentRunRepository: AgentRunRepository;
}

export class DeterministicNativeBenchmarkProvider implements ExecutionProvider {
  readonly name = 'native';
  readonly mode = 'native' as const;

  constructor(private readonly opts: DeterministicNativeBenchmarkProviderOptions) {}

  async submit(task: ExecutionTask): Promise<ExecutionSubmission> {
    // Create the AgentRun row (the same repository the real provider uses).
    const run = await this.opts.agentRunRepository.create({
      executionId: task.executionId,
      workItemId: task.workItemId,
      workOrderId: task.workOrderId,
      architectureVersionId: task.architectureVersionId ?? undefined,
      provider: task.provider,
      configuration: { model: task.model, variant: this.opts.variant },
      repositoryRef: task.repositoryOwner && task.repositoryName ? `${task.repositoryOwner}/${task.repositoryName}` : undefined,
      branch: task.implementationBranch ?? undefined,
      maxRetries: 1,
    });

    const now = new Date();
    const commitRef = `${task.executionId}-commit-0`;
    const pullRequestRef = `${task.executionId}-pr-1`;
    const startedAt = new Date(now.getTime() - 60_000);

    // Finalize the run with a synthetic success result.
    // PR #52 round 2 (BLOCKER 1): the execution result is PR-incapable —
    // no pullRequestRef on the agent run (the synthetic PR ref below is
    // BENCHMARK TELEMETRY on the submission only, mimicking an external
    // provider's observation report; it never enters the governed path).
    await this.opts.agentRunRepository.updateSuccess(run.id, {
      status: 'success',
      output: `Deterministic native execution (${this.opts.variant}) for ${task.workItemLabel}.`,
      startedAt,
      completedAt: now,
      executionId: task.executionId,
      provider: task.provider,
      configuration: { model: task.model, variant: this.opts.variant },
      commitRef,
      reportedTests: [{ name: 'deterministic-test', status: 'pass' }],
      reportedBlockers: [],
      error: null,
      metadata: { variant: this.opts.variant, benchmark: true },
    });

    return {
      executionId: task.executionId,
      provider: task.provider,
      mode: 'native',
      status: 'completed',
      agentRunId: run.id,
      commitRef,
      pullRequestRef,
      startedAt,
      completedAt: now,
    };
  }
}
