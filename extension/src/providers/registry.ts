/**
 * WorkflowOS Companion — ExternalProviderAdapterRegistry (§26).
 *
 * WORK-028 shipped the deterministic FAKE adapter (extension-page based, no
 * DOM automation). WORK-029 added the REAL Z.ai adapter; WORK-030 adds the
 * REAL ChatGPT adapter; Claude (WORK-031) remains placeholder metadata. This
 * file stays provider-neutral: no selectors, no provider-specific logic —
 * the import + register calls are the entire provider surface here.
 */
import type { ExternalProviderAdapter } from './types.js';

/** Capability metadata row (concrete — never null providerId). */
export interface ProviderInfo {
  readonly providerId: string;
  readonly displayName: string;
  readonly supported: boolean;
  readonly adapterAvailable: boolean;
}
import { fakeProviderAdapter } from './fake/fake-provider-adapter.js';
// WORK-029: the REAL Z.ai adapter (chat.z.ai, user's existing session).
import { zaiProviderAdapter } from './zai/zai-provider-adapter.js';
// WORK-030: the REAL ChatGPT adapter (chatgpt.com, user's existing session).
import { chatgptProviderAdapter } from './chatgpt/chatgpt-provider-adapter.js';

/** Placeholder metadata for providers whose adapters ship in later work items. */
export interface PendingProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly workItem: string;
}

const PENDING_PROVIDERS: readonly PendingProvider[] = [
  // WORK-029 shipped Z.ai; WORK-030 shipped ChatGPT — only Claude remains.
  { providerId: 'claude', displayName: 'Claude', workItem: 'WORK-031' },
];

export class ExternalProviderAdapterRegistry {
  private readonly adapters = new Map<string, ExternalProviderAdapter>();

  constructor() {
    // WORK-028: the deterministic fake (test mode).
    this.register(fakeProviderAdapter);
    // WORK-029: the real Z.ai web-product adapter (chat.z.ai).
    this.register(zaiProviderAdapter);
    // WORK-030: the real ChatGPT web-product adapter (chatgpt.com).
    this.register(chatgptProviderAdapter);
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
      displayName: a.displayName,
      supported: true,
      adapterAvailable: true,
    }));
    const pending = PENDING_PROVIDERS.map((p) => ({
      providerId: p.providerId,
      displayName: p.displayName,
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
