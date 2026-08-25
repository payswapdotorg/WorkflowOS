import type { JobRecord } from '../queue/queue.js';

/**
 * A handler for a single background job type.
 *
 * Future work items register handlers for `github.webhook`, `llm.request`,
 * `agent.execute`, etc. The handler runs inside an execution context that
 * carries the job's {@link JobRecord.executionId}, so any logs it emits
 * automatically include the traceable identifier (OBS-AC-02).
 */
export interface JobHandler {
  /** Job type this handler accepts (must match {@link JobRecord.type}). */
  readonly type: string;
  /** Process a single job. Throw to signal failure; the worker re-acks. */
  handle(job: JobRecord): Promise<void>;
  /**
   * PR #38 review (durable redelivery): OPT-IN bounded redelivery on
   * handler failure. When a handler declares a policy and its handle()
   * throws, the WorkerHost re-enqueues the job onto the SAME durable queue
   * with attempt+1 (up to maxAttempts total deliveries) BEFORE
   * acknowledging the failed delivery — so a transient failure (e.g. a DB
   * blip during a session-terminal reconciliation) produces another
   * DURABLE attempt without a process restart. Handlers WITHOUT a policy
   * keep the historical acknowledge-regardless semantics exactly (the
   * default path is unchanged).
   *
   * A handler opting in MUST be idempotent per delivery attempt (its
   * side effects safe to re-apply) — the same contract as the outbox
   * relay consumers.
   */
  readonly redeliveryPolicy?: {
    /** Total delivery attempts including the first (>= 1). */
    readonly maxAttempts: number;
  };
}

/**
 * Convenience type for a registry of job handlers keyed by job type.
 */
export type HandlerRegistry = ReadonlyMap<string, JobHandler>;

/**
 * Build a handler registry from a list of handlers. Throws on duplicate types.
 */
export function buildHandlerRegistry(handlers: readonly JobHandler[]): HandlerRegistry {
  const map = new Map<string, JobHandler>();
  for (const h of handlers) {
    if (map.has(h.type)) {
      throw new Error(`Duplicate job handler for type: ${h.type}`);
    }
    map.set(h.type, h);
  }
  return map;
}
