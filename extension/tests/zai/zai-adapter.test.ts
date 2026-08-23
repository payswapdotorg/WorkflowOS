/**
 * WORK-029 — Z.ai background adapter + security regression tests (§34/§35).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ZaiProviderAdapter,
  resolveZaiConfig,
} from '../../src/providers/zai/zai-provider-adapter.js';
import { toSessionView } from '../../src/shared/session.js';
import { providerRegistry } from '../../src/providers/registry.js';
import { detectProvider } from '../../src/providers/detector.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_SRC = join(HERE, '..', '..', 'src');

describe('ZaiProviderAdapter (background side)', () => {
  it('matches the real Z.ai domains incl. chat.z.ai; rejects others', () => {
    const adapter = new ZaiProviderAdapter();
    expect(adapter.matchesPage(new URL('https://chat.z.ai/chat/abc'))).toBe(true);
    expect(adapter.matchesPage(new URL('https://z.ai/'))).toBe(true);
    expect(adapter.matchesPage(new URL('https://app.z.ai/x'))).toBe(true);
    expect(adapter.matchesPage(new URL('https://example.com/'))).toBe(false);
    expect(adapter.matchesPage(new URL('https://chatgpt.com/'))).toBe(false);
  });

  it('fixture matching is config-driven and OFF by default', async () => {
    const adapter = new ZaiProviderAdapter();
    expect(await adapter.matchesFixture(new URL('http://127.0.0.1:3777/'))).toBe(false);
    // Configured (E2E harness stages storage.session):
    const staged = new ZaiProviderAdapter(
      { sendMessage: async () => null },
      Promise.resolve({
        zaiOrigin: 'https://chat.z.ai',
        fixtureOrigin: 'http://127.0.0.1:3777',
      }),
    );
    expect(await staged.matchesFixture(new URL('http://127.0.0.1:3777/?x=1'))).toBe(true);
    expect(await staged.matchesFixture(new URL('http://127.0.0.1:9999/'))).toBe(false);
  });

  it('openTask prefers the staged fixture origin, else the Z.ai new-task root', async () => {
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
    const prod = new ZaiProviderAdapter(
      { sendMessage: async () => null },
      Promise.resolve({ zaiOrigin: 'https://chat.z.ai' }),
    );
    await prod.openTask({} as never, runtime);
    expect(opened[0]).toBe('https://chat.z.ai/');

    const staged = new ZaiProviderAdapter(
      { sendMessage: async () => null },
      Promise.resolve({ zaiOrigin: 'https://chat.z.ai', fixtureOrigin: 'http://127.0.0.1:3777' }),
    );
    await staged.openTask({} as never, runtime);
    expect(opened[1]).toBe('http://127.0.0.1:3777');
  });

  it('injectPrompt REFUSES when the prompt was already submitted (duplicate guard)', async () => {
    const port = { sendMessage: vi.fn(async () => null) };
    const adapter = new ZaiProviderAdapter(port);
    const runtime = {
      openTab: async () => 1,
      closeTab: async () => undefined,
      getActiveTabId: async () => 42,
      extensionPageUrl: (p: string) => p,
    };
    await adapter.injectPrompt(
      { executionId: 'wf_1', promptSubmitted: true } as never,
      runtime,
    );
    expect(port.sendMessage).not.toHaveBeenCalled(); // §35: no resubmit path
  });

  it('stop() notifies the page runtime via the tab port', async () => {
    const port = { sendMessage: vi.fn(async () => null) };
    const adapter = new ZaiProviderAdapter(port);
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

  it('is registered with Z.ai available; ChatGPT shipped (WORK-030); Claude pending', () => {
    expect(providerRegistry.get('zai')).toBeInstanceOf(ZaiProviderAdapter);
    expect(providerRegistry.get('chatgpt')).not.toBeNull(); // WORK-030
    expect(providerRegistry.get('claude')).toBeNull(); // WORK-031
    expect(detectProvider(new URL('https://chat.z.ai/')).adapterAvailable).toBe(true);
    expect(detectProvider(new URL('https://chatgpt.com/')).adapterAvailable).toBe(true);
    expect(detectProvider(new URL('https://claude.ai/')).adapterAvailable).toBe(false);
  });
});

describe('WORK-029 §35 — security regressions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolveZaiConfig reads the fixture origin ONLY from storage.session (never localStorage)', async () => {
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
    stored['wfos.zai.fixtureOrigin'] = 'http://127.0.0.1:3777';
    expect((await resolveZaiConfig()).fixtureOrigin).toBe('http://127.0.0.1:3777');
    delete stored['wfos.zai.fixtureOrigin'];
    expect((await resolveZaiConfig()).fixtureOrigin).toBeUndefined();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('the page session + SessionView carry NO credential material (callback token never enters the page)', () => {
    const view = toSessionView({
      executionId: 'wf_1',
      provider: 'zai',
      providerLabel: 'Z.ai',
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
      callback: { token: 'wfct_SECRET'.padEnd(40, 'x'), expiresAt: new Date().toISOString(), origin: 'http://localhost:5173' },
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

  it('Z.ai sources never touch cookies, storage APIs, API keys, or WorkflowOS HTTP', () => {
    const zaiFiles = [
      'zai-provider-adapter.ts',
      'zai-page-runtime.ts',
      'zai-selectors.ts',
      'zai-types.ts',
    ];
    for (const file of zaiFiles) {
      const src = readFileSync(join(EXT_SRC, 'providers', 'zai', file), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${file} must not read cookies`).not.toMatch(/document\.cookie|chrome\.cookies/);
      expect(code, `${file} must not use localStorage`).not.toMatch(/localStorage|storage\.local/);
      expect(code, `${file} must not send API keys`).not.toMatch(/x-api-key|Authorization/);
      expect(code, `${file} must not call WorkflowOS HTTP`).not.toMatch(/\/api\/companion|\/api\/execution/);
      expect(code, `${file} must not mutate workflow state`).not.toMatch(/workflow\/transitions|request-merge|advance-to-verified/);
      expect(code, `${file} must not evaluate untrusted output`).not.toMatch(/eval\s*\(|new Function\s*\(|innerHTML\s*=/);
    }
  });

  it('zai-bridge content script contains NO Z.ai DOM selectors', () => {
    const src = readFileSync(join(EXT_SRC, 'content', 'zai-bridge.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/querySelector|getElementById|getElementsBy/);
    expect(code).not.toMatch(/aria-label=|chat-input|Send Message/);
  });
});
