/**
 * WORK-026: Agent Provider Registry — provider-independent readiness surface
 * for the /agents module.
 *
 * Mirrors the /llm ProviderRegistry pattern (platform/provider-registry.ts +
 * platform/default-provider-registry.ts): domain code consumes the registry
 * interface and never reads `process.env` directly for secrets. The registry
 * returns readiness information only — never secret values.
 *
 * Two layers compose:
 *   1. Platform-level {@link AgentProviderRegistry} — env-var backed, used
 *      when no per-project config exists.
 *   2. Per-project {@link AgentProviderConfigRepository} — overrides the
 *      platform default for a specific project (e.g. one project uses Gemini,
 *      another uses Claude). Stores NO secret values — only a `secretRef`
 *      (a SecretStore key name) + readiness-relevant metadata.
 *
 * {@link DefaultAgentProviderRegistryService} (in
 * ./agent-provider-registry-service.ts) composes both layers.
 *
 * This file is private to /agents (PLAT-AC-02). Cross-module imports of this
 * file are forbidden; callers consume the types exposed by the public barrel
 * (`@modules/agents/index.js`) or via DI.
 */

/**
 * Readiness-only provider configuration (no secrets). Mirrors the platform
 * `ProviderConfig` shape — kept structurally identical so the platform
 * `DefaultAgentProviderRegistry` can satisfy this interface via TypeScript
 * structural typing without the platform importing from /agents (which is
 * forbidden by the static-architecture `platform runtime does not import
 * from any domain module` invariant).
 */
export interface AgentProviderConfig {
  /** Display name (readiness metadata only — never a secret). */
  readonly name: string;
  /** Provider identifier (e.g. 'openai' | 'fake' | 'gemini' | 'claude'). */
  readonly provider: string;
  /** Model identifier (e.g. 'gpt-4o', 'gemini-1.5-pro'). */
  readonly model: string;
  /** Readiness flag — 'ready' if a usable secret exists, else 'not-configured'. */
  readonly status: 'ready' | 'not-configured';
}

/**
 * Agent provider registry — checks if agent providers are configured and
 * returns readiness information without exposing credentials.
 *
 * Mirrors the platform `ProviderRegistry` interface; the difference is naming
 * (`isProviderConfigured` vs `isConfigured`) to make the call site read
 * naturally when both registries are wired in the same composition root.
 */
export interface AgentProviderRegistry {
  /** Get available agent provider configurations (readiness only — no secrets). */
  getProviders(): AgentProviderConfig[];

  /** Validate that a provider+model combination is configured. */
  isProviderConfigured(provider: string, model: string): boolean;
}

/**
 * Persisted per-project agent provider config row. Mirrors migration 0022
 * (`wfos_agent_provider_configs`).
 *
 * IMPORTANT: this record stores a `secretRef` (a SecretStore key name) — NEVER
 * the secret value. Resolving the secret requires the SecretStore capability,
 * which is only invoked by authorized infrastructure code (SEC-001).
 */
export interface AgentProviderConfigRecord {
  readonly id: string;
  readonly projectId: string;
  readonly provider: string;
  readonly model: string;
  /** SecretStore key name (e.g. env var name) — NOT the secret value. */
  readonly secretRef: string;
  /** Readiness metadata (display name, base url, max tokens, etc.) — no secrets. */
  readonly metadata: Record<string, unknown>;
  /** Whether this is the default provider config for the project. */
  readonly isDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Repository contract for the `wfos_agent_provider_configs` table.
 *
 * At most one row per (project, provider, model) — enforced by UNIQUE.
 * At most one default per project — enforced by the partial unique index
 * `uq_agent_provider_configs_default` (see migration 0022). The `create`
 * implementation must atomically clear prior defaults within the same
 * transaction when `isDefault: true` is supplied.
 */
export interface AgentProviderConfigRepository {
  create(input: {
    projectId: string;
    provider: string;
    model: string;
    secretRef: string;
    metadata?: Record<string, unknown>;
    isDefault?: boolean;
  }): Promise<AgentProviderConfigRecord>;

  findByProject(projectId: string): Promise<AgentProviderConfigRecord[]>;

  findDefaultByProject(projectId: string): Promise<AgentProviderConfigRecord | null>;

  findByProjectProviderModel(
    projectId: string,
    provider: string,
    model: string,
  ): Promise<AgentProviderConfigRecord | null>;

  findById(id: string): Promise<AgentProviderConfigRecord | null>;

  remove(id: string): Promise<void>;
}

/**
 * WORK-027: Execution-capability surface for a provider — distinguishes the
 * NATIVE execution path (WorkflowOS → provider API → agent/model, readiness
 * backed by a configured secret) from the EXTERNAL execution path (external
 * execution package → Companion extension → the provider's chat UI, available
 * without any WorkflowOS-side credentials because the user's own browser
 * session drives it).
 *
 * Readiness metadata only — never secrets. Safe to display in the frontend.
 */
export interface ExecutionProviderInfo {
  /** Display name (e.g. 'Z.ai'). */
  readonly name: string;
  /** Provider identifier (e.g. 'zai'). */
  readonly provider: string;
  /** Model (from the configured native credential; 'default' for catalog-only entries). */
  readonly model: string;
  /** Native API readiness — 'ready' iff a usable provider credential exists. */
  readonly nativeApi: 'ready' | 'not-configured';
  /** External UI availability — catalog providers are always 'available'. */
  readonly externalUi: 'available' | 'not-supported';
}

/**
 * WORK-027: the external-UI provider catalog. Providers listed here can be
 * driven through the EXTERNAL execution mode (execution package → Companion
 * extension → the provider's native chat UI). The catalog is pure display +
 * validation metadata — NO credentials, NO URLs, NO DOM automation (those
 * belong to the Companion extension, WORK-028/029).
 */
export const EXTERNAL_UI_CATALOG: readonly { name: string; provider: string }[] = [
  { name: 'Z.ai', provider: 'zai' },
  { name: 'ChatGPT', provider: 'chatgpt' },
  { name: 'Claude', provider: 'claude' },
];
