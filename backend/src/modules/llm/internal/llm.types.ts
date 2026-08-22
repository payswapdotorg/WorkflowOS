/**
 * LLM Gateway domain types (LLM-001..005).
 *
 * The /llm module owns the LLM Gateway: provider selection, model selection,
 * request/response normalization, retries, usage recording, error handling.
 * Provider-specific SDK code stays inside /llm internal/. Credentials via
 * SecretStore (SEC-001).
 */

// --- Provider-independent request ---

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LlmRequest {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly systemInstruction?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly executionId: string;
  readonly workItemId?: string;
  readonly metadata?: Record<string, unknown>;
}

// --- Provider-independent response ---

export interface LlmResponse {
  readonly content: string;
  readonly provider: string;
  readonly model: string;
  readonly finishReason: 'stop' | 'length' | 'content_filter' | 'tool_call' | 'unknown';
  readonly usage: LlmUsage;
  readonly executionId: string;
  readonly metadata: Record<string, unknown>;
}

export interface LlmUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

// --- Error normalization ---

export type LlmErrorType =
  | 'retryable'
  | 'non_retryable'
  | 'authentication'
  | 'rate_limit'
  | 'invalid_request'
  | 'provider_unavailable'
  | 'unknown';

export interface LlmError {
  readonly type: LlmErrorType;
  readonly message: string;
  readonly provider: string;
  readonly retryable: boolean;
}

// --- Provider adapter interface (internal) ---

/**
 * Internal adapter interface. Concrete implementations use provider SDKs
 * (OpenAI, Anthropic, etc.) but the gateway sees only this interface.
 * Tests use a deterministic fake.
 */
export interface LlmProviderAdapter {
  readonly providerName: string;

  /** Execute a request against the provider. Returns a normalized response or throws an LlmError. */
  generate(request: LlmRequest): Promise<LlmResponse>;

  /** Check if the adapter supports the given provider/model combination. */
  supports(provider: string, model: string): boolean;
}

// --- Gateway interface (public) ---

/**
 * The LLM Gateway is the provider-independent entry point. Later consumers
 * (Architect Service, Work Order generation) call `generate(request)` without
 * knowing which provider/SDK is active.
 */
export interface LlmGateway {
  /**
   * Generate a response using the configured provider/model.
   * Handles: provider selection, retries, usage recording, error normalization.
   */
  generate(request: LlmRequest): Promise<LlmResponse>;
}

// --- Execution record (persistence) ---

export type LlmExecutionStatus = 'pending' | 'in_progress' | 'success' | 'failed';

export interface LlmExecutionRecord {
  readonly id: string;
  readonly executionId: string;
  readonly workItemId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly requestMetadata: Record<string, unknown>;
  readonly responseContent: string | null;
  readonly usageMetadata: Record<string, unknown>;
  readonly status: LlmExecutionStatus;
  readonly errorType: string | null;
  readonly errorMessage: string | null;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LlmExecutionRecordRepository {
  create(input: {
    executionId: string;
    workItemId?: string;
    provider: string;
    model: string;
    requestMetadata?: Record<string, unknown>;
    maxRetries?: number;
  }): Promise<LlmExecutionRecord>;
  findById(id: string): Promise<LlmExecutionRecord | null>;
  findByExecutionId(executionId: string): Promise<LlmExecutionRecord | null>;
  findByWorkItem(workItemId: string): Promise<LlmExecutionRecord[]>;
  updateSuccess(id: string, responseContent: string, usage: LlmUsage): Promise<LlmExecutionRecord | null>;
  updateFailed(id: string, errorType: LlmErrorType, errorMessage: string, retryCount: number): Promise<LlmExecutionRecord | null>;
}
