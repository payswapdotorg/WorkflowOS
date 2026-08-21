import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type {
  ObjectStore,
  PutObjectInput,
  PutObjectResult,
  StoredObject,
} from './object-store.js';

/**
 * In-memory {@link ObjectStore} for tests and local dev.
 *
 * Provider name: `memory`. Satisfies the same {@link ObjectStore} interface as
 * production providers. Not durable across process restarts — production uses
 * {@link FsObjectStore} or a cloud provider adapter.
 */
export class InMemoryObjectStore implements ObjectStore {
  readonly provider = 'memory';
  private readonly objects = new Map<string, StoredObject>();

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    const key = randomUUID();
    const digest = sha256Hex(input.body);
    const stored: StoredObject = {
      key,
      body: Buffer.from(input.body),
      contentType: input.contentType,
      metadata: input.metadata,
    };
    this.objects.set(key, stored);
    return {
      key,
      provider: this.provider,
      contentLength: input.body.length,
      digestSha256: digest,
    };
  }

  async get(key: string): Promise<StoredObject | null> {
    const obj = this.objects.get(key);
    if (!obj) return null;
    return { ...obj, body: Buffer.from(obj.body) };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/** Compute the SHA-256 hex digest of a buffer. */
export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
