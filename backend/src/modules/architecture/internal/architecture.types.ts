/**
 * Architecture domain types (ARCH-001..004, ARCH-AC-01..03, ARCH2/3/4-AC-01..03).
 *
 * The /architecture module owns the runtime project-specific Architecture,
 * ArchitectureVersion, Architecture Decision Records (ADRs), and Architecture
 * Change Requests. This is distinct from the frozen repository governance
 * documents (/spec/architecture.md, /spec/architecture-lock.md) which are NOT
 * modified by this module.
 *
 * Architecture is a versioned project artifact (spec/architecture.md §9).
 * Lifecycle: DRAFT → FROZEN → SUPERSEDED. A frozen version is immutable
 * (enforced at the persistence level, not just the service layer).
 *
 * Tenant scoping is inherited through the project's owning organization
 * (reused WORK-002 AuthorizationService).
 */

// --- Architecture ---

export interface Architecture {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateArchitectureInput {
  projectId: string;
  name: string;
  description?: string;
}

// --- ArchitectureVersion ---

export type ArchitectureVersionState = 'draft' | 'frozen' | 'superseded';

export interface ArchitectureVersion {
  readonly id: string;
  readonly architectureId: string;
  readonly versionNumber: number;
  readonly state: ArchitectureVersionState;
  readonly contentInline: string | null;
  readonly storageKey: string | null;
  readonly storageProvider: string | null;
  readonly contentLength: number;
  readonly contentType: string | null;
  readonly digestSha256: string | null;
  readonly metadata: Record<string, unknown>;
  readonly frozenAt: Date | null;
  readonly frozenBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateArchitectureVersionInput {
  architectureId: string;
  contentInline?: string;
  storageKey?: string;
  storageProvider?: string;
  contentLength?: number;
  contentType?: string;
  digestSha256?: string;
  metadata?: Record<string, unknown>;
}

export interface ArchitectureVersionRepository {
  create(input: CreateArchitectureVersionInput): Promise<ArchitectureVersion>;
  findById(id: string): Promise<ArchitectureVersion | null>;
  findByArchitecture(architectureId: string): Promise<ArchitectureVersion[]>;
  findLatest(architectureId: string): Promise<ArchitectureVersion | null>;
  /** Transition state. Validates the transition. Rejects content mutation on frozen. */
  transitionState(id: string, to: ArchitectureVersionState, frozenBy?: string): Promise<ArchitectureVersion>;
}

// --- Architecture (root) repository ---

export interface ArchitectureRepository {
  create(input: CreateArchitectureInput): Promise<Architecture>;
  findById(id: string): Promise<Architecture | null>;
  findByProject(projectId: string): Promise<Architecture[]>;
}

// --- Architecture Decision Records (ARCH-003) ---

export interface ArchitectureDecisionRecord {
  readonly id: string;
  readonly versionId: string;
  readonly adrNumber: number;
  readonly title: string;
  readonly content: string;
  readonly status: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface CreateAdrInput {
  versionId: string;
  title: string;
  content: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface ArchitectureDecisionRepository {
  create(input: CreateAdrInput): Promise<ArchitectureDecisionRecord>;
  findById(id: string): Promise<ArchitectureDecisionRecord | null>;
  listForVersion(versionId: string): Promise<ArchitectureDecisionRecord[]>;
}

// --- Architecture Change Requests (ARCH-004) ---

export type ChangeRequestStatus = 'requested' | 'approved' | 'rejected';

export interface ArchitectureChangeRequest {
  readonly id: string;
  readonly architectureId: string;
  readonly affectedVersionId: string | null;
  readonly requesterId: string | null;
  readonly reason: string;
  readonly requestedChange: string;
  readonly status: ChangeRequestStatus;
  readonly approverId: string | null;
  readonly approvedAt: Date | null;
  readonly replacementVersionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateChangeRequestInput {
  architectureId: string;
  affectedVersionId?: string;
  requesterId?: string;
  reason: string;
  requestedChange: string;
}

export interface ArchitectureChangeRequestRepository {
  create(input: CreateChangeRequestInput): Promise<ArchitectureChangeRequest>;
  findById(id: string): Promise<ArchitectureChangeRequest | null>;
  listForArchitecture(architectureId: string): Promise<ArchitectureChangeRequest[]>;
  approve(id: string, approverId: string): Promise<ArchitectureChangeRequest>;
  reject(id: string, approverId: string): Promise<ArchitectureChangeRequest>;
  /** Link the replacement version after approved-change version creation. */
  linkReplacement(id: string, replacementVersionId: string): Promise<ArchitectureChangeRequest>;
}

/**
 * The ArchitectureService is the domain service that orchestrates the
 * architecture change process (ARCH4-AC-03). The approved Change Request →
 * new version → previous version SUPERSEDED transition is ATOMIC (a single
 * transaction).
 *
 * Only an APPROVED Change Request may initiate replacement-version creation.
 */
export interface ArchitectureService {
  /**
   * Freeze a DRAFT version. Validates the transition (DRAFT → FROZEN only).
   * Once frozen, the version's content is immutable (persistence-enforced).
   */
  freezeVersion(versionId: string, frozenBy: string): Promise<ArchitectureVersion>;

  /**
   * Approve a Change Request and atomically create a replacement version.
   * The previous frozen version becomes SUPERSEDED; the new version starts
   * in DRAFT. This is a single transaction (ARCH4-AC-03).
   *
   * @returns the new ArchitectureVersion and the updated ChangeRequest.
   */
  approveChangeAndCreateReplacement(
    changeRequestId: string,
    approverId: string,
    newVersionContent: {
      contentInline?: string;
      storageKey?: string;
      storageProvider?: string;
      contentLength?: number;
      contentType?: string;
      digestSha256?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ newVersion: ArchitectureVersion; changeRequest: ArchitectureChangeRequest }>;

  /**
   * Reject a Change Request. No replacement version is created.
   */
  rejectChangeRequest(changeRequestId: string, approverId: string): Promise<ArchitectureChangeRequest>;
}
