/**
 * Background session-lifecycle tests (§9/§12) — with a mocked chrome bridge.
 * Proves: handoff → session (memory storage) → provider open → observations
 * → reported events, plus token non-persistence (storage.session only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompanionBackground } from '../src/background/index.js';
import { chromeSessionStorage } from '../src/background/store.js';
import { WorkflowOsClient } from '../src/workflowos/client.js';
import { ExecutionReporter } from '../src/workflowos/reporter.js';
import type { ExecutionEventRequest } from '../src/workflowos/client.js';
import { message } from '../src/shared/messages.js';
import { resetFakeAdapterState } from '../src/providers/fake/fake-provider-adapter.js';

function makeArea() {
  const mem = new Map<string, string>();
  return {
    area: {
      async get(keys: string[]) {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (mem.has(k)) out[k] = mem.get(k);
        return out;
      },
      async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) mem.set(k, v as string);
      },
      async remove(keys: string[]) {
        for (const k of keys) mem.delete(k);
      },
    },
    mem,
  };
}

function makeHarness() {
  const { area, mem } = makeArea();
  const sent: ExecutionEventRequest[] = [];
  const fetchCalls: { url: string; headers: Record<string, string> }[] = [];

  const fetchImpl = (async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, headers: init.headers as Record<string, string> });
    if (url.endsWith('/api/companion/redeem')) {
      return new Response(
        JSON.stringify({
          execution: {
            executionId: 'wf_bg000001',
            projectId: 'p1',
            workItemId: 'wi1',
            mode: 'external',
            provider: 'fake',
            model: null,
            status: 'submitted',
            repository: 'workflowos/repo',
            branch: 'feat/work-bg-001',
            promptDigest: 'digest',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
          package: {
            executionId: 'wf_bg000001',
            workItemLabel: 'WORK-BG-001',
            provider: 'fake',
            repository: { owner: 'workflowos', name: 'repo', url: null, defaultBranch: 'main' },
            branch: 'feat/work-bg-001',
            prompt: '# Implementation Instructions — WORK-BG-001',
            structuredInstructions: ['run tests'],
            verificationRequirements: ['All tests pass'],
            expectedOutputs: [],
            returnCallback: {
              eventsPath: '/execution/wf_bg000001/events',
              eventTypes: ['started'],
              auth: 'x-callback-token',
              note: '',
            },
            expiration: new Date(Date.now() + 3600_000).toISOString(),
          },
          callbackToken: 'wfct_' + '1'.repeat(32),
          callbackExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200 },
      );
    }
    // events endpoint
    sent.push(JSON.parse(init.body as string) as ExecutionEventRequest);
    return new Response(
      JSON.stringify({ accepted: true, duplicate: false, status: 'running' }),
      { status: 202 },
    );
  }) as never;

  const client = new WorkflowOsClient(fetchImpl);
  const tabs: { id: number; url: string }[] = [];
  let nextTabId = 100;
  const runtime = {
    onMessage: () => undefined,
    sendMessage: async () => null,
    openTab: async (url: string) => {
      const id = nextTabId++;
      tabs.push({ id, url });
      return id;
    },
    closeTab: async () => undefined,
    getExtensionUrl: (path: string) => `chrome-extension://test/${path}`,
  };
  const reporterEvents: ExecutionEventRequest[] = [];
  const companion = new CompanionBackground(
    runtime as never,
    chromeSessionStorage(area as never),
    client,
    (c) =>
      new ExecutionReporter(
        {
          sendExecutionEvent: async (
            session: { executionId: string; callback: { token: string; expiresAt: string; origin: string } },
            event: ExecutionEventRequest,
          ) => {
            reporterEvents.push(event);
            return c.sendExecutionEvent(session, event);
          },
        } as never,
        {
          loadQueue: async () => [],
          saveQueue: async () => undefined,
        },
        { sleep: async () => undefined },
      ),
    {
      openTab: runtime.openTab,
      closeTab: runtime.closeTab,
      getActiveTabId: async () => null,
      extensionPageUrl: (path: string, params: Record<string, string>) => {
        const url = new URL(`chrome-extension://test/${path.replace(/^\//, '')}`);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        return url.toString();
      },
    },
  );
  return { companion, mem, tabs, fetchCalls, sent: reporterEvents };
}

describe('CompanionBackground — session lifecycle', () => {
  beforeEach(() => {
    resetFakeAdapterState();
    vi.restoreAllMocks();
  });

  it('handoff → redeem → session stored (memory) → provider tab opened', async () => {
    const h = makeHarness();
    let ack: { ok: boolean; executionId?: string } | undefined;
    h.companion.setHandoffAck((r) => (ack = r));
    await h.companion.init();

    const result = await h.companion.onHandoff('wfht_' + '9'.repeat(32), 'http://localhost:5173');
    expect(result.ok).toBe(true);
    expect(ack?.ok).toBe(true);

    // Session persisted in storage.session (memory) — the ONLY store used.
    const stored = h.mem.get('wfos.companion.session.v1');
    expect(stored).toBeTruthy();
    const session = JSON.parse(stored!);
    expect(session.executionId).toBe('wf_bg000001');
    expect(session.provider).toBe('fake');
    // Opening the provider reports `started` → session is running.
    expect(session.status).toBe('running');

    // The provider tab was opened (extension fake-provider page; NO token in URL).
    expect(h.tabs.length).toBe(1);
    expect(h.tabs[0]!.url).toContain('chrome-extension://test/ui/fake-provider/index.html');
    expect(h.tabs[0]!.url).toContain('executionId=wf_bg000001');
    expect(h.tabs[0]!.url).not.toMatch(/wfct_|wfht_/);
  });

  it('execution messages from the fake page flow through the adapter → reporter → WorkflowOS', async () => {
    const h = makeHarness();
    await h.companion.init();
    await h.companion.onHandoff('wfht_' + '8'.repeat(32), 'http://localhost:5173');

    // Simulate the fake provider page posting lifecycle observations.
    await h.companion.onExecutionMessage(
      'EXECUTION_PROGRESS',
      { externalSessionRef: 'fake-session-1', output: 'underway' },
      'wf_bg000001',
    );
    await h.companion.onExecutionMessage(
      'EXECUTION_COMPLETED',
      { commitRef: 'fakesha12345678', branch: 'feat/work-bg-001' },
      'wf_bg000001',
    );

    // Event delivery is async (bounded-backoff drain) — wait for all three
    // (the background reports `started` when the provider opens).
    await vi.waitFor(() => {
      expect(h.sent.map((e) => e.eventType)).toEqual(['started', 'progress', 'completed']);
    });
    expect(h.sent[0]!.idempotencyKey).toMatch(/^wf_bg000001:\d+$/);
    expect(h.sent[1]!.idempotencyKey).toMatch(/^wf_bg000001:\d+$/);
    expect(h.sent[0]!.idempotencyKey).not.toBe(h.sent[1]!.idempotencyKey);

    // Event requests carry ONLY the callback token (verified via fetchCalls).
    const eventsCall = h.fetchCalls.find((c) => c.url.includes('/events'));
    expect(eventsCall?.headers['x-callback-token']).toBe('wfct_' + '1'.repeat(32));
    expect(eventsCall?.headers['x-api-key']).toBeUndefined();
  });

  it('cross-execution messages are dropped (session scope)', async () => {
    const h = makeHarness();
    await h.companion.init();
    await h.companion.onHandoff('wfht_' + '7'.repeat(32), 'http://localhost:5173');
    await h.companion.onExecutionMessage(
      'EXECUTION_COMPLETED',
      { output: 'from another execution' },
      'wf_someother',
    );
    // Only the background's own `started` event was sent — the
    // cross-execution message was dropped.
    expect(h.sent.map((e) => e.eventType)).toEqual(['started']);
  });

  it('stopSession marks stopped; resume reopens the provider', async () => {
    const h = makeHarness();
    await h.companion.init();
    await h.companion.onHandoff('wfht_' + '6'.repeat(32), 'http://localhost:5173');
    await h.companion.stopSession();
    expect(h.companion.getState().session?.status).toBe('stopped');

    await h.companion.resumeSession();
    expect(h.tabs.length).toBe(2); // provider reopened
    expect(h.companion.getState().session?.status).toBe('ready');
  });

  it('getState exposes a token-free session view for the popup', () => {
    const h = makeHarness();
    const state = h.companion.getState();
    expect(state.session).toBeNull();
    expect(state.providers.map((p) => p.providerId)).toContain('fake');
    expect(state.connection).toBe('connected');
    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/wfct_|wfht_/);
  });

  it('failed handoff (bad token) reports the error and keeps no session', async () => {
    makeHarness();
    // Overwrite fetch to reject the redeem.
    const bad = new CompanionBackground(
      {
        onMessage: () => undefined,
        sendMessage: async () => null,
        openTab: async () => null,
        closeTab: async () => undefined,
        getExtensionUrl: (p: string) => p,
      } as never,
      chromeSessionStorage(makeArea().area as never),
      new WorkflowOsClient(
        (async () =>
          new Response(JSON.stringify({ error: 'handoff-token-invalid' }), { status: 403 })) as never,
      ),
      () =>
        new ExecutionReporter({} as never, {
          loadQueue: async () => [],
          saveQueue: async () => undefined,
        }),
      {
        openTab: async () => null,
        closeTab: async () => undefined,
        getActiveTabId: async () => null,
        extensionPageUrl: (p: string) => p,
      },
    );
    const result = await bad.onHandoff('wfht_bad', 'http://localhost:5173');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(bad.getState().session).toBeNull();
  });

  it('the message envelope the popup uses is valid (protocol contract)', () => {
    const msg = message('GET_STATE', null, {});
    expect(msg.type).toBe('GET_STATE');
    expect(typeof msg.timestamp).toBe('number');
  });
});
