/**
 * WORK-032 §37: DeterministicExternalBenchmarkProvider — an ExecutionProvider
 * implementation that simulates the external Companion lifecycle WITHOUT a
 * real browser session or real provider account.
 *
 * Variants (selected by the `variant` constructor option):
 *   - 'perfect-first-pass'   → external handoff → completed event with PR.
 *   - 'one-correction'       → first completion → REQUEST_CHANGES → second.
 *   - 'ci-failure'           → completion → CI evidence with failing conclusion.
 *   - 'verification-failure' → completion → verification run with failing criterion.
 *
 * The provider implements the /agents ExecutionProvider boundary (mode='external').
 * It returns a 'handoff_ready' submission with a deterministic package (same
 * shape the real ExternalExecutionProvider returns). The post-execution
 * lifecycle (companion redemption, started/progress/completed events, PR, CI,
 * verification, review) is driven by the test fixture's lifecycle driver via
 * the existing execution-event-ingestion + GitHub + workflow + verification +
 * review authorities.
 *
 * SECURITY: the package contains NO secrets (no GitHub tokens, no LLM API
 * keys, no callback tokens). The returnCallback uses the scoped callback
 * token mechanism (x-callback-token header) — the token itself is issued
 * separately by the ExecutionHandoffService and is NOT embedded here.
 *
 * Boundary: implements @modules/agents ExecutionProvider.
 */
import type {
  ExecutionProvider,
  ExecutionTask,
  ExecutionSubmission,
  ExternalExecutionPackage,
} from '@modules/agents/index.js';

export type DeterministicExternalVariant =
  | 'perfect-first-pass'
  | 'one-correction'
  | 'ci-failure'
  | 'verification-failure';

export interface DeterministicExternalBenchmarkProviderOptions {
  readonly variant: DeterministicExternalVariant;
}

export class DeterministicExternalBenchmarkProvider implements ExecutionProvider {
  readonly name = 'external';
  readonly mode = 'external' as const;

  constructor(private readonly opts: DeterministicExternalBenchmarkProviderOptions) {}

  async submit(task: ExecutionTask): Promise<ExecutionSubmission> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour

    const pkg: ExternalExecutionPackage = {
      executionId: task.executionId,
      mode: 'external',
      projectId: task.projectId,
      workItemId: task.workItemId,
      workItemLabel: task.workItemLabel,
      workOrderId: task.workOrderId,
      implementationContextId: task.implementationContextId,
      provider: task.provider,
      model: task.model,
      repository: {
        owner: task.repositoryOwner,
        name: task.repositoryName,
        url: task.repositoryOwner && task.repositoryName ? `https://github.com/${task.repositoryOwner}/${task.repositoryName}` : null,
        defaultBranch: task.repositoryDefaultBranch,
      },
      branch: task.implementationBranch ?? `trial/${task.executionId}`,
      prompt: task.prompt,
      structuredInstructions: task.instructions,
      verificationRequirements: task.verificationRequirements,
      expectedOutputs: task.expectedOutputs,
      browserTestRequirements: [],
      returnCallback: {
        eventsPath: `/execution/${task.executionId}/events`,
        eventTypes: ['started', 'progress', 'completed', 'failed'],
        auth: 'x-callback-token',
        note: 'Deterministic external benchmark provider — use the scoped callback token issued by the handoff service.',
      },
      expiration: expiresAt.toISOString(),
      // AR-043-03: the authoritative dispatch-event timestamp (stamped at the
      // package derivation — the simulated dispatch initiation), mirroring
      // the real ExternalExecutionProvider's contract.
      dispatchedAt: now.toISOString(),
    };

    return {
      executionId: task.executionId,
      provider: task.provider,
      mode: 'external',
      status: 'handoff_ready',
      externalSessionRef: `deterministic-${this.opts.variant}-${task.executionId}`,
      startedAt: now,
      expiresAt,
      package: pkg,
    };
  }
}
