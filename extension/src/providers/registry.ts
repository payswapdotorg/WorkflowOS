/**
 * WorkflowOS Companion — ExternalProviderAdapterRegistry (§26).
 *
 * WORK-028: the registry contains NO real provider implementation — only the
 * deterministic FAKE adapter (extension-page based, no DOM automation) plus
 * placeholder capability metadata for Z.ai / ChatGPT / Claude (pending
 * WORK-029 / WORK-030 / WORK-031 respectively). This file stays
 * provider-neutral: no selectors, no provider-specific logic.
 */
import type { ExternalProviderAdapter } from './types.js';

/** Capability metadata row (concrete — never null providerId). */
export interface ProviderInfo {
  readonly providerId: string;
  readonly supported: boolean;
  readonly adapterAvailable: boolean;
}
import { fakeProviderAdapter } from './fake/fake-provider-adapter.js';

/** Placeholder metadata for providers whose adapters ship in later work items. */
export interface PendingProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly workItem: string;
}

const PENDING_PROVIDERS: readonly PendingProvider[] = [
  { providerId: 'zai', displayName: 'Z.ai', workItem: 'WORK-029' },
  { providerId: 'chatgpt', displayName: 'ChatGPT', workItem: 'WORK-030' },
  { providerId: 'claude', displayName: 'Claude', workItem: 'WORK-031' },
];

export class ExternalProviderAdapterRegistry {
  private readonly adapters = new Map<string, ExternalProviderAdapter>();

  constructor() {
    // WORK-028 ships exactly ONE adapter: the deterministic fake (test mode).
    this.register(fakeProviderAdapter);
  }

  register(adapter: ExternalProviderAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  get(providerId: string): ExternalProviderAdapter | null {
    return this.adapters.get(providerId) ?? null;
  }

  /** Capability surface for the popup / detection (no instantiation). */
  listProviders(): ProviderInfo[] {
    const implemented = [...this.adapters.values()].map((a) => ({
      providerId: a.providerId,
      supported: true,
      adapterAvailable: true,
    }));
    const pending = PENDING_PROVIDERS.map((p) => ({
      providerId: p.providerId,
      supported: true,
      adapterAvailable: false,
    }));
    return [...implemented, ...pending];
  }

  /** Placeholder metadata (display only — no logic). */
  get pendingProviders(): readonly PendingProvider[] {
    return PENDING_PROVIDERS;
  }
}

export const providerRegistry = new ExternalProviderAdapterRegistry();
