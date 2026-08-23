/**
 * WORK-026: Default AgentProviderRegistryService.
 *
 * Composes two layers:
 *   1. Platform-level `AgentProviderRegistry` (env-var backed, constructed by
 *      the composition root as `DefaultAgentProviderRegistry`).
 *   2. Per-project `AgentProviderConfigRepository` (overrides the platform
 *      default for a specific project — e.g. one project uses Gemini,
 *      another uses Claude).
 *
 * `getProviders(projectId?)`:
 *   - With a `projectId`: returns project-specific configs (readiness resolved
 *     by checking whether the configured `secretRef` resolves to a non-null
 *     secret via the SecretStore). If the project has no configs, falls back
 *     to the platform registry's providers.
 *   - Without a `projectId`: returns the platform registry's providers.
 *
 * `isProviderConfigured(provider, model, projectId?)`:
 *   - With a `projectId`: checks the project-specific config first; if the
 *     (project, provider, model) tuple matches a stored row AND its
 *     `secretRef` resolves to a non-null secret, returns true. Otherwise
 *     falls back to the platform registry's check.
 *   - Without a `projectId`: delegates directly to the platform registry.
 *
 * The service NEVER exposes secret values — only readiness flags. The
 * underlying `SecretStore.getSecret` return value is consumed ONLY for the
 * `!== null` check and is never persisted, logged, or returned to callers.
 *
 * This file is private to /agents (PLAT-AC-02). Cross-module imports are
 * forbidden; the composition root constructs this service and injects it
 * into the consuming route (POST /projects/:projectId/agents/providers).
 */
import type { SecretStore } from '@platform/index.js';
import type {
  AgentProviderConfig,
  AgentProviderRegistry,
  AgentProviderConfigRepository,
  AgentProviderConfigRecord,
} from './agent-provider-registry.types.js';

export class DefaultAgentProviderRegistryService {
  constructor(
    private readonly platformRegistry: AgentProviderRegistry,
    private readonly projectConfigRepository: AgentProviderConfigRepository,
    private readonly secretStore: SecretStore,
  ) {}

  /**
   * Get available agent provider configurations.
   *
   * With a `projectId`: returns project-specific configs (readiness resolved
   * via SecretStore). If the project has no configs, falls back to the
   * platform registry's providers.
   *
   * Without a `projectId`: returns the platform registry's providers.
   */
  async getProviders(projectId?: string): Promise<AgentProviderConfig[]> {
    if (!projectId) {
      return this.platformRegistry.getProviders();
    }
    const records = await this.projectConfigRepository.findByProject(projectId);
    if (records.length === 0) {
      return this.platformRegistry.getProviders();
    }
    return Promise.all(records.map((r) => this.toProviderConfig(r)));
  }

  /**
   * Validate that a provider+model combination is configured.
   *
   * With a `projectId`: checks the project-specific config first; falls back
   * to the platform registry if no project config matches.
   *
   * Without a `projectId`: delegates directly to the platform registry.
   */
  async isProviderConfigured(
    provider: string,
    model: string,
    projectId?: string,
  ): Promise<boolean> {
    if (!projectId) {
      return this.platformRegistry.isProviderConfigured(provider, model);
    }
    const record = await this.projectConfigRepository.findByProjectProviderModel(
      projectId,
      provider,
      model,
    );
    if (!record) {
      return this.platformRegistry.isProviderConfigured(provider, model);
    }
    return this.hasSecret(record.secretRef);
  }

  /**
   * Map a persisted {@link AgentProviderConfigRecord} to a readiness-only
   * {@link AgentProviderConfig}. Resolves the `secretRef` via the SecretStore
   * to determine `status` — the secret value is consumed ONLY for the
   * `!== null` check and is never persisted, logged, or returned.
   */
  private async toProviderConfig(
    record: AgentProviderConfigRecord,
  ): Promise<AgentProviderConfig> {
    const ready = await this.hasSecret(record.secretRef);
    const displayName =
      typeof record.metadata.displayName === 'string'
        ? record.metadata.displayName
        : record.provider;
    return {
      name: displayName,
      provider: record.provider,
      model: record.model,
      status: ready ? 'ready' : 'not-configured',
    };
  }

  /**
   * Check that a `secretRef` resolves to a non-null secret. The secret value
   * itself is consumed ONLY for the `!== null` check — it is never persisted,
   * logged, or returned.
   */
  private async hasSecret(secretRef: string): Promise<boolean> {
    const ref = this.secretStore.ref(secretRef);
    const value = await this.secretStore.getSecret(ref);
    return value !== null && value !== '';
  }
}
