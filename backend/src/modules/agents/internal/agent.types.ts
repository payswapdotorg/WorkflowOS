/**
 * Agent Gateway domain types (AGENT-001, AGENT-002).
 *
 * /agents owns the Agent Gateway + Agent Runs. Provider-specific code stays
 * inside /agents internal/. Agent execution is distinct from LLM execution
 * (spec §17). Agent output is claim/evidence input only — it must NOT
 * directly mutate workflow state, mark criteria PASS, or bypass /workflows.
 */

// --- Agent status (spec §15) ---

export type AgentStatus = 'pending' | 'in_progress' | 'success' | 'failed' | 'cancelled';

export type AgentErrorType =
  | 'retryable'
  | 'non_retryable'
  | 'authentication'
  | 'rate_limit'
  | 'invalid_request'
  | 'provider_unavailable'
  | 'execution_failed'
  | 'blocked'
  | 'cancelled'
  | 'unknown';

// --- Provider-independent request ---

export interface AgentRequest {
  readonly provider: string;
  readonly configuration: Record<string, unknown>;
  readonly workItemId: string;
  readonly workOrderId: string;
  readonly architectureVersionId?: string;
  readonly executionId: string;
  readonly repositoryRef?: string;
  readonly branch?: string;
  readonly workOrderConstraints?: string;
  readonly scope?: string;
  readonly input: string;
  readonly metadata?: Record<string, unknown>;
  /**
   * WORK-051 round 1 (PR #52 review, BLOCKER 2): the PR-creation capability
   * for this execution phase.
   *
   * - 'provider-managed' (default — backward compatible): the provider owns
   *   PR creation for its execution and may report a `pullRequestRef`.
   * - 'prohibited': this phase MUST NOT create a pull request. A provider
   *   that returns a non-null `pullRequestRef` under prohibition VIOLATES
   *   the contract — the gateway fails the run and throws the typed
   *   {@link AgentPullRequestProhibitedError} (fail closed). The governed
   *   convergence path (the architecture checkpoint gate) uses this policy
   *   for its pre-gate implementation phase: the PR is created ONLY after
   *   the architecture checkpoint allows it, through the PR-creation
   *   boundary the orchestrator owns — never as an agent side effect that
   *   could precede the gate.
   */
  readonly pullRequestPolicy?: 'prohibited' | 'provider-managed';
}

// --- Provider-independent result ---

export interface AgentExecutionResult {
  readonly status: AgentStatus;
  readonly output: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly executionId: string;
  readonly provider: string;
  readonly configuration: Record<string, unknown>;
  readonly commitRef: string | null;
  readonly pullRequestRef: string | null;
  readonly reportedTests: AgentTestReport[];
  readonly reportedBlockers: AgentBlockerReport[];
  readonly error: AgentError | null;
  readonly metadata: Record<string, unknown>;
}

export interface AgentTestReport {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'skip';
  readonly message?: string;
}

export interface AgentBlockerReport {
  readonly description: string;
  readonly severity: 'info' | 'warning' | 'error';
}

export interface AgentError {
  readonly type: AgentErrorType;
  readonly message: string;
  readonly provider: string;
  readonly retryable: boolean;
}

/**
 * WORK-051 round 1 (PR #52 review, BLOCKER 2) — the typed contract violation
 * raised when a provider reports a pull request for an execution whose
 * {@link AgentRequest.pullRequestPolicy} is 'prohibited'. The gateway fails
 * the run and throws this error: the pre-checkpoint phase structurally
 * cannot yield a PR, regardless of what a provider does.
 */
export class AgentPullRequestProhibitedError extends Error
  implements AgentError
{
  readonly type = 'invalid_request' as const;
  readonly retryable = false;

  constructor(
    readonly provider: string,
    readonly executionId: string,
    readonly pullRequestRef: string,
  ) {
    super(
      `agent contract violation: provider '${provider}' reported pull request '${pullRequestRef}' ` +
        `for execution ${executionId} whose pullRequestPolicy is 'prohibited' — ` +
        'the pre-checkpoint implementation phase cannot create pull requests; ' +
        'PR creation happens only after the architecture checkpoint gate allows it',
    );
    this.name = 'AgentPullRequestProhibitedError';
  }
}

// --- Provider adapter interface (internal) ---

export interface AgentProviderAdapter {
  readonly providerName: string;
  supports(provider: string): boolean;
  execute(request: AgentRequest): Promise<AgentExecutionResult>;
}

// --- Gateway interface (public) ---

export interface AgentGateway {
  execute(request: AgentRequest): Promise<AgentExecutionResult>;
}

// --- Agent Run persistence ---

export interface AgentRun {
  readonly id: string;
  readonly executionId: string;
  readonly workItemId: string;
  readonly workOrderId: string | null;
  readonly architectureVersionId: string | null;
  readonly provider: string;
  readonly configuration: Record<string, unknown>;
  readonly repositoryRef: string | null;
  readonly branch: string | null;
  readonly status: AgentStatus;
  readonly output: string | null;
  readonly outputStorageKey: string | null;
  readonly outputStorageProvider: string | null;
  readonly commitRef: string | null;
  readonly pullRequestRef: string | null;
  readonly reportedTests: AgentTestReport[];
  readonly reportedBlockers: AgentBlockerReport[];
  readonly executionMetadata: Record<string, unknown>;
  readonly errorType: string | null;
  readonly errorMessage: string | null;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AgentRunRepository {
  create(input: {
    executionId: string;
    workItemId: string;
    workOrderId?: string;
    architectureVersionId?: string;
    provider: string;
    configuration?: Record<string, unknown>;
    repositoryRef?: string;
    branch?: string;
    maxRetries?: number;
  }): Promise<AgentRun>;
  findById(id: string): Promise<AgentRun | null>;
  findByExecutionId(executionId: string): Promise<AgentRun | null>;
  findByWorkItem(workItemId: string): Promise<AgentRun[]>;
  updateSuccess(id: string, result: AgentExecutionResult): Promise<AgentRun | null>;
  updateFailed(id: string, error: AgentError, retryCount: number): Promise<AgentRun | null>;
}
