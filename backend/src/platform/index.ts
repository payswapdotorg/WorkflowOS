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

// --- WORK-003: PostgreSQL, Redis extensions, object storage, persistence ---

export type {
  DatabaseClient,
  DatabaseTx,
  QueryParams,
} from './postgres/database-client.js';
export { PgDatabaseClient } from './postgres/database-client.js';
export { createDatabaseClient, defaultPoolConfig } from './postgres/database-factory.js';
export {
  createPgliteDatabaseClient,
  PgliteDatabaseClient,
} from './postgres/pglite-database-client.js';
export { runMigrations, resetMigrationsTable } from './postgres/migration-runner.js';

export type {
  ObjectStore,
  PutObjectInput,
  PutObjectResult,
  StoredObject,
  StoredObjectRef,
} from './storage/object-store.js';
export { InMemoryObjectStore } from './storage/in-memory-object-store.js';
export { FsObjectStore, createTempFsObjectStore } from './storage/fs-object-store.js';

export { TransientLock } from './redis/transient-lock.js';
export type { AcquiredLock, AcquireOptions } from './redis/transient-lock.js';
export { TransientCache } from './redis/transient-cache.js';
export type { CacheGetOptions } from './redis/transient-cache.js';

export { ArtifactMetadataRepository } from './persistence/artifact-metadata-repository.js';
export type {
  ArtifactMetadata,
  CreateArtifactMetadataInput,
} from './persistence/artifact-metadata-repository.js';
export {
  buildInfrastructure,
} from './persistence/infrastructure.js';
export type { Infrastructure, BuildInfrastructureOptions } from './persistence/infrastructure.js';

// --- WORK-002: Secret management (SEC-001) ---

export type {
  SecretRef,
  SecretStore,
} from './secrets/secret-store.js';
export { EnvSecretStore } from './secrets/env-secret-store.js';
