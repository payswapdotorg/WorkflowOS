/**
 * WorkflowOS Companion — ExternalProviderAdapterRegistry (§26).
 *
 * WORK-028 shipped the deterministic FAKE adapter (extension-page based, no
 * DOM automation). WORK-029 added the REAL Z.ai adapter; WORK-030 added the
 * REAL ChatGPT adapter; WORK-031 added the REAL Claude adapter. This file
 * stays provider-neutral: no selectors, no provider-specific logic — the
 * import + register calls are the entire provider surface here.
 */
import type { ExternalProviderAdapter, ProviderSurfaceCapabilities } from './types.js';

/** Capability metadata row (concrete — never null providerId). */
export interface ProviderInfo {
  readonly providerId: string;
  readonly displayName: string;
  readonly supported: boolean;
  readonly adapterAvailable: boolean;
  /** WORK-030 (PR #33 review): surface capabilities when the adapter declares them. */
  readonly surfaces?: ProviderSurfaceCapabilities;
}
import { fakeProviderAdapter } from './fake/fake-provider-adapter.js';
// WORK-029: the REAL Z.ai adapter (chat.z.ai, user's existing session).
import { zaiProviderAdapter } from './zai/zai-provider-adapter.js';
// WORK-030: the REAL ChatGPT adapter (chatgpt.com, user's existing session).
import { chatgptProviderAdapter } from './chatgpt/chatgpt-provider-adapter.js';
// WORK-031: the REAL Claude adapter (claude.ai, user's existing session).
import { claudeProviderAdapter } from './claude/claude-provider-adapter.js';

/** Placeholder metadata for providers whose adapters ship in later work items. */
export interface PendingProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly workItem: string;
}

const PENDING_PROVIDERS: readonly PendingProvider[] = [
  // WORK-029 shipped Z.ai; WORK-030 shipped ChatGPT; WORK-031 shipped
  // Claude — no pending provider adapters remain.
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
    // WORK-031: the real Claude web-product adapter (claude.ai).
    this.register(claudeProviderAdapter);
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
      surfaces: a.describeSurfaces?.(),
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
