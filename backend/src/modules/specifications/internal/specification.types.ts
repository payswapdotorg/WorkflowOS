/**
 * Specification domain types (SPEC-001, SPEC-AC-01..03).
 *
 * A specification belongs to exactly one project (architecture §6). Tenant
 * scoping is inherited through the project's owning organization — the
 * AuthorizationService resolves access via the project.
 *
 * Large/immutable specification content is stored via the existing ObjectStore
 * abstraction (DATA-003); only references + metadata live in PostgreSQL.
 */

/** Explicit specification lifecycle state (SPEC-AC-02). */
export type SpecificationState = 'draft' | 'published' | 'archived';

/** A specification record. Belongs to exactly one project. */
export interface Specification {
  readonly id: string;
  readonly projectId: string;
  readonly slug: string;
  readonly title: string;
  readonly state: SpecificationState;
  readonly currentVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateSpecificationInput {
  projectId: string;
  slug: string;
  title: string;
}

export interface UpdateSpecificationInput {
  title?: string;
}

/** A specification version — an immutable record of content at a point in time. */
export interface SpecificationVersion {
  readonly id: string;
  readonly specificationId: string;
  readonly versionNumber: number;
  /** Object-storage key when content is stored externally (large bodies). */
  readonly storageKey: string | null;
  readonly storageProvider: string | null;
  /** Inline content for small specs; null when using object storage. */
  readonly contentInline: string | null;
  readonly contentLength: number;
  readonly contentType: string | null;
  readonly digestSha256: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

/** Input for creating a new version. Content may be inline or in object storage. */
export interface CreateSpecificationVersionInput {
  specificationId: string;
  /** When provided, content is stored inline (small specs). */
  contentInline?: string;
  /** When provided, content is referenced from object storage (large bodies). */
  storageKey?: string;
  storageProvider?: string;
  contentLength: number;
  contentType?: string;
  digestSha256?: string;
  createdBy?: string;
}

/** Result of a specification lifecycle transition. */
export interface SpecificationLifecycleTransition {
  readonly specificationId: string;
  readonly from: SpecificationState;
  readonly to: SpecificationState;
}

/**
 * Repository contract for specification persistence.
 */
export interface SpecificationRepository {
  create(input: CreateSpecificationInput): Promise<Specification>;
  findById(id: string): Promise<Specification | null>;
  findByProjectAndSlug(projectId: string, slug: string): Promise<Specification | null>;
  update(id: string, input: UpdateSpecificationInput): Promise<Specification | null>;
  transitionState(id: string, to: SpecificationState): Promise<SpecificationLifecycleTransition>;
  listForProject(projectId: string): Promise<Specification[]>;
}

/**
 * Repository contract for specification versions (SPEC-AC-03).
 */
export interface SpecificationVersionRepository {
  create(input: CreateSpecificationVersionInput): Promise<SpecificationVersion>;
  findLatest(specificationId: string): Promise<SpecificationVersion | null>;
  findBySpecAndVersion(specificationId: string, versionNumber: number): Promise<SpecificationVersion | null>;
  listForSpecification(specificationId: string): Promise<SpecificationVersion[]>;
}
