/**
 * Platform public surface.
 *
 * This barrel re-exports the shared runtime foundation that every WorkflowOS
 * module and the API/worker processes consume:
 *
 * - module contract + frozen module list
 * - execution context (traceable execution ids — OBS-AC-01)
 * - structured, execution-aware logger (OBS-AC-02)
 * - metrics + error-tracker integration points (OBS-001)
 * - queue + worker infrastructure (PLAT-AC-03)
 *
 * Module-specific public surfaces live under `src/modules/<name>/index.ts`.
 */

export type {
  ModuleName,
  ModuleContract,
} from './module-contract.js';
export { FROZEN_MODULE_NAMES } from './module-contract.js';

export {
  runWithExecutionContext,
  getExecutionContext,
  getExecutionId,
  ensureExecutionId,
} from './execution-context.js';
export type { ExecutionContext } from './execution-context.js';

export { createLogger } from './logger.js';
export type { Logger, CreateLoggerOptions } from './logger.js';

export { setMetricsSink, metrics } from './metrics.js';
export type { MetricsSink } from './metrics.js';

export { setErrorTracker, errorTracker } from './error-tracker.js';
export type { ErrorTracker } from './error-tracker.js';

export { generateExecutionId } from './ids.js';

export type {
  Queue,
  JobRecord,
  EnqueueOptions,
} from './queue/queue.js';
export { InMemoryQueue } from './queue/in-memory-queue.js';
export { RedisQueue } from './redis/redis-queue.js';
export { createRedisClient } from './redis/redis-client.js';

export type {
  JobHandler,
  HandlerRegistry,
} from './worker/job-handler.js';
export { buildHandlerRegistry } from './worker/job-handler.js';
export { WorkerHost } from './worker/worker-host.js';
export type { WorkerHostOptions } from './worker/worker-host.js';

export {
  createEchoJobHandler,
} from './worker/fixtures/echo.job.js';
export type {
  EchoJobPayload,
  EchoJobResult,
  EchoListener,
  EchoJobOptions,
} from './worker/fixtures/echo.job.js';
