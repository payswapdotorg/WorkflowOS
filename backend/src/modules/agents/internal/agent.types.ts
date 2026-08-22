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
