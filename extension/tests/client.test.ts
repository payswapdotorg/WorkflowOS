import { describe, it, expect, vi } from 'vitest';
import { WorkflowOsClient } from '../src/workflowos/client.js';

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('WorkflowOsClient (§6/§8) — exactly two endpoints, no API key', () => {
  it('redeems a handoff with ONLY the one-time token header', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return ok({
        execution: { executionId: 'wf_1' },
        package: { prompt: '# prompt' },
        callbackToken: 'wfct_' + 'c'.repeat(32),
        callbackExpiresAt: new Date().toISOString(),
      });
    };
    const client = new WorkflowOsClient(fetchImpl as never);
    const result = await client.redeemHandoff('http://localhost:5173', 'wfht_' + 'd'.repeat(32));
    expect(result.execution.executionId).toBe('wf_1');
    expect(calls[0]!.url).toBe('http://localhost:5173/api/companion/redeem');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-handoff-token']).toBe('wfht_' + 'd'.repeat(32));
    // NEVER an API key or bearer header.
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['authorization']).toBeUndefined();
  });

  it('sends events with ONLY the scoped callback token + idempotency key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return ok({ accepted: true, duplicate: false, status: 'running' });
    };
    const client = new WorkflowOsClient(fetchImpl as never);
    const session = {
      executionId: 'wf_2',
      callback: {
        token: 'wfct_' + 'e'.repeat(32),
        expiresAt: new Date().toISOString(),
        origin: 'http://localhost:5173',
      },
    };
    const result = await client.sendExecutionEvent(session, {
      eventType: 'started',
      idempotencyKey: 'wf_2:0',
    });
    expect(result.status).toBe('running');
    expect(calls[0]!.url).toBe('http://localhost:5173/api/execution/wf_2/events');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-callback-token']).toBe('wfct_' + 'e'.repeat(32));
    expect(headers['x-api-key']).toBeUndefined();
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      eventType: 'started',
      idempotencyKey: 'wf_2:0',
    });
  });

  it('surfaces HTTP error codes and offline transitions', async () => {
    const offline = vi.fn();
    const client = new WorkflowOsClient(
      (async () => {
        throw new TypeError('network down');
      }) as never,
      offline,
    );
    await expect(
      client.redeemHandoff('http://localhost:5173', 'wfht_' + 'f'.repeat(32)),
    ).rejects.toMatchObject({ status: 0 });
    expect(offline).toHaveBeenCalled();
  });
});
