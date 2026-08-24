/**
 * WORK-030 — ChatGPT background adapter + security regression tests
 * (§32/§33), mirroring the WORK-029 suite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChatgptProviderAdapter,
  resolveChatgptConfig,
} from '../../src/providers/chatgpt/chatgpt-provider-adapter.js';
import { toSessionView } from '../../src/shared/session.js';
import { providerRegistry } from '../../src/providers/registry.js';
import { detectProvider } from '../../src/providers/detector.js';
import { ZaiProviderAdapter } from '../../src/providers/zai/zai-provider-adapter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_SRC = join(HERE, '..', '..', 'src');

describe('ChatgptProviderAdapter (background side)', () => {
  it('matches the real ChatGPT domains; rejects others', () => {
    const adapter = new ChatgptProviderAdapter();
    expect(adapter.matchesPage(new URL('https://chatgpt.com/'))).toBe(true);
    expect(adapter.matchesPage(new URL('https://chatgpt.com/c/abc'))).toBe(true);
    expect(adapter.matchesPage(new URL('https://ab.chatgpt.com/c/abc'))).toBe(true);
    expect(adapter.matchesPage(new URL('https://chat.z.ai/'))).toBe(false);
    expect(adapter.matchesPage(new URL('https://example.com/'))).toBe(false);
    expect(adapter.matchesPage(new URL('https://claude.ai/'))).toBe(false);
  });

  it('fixture matching is config-driven and OFF by default', async () => {
    const adapter = new ChatgptProviderAdapter();
    expect(await adapter.matchesFixture(new URL('http://127.0.0.1:3778/'))).toBe(false);
    const staged = new ChatgptProviderAdapter(
      { sendMessage: async () => null },
      Promise.resolve({ chatgptOrigin: 'https://chatgpt.com', fixtureOrigin: 'http://127.0.0.1:3778' }),
    );
    expect(await staged.matchesFixture(new URL('http://127.0.0.1:3778/?x=1'))).toBe(true);
    expect(await staged.matchesFixture(new URL('http://127.0.0.1:9999/'))).toBe(false);
  });

  it('openTask targets the CODING surface: chatgpt.com/codex (or the staged fixture)', async () => {
    const opened: string[] = [];
    const runtime = {
      openTab: async (url: string) => {
        opened.push(url);
        return 1;
      },
      closeTab: async () => undefined,
      getActiveTabId: async () => null,
      extensionPageUrl: (p: string) => p,
    };
    const prod = new ChatgptProviderAdapter(
      { sendMessage: async () => null },
      Promise.resolve({ chatgptOrigin: 'https://chatgpt.com' }),
    );
    await prod.openTask({} as never, runtime);
    // PR #33 review: implementation targets Codex — never the Chat root.
    expect(opened[0]).toBe('https://chatgpt.com/codex');

    const staged = new ChatgptProviderAdapter(
      { sendMessage: async () => null },
      Promise.resolve({ chatgptOrigin: 'https://chatgpt.com', fixtureOrigin: 'http://127.0.0.1:3778' }),
    );
    await staged.openTask({} as never, runtime);
    expect(opened[1]).toBe('http://127.0.0.1:3778');
  });

  it('injectPrompt REFUSES when the prompt was already submitted (duplicate guard)', async () => {
    const port = { sendMessage: vi.fn(async () => null) };
    const adapter = new ChatgptProviderAdapter(port);
    await adapter.injectPrompt(
      { executionId: 'wf_1', promptSubmitted: true } as never,
      {
        openTab: async () => 1,
        closeTab: async () => undefined,
        getActiveTabId: async () => 42,
        extensionPageUrl: (p: string) => p,
      },
    );
    expect(port.sendMessage).not.toHaveBeenCalled(); // §33: no resubmit path
  });

  it('stop() notifies the page runtime via the tab port', async () => {
    const port = { sendMessage: vi.fn(async () => null) };
    const adapter = new ChatgptProviderAdapter(port);
    await adapter.stop({ executionId: 'wf_1' } as never, {
      openTab: async () => 1,
      closeTab: async () => undefined,
      getActiveTabId: async () => 7,
      extensionPageUrl: (p: string) => p,
    });
    expect(port.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'STOP_EXECUTION', executionId: 'wf_1' }),
    );
  });

  it('is registered; Z.ai + Claude + fake all present and preserved (§29)', () => {
    expect(providerRegistry.get('chatgpt')).toBeInstanceOf(ChatgptProviderAdapter);
    expect(providerRegistry.get('zai')).toBeInstanceOf(ZaiProviderAdapter); // preserved
    expect(providerRegistry.get('fake')).not.toBeNull(); // preserved
    expect(providerRegistry.get('claude')).not.toBeNull(); // WORK-031 shipped
    expect(detectProvider(new URL('https://chatgpt.com/c/x')).adapterAvailable).toBe(true);
    expect(detectProvider(new URL('https://chat.z.ai/')).adapterAvailable).toBe(true);
    expect(detectProvider(new URL('https://claude.ai/')).adapterAvailable).toBe(true);
  });

  it('registry lists chatgpt with display name + surface capabilities; all adapters shipped', () => {
    const providers = providerRegistry.listProviders();
    expect(providers.find((p) => p.providerId === 'chatgpt')).toEqual({
      providerId: 'chatgpt',
      displayName: 'ChatGPT',
      supported: true,
      adapterAvailable: true,
      surfaces: {
        conversationalChat: 'ready',
        codingAgent: 'unverified',
        implementationSurface: 'coding-agent',
      },
    });
    expect(providerRegistry.pendingProviders).toEqual([]); // Claude shipped (WORK-031)
  });

  it('describeSurfaces(): implementation surface is coding-agent; coding stays unverified (no fixture-only readiness)', () => {
    const adapter = new ChatgptProviderAdapter();
    expect(adapter.describeSurfaces()).toEqual({
      conversationalChat: 'ready',
      codingAgent: 'unverified',
      implementationSurface: 'coding-agent',
    });
  });
});

describe('WORK-030 §33 — security regressions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolveChatgptConfig reads the fixture origin ONLY from storage.session', async () => {
    const stored: Record<string, unknown> = {};
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        session: {
          get: async (keys: string[]) => {
            const out: Record<string, unknown> = {};
            for (const k of keys) if (k in stored) out[k] = stored[k];
            return out;
          },
          set: async (items: Record<string, unknown>) => Object.assign(stored, items),
        },
      },
    };
    stored['wfos.chatgpt.fixtureOrigin'] = 'http://127.0.0.1:3778';
    expect((await resolveChatgptConfig()).fixtureOrigin).toBe('http://127.0.0.1:3778');
    delete stored['wfos.chatgpt.fixtureOrigin'];
    expect((await resolveChatgptConfig()).fixtureOrigin).toBeUndefined();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('the page session + SessionView carry NO credential material (callback token never reaches the adapter)', () => {
    const view = toSessionView({
      executionId: 'wf_1',
      provider: 'chatgpt',
      providerLabel: 'ChatGPT',
      projectId: 'p',
      workItemId: 'wi',
      workItemLabel: 'WORK-1',
      repository: 'o/r',
      branch: 'feat/x',
      prompt: 'prompt',
      structuredInstructions: [],
      verificationRequirements: [],
      expectedOutputs: [],
      promptDigest: 'd',
      workflowosOrigin: 'http://localhost:5173',
      callback: {
        token: 'wfct_SECRET'.padEnd(40, 'x'),
        expiresAt: new Date().toISOString(),
        origin: 'http://localhost:5173',
      },
      status: 'running',
      startedAt: null,
      openedTabId: 1,
      promptSubmitted: true,
      phase: 'agent-running',
      blockedReason: null,
      externalSessionRef: '/c/abc',
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('wfct_');
    expect(serialized).not.toContain('callback');
  });

  it('ChatGPT sources never touch cookies, storage APIs, API keys, or WorkflowOS HTTP', () => {
    const files = [
      'chatgpt-provider-adapter.ts',
      'chatgpt-page-runtime.ts',
      'chatgpt-selectors.ts',
      'chatgpt-types.ts',
    ];
    for (const file of files) {
      const src = readFileSync(join(EXT_SRC, 'providers', 'chatgpt', file), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${file} must not read cookies`).not.toMatch(/document\.cookie|chrome\.cookies/);
      expect(code, `${file} must not use localStorage`).not.toMatch(/localStorage|storage\.local/);
      expect(code, `${file} must not send API keys`).not.toMatch(/x-api-key|Authorization/);
      expect(code, `${file} must not call WorkflowOS HTTP`).not.toMatch(
        /\/api\/companion|\/api\/execution/,
      );
      expect(code, `${file} must not mutate workflow state`).not.toMatch(
        /workflow\/transitions|request-merge|advance-to-verified/,
      );
      expect(code, `${file} must not evaluate untrusted output`).not.toMatch(
        /eval\s*\(|new Function\s*\(|innerHTML\s*=/,
      );
    }
  });

  it('chatgpt-bridge content script contains NO ChatGPT DOM selectors', () => {
    const src = readFileSync(join(EXT_SRC, 'content', 'chatgpt-bridge.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/querySelector|getElementById|getElementsBy/);
    expect(code).not.toMatch(/prompt-textarea|send-button|data-testid/);
  });

  it('Claude automation now exists as its OWN adapter (WORK-031 shipped)', () => {
    expect(existsSyncSafe(join(EXT_SRC, 'providers', 'claude', 'claude-provider-adapter.ts'))).toBe(true);
    expect(existsSyncSafe(join(EXT_SRC, 'content', 'claude-bridge.ts'))).toBe(true);
  });
});

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
