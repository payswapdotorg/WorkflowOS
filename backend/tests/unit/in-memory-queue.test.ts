import { describe, it, expect } from 'vitest';
import { InMemoryQueue } from '@platform/queue/in-memory-queue.js';
import { generateExecutionId } from '@platform/ids.js';

describe('InMemoryQueue', () => {
  it('enqueues and dequeues in FIFO order', async () => {
    const queue = new InMemoryQueue();
    const a = await queue.enqueue('echo', { n: 1 }, { executionId: generateExecutionId() });
    const b = await queue.enqueue('echo', { n: 2 }, { executionId: generateExecutionId() });
    expect(await queue.size()).toBe(2);

    const first = await queue.dequeue();
    const second = await queue.dequeue();
    expect(first?.id).toBe(a.id);
    expect(second?.id).toBe(b.id);
    expect(await queue.dequeue()).toBeNull();
    await queue.close();
  });

  it('carries the supplied execution id (OBS-AC-01)', async () => {
    const queue = new InMemoryQueue();
    const record = await queue.enqueue('echo', { msg: 'x' }, { executionId: 'wf_queue1' });
    expect(record.executionId).toBe('wf_queue1');
    expect(record.correlationId).toBe('wf_queue1');
    const dequeued = await queue.dequeue();
    expect(dequeued?.executionId).toBe('wf_queue1');
    await queue.close();
  });

  it('generates an execution id when none is supplied', async () => {
    const queue = new InMemoryQueue();
    const record = await queue.enqueue('echo', {});
    expect(record.executionId).toMatch(/^wf_[0-9a-f]{8}$/);
    await queue.close();
  });

  it('acks without error', async () => {
    const queue = new InMemoryQueue();
    const record = await queue.enqueue('echo', {});
    await expect(queue.ack(record.id)).resolves.toBeUndefined();
    await queue.close();
  });

  it('returns null when empty (non-blocking)', async () => {
    const queue = new InMemoryQueue();
    expect(await queue.dequeue()).toBeNull();
    await queue.close();
  });
});
