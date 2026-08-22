import type { DatabaseClient } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type {
  AgentGateway, AgentRequest, AgentExecutionResult, AgentError,
  AgentProviderAdapter,
} from './agent.types.js';
import { PgAgentRunRepository } from './pg-agent-repository.js';

/** Deterministic fake agent adapter for tests. */
export class FakeAgentAdapter implements AgentProviderAdapter {
  readonly providerName = 'fake';
  private output = 'Fake agent output';
  private failure: { type: import('./agent.types.js').AgentErrorType; message: string; retryable: boolean } | null = null;
  private failCount = 0;
  private callCount = 0;

  setOutput(output: string): void { this.output = output; }
  setFailure(type: import('./agent.types.js').AgentErrorType, message: string, retryable: boolean, failCount = 1): void {
    this.failure = { type, message, retryable };
    this.failCount = failCount;
  }
  reset(): void {
    this.failure = null;
    this.failCount = 0;
    this.callCount = 0;
    this.output = 'Fake agent output';
  }
  getCallCount(): number { return this.callCount; }

  supports(provider: string): boolean { return provider === 'fake'; }

  async execute(request: AgentRequest): Promise<AgentExecutionResult> {
    this.callCount++;
    if (this.failure && this.callCount <= this.failCount) {
      throw {
        type: this.failure.type, message: this.failure.message,
        provider: this.providerName, retryable: this.failure.retryable,
      } as AgentError;
    }
    return {
      status: 'success', output: this.output,
      startedAt: new Date(), completedAt: new Date(),
      executionId: request.executionId, provider: this.providerName,
      configuration: request.configuration,
      commitRef: 'abc123', pullRequestRef: 'github:owner/repo#1',
      reportedTests: [{ name: 'test-1', status: 'pass' }],
      reportedBlockers: [],
      error: null, metadata: {},
    };
  }
}

/** Default AgentGateway — owns retry policy + Agent Run persistence. */
export class DefaultAgentGateway implements AgentGateway {
  private readonly adapters: Map<string, AgentProviderAdapter>;
  private readonly runRepo: PgAgentRunRepository;
  private readonly maxRetries: number;

  constructor(
    db: DatabaseClient,
    private readonly logger: Logger,
    adapters: readonly AgentProviderAdapter[],
    maxRetries = 3,
  ) {
    this.adapters = new Map();
    for (const a of adapters) this.adapters.set(a.providerName, a);
    this.runRepo = new PgAgentRunRepository(db);
    this.maxRetries = maxRetries;
  }

  async execute(request: AgentRequest): Promise<AgentExecutionResult> {
    const adapter = this.adapters.get(request.provider);
    if (!adapter || !adapter.supports(request.provider)) {
      throw {
        type: 'invalid_request' as const, retryable: false,
        message: `unsupported agent provider: ${request.provider}`,
        provider: request.provider,
      } as AgentError;
    }

    const run = await this.runRepo.create({
      executionId: request.executionId, workItemId: request.workItemId,
      workOrderId: request.workOrderId, architectureVersionId: request.architectureVersionId,
      provider: request.provider, configuration: request.configuration,
      repositoryRef: request.repositoryRef, branch: request.branch, maxRetries: this.maxRetries,
    });

    let lastError: AgentError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await adapter.execute(request);
        await this.runRepo.updateSuccess(run.id, result);
        this.logger.info('agent.execute.success', { executionId: request.executionId, attempt });
        return result;
      } catch (err) {
        lastError = err as AgentError;
        if (!lastError.retryable || attempt >= this.maxRetries) {
          await this.runRepo.updateFailed(run.id, lastError, attempt);
          this.logger.warn('agent.execute.failed', { executionId: request.executionId, error: lastError, attempt });
          throw lastError;
        }
        this.logger.info('agent.execute.retrying', { executionId: request.executionId, attempt, error: lastError.message });
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 100));
      }
    }
    await this.runRepo.updateFailed(run.id, lastError!, this.maxRetries);
    throw lastError!;
  }
}
