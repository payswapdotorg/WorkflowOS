import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import type {
  ObjectStore,
  PutObjectInput,
  PutObjectResult,
  StoredObject,
} from './object-store.js';

/**
 * Filesystem-backed {@link ObjectStore} (DATA-003).
 *
 * Stores objects as files under a configured root directory. Suitable for
 * local development and single-node deployments. Cloud deployments may
 * substitute an S3/GCS adapter (added by a later work item if required)
 * without changing domain code — both satisfy {@link ObjectStore}.
 *
 * The provider name is `fs`. Storage keys are opaque UUIDs; the filesystem
 * path is `<root>/<key>`.
 */
export class FsObjectStore implements ObjectStore {
  readonly provider = 'fs';

  constructor(private readonly rootDir: string) {}

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    await mkdir(this.rootDir, { recursive: true });
    const key = randomUUID();
    const path = this.pathFor(key);
    await writeFile(path, input.body);
    const digest = sha256Hex(input.body);
    // Sidecar metadata file so we can restore contentType/metadata on get.
    const sidecar = `${path}.meta.json`;
    await writeFile(
      sidecar,
      JSON.stringify({
        contentType: input.contentType ?? null,
        metadata: input.metadata ?? {},
      }),
    );
    return {
      key,
      provider: this.provider,
      contentLength: input.body.length,
      digestSha256: digest,
    };
  }

  async get(key: string): Promise<StoredObject | null> {
    const path = this.pathFor(key);
    try {
      await stat(path);
    } catch {
      return null;
    }
    const body = await readFile(path);
    const sidecar = `${path}.meta.json`;
    let contentType: string | undefined;
    let metadata: Record<string, string> | undefined;
    try {
      const metaJson = await readFile(sidecar, 'utf8');
      const parsed = JSON.parse(metaJson) as {
        contentType: string | null;
        metadata: Record<string, string>;
      };
      contentType = parsed.contentType ?? undefined;
      metadata = parsed.metadata;
    } catch {
      // No sidecar — content/metadata unknown but body is still retrievable.
    }
    return { key, body, contentType, metadata };
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.meta.json`, { force: true });
  }

  private pathFor(key: string): string {
    return join(this.rootDir, key);
  }
}

/** Compute the SHA-256 hex digest of a buffer. */
function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Create an {@link FsObjectStore} rooted at a fresh temporary directory.
 * Useful for tests that want isolation without managing cleanup.
 */
export function createTempFsObjectStore(): FsObjectStore {
  const root = join(tmpdir(), `wfos-objstore-${randomUUID()}`);
  return new FsObjectStore(root);
}
