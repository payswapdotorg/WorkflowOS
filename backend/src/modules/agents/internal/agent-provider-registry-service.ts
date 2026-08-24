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
  ExecutionProviderInfo,
} from './agent-provider-registry.types.js';
import { EXTERNAL_UI_CATALOG, type ProviderSurfaceCapabilities } from './agent-provider-registry.types.js';

/** Catalog surface capabilities for a provider (undefined → not cataloged). */
export function catalogCapabilities(provider: string): ProviderSurfaceCapabilities | undefined {
  return EXTERNAL_UI_CATALOG.find((c) => c.provider === provider)?.capabilities;
}

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
   * Return the platform-default provider name (when the platform registry has
   * a ready provider). Used by the start-implementation route as the fallback
   * when the caller does not explicitly supply a provider. Returns undefined
   * when no platform provider is ready (the route then returns 400).
   */
  getPlatformDefaultProvider(): string | undefined {
    const ready = this.platformRegistry.getProviders().find(p => p.status === 'ready');
    return ready?.provider;
  }

  /**
   * Return the platform-default model (when the platform registry has a ready
   * provider). Used by the start-implementation route as the fallback when
   * the caller does not explicitly supply a model.
   */
  getPlatformDefaultModel(): string | undefined {
    const ready = this.platformRegistry.getProviders().find(p => p.status === 'ready');
    return ready?.model;
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

  // ---------------------------------------------------------------------
  // WORK-027: execution capability surface (native vs external).
  // ---------------------------------------------------------------------

  /**
   * List providers with their EXECUTION capabilities: native API readiness
   * (backed by a configured credential) + external UI availability (catalog).
   *
   * Merges:
   *   1. The EXTERNAL_UI_CATALOG entries (Z.ai / ChatGPT / Claude) — external
   *      'available' by design; native readiness reflects configuration.
   *   2. Any configured provider (platform or project layer) not already in
   *      the catalog — surfaced with its native readiness and external
   *      'not-supported' (only catalog providers have a Companion-extension
   *      execution path).
   *
   * Readiness metadata only — never secrets. Safe for frontend display.
   */
  async getExecutionProviders(projectId?: string): Promise<ExecutionProviderInfo[]> {
    const configured = await this.getProviders(projectId);
    const catalogProviders = new Set(EXTERNAL_UI_CATALOG.map((c) => c.provider));

    const result: ExecutionProviderInfo[] = EXTERNAL_UI_CATALOG.map((entry) => {
      const native = configured.find((c) => c.provider === entry.provider && c.status === 'ready');
      return {
        name: entry.name,
        provider: entry.provider,
        model: native?.model ?? 'default',
        nativeApi: native ? 'ready' : 'not-configured',
        externalUi: 'available' as const,
        capabilities: entry.capabilities,
      };
    });

    for (const c of configured) {
      if (catalogProviders.has(c.provider)) continue;
      result.push({
        name: c.name,
        provider: c.provider,
        model: c.model,
        nativeApi: c.status === 'ready' ? 'ready' : 'not-configured',
        externalUi: 'not-supported',
      });
    }

    return result;
  }

  /**
   * Whether `provider` can be driven through the EXTERNAL execution mode
   * (i.e. it is in the external-UI catalog). External execution needs NO
   * WorkflowOS-side credential for the provider — the user's own browser
   * session in the external platform drives it.
   */
  async isExternalProviderSupported(provider: string, _projectId?: string): Promise<boolean> {
    return EXTERNAL_UI_CATALOG.some((c) => c.provider === provider);
  }
}
