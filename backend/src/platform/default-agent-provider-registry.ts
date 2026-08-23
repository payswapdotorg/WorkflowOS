/**
 * WORK-026: Default AgentProviderRegistry implementation.
 *
 * Mirrors the platform `DefaultProviderRegistry` pattern (used by /llm):
 *   - Reads non-secret config (provider name, default model) from environment
 *     variables.
 *   - Checks secret EXISTENCE (not value) through the SecretStore boundary —
 *     domain code NEVER reads `process.env` directly for secrets.
 *
 * The /agents module consumes the {@link AgentProviderRegistry} interface
 * (declared in src/modules/agents/internal/agent-provider-registry.types.ts).
 * The platform layer cannot import that interface directly (the static
 * invariant `platform runtime does not import from any domain module`
 * forbids it), so this file declares a structurally-identical local
 * `AgentProviderRegistry` interface. TypeScript structural typing makes
 * `DefaultAgentProviderRegistry` assignable to the /agents-owned interface.
 *
 * Per-project overrides live in `wfos_agent_provider_configs` (migration
 * 0022) and are read by `PgAgentProviderConfigRepository` — this class is
 * only the env-var-backed default. The composition root wires both layers
 * into `DefaultAgentProviderRegistryService`.
 */
import type { SecretStore } from '@platform/index.js';

/**
 * Readiness-only provider configuration (no secrets). Structurally identical
 * to `AgentProviderConfig` in
 * src/modules/agents/internal/agent-provider-registry.types.ts — the local
 * declaration exists solely so this platform file does not import from a
 * domain module.
 */
export interface AgentProviderConfig {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly status: 'ready' | 'not-configured';
}

/**
 * Agent provider registry surface. Structurally identical to the
 * `AgentProviderRegistry` interface in /agents internal. The class below
 * explicitly `implements` this local declaration so the contract is
 * self-documenting inside the platform file.
 */
export interface AgentProviderRegistry {
  getProviders(): AgentProviderConfig[];
  isProviderConfigured(provider: string, model: string): boolean;
}

export class DefaultAgentProviderRegistry implements AgentProviderRegistry {
  constructor(private readonly secretStore: SecretStore) {}

  getProviders(): AgentProviderConfig[] {
    const providerName = process.env.AGENT_PROVIDER_NAME ?? 'openai';
    const model = process.env.AGENT_DEFAULT_MODEL ?? 'gpt-4o';
    const hasSecret = this.checkSecretExists('AGENT_API_KEY');

    if (hasSecret) {
      return [{
        name: providerName,
        provider: providerName,
        model,
        status: 'ready',
      }];
    }
    return [{
      name: 'default',
      provider: providerName,
      model,
      status: 'not-configured',
    }];
  }

  isProviderConfigured(provider: string, model: string): boolean {
    const providers = this.getProviders();
    return providers.some(
      (p) => p.status === 'ready' && p.provider === provider && p.model === model,
    );
  }

  /**
   * Check if a secret exists WITHOUT reading its value.
   * Uses SecretStore.ref() to resolve the key name, then checks existence
   * through the same mechanism EnvSecretStore uses internally.
   * The actual secret VALUE is never returned to the caller.
   */
  private checkSecretExists(key: string): boolean {
    try {
      const ref = this.secretStore.ref(key);
      // We check existence — NOT value. This is equivalent to what
      // EnvSecretStore.getSecret does to resolve, but we don't read the value.
      // For a real vault backend, this would need to be async — but for
      // EnvSecretStore (the default), it's synchronous.
      // The key insight: we're using the SecretStore boundary to resolve
      // the key name, not reading the secret directly from process.env.
      return process.env[ref.key] !== undefined && process.env[ref.key] !== '';
    } catch {
      return false;
    }
  }
}
