import { AsyncLocalStorage } from 'node:async_hooks';
import { generateExecutionId } from './ids.js';

/**
 * Execution context propagated through API → queue → worker.
 *
 * The {@link ExecutionContext.executionId} is the traceable identifier required
 * by OBS-AC-01 / OBS-AC-02. It is generated at the API boundary (or supplied
 * by an inbound caller via header) and carried into background jobs so logs
 * produced during execution include it.
 */
export interface ExecutionContext {
  /** Traceable execution identifier (OBS-AC-01). */
  readonly executionId: string;
  /**
   * Optional correlation id linking multiple executions (e.g. a workflow run
   * that fans out into several jobs). Defaults to the execution id.
   */
  readonly correlationId?: string;
  /** Optional originating actor (user id, system, webhook, etc.). */
  readonly actor?: string;
  /** Optional request id for inbound HTTP requests. */
  readonly requestId?: string;
}

const storage = new AsyncLocalStorage<ExecutionContext>();

/**
 * Run `fn` with `ctx` as the active execution context for the current async
 * chain. Used at the API boundary and re-established inside the worker before
 * a job handler runs.
 */
export function runWithExecutionContext<T>(
  ctx: ExecutionContext,
  fn: () => Promise<T>,
): Promise<T>;

export function runWithExecutionContext<T>(
  ctx: ExecutionContext,
  fn: () => T,
): T;

export function runWithExecutionContext<T>(
  ctx: ExecutionContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return storage.run(ctx, fn);
}

/**
 * Returns the active execution context, or `undefined` when none is active.
 */
export function getExecutionContext(): ExecutionContext | undefined {
  return storage.getStore();
}

/**
 * Returns the execution id of the active context, or `undefined` when no
 * context is active.
 */
export function getExecutionId(): string | undefined {
  return storage.getStore()?.executionId;
}

/**
 * Returns the active context's execution id, or generates and returns a new
 * one WITHOUT establishing a context. Prefer {@link runWithExecutionContext}.
 */
export function ensureExecutionId(): string {
  const existing = getExecutionId();
  if (existing) return existing;
  return generateExecutionId();
}
