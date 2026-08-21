import type { Logger, Queue, WorkerHostOptions, EchoJobOptions, Infrastructure, ObjectStore, DatabaseClient } from '@platform/index.js';
import {
  InMemoryQueue,
  RedisQueue,
  WorkerHost,
  buildHandlerRegistry,
  createEchoJobHandler,
  createLogger,
  createRedisClient,
  createDatabaseClient,
  runMigrations,
  FsObjectStore,
  InMemoryObjectStore,
  buildInfrastructure,
  type HandlerRegistry,
} from '@platform/index.js';
import type { AppConfig } from './config.js';

/**
 * Application composition root.
 *
 * Wires together the shared runtime foundation required by WORK-001:
 *
 * - structured, execution-aware {@link Logger}
 * - background {@link Queue} (Redis in production, in-memory for tests/dev)
 * - {@link WorkerHost} with the registered job handlers
 *
 * The API process and the worker process share the same codebase and
 * composition; only the {@link AppConfig.role} differs.
 */
export interface AppDeps {
  logger: Logger;
  queue: Queue;
  handlers: HandlerRegistry;
  worker: WorkerHost;
  /** Shared infrastructure (PostgreSQL, Redis extensions, object storage). May be undefined when no DATABASE_URL/OBJECT_STORAGE_DIR is configured. */
  infrastructure?: Infrastructure;
}

export interface BuildAppOptions {
  /** Override the queue (tests inject an in-memory queue). */
  queue?: Queue;
  /** Override the logger (tests inject a capturing logger). */
  logger?: Logger;
  /** Echo job listener (tests observe async completion). */
  onEcho?: EchoJobOptions['onEcho'];
  /** Worker host options. */
  workerOptions?: WorkerHostOptions;
  /** Whether to start the worker host. The `api` role does not start it. */
  startWorker?: boolean;
}

export interface AppHandle {
  deps: AppDeps;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Build the WorkflowOS application handle from config.
 *
 * Resource ownership rules:
 * - When `BuildAppOptions.queue` is supplied (tests), the caller owns it and
 *   is responsible for closing it.
 * - When the app creates a Redis client for a `RedisQueue`, the app owns the
 *   client and closes it on `stop()`.
 */
export async function buildApp(
  config: AppConfig,
  options: BuildAppOptions = {},
): Promise<AppHandle> {
  const logger = options.logger ?? createLogger({ level: config.logLevel });

  let queue: Queue;
  let ownsRedis = false;
  let redisClient: Awaited<ReturnType<typeof createRedisClient>> | undefined;

  if (options.queue) {
    queue = options.queue;
  } else if (config.redisUrl) {
    redisClient = await createRedisClient(config.redisUrl);
    queue = new RedisQueue(redisClient);
    ownsRedis = true;
  } else {
    queue = new InMemoryQueue();
    logger.warn('app.queue.in_memory', {
      reason: 'REDIS_URL not set; using non-durable in-memory queue',
    });
  }

  const handlers = buildHandlerRegistry([
    createEchoJobHandler(logger, { onEcho: options.onEcho }),
  ]);
  const worker = new WorkerHost(queue, handlers, logger, options.workerOptions);

  // --- WORK-003: optional infrastructure wiring (PostgreSQL + object storage).
  // When DATABASE_URL is set, a real PostgreSQL client is constructed and
  // migrations are applied. When OBJECT_STORAGE_DIR is set, a filesystem-backed
  // object store is constructed; otherwise an in-memory store is used for dev.
  // Domain modules obtain these from the Infrastructure container rather than
  // constructing their own clients.
  let infrastructure: Infrastructure | undefined;
  let ownsDatabase = false;
  let database: DatabaseClient | undefined;
  if (config.databaseUrl) {
    database = createDatabaseClient({ connectionString: config.databaseUrl });
    ownsDatabase = true;
    await runMigrations(database, logger);
  }
  let objectStore: ObjectStore;
  if (config.objectStorageDir) {
    objectStore = new FsObjectStore(config.objectStorageDir);
  } else {
    objectStore = new InMemoryObjectStore();
    if (!options.queue) {
      logger.warn('app.object_store.in_memory', {
        reason: 'OBJECT_STORAGE_DIR not set; using non-durable in-memory object store',
      });
    }
  }
  // infrastructure requires a Redis client (for locks/cache) and a database.
  // If we have a Redis client (created above for the queue), reuse it.
  if (redisClient && database) {
    infrastructure = buildInfrastructure({
      database,
      redis: redisClient,
      queue,
      objectStore,
      logger,
    });
  } else if (database) {
    // No Redis configured — infrastructure is partial (DB + object store only).
    // We still build it so domain code can use the database; lock/cache will
    // be present only if redisClient exists. For WORK-003 we keep it simple:
    // require Redis for the full Infrastructure container.
    infrastructure = undefined;
    logger.warn('app.infrastructure.partial', {
      reason: 'REDIS_URL not set; infrastructure container requires Redis for locks/cache',
    });
  }

  const handle: AppHandle = {
    deps: { logger, queue, handlers, worker, infrastructure },
    start: async () => {
      if (options.startWorker !== false) {
        await worker.start();
      }
    },
    stop: async () => {
      await worker.stop();
      if (options.queue) {
        // Caller owns the queue.
        return;
      }
      await queue.close();
      if (ownsRedis && redisClient) {
        await redisClient.quit();
      }
      if (ownsDatabase && database) {
        await database.close();
      }
    },
  };
  return handle;
}
