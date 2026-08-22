import type {
  LlmProviderAdapter,
  LlmRequest,
  LlmResponse,
  LlmUsage,
  LlmError,
  LlmGateway,
} from './llm.types.js';
import type { Logger } from "@platform/logger.js";
import type { DatabaseClient } from "@platform/index.js";
import { PgLlmExecutionRecordRepository } from "./pg-llm-repository.js";

/**
 * Deterministic fake LLM adapter for tests. Does NOT make real API calls.
 * Returns a configurable response or throws a configurable error.
 */
export class FakeLlmAdapter implements LlmProviderAdapter {
  readonly providerName = 'fake';
  private responseContent = 'Fake LLM response';
  private shouldFail: { type: import('./llm.types.js').LlmErrorType; message: string; retryable: boolean } | null = null;
  private callCount = 0;
  private failOnCall = 0; // fail on the Nth call (1-based); 0 = never fail

  setResponse(content: string): void {
    this.responseContent = content;
  }

  setFailure(type: import('./llm.types.js').LlmErrorType, message: string, retryable: boolean, failOnCall = 1): void {
    this.shouldFail = { type, message, retryable };
    this.failOnCall = failOnCall;
  }

  getCallCount(): number {
    return this.callCount;
  }

  supports(provider: string, _model: string): boolean {
    return provider === 'fake';
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    this.callCount++;
    if (this.shouldFail && this.callCount <= this.failOnCall) {
      const err = this.shouldFail;
      throw {
        type: err.type,
        message: err.message,
        provider: this.providerName,
        retryable: err.retryable,
      } as import('./llm.types.js').LlmError;
    }
    const usage: LlmUsage = {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    };
    return {
      content: this.responseContent,
      provider: this.providerName,
      model: request.model,
      finishReason: 'stop',
      usage,
      executionId: request.executionId,
      metadata: {},
    };
  }
}

/**
 * Default {@link LlmGateway} implementation (LLM-001..005).
 *
 * Owns: provider selection, retry policy, usage recording, error normalization.
 * Provider adapters classify provider-specific errors; the gateway owns retry
 * policy — adapters do not retry themselves.
 */
export class DefaultLlmGateway implements LlmGateway {
  private readonly adapters: Map<string, LlmProviderAdapter>;
  private readonly recordRepo: PgLlmExecutionRecordRepository;
  private readonly maxRetries: number;

  constructor(
    db: DatabaseClient,
    private readonly logger: Logger,
    adapters: readonly LlmProviderAdapter[],
    maxRetries = 3,
  ) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      this.adapters.set(adapter.providerName, adapter);
    }
    this.recordRepo = new PgLlmExecutionRecordRepository(db);
    this.maxRetries = maxRetries;
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    // 1. Select adapter.
    const adapter = this.adapters.get(request.provider);
    if (!adapter || !adapter.supports(request.provider, request.model)) {
      throw {
        type: 'invalid_request' as const,
        message: `unsupported provider/model: ${request.provider}/${request.model}`,
        provider: request.provider,
        retryable: false,
      } as import('./llm.types.js').LlmError;
    }

    // 2. Create execution record.
    const record = await this.recordRepo.create({
      executionId: request.executionId,
      workItemId: request.workItemId,
      provider: request.provider,
      model: request.model,
      requestMetadata: request.metadata,
      maxRetries: this.maxRetries,
    });

    // 3. Retry loop (centralized in gateway — adapters don't retry).
    let lastError: LlmError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await adapter.generate(request);

        // 4. Record success.
        await this.recordRepo.updateSuccess(record.id, response.content, response.usage);
        this.logger.info('llm.generate.success', {
          executionId: request.executionId,
          provider: request.provider,
          model: request.model,
          attempt,
          usage: response.usage,
        });

        return response;
      } catch (err) {
        lastError = err as LlmError;

        // 5. Classify error — non-retryable errors fail immediately.
        if (!lastError.retryable) {
          await this.recordRepo.updateFailed(record.id, lastError.type, lastError.message, attempt);
          this.logger.warn('llm.generate.non_retryable', {
            executionId: request.executionId,
            error: lastError,
            attempt,
          });
          throw lastError;
        }

        // 6. Retryable error — retry if attempts remain.
        if (attempt < this.maxRetries) {
          this.logger.info('llm.generate.retrying', {
            executionId: request.executionId,
            error: lastError.message,
            attempt,
            maxRetries: this.maxRetries,
          });
          // Exponential backoff (deterministic: 2^attempt * 100ms).
          const delayMs = Math.pow(2, attempt) * 100;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    // 7. All retries exhausted.
    await this.recordRepo.updateFailed(record.id, lastError!.type, lastError!.message, this.maxRetries);
    this.logger.error('llm.generate.exhausted', {
      executionId: request.executionId,
      error: lastError,
    });
    throw lastError!;
  }
}
