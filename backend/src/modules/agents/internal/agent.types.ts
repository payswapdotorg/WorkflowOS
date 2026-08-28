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
   * PR #52 round 2 (BLOCKER 1) — this request is PURE DATA. It carries no
   * capability objects of any kind: a pre-gate agent execution has NO
   * PR-creation capability (there is no port, credential, or function here
   * or anywhere in the execution contract through which a provider could
   * create a pull request). PR creation is a SEPARATE capability that exists
   * ONLY at the post-gate PullRequestCreationPort → /github boundary owned
   * by the workflow orchestrator. The round-1 policy mechanism (a request
   * field that merely ASKED providers not to create PRs) was REMOVED: a
   * contract request is not a capability boundary. The capability split is
   * now structural: the execution contract has no PR semantics at all.
   */
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
  /**
   * PR #52 round 2 (BLOCKER 1): there is DELIBERATELY no `pullRequestRef`
   * field on the execution result. A provider cannot report — and the
   * gateway cannot accept — a pull request through the agent execution
   * contract: the pre-gate phase is structurally PR-incapable. A PR that a
   * HUMAN or an out-of-band tool opens is an EXTERNAL observation that
   * enters through the execution-event/webhook ingestion boundary and is
   * adopted by the orchestrator only AFTER the architecture checkpoint gate
   * allows it. The gateway is the capability membrane: it re-projects every
   * provider return onto this interface, so properties outside the contract
   * cannot cross the boundary even at runtime.
   */
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
 * The agent execution contract is PR-INCAPABLE (PR #52 round 2, BLOCKER 1).
 * The round-1 prohibition mechanism — a post-hoc check of a provider-
 * reported PR ref AFTER `adapter.execute()` returned — was removed with the
 * field it inspected: it detected a contract violation only after the
 * forbidden side effect could already have happened. The structural fix
 * removes the capability itself (see AgentRequest/AgentExecutionResult).
 */

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
  /**
   * EXTERNAL PR observations ONLY (PR #52 round 2, BLOCKER 1): a run row's
   * PR ref can be set only by the external observation ingestion boundary
   * (execution events / webhooks) — the agent execution contract has no PR
   * semantics, so a gateway-recorded run result can never populate it.
   */
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
