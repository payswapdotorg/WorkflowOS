/**
 * OpenAI-compatible LLM provider adapter (PRODUCTION READINESS).
 *
 * Implements the existing {@link LlmProviderAdapter} interface — no new
 * architecture. This adapter works with any OpenAI-compatible API endpoint,
 * including:
 *   - OpenAI (https://api.openai.com/v1)
 *   - Z.ai (https://api.z.ai/api/paas/v4)
 *   - Mistral (https://api.mistral.ai/v1)
 *   - any other OpenAI-compatible provider
 *
 * The adapter is configured through environment variables:
 *   LLM_API_KEY       — the provider API key
 *   LLM_BASE_URL      — the provider's base URL (e.g. https://api.openai.com/v1)
 *   LLM_DEFAULT_MODEL — the default model name (e.g. gpt-4o, glm-4-flash)
 *
 * The provider name is "openai-compatible" so the LlmGateway can route
 * requests to it when `provider: "openai-compatible"` is specified.
 */
import type {
  LlmProviderAdapter,
  LlmRequest,
  LlmResponse,
  LlmUsage,
  LlmError,
  LlmErrorType,
  LlmMessage,
} from './llm.types.js';

export interface OpenAiCompatibleConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  providerName?: string;
}

export class OpenAiCompatibleLlmAdapter implements LlmProviderAdapter {
  readonly providerName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(config: OpenAiCompatibleConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.defaultModel = config.defaultModel;
    this.providerName = config.providerName ?? 'openai-compatible';
  }

  supports(provider: string, _model: string): boolean {
    return provider === this.providerName || provider === 'openai-compatible';
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const model = request.model || this.defaultModel;
    const messages: LlmMessage[] = [];
    if (request.systemInstruction) {
      messages.push({ role: 'system', content: request.systemInstruction });
    }
    messages.push(...request.messages);

    const body: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (request.maxTokens !== undefined) body['max_tokens'] = request.maxTokens;
    if (request.temperature !== undefined) body['temperature'] = request.temperature;

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '');
        const errorType = this.classifyHttpError(res.status);
        const err: LlmError = {
          type: errorType,
          message: `HTTP ${res.status}: ${errorBody.slice(0, 500)}`,
          provider: this.providerName,
          retryable: errorType === 'retryable' || errorType === 'rate_limit' || errorType === 'provider_unavailable',
        };
        throw err;
      }

      const data = await res.json() as {
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      const content = data.choices?.[0]?.message?.content ?? '';
      const finishReason = (data.choices?.[0]?.finish_reason ?? 'unknown') as LlmResponse['finishReason'];
      const usage: LlmUsage = {
        promptTokens: data.usage?.prompt_tokens ?? null,
        completionTokens: data.usage?.completion_tokens ?? null,
        totalTokens: data.usage?.total_tokens ?? null,
      };

      return {
        content,
        provider: this.providerName,
        model,
        finishReason,
        usage,
        executionId: request.executionId,
        metadata: {},
      };
    } catch (err) {
      // Re-throw LlmError as-is.
      if (err && typeof err === 'object' && 'type' in err && 'provider' in err) {
        throw err;
      }
      // Network error.
      const llmError: LlmError = {
        type: 'provider_unavailable',
        message: (err as Error).message,
        provider: this.providerName,
        retryable: true,
      };
      throw llmError;
    }
  }

  private classifyHttpError(status: number): LlmErrorType {
    if (status === 401 || status === 403) return 'authentication';
    if (status === 429) return 'rate_limit';
    if (status >= 400 && status < 500) return 'invalid_request';
    if (status >= 500) return 'provider_unavailable';
    return 'unknown';
  }
}

/**
 * Create an OpenAI-compatible adapter from environment variables.
 * Returns undefined when LLM_API_KEY is not set (tests/dev use FakeLlmAdapter).
 */
export function createOpenAiCompatibleAdapterFromEnv(): OpenAiCompatibleLlmAdapter | undefined {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return undefined;
  const baseUrl = process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1';
  const defaultModel = process.env.LLM_DEFAULT_MODEL ?? 'gpt-4o';
  const providerName = process.env.LLM_PROVIDER_NAME ?? 'openai-compatible';
  return new OpenAiCompatibleLlmAdapter({ apiKey, baseUrl, defaultModel, providerName });
}
