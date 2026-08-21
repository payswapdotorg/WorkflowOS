/**
 * Object storage abstraction for WorkflowOS (DATA-003).
 *
 * The frozen architecture requires object storage for large or immutable
 * artifacts where storing the complete content in PostgreSQL is undesirable
 * (architecture §30). PostgreSQL stores metadata and references to these
 * objects; the objects themselves live behind this provider-independent
 * interface.
 *
 * Provider independence (architecture §2.5): domain modules MUST depend on
 * {@link ObjectStore}, never on a concrete implementation (`FsObjectStore`,
 * S3 adapter, etc.). Future providers can be substituted without changing
 * domain code.
 *
 * Potential artifacts include large agent transcripts, PR snapshots, generated
 * reports, CI artifacts, large specification files, exported project data
 * (architecture §30).
 */

/**
 * Reference to a stored object. The `key` is provider-independent; combined
 * with the provider name it uniquely locates the object via {@link ObjectStore}.
 */
export interface StoredObjectRef {
  readonly key: string;
  readonly provider: string;
}

export interface PutObjectInput {
  /** Object content as a Buffer (binary-safe). */
  readonly body: Buffer;
  /** MIME / content type if known. */
  readonly contentType?: string;
  /** Provider-specific metadata (e.g. cache headers). */
  readonly metadata?: Record<string, string>;
}

export interface PutObjectResult extends StoredObjectRef {
  /** Object size in bytes. */
  readonly contentLength: number;
  /** SHA-256 digest of the stored content (hex), if computed. */
  readonly digestSha256?: string;
}

export interface ObjectStore {
  /**
   * Store an object and return a durable reference. The reference's `key` is
   * sufficient to retrieve the object later via {@link getObject}.
   */
  put(input: PutObjectInput): Promise<PutObjectResult>;

  /**
   * Retrieve an object by its storage key, or `null` if it does not exist.
   */
  get(key: string): Promise<StoredObject | null>;

  /**
   * Delete an object. Idempotent: deleting a non-existent key succeeds.
   */
  delete(key: string): Promise<void>;

  /** Provider name (e.g. `fs`, `s3`, `memory`). Used for persisted metadata. */
  readonly provider: string;
}

export interface StoredObject {
  readonly key: string;
  readonly body: Buffer;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
}
