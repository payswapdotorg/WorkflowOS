import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionReporter } from '../src/workflowos/reporter.js';
import { WorkflowOsError } from '../src/workflowos/client.js';
import type { ExecutionEventRequest } from '../src/workflowos/client.js';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    executionId: 'wf_test0001',
    callback: {
      token: 'wfct_' + 'a'.repeat(32),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      origin: 'http://localhost:5173',
    },
    ...overrides,
  };
}

interface SentEntry {
  url: string;
  event: ExecutionEventRequest;
}

/**
 * Deterministic harness: a `failMode` flag + MANUAL sleep gates. When a send
 * fails, the drain parks on the next sleep gate; tests release gates to
 * advance time — no real timers, no races.
 */
function makeHarness() {
  const sent: SentEntry[] = [];
  const storageState: { queue: { event: ExecutionEventRequest; attempts: number }[] } = {
    queue: [],
  };
  const mode = { fail: false, status: 0 };

  // Sleep gates: each drain backoff parks until released.
  const gates: Array<() => void> = [];
  const sleep = () =>
    new Promise<void>((resolve) => {
      gates.push(resolve);
    });
  const releaseAllGates = () => {
    while (gates.length > 0) gates.shift()!();
  };

  const client = {
    async sendExecutionEvent(
      session: { executionId: string; callback?: { origin: string } },
      event: ExecutionEventRequest,
    ) {
      sent.push({
        url: `${session.callback?.origin ?? 'http://localhost:5173'}/api/execution/${session.executionId}/events`,
        event,
      });
      if (mode.fail) {
        throw new WorkflowOsError('network failed', mode.status);
      }
      return { accepted: true, duplicate: false, status: 'running' } as {
        accepted: boolean;
        duplicate: boolean;
        status: string;
      };
    },
  };

  const reporter = new ExecutionReporter(
    client as never,
    {
      loadQueue: async () => [...storageState.queue] as never[],
      saveQueue: async (queue: unknown[]) => {
        storageState.queue = [...(queue as { event: ExecutionEventRequest; attempts: number }[])];
      },
    },
    { sleep: sleep as (ms: number) => Promise<void> },
  );

  return {
    reporter,
    sent,
    storageState,
    mode,
    releaseAllGates,
    pendingGates: () => gates.length,
  };
}

describe('ExecutionReporter (§16/§17) — idempotency, retry, expiry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('assigns sequential idempotency keys per execution', async () => {
    const h = makeHarness();
    await h.reporter.report(makeSession(), { eventType: 'started' });
    await h.reporter.report(makeSession(), { eventType: 'progress', output: 'half' });
    await h.reporter.report(makeSession(), { eventType: 'completed' });
    const keys = h.sent.map((s) => s.event.idempotencyKey);
    expect(keys).toEqual(['wf_test0001:0', 'wf_test0001:1', 'wf_test0001:2']);
  });

  it('retries with the SAME idempotency key on network failure (no duplicate state)', async () => {
    const h = makeHarness();
    h.mode.fail = true; // offline
    await h.reporter.report(makeSession(), { eventType: 'started' });
    // Drain parked on its backoff gate with the event still buffered.
    expect(h.reporter.pendingCount).toBe(1);
    expect(h.pendingGates()).toBe(1);

    // Reconnect + advance time: the retry uses the SAME key.
    h.mode.fail = false;
    h.releaseAllGates();
    await h.reporter.flush(makeSession());
    const keys = h.sent.map((s) => s.event.idempotencyKey);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(1); // SAME key reused on retry
    expect(h.reporter.pendingCount).toBe(0);
  });

  it('buffers offline events in memory storage and drains on reconnect', async () => {
    const h = makeHarness();
    h.mode.fail = true;
    await h.reporter.report(makeSession(), { eventType: 'started' });
    expect(h.reporter.pendingCount).toBe(1);
    expect(h.storageState.queue.length).toBe(1); // buffered (memory storage)
    expect(h.pendingGates()).toBe(1);

    // Reconnect: release the backoff gate, drain completes.
    h.mode.fail = false;
    h.releaseAllGates();
    await h.reporter.flush(makeSession());
    expect(h.reporter.pendingCount).toBe(0);
    expect(h.storageState.queue.length).toBe(0);
  });

  it('restores the queue after a service-worker restart and continues the sequence', async () => {
    const h = makeHarness();
    h.mode.fail = true;
    await h.reporter.report(makeSession(), { eventType: 'started' });
    expect(h.storageState.queue.length).toBe(1);
    const firstKey = h.storageState.queue[0]!.event.idempotencyKey;

    // A NEW reporter over the SAME memory storage (worker restarted).
    const sent2: SentEntry[] = [];
    const client2 = {
      async sendExecutionEvent(
        session: { executionId: string; callback?: { origin: string } },
        event: ExecutionEventRequest,
      ) {
        sent2.push({
          url: `${session.callback?.origin ?? ''}/api/execution/${session.executionId}/events`,
          event,
        });
        return { accepted: true, duplicate: false, status: 'running' };
      },
    };
    const restored = new ExecutionReporter(
      client2 as never,
      {
        loadQueue: async () => [...h.storageState.queue] as never[],
        saveQueue: async () => undefined,
      },
      { sleep: async () => undefined },
    );
    await restored.restore();
    expect(restored.pendingCount).toBe(1);
    // The restored (undelivered) event is re-sent with its ORIGINAL key, and
    // new events continue the sequence without colliding with it.
    await restored.report(makeSession(), { eventType: 'progress' });
    await restored.flush(makeSession());
    const keys = sent2.map((s) => s.event.idempotencyKey);
    expect(keys.filter((k) => k === firstKey).length).toBe(1); // delivered exactly once
    const newKeys = keys.filter((k) => k !== firstKey);
    expect(newKeys.length).toBe(1);
    expect(newKeys[0]).not.toBe(firstKey);
    expect(keys.every((k) => k.startsWith('wf_test0001:'))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('stops retrying and drops the queue when the credential expires (§17)', async () => {
    const h = makeHarness();
    h.mode.fail = true; // always offline
    const expired = makeSession({
      callback: {
        token: 'wfct_' + 'b'.repeat(32),
        expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
        origin: 'http://localhost:5173',
      },
    });
    await h.reporter.report(expired, { eventType: 'started' });
    expect(h.reporter.pendingCount).toBe(0); // dropped, no retry loop
  });

  it('drops the event on permanent rejections (403 invalid credential, 410 gone)', async () => {
    const h = makeHarness();
    h.mode.fail = true;
    h.mode.status = 403;
    await h.reporter.report(makeSession(), { eventType: 'started' });
    expect(h.reporter.pendingCount).toBe(0); // invalid credential → cleared

    h.mode.status = 410;
    await h.reporter.report(makeSession(), { eventType: 'progress' });
    await h.reporter.flush(makeSession());
    expect(h.reporter.pendingCount).toBe(0); // gone → event dropped
  });

  it('never serializes the callback token into queue storage', async () => {
    const h = makeHarness();
    h.mode.fail = true; // keep the event buffered so storage is inspectable
    const session = makeSession();
    await h.reporter.report(session, { eventType: 'started' });
    const serialized = JSON.stringify(h.storageState.queue);
    expect(serialized).not.toContain(session.callback.token);
  });

  it('tracks online/offline + last status for the popup connection badge', async () => {
    const h = makeHarness();
    const states: { pending: number; online: boolean }[] = [];
    h.reporter.onStateChange((s) => states.push({ pending: s.pending, online: s.online }));
    await h.reporter.report(makeSession(), { eventType: 'started' });
    await h.reporter.flush(makeSession());
    expect(h.reporter.lastKnownStatus).toBe('running');
    expect(h.reporter.pendingCount).toBe(0);
    expect(h.reporter.isOnline).toBe(true);
    expect(states.some((s) => s.pending === 0 && s.online)).toBe(true);
  });
});
