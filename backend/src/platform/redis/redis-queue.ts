import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type {
  Queue,
  EnqueueOptions,
  JobRecord,
} from '../queue/queue.js';
import { generateExecutionId } from '../ids.js';

/**
 * Redis-backed {@link Queue} implementation.
 *
 * Production queue implementation for the WorkflowOS modular monolith. Jobs
 * are serialized as JSON and pushed onto a Redis list (LPUSH). Workers pop
 * (LPOP) and acknowledge via a Redis set of completed job ids. Redis is the
 * backing store for the queue only; it is NOT authoritative application
 * state (architecture §29 — `DATA-002`, `DATA2-AC-02`).
 *
 * `dequeue` is intentionally non-blocking (LPOP) so the worker host can poll
 * without busy-spinning and so this implementation is trivially testable
 * against an in-memory ioredis-compatible client.
 */
const QUEUE_KEY = 'wfos:jobs:pending';
const ACK_SET_KEY = 'wfos:jobs:acked';

export class RedisQueue implements Queue {
  constructor(
    private readonly redis: Redis,
    private readonly queueKey: string = QUEUE_KEY,
    private readonly ackSetKey: string = ACK_SET_KEY,
  ) {}

  async enqueue<T>(
    type: string,
    payload: T,
    options?: EnqueueOptions,
  ): Promise<JobRecord<T>> {
    const executionId = options?.executionId ?? generateExecutionId();
    const record: JobRecord<T> = {
      id: randomUUID(),
      type,
      payload,
      executionId,
      correlationId: options?.correlationId ?? executionId,
      enqueuedAt: Date.now(),
    };
    const serialized = JSON.stringify(record);
    // RPUSH (append to tail) + LPOP (remove from head) => FIFO. This matches
    // the InMemoryQueue semantics so both implementations are interchangeable.
    await this.redis.rpush(this.queueKey, serialized);
    return record;
  }

  async dequeue(): Promise<JobRecord | null> {
    const raw = await this.redis.lpop(this.queueKey);
    if (!raw) return null;
    try {
      return this.parseRecord(raw);
    } catch {
      // Malformed record — drop silently to avoid blocking the queue.
      // A real observability pipeline would emit a metric / error here.
      return null;
    }
  }

  async ack(jobId: string): Promise<void> {
    await this.redis.sadd(this.ackSetKey, jobId);
  }

  async size(): Promise<number> {
    const len = await this.redis.llen(this.queueKey);
    return len;
  }

  async close(): Promise<void> {
    // The queue does NOT own the Redis connection; callers manage its
    // lifecycle. Nothing to release here.
  }

  private parseRecord(raw: string): JobRecord {
    const parsed = JSON.parse(raw) as JobRecord;
    return {
      id: parsed.id,
      type: parsed.type,
      payload: parsed.payload,
      executionId: parsed.executionId,
      correlationId: parsed.correlationId,
      enqueuedAt: parsed.enqueuedAt,
    };
  }
}
