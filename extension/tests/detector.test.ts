import { describe, it, expect } from 'vitest';
import { detectProvider, supportedProviderIds } from '../src/providers/detector.js';
import { providerRegistry } from '../src/providers/registry.js';

describe('provider detection (§11) — generic, no automation', () => {
  it('recognizes supported provider domains', () => {
    expect(detectProvider(new URL('https://z.ai/chat'))).toMatchObject({
      providerId: 'zai', supported: true, adapterAvailable: false,
    });
    expect(detectProvider(new URL('https://chatgpt.com/c/abc'))).toMatchObject({
      providerId: 'chatgpt', supported: true, adapterAvailable: false,
    });
    expect(detectProvider(new URL('https://claude.ai/chat/123'))).toMatchObject({
      providerId: 'claude', supported: true, adapterAvailable: false,
    });
  });

  it('supports subdomains of provider domains', () => {
    expect(detectProvider(new URL('https://app.z.ai/x')).providerId).toBe('zai');
  });

  it('marks unknown domains unsupported', () => {
    const result = detectProvider(new URL('https://example.com/'));
    expect(result).toEqual({ providerId: null, supported: false, adapterAvailable: false });
  });

  it('detects the extension-internal fake provider page', () => {
    expect(detectProvider(new URL('chrome-extension://abc/ui/fake-provider/index.html'))).toEqual({
      providerId: 'fake', supported: true, adapterAvailable: true,
    });
    // Other extension pages are not providers.
    expect(detectProvider(new URL('chrome-extension://abc/ui/popup/index.html')).providerId).toBeNull();
  });

  it('lists all supported provider ids', () => {
    expect(supportedProviderIds().sort()).toEqual(['chatgpt', 'claude', 'fake', 'zai']);
  });
});

describe('adapter registry (§26) — no real provider adapters in WORK-028', () => {
  it('registers exactly one adapter: the deterministic fake', () => {
    expect(providerRegistry.get('fake')).not.toBeNull();
    expect(providerRegistry.get('zai')).toBeNull();
    expect(providerRegistry.get('chatgpt')).toBeNull();
    expect(providerRegistry.get('claude')).toBeNull();
  });

  it('surfaces placeholders as supported-but-pending with their work items', () => {
    const providers = providerRegistry.listProviders();
    const zai = providers.find((p) => p.providerId === 'zai');
    expect(zai).toEqual({ providerId: 'zai', supported: true, adapterAvailable: false });
    const meta = providerRegistry.pendingProviders;
    expect(meta.find((m) => m.providerId === 'zai')?.workItem).toBe('WORK-029');
    expect(meta.find((m) => m.providerId === 'chatgpt')?.workItem).toBe('WORK-030');
    expect(meta.find((m) => m.providerId === 'claude')?.workItem).toBe('WORK-031');
  });

  it('the fake adapter declares no DOM capabilities (message-driven only)', () => {
    const fake = providerRegistry.get('fake')!;
    expect(fake.capabilities).toEqual({ openTask: true, injectPrompt: true, observe: true });
    // It matches only its own extension page.
    expect(fake.matchesPage(new URL('chrome-extension://x/ui/fake-provider/index.html'))).toBe(true);
    expect(fake.matchesPage(new URL('https://z.ai/'))).toBe(false);
  });
});
