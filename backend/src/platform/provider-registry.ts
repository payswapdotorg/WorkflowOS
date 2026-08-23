/**
 * WORK-025: Provider Registry — platform-level abstraction for checking
 * LLM/Agent provider readiness without exposing secrets to domain code.
 *
 * The /llm module and the architect route consume this interface. The
 * implementation lives in the platform layer and reads configuration
 * through the existing SecretStore/config boundary.
 *
 * Domain code NEVER reads process.env directly for secrets.
 */

/** A provider configuration entry (no secrets — readiness only). */
export interface ProviderConfig {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly status: 'ready' | 'not-configured';
}

/**
 * Provider registry — checks if providers are configured and returns
 * readiness information without exposing credentials.
 */
export interface ProviderRegistry {
  /** Get all available provider configurations (readiness only). */
  getProviders(): ProviderConfig[];

  /** Check if a specific provider+model combination is configured. */
  isConfigured(provider: string, model: string): boolean;

  /** Get the default (first ready) provider, or null. */
  getDefaultProvider(): ProviderConfig | null;
}
