/**
 * V2-002 — Workflow Repository + Immutable Versioning: the public contracts.
 *
 * This module lives at `src/workflow-repository/` (application-layer
 * capability OUTSIDE src/modules/, mirroring the §34 benchmark /
 * execution-policy / agent-roles / delegation / orchestration pattern — NOT
 * an 18th frozen module). It owns the Git-like durable repository model of
 * the V2 constitution §2/§14:
 *
 *   Workflow (durable identity + repository scope + visibility)
 *     └── immutable WorkflowVersion (content-addressed, opaque content)
 *          └── WorkflowInstallation (pins ONE exact version)
 *
 * BOUNDARY CONTRACT (V2-002 vs its parallel W1 siblings — no-rebase wave):
 *
 *   - WorkflowIR SEMANTICS ARE NOT OWNED HERE (V2-003 owns the IR, its
 *     validation, and the SEMANTIC digest). Version `content` is an OPAQUE
 *     JSON document: this module stores it immutably, digests it
 *     deterministically for immutability/convergence proofs (the CONTENT
 *     digest — explicitly NOT the semantic digest), and NEVER interprets,
 *     validates, or claims workflow meaning.
 *   - Node/Capability semantics are V2-004's; Run/evidence is V2-005's (no
 *     execution engine exists here — installations are pinned, not run).
 *   - The protocol-compatibility descriptor (`protocol`) is a declaration
 *     the version author makes (currently the WorkflowIR schema version);
 *     it is persisted immutably and never interpreted by this layer.
 *   - Visibility identifiers come from the canonical V2-CTRL-003 registry
 *     (`private` | `organization` | `public`) — no aliases are introduced.
 *   - No secret material is stored anywhere in this module (constitution
 *     §16); forks transfer version content only — tenant-private state
 *     (installations/bindings) never transfers (constitution §14).
 */

// ============================================================================
// Canonical visibility (V2-CTRL-003 registry identifiers — no aliases)
// ============================================================================

/** The canonical repository visibility identifiers (registry-conformant). */
export const WORKFLOW_VISIBILITIES = ['private', 'organization', 'public'] as const;

export type WorkflowVisibility = (typeof WORKFLOW_VISIBILITIES)[number];

// ============================================================================
// Installation lifecycle (repository vocabulary; never a workflow state)
// ============================================================================

export type WorkflowInstallationStatus = 'enabled' | 'disabled' | 'uninstalled';

export type WorkflowInstallationAction = 'enable' | 'disable' | 'uninstall';

// ============================================================================
// Protocol compatibility descriptor (opaque to this module)
// ============================================================================

/**
 * The protocol-compatibility descriptor an immutable version carries.
 *
 * `irSchemaVersion` is the WorkflowIR schema version the version author
 * declares the content to be compatible with. It is OPAQUE to the
 * repository: persisted immutably, part of the version identity inputs,
 * and never validated or interpreted here (WorkflowIR semantics are owned
 * by V2-003; the compiler by V2-007).
 */
export interface WorkflowVersionProtocolDescriptor {
  readonly irSchemaVersion: string;
}

// ============================================================================
// Durable records
// ============================================================================

/** The acting principal (a persisted WorkflowOS user). */
export interface WorkflowPrincipal {
  readonly userId: string;
}

/** A Workflow — the durable repository identity (constitution §2). */
export interface Workflow {
  readonly id: string;
  /** TENANT scope — the organization owning the workflow repository. */
  readonly organizationId: string;
  /** The durable owner (the forker, for forks). */
  readonly ownerUserId: string;
  /** The immutable logical key within the tenant (repo name). */
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly visibility: WorkflowVisibility;
  /** The current head version (advanced ONLY by creating a new version). */
  readonly headVersionId: string | null;
  /** FORK PROVENANCE — preserved, never rewritten (constitution §14). */
  readonly forkedFromWorkflowId: string | null;
  readonly forkedFromVersionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * An immutable WorkflowVersion (constitution §2: "immutable executable
 * meaning"; §19: silently altering one is forbidden drift).
 *
 * `contentDigest` is the CONTENT digest — SHA-256 over canonical JSON of
 * the OPAQUE content document — an immutability and deterministic-
 * convergence proof. It is NOT the semantic digest: the semantic digest of
 * a WorkflowVersion is computed from its canonical WorkflowIR and is owned
 * by V2-003.
 */
export interface WorkflowVersion {
  readonly id: string;
  readonly workflowId: string;
  /** Per-workflow sequence (a convenience label; the ID is the identity). */
  readonly versionNumber: number;
  readonly contentDigest: string;
  /** The OPAQUE version content (WorkflowIR semantics: V2-003's). */
  readonly content: Readonly<Record<string, unknown>>;
  readonly protocol: WorkflowVersionProtocolDescriptor;
  /** Ancestry: the version this one was created after (NULL = root). */
  readonly parentVersionId: string | null;
  readonly createdByUserId: string;
  readonly createdAt: Date;
}

/**
 * A WorkflowInstallation — an installation/deployment PIN: it binds ONE
 * tenant to ONE EXACT immutable version (constitution §14: "Installation
 * pins a version. Publisher edits create later versions and cannot mutate
 * customer-installed versions silently").
 *
 * The full WorkflowDeployment concept (execution placement and policy —
 * constitution §2) is downstream (V2-008/V2-009); when it lands it pins the
 * SAME immutable version identity this record pins. This module owns the
 * pin persistence, not placement policy.
 */
export interface WorkflowInstallation {
  readonly id: string;
  readonly organizationId: string;
  readonly workflowId: string;
  /** The pinned EXACT version — immutable for the installation's life. */
  readonly versionId: string;
  readonly installedByUserId: string;
  readonly status: WorkflowInstallationStatus;
  readonly installedAt: Date;
  readonly updatedAt: Date;
}

/** An installation with its pinned version resolved (one-read pin proof). */
export interface WorkflowInstallationDetail {
  readonly installation: WorkflowInstallation;
  readonly pinnedVersion: {
    readonly id: string;
    readonly workflowId: string;
    readonly versionNumber: number;
    readonly contentDigest: string;
    readonly protocol: WorkflowVersionProtocolDescriptor;
  };
}

// ============================================================================
// Inputs / results (create-or-converge everywhere: duplicates converge)
// ============================================================================

export interface CreateWorkflowInput {
  readonly organizationId: string;
  readonly slug: string;
  readonly name: string;
  readonly description?: string | null;
  readonly visibility: WorkflowVisibility;
  /** The workflow is BORN with its immutable version 1 (content required). */
  readonly content: Record<string, unknown>;
  readonly protocol: WorkflowVersionProtocolDescriptor;
}

/** Mutable repository metadata (never version content — that is a new version). */
export interface UpdateWorkflowPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly visibility?: WorkflowVisibility;
}

export interface CreateVersionInput {
  readonly content: Record<string, unknown>;
  readonly protocol: WorkflowVersionProtocolDescriptor;
  /** Defaults to the workflow's current head. Must belong to the workflow. */
  readonly parentVersionId?: string | null;
}

export interface ForkWorkflowInput {
  /** The forker's tenant (the fork is created here). */
  readonly organizationId: string;
  readonly sourceWorkflowId: string;
  readonly sourceVersionId: string;
  readonly slug: string;
  readonly name?: string;
  readonly description?: string | null;
  /** Defaults to `private` (a fork never leaks the source's scope). */
  readonly visibility?: WorkflowVisibility;
}

export interface InstallVersionInput {
  /** The tenant installing (may differ from the workflow's owner tenant). */
  readonly organizationId: string;
  readonly workflowId: string;
  readonly versionId: string;
}

export interface CreateWorkflowResult {
  readonly workflow: Workflow;
  readonly initialVersion: WorkflowVersion;
  /** false = converged on an existing workflow (idempotent create). */
  readonly created: boolean;
}

export interface CreateVersionResult {
  readonly version: WorkflowVersion;
  /** false = converged on the existing immutable version (duplicate content). */
  readonly created: boolean;
}

/**
 * A fork result's initial version: the workflow's (possibly pre-existing)
 * immutable version carrying the source content, plus the per-version
 * create-or-converge flag (a converged fork workflow can still gain a NEW
 * version when a NEWER source version is forked under the same slug).
 */
export type ForkInitialVersion = WorkflowVersion & {
  /** false = converged on an existing immutable version of the fork. */
  readonly created: boolean;
};

export interface ForkWorkflowResult {
  readonly workflow: Workflow;
  readonly initialVersion: ForkInitialVersion;
  /** false = converged on an existing fork workflow (idempotent fork). */
  readonly created: boolean;
}

export interface InstallVersionResult {
  readonly installation: WorkflowInstallation;
  /** false = converged on the existing installation (idempotent install). */
  readonly created: boolean;
}

// ============================================================================
// The membership port (identity authority consumed, never re-implemented)
// ============================================================================

/**
 * The organization-membership fact source. The identity/authorization
 * authority (the /auth + /organizations modules) owns membership truth;
 * this module CONSUMES it through this port and layers repository
 * visibility rules on top.
 */
export interface OrganizationMembershipResolver {
  isMember(userId: string, organizationId: string): Promise<boolean>;
}

// ============================================================================
// The service contract
// ============================================================================

/**
 * The workflow repository service: the one repository authority for the V2
 * Git-like model — lifecycle, immutable versions, forks, installs, and
 * repository visibility/permission rules.
 *
 * Every mutating operation is create-or-converge: duplicates (retries,
 * duplicate submissions) converge on the existing durable identity instead
 * of creating divergent rows.
 */
export interface WorkflowRepositoryService {
  /** Create a workflow (born with immutable version 1) — converges on (tenant, slug). */
  createWorkflow(principal: WorkflowPrincipal, input: CreateWorkflowInput): Promise<CreateWorkflowResult>;

  /** Read one workflow (visibility-checked; denied reads are typed 404s — no existence leak). */
  getWorkflow(principal: WorkflowPrincipal, workflowId: string): Promise<Workflow>;

  /** Update repository metadata (owner-only; never touches versions). */
  updateWorkflow(
    principal: WorkflowPrincipal,
    workflowId: string,
    patch: UpdateWorkflowPatch,
  ): Promise<Workflow>;

  /** List the tenant's workflows visible to the principal (member-only). */
  listWorkflowsInOrganization(
    principal: WorkflowPrincipal,
    organizationId: string,
  ): Promise<Workflow[]>;

  /** Create a new immutable version (owner-only "edit") — converges on content. */
  createVersion(
    principal: WorkflowPrincipal,
    workflowId: string,
    input: CreateVersionInput,
  ): Promise<CreateVersionResult>;

  /** Read one exact version (visibility-checked; must belong to the workflow). */
  getVersion(
    principal: WorkflowPrincipal,
    workflowId: string,
    versionId: string,
  ): Promise<WorkflowVersion>;

  /** List the workflow's versions in stable (version_number, id) order. */
  listVersions(principal: WorkflowPrincipal, workflowId: string): Promise<WorkflowVersion[]>;

  /**
   * Fork: a NEW independent workflow identity in the forker's tenant with
   * preserved provenance, whose first version carries the source version's
   * content. Source private state (installations) never transfers.
   */
  forkWorkflow(principal: WorkflowPrincipal, input: ForkWorkflowInput): Promise<ForkWorkflowResult>;

  /**
   * Install ONE EXACT version into a tenant. The installation pins that
   * version forever; a newer version can never move it.
   */
  installVersion(
    principal: WorkflowPrincipal,
    input: InstallVersionInput,
  ): Promise<InstallVersionResult>;

  /** Enable / disable / uninstall an installation (never touches versions). */
  setInstallationStatus(
    principal: WorkflowPrincipal,
    organizationId: string,
    installationId: string,
    action: WorkflowInstallationAction,
  ): Promise<WorkflowInstallation>;

  /** Read one installation of a tenant (with its pinned version resolved). */
  getInstallation(
    principal: WorkflowPrincipal,
    organizationId: string,
    installationId: string,
  ): Promise<WorkflowInstallationDetail>;

  /** List a tenant's installations with their pinned versions (member-only). */
  listInstallations(
    principal: WorkflowPrincipal,
    organizationId: string,
  ): Promise<WorkflowInstallationDetail[]>;
}

// ============================================================================
// Typed errors (stable machine-readable codes — never parse message strings)
// ============================================================================

export const WORKFLOW_REPOSITORY_ERROR_CODES = [
  'WORKFLOW_NOT_FOUND',
  'WORKFLOW_NOT_VISIBLE',
  'WORKFLOW_NOT_OWNED',
  'WORKFLOW_VERSION_NOT_FOUND',
  'WORKFLOW_INSTALLATION_NOT_FOUND',
  'WORKFLOW_NOT_ORGANIZATION_MEMBER',
  'WORKFLOW_INVALID_SLUG',
  'WORKFLOW_NAME_REQUIRED',
  'WORKFLOW_INVALID_VISIBILITY',
  'WORKFLOW_INVALID_CONTENT',
  'WORKFLOW_INVALID_PROTOCOL',
  'WORKFLOW_INVALID_PARENT_VERSION',
] as const;

export type WorkflowRepositoryErrorCode = (typeof WORKFLOW_REPOSITORY_ERROR_CODES)[number];

/** The typed workflow-repository error (discriminated by `code`). */
export class WorkflowRepositoryError extends Error {
  readonly code: WorkflowRepositoryErrorCode;

  constructor(code: WorkflowRepositoryErrorCode, message: string) {
    super(`workflow-repository: ${message}`);
    this.name = 'WorkflowRepositoryError';
    this.code = code;
  }
}
