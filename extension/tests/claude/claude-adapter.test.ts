/**
 * WORK-031 — Claude background adapter + security regression tests
 * (§30/§31), mirroring the WORK-029/030 suites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaudeProviderAdapter,
  resolveClaudeConfig,
} from '../../src/providers/claude/claude-provider-adapter.js';
import { toSessionView } from '../../src/shared/session.js';
import { providerRegistry } from '../../src/providers/registry.js';
import { detectProvider } from '../../src/providers/detector.js';
import { ZaiProviderAdapter } from '../../src/providers/zai/zai-provider-adapter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_SRC = join(HERE, '..', '..', 'src');

describe('ClaudeProviderAdapter (background side)', () => {
  it('matches the real Claude domains; rejects others', () => {
    const adapter = new ClaudeProviderAdapter();
    expect(adapter.matchesPage(new URL('https://claude.ai/'))).toBe(true);
    expect(adapter.matchesPage(new URL('https://claude.ai/chat/abc'))).toBe(true);
    expect(adapter.matchesPage(new URL('https://claude.ai/code'))).toBe(true);
    expect(adapter.matchesPage(new URL('https://ab.claude.ai/chat/x'))).toBe(true);
    expect(adapter.matchesPage(new URL('https://claude.com/'))).toBe(true); // redirect host
    expect(adapter.matchesPage(new URL('https://chat.z.ai/'))).toBe(false);
    expect(adapter.matchesPage(new URL('https://chatgpt.com/'))).toBe(false);
    expect(adapter.matchesPage(new URL('https://example.com/'))).toBe(false);
  });

  it('fixture matching is config-driven and OFF by default', async () => {
    const adapter = new ClaudeProviderAdapter();
    expect(await adapter.matchesFixture(new URL('http://127.0.0.1:3779/'))).toBe(false);
    const staged = new ClaudeProviderAdapter(
      { sendMessage: async () => null },
      Promise.resolve({ claudeOrigin: 'https://claude.ai', fixtureOrigin: 'http://127.0.0.1:3779' }),
    );
    expect(await staged.matchesFixture(new URL('http://127.0.0.1:3779/?x=1'))).toBe(true);
    expect(await staged.matchesFixture(new URL('http://127.0.0.1:9999/'))).toBe(false);
  });

  it('openTask targets the CODING surface: claude.ai/code (or the staged fixture)', async () => {
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
    const prod = new ClaudeProviderAdapter(
      { sendMessage: async () => null },
      Promise.resolve({ claudeOrigin: 'https://claude.ai' }),
    );
    await prod.openTask({} as never, runtime);
    // PR #33 review: implementation targets Codex — never the Chat root.
    expect(opened[0]).toBe('https://claude.ai/code');

    const staged = new ClaudeProviderAdapter(
      { sendMessage: async () => null },
      Promise.resolve({ claudeOrigin: 'https://claude.ai', fixtureOrigin: 'http://127.0.0.1:3779' }),
    );
    await staged.openTask({} as never, runtime);
    expect(opened[1]).toBe('http://127.0.0.1:3779');
  });

  it('injectPrompt REFUSES when the prompt was already submitted (duplicate guard)', async () => {
    const port = { sendMessage: vi.fn(async () => null) };
    const adapter = new ClaudeProviderAdapter(port);
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
    const adapter = new ClaudeProviderAdapter(port);
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

  it('is registered alongside Z.ai + ChatGPT + fake — all preserved (§29)', () => {
    expect(providerRegistry.get('claude')).toBeInstanceOf(ClaudeProviderAdapter);
    expect(providerRegistry.get('chatgpt')).not.toBeNull(); // preserved (WORK-030)
    expect(providerRegistry.get('zai')).toBeInstanceOf(ZaiProviderAdapter); // preserved (WORK-029)
    expect(providerRegistry.get('fake')).not.toBeNull(); // preserved (WORK-028)
    expect(detectProvider(new URL('https://claude.ai/code')).adapterAvailable).toBe(true);
    expect(detectProvider(new URL('https://chatgpt.com/c/x')).adapterAvailable).toBe(true);
    expect(detectProvider(new URL('https://chat.z.ai/')).adapterAvailable).toBe(true);
  });

  it('registry lists claude with display name + surface capabilities', () => {
    const providers = providerRegistry.listProviders();
    expect(providers.find((p) => p.providerId === 'claude')).toEqual({
      providerId: 'claude',
      displayName: 'Claude',
      supported: true,
      adapterAvailable: true,
      surfaces: {
        conversationalChat: 'ready',
        codingAgent: 'unverified',
        implementationSurface: 'coding-agent',
      },
    });
    expect(providerRegistry.pendingProviders).toEqual([]); // all adapters shipped
  });

  it('describeSurfaces(): implementation surface is coding-agent; coding stays unverified (no fixture-only readiness)', () => {
    const adapter = new ClaudeProviderAdapter();
    expect(adapter.describeSurfaces()).toEqual({
      conversationalChat: 'ready',
      codingAgent: 'unverified',
      implementationSurface: 'coding-agent',
    });
  });
});

describe('WORK-031 §31 — security regressions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolveClaudeConfig reads the fixture origin ONLY from storage.session', async () => {
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
    stored['wfos.claude.fixtureOrigin'] = 'http://127.0.0.1:3779';
    expect((await resolveClaudeConfig()).fixtureOrigin).toBe('http://127.0.0.1:3779');
    delete stored['wfos.claude.fixtureOrigin'];
    expect((await resolveClaudeConfig()).fixtureOrigin).toBeUndefined();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('the page session + SessionView carry NO credential material (callback token never reaches the adapter)', () => {
    const view = toSessionView({
      executionId: 'wf_1',
      provider: 'claude',
      providerLabel: 'Claude',
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
      externalSessionRef: '/chat/abc',
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('wfct_');
    expect(serialized).not.toContain('callback');
  });

  it('Claude sources never touch cookies, storage APIs, API keys, or WorkflowOS HTTP', () => {
    const files = [
      'claude-provider-adapter.ts',
      'claude-page-runtime.ts',
      'claude-selectors.ts',
      'claude-types.ts',
    ];
    for (const file of files) {
      const src = readFileSync(join(EXT_SRC, 'providers', 'claude', file), 'utf8');
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

  it('claude-bridge content script contains NO Claude DOM selectors', () => {
    const src = readFileSync(join(EXT_SRC, 'content', 'claude-bridge.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/querySelector|getElementById|getElementsBy/);
    expect(code).not.toMatch(/ProseMirror|Send message|data-testid|assistant-message/);
  });

  it('the claude adapter + bridge exist and are wired (WORK-031 shipped)', () => {
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
