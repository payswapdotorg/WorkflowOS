import { describe, it, expect } from 'vitest';
import { detectProvider, supportedProviderIds } from '../src/providers/detector.js';
import { providerRegistry } from '../src/providers/registry.js';

describe('provider detection (§11) — generic, no automation', () => {
  it('recognizes supported provider domains', () => {
    // WORK-029 shipped Z.ai; WORK-030 shipped ChatGPT — Claude (WORK-031)
    // remains pending.
    expect(detectProvider(new URL('https://z.ai/chat'))).toMatchObject({
      providerId: 'zai', supported: true, adapterAvailable: true,
    });
    expect(detectProvider(new URL('https://chatgpt.com/c/abc'))).toMatchObject({
      providerId: 'chatgpt', supported: true, adapterAvailable: true,
    });
    expect(detectProvider(new URL('https://claude.ai/chat/123'))).toMatchObject({
      providerId: 'claude', supported: true, adapterAvailable: true,
    });
  });

  it('supports subdomains of provider domains', () => {
    expect(detectProvider(new URL('https://app.z.ai/x')).providerId).toBe('zai');
  });

  it('recognizes the ACTUAL Z.ai chat application domain (PR #31 fix: chat.z.ai)', () => {
    // The Z.ai chat app is served at https://chat.z.ai — the detector must
    // recognize it, and (verified by the static architecture check) the
    // manifest host permissions + content-script matches must cover it.
    const detection = detectProvider(new URL('https://chat.z.ai/chat/some-conversation-id'));
    expect(detection).toMatchObject({
      providerId: 'zai',
      supported: true,
      adapterAvailable: true, // WORK-029 shipped the adapter
    });
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

describe('adapter registry (§26) — fake + Z.ai (029) + ChatGPT (030) + Claude (031)', () => {
  it('registers the fake, Z.ai, ChatGPT, and Claude adapters', () => {
    expect(providerRegistry.get('fake')).not.toBeNull();
    expect(providerRegistry.get('zai')).not.toBeNull();
    expect(providerRegistry.get('chatgpt')).not.toBeNull();
    expect(providerRegistry.get('claude')).not.toBeNull();
  });

  it('surfaces Z.ai + ChatGPT + Claude as adapter-ready', () => {
    const providers = providerRegistry.listProviders();
    expect(providers.find((p) => p.providerId === 'zai')).toEqual({
      providerId: 'zai',
      displayName: 'Z.ai',
      supported: true,
      adapterAvailable: true,
    });
    expect(providers.find((p) => p.providerId === 'chatgpt')).toEqual({
      providerId: 'chatgpt',
      displayName: 'ChatGPT',
      supported: true,
      adapterAvailable: true,
      // PR #33 review: implementation surface is the coding agent (Codex);
      // readiness stays 'unverified' pending live verification.
      surfaces: {
        conversationalChat: 'ready',
        codingAgent: 'unverified',
        implementationSurface: 'coding-agent',
      },
    });
    expect(providerRegistry.pendingProviders).toEqual([]); // all shipped
  });

  it('the fake adapter declares no DOM capabilities (message-driven only)', () => {
    const fake = providerRegistry.get('fake')!;
    expect(fake.capabilities).toEqual({ openTask: true, injectPrompt: true, observe: true });
    // It matches only its own extension page.
    expect(fake.matchesPage(new URL('chrome-extension://x/ui/fake-provider/index.html'))).toBe(true);
    expect(fake.matchesPage(new URL('https://z.ai/'))).toBe(false);
  });
});
