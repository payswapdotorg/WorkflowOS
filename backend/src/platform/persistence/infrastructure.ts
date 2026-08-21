import type { DatabaseClient } from '../postgres/database-client.js';
import type { Redis } from 'ioredis';
import type { Queue } from '../queue/queue.js';
import type { ObjectStore } from '../storage/object-store.js';
import { TransientLock } from '../redis/transient-lock.js';
import { TransientCache } from '../redis/transient-cache.js';
import { ArtifactMetadataRepository } from './artifact-metadata-repository.js';
import type { Logger } from '../logger.js';

/**
 * Shared infrastructure container for WorkflowOS (DATA-001 / DATA-002 / DATA-003).
 *
 * Centralizes the construction of the three storage boundaries so that domain
 * modules never create their own PostgreSQL pools, Redis clients, or
 * object-storage implementations. Later work items obtain these from the
 * container (or via the platform barrel) instead of constructing them.
 *
 * Boundary rules (enforced by the static architecture check):
 *
 * - Domain modules depend on the *interfaces* (`DatabaseClient`, `Queue`,
 *   `ObjectStore`, `TransientLock`, `TransientCache`), not on `pg` / `ioredis`
 *   / a concrete object-store implementation.
 * - `platform/` is the only layer that constructs concrete infrastructure
 *   clients.
 *
 * Ownership of the underlying connections is delegated to the caller: the
 * container holds references but does NOT close them. The composition root
 * (`buildApp`) owns the lifecycle.
 */
export interface Infrastructure {
  /** Authoritative PostgreSQL application database (architecture §28). */
  readonly database: DatabaseClient;
  /** Shared Redis client for queues, locks, cache, coordination (§29). */
  readonly redis: Redis;
  /** Background job queue (reused from WORK-001, §27). */
  readonly queue: Queue;
  /** Object storage for large/immutable artifacts (§30). */
  readonly objectStore: ObjectStore;
  /** Transient, non-authoritative distributed lock (§29). */
  readonly transientLock: TransientLock;
  /** Transient, non-authoritative cache (§29). */
  readonly transientCache: TransientCache;
  /** Repository for durable artifact-metadata records (DATA3-AC-01). */
  readonly artifactMetadata: ArtifactMetadataRepository;
}

export interface BuildInfrastructureOptions {
  database: DatabaseClient;
  redis: Redis;
  queue: Queue;
  objectStore: ObjectStore;
  logger?: Logger;
}

/**
 * Assemble the {@link Infrastructure} container from already-constructed
 * clients. Domain code receives the container; it never builds the clients.
 */
export function buildInfrastructure(
  options: BuildInfrastructureOptions,
): Infrastructure {
  return {
    database: options.database,
    redis: options.redis,
    queue: options.queue,
    objectStore: options.objectStore,
    transientLock: new TransientLock(options.redis, options.logger),
    transientCache: new TransientCache(options.redis),
    artifactMetadata: new ArtifactMetadataRepository(options.database),
  };
}
