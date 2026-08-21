import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  Queue,
  EnqueueOptions,
  JobRecord,
} from './queue.js';
import { generateExecutionId } from '../ids.js';

/**
 * In-process FIFO {@link Queue} implementation.
 *
 * Used for local development and for tests (PLAT-AC-03, OBS-AC-01, OBS-AC-02).
 * Production uses {@link RedisQueue}; both implementations satisfy the same
 * shared interface so domain code is queue-agnostic.
 *
 * This implementation is intentionally simple: a single list, non-blocking
 * `dequeue`. It is NOT durable across process restarts and MUST NOT be used
 * for authoritative workflow state (architecture §29).
 */
export class InMemoryQueue implements Queue {
  private readonly pending: JobRecord[] = [];
  private readonly acked = new Set<string>();
  private readonly emitter = new EventEmitter();
  private closed = false;

  async enqueue<T>(
    type: string,
    payload: T,
    options?: EnqueueOptions,
  ): Promise<JobRecord<T>> {
    if (this.closed) throw new Error('InMemoryQueue: closed');
    const executionId = options?.executionId ?? generateExecutionId();
    const record: JobRecord<T> = {
      id: randomUUID(),
      type,
      payload,
      executionId,
      correlationId: options?.correlationId ?? executionId,
      enqueuedAt: Date.now(),
    };
    this.pending.push(record);
    this.emitter.emit('job', record);
    return record;
  }

  async dequeue(): Promise<JobRecord | null> {
    if (this.pending.length === 0) return null;
    const job = this.pending.shift();
    return job ?? null;
  }

  async ack(jobId: string): Promise<void> {
    this.acked.add(jobId);
  }

  async size(): Promise<number> {
    return this.pending.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.emitter.removeAllListeners();
    this.pending.length = 0;
  }
}
