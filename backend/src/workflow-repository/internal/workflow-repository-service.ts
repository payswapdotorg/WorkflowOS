/**
 * V2-002 — the workflow repository service: the one authority for the V2
 * Git-like durable repository model (Workflow, immutable WorkflowVersion,
 * WorkflowInstallation).
 *
 * Composition (constitution §2/§14, work order V2-002):
 *
 *   - IDENTITY is derived deterministically BEFORE persistence (internal/
 *     identity.ts): identical authoritative inputs converge on byte-identical
 *     identities — no random/uuid/timestamp ever enters identity.
 *   - PERSISTENCE is the PostgreSQL layer (internal/pg-workflow-repository.ts
 *     + migration 0060): create-or-converge inserts, DB-level immutability
 *     triggers, composite tuple integrity.
 *   - VISIBILITY is the pure policy (internal/visibility-policy.ts) fed by
 *     the identity authority's membership fact (OrganizationMembershipResolver
 *     port — consumed, never re-implemented here).
 *
 * BOUNDARIES (explicit, never silent):
 *   - version `content` is OPAQUE: never interpreted or validated as workflow
 *     semantics here (V2-003 owns WorkflowIR semantics + the SEMANTIC digest;
 *     the digest here is the CONTENT digest);
 *   - `protocol` is the author's compatibility declaration (opaque, persisted
 *     immutably). Its shape is validated as a STORAGE contract (exactly one
 *     `irSchemaVersion` string key — the closed descriptor of this module's
 *     public type) so the deterministic version identity stays total over the
 *     stored descriptor; no workflow meaning is inferred from it;
 *   - no execution engine: installations pin versions but never run them
 *     (WorkflowRun is V2-005's).
 */
import type { DatabaseClient } from '@platform/index.js';
import type {
  CreateVersionInput,
  CreateVersionResult,
  CreateWorkflowInput,
  CreateWorkflowResult,
  ForkInitialVersion,
  ForkWorkflowInput,
  ForkWorkflowResult,
  InstallVersionInput,
  InstallVersionResult,
  OrganizationMembershipResolver,
  UpdateWorkflowPatch,
  Workflow,
  WorkflowInstallation,
  WorkflowInstallationAction,
  WorkflowInstallationDetail,
  WorkflowPrincipal,
  WorkflowRepositoryService,
  WorkflowVersion,
  WorkflowVersionProtocolDescriptor,
  WorkflowVisibility,
} from '../types.js';
import {
  WorkflowRepositoryError,
  WORKFLOW_VISIBILITIES,
} from '../types.js';
import {
  computeContentDigest,
  deriveWorkflowId,
  deriveWorkflowInstallationId,
  deriveWorkflowVersionId,
} from './identity.js';
import {
  PgWorkflowRepository,
  isVersionNumberRace,
  mapInstallationDetailRow,
  mapInstallationRow,
  mapVersionRow,
  mapWorkflowRow,
  type InstallationRow,
  type VersionRow,
  type WorkflowRow,
} from './pg-workflow-repository.js';
import { decideWorkflowReadAccessFor } from './visibility-policy.js';

export interface DefaultWorkflowRepositoryServiceDeps {
  /** The authoritative PostgreSQL client (the persistence authority). */
  readonly db: DatabaseClient;
  /** The identity authority's membership fact source (consumed port). */
  readonly memberships: OrganizationMembershipResolver;
}

/**
 * Retries for the concurrent version-number allocation race (UNIQUE
 * (workflow_id, version_number)). Each retry re-allocates from durable state,
 * so convergence is deterministic — a race never loses a row.
 */
const VERSION_NUMBER_RACE_ATTEMPTS = 5;

/** The canonical slug shape (the immutable logical repo name, 1–64 chars). */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** True for a plain JSON object (NOT an array — arrays are content-invalid). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalVisibility(value: unknown): value is WorkflowVisibility {
  return (
    typeof value === 'string' &&
    (WORKFLOW_VISIBILITIES as readonly string[]).includes(value)
  );
}

/** Fail-closed structural validation (typed codes — never string parsing). */
function assertSlug(slug: string): void {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new WorkflowRepositoryError(
      'WORKFLOW_INVALID_SLUG',
      `slug must be 1-64 lowercase alphanumeric characters with no leading/trailing hyphen (got: ${JSON.stringify(slug)})`,
    );
  }
}

function assertName(name: string): void {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new WorkflowRepositoryError(
      'WORKFLOW_NAME_REQUIRED',
      'a non-empty workflow name is required',
    );
  }
}

function assertVisibility(visibility: unknown): asserts visibility is WorkflowVisibility {
  if (!isCanonicalVisibility(visibility)) {
    throw new WorkflowRepositoryError(
      'WORKFLOW_INVALID_VISIBILITY',
      `visibility must be one of ${WORKFLOW_VISIBILITIES.join('|')} (canonical registry identifiers — no aliases)`,
    );
  }
}

function assertContent(content: unknown): asserts content is Record<string, unknown> {
  if (!isPlainObject(content)) {
    throw new WorkflowRepositoryError(
      'WORKFLOW_INVALID_CONTENT',
      'version content must be a JSON object (it is stored opaquely — WorkflowIR semantics are owned by V2-003)',
    );
  }
}

function assertProtocol(
  protocol: unknown,
): asserts protocol is WorkflowVersionProtocolDescriptor {
  if (!isPlainObject(protocol)) {
    throw new WorkflowRepositoryError(
      'WORKFLOW_INVALID_PROTOCOL',
      'protocol must be an object declaring the version author\'s compatibility descriptor',
    );
  }
  const keys = Object.keys(protocol);
  if (keys.length !== 1 || keys[0] !== 'irSchemaVersion') {
    throw new WorkflowRepositoryError(
      'WORKFLOW_INVALID_PROTOCOL',
      'protocol must declare exactly irSchemaVersion (the closed compatibility descriptor of this module)',
    );
  }
  const irSchemaVersion = protocol.irSchemaVersion;
  if (typeof irSchemaVersion !== 'string' || irSchemaVersion.length === 0) {
    throw new WorkflowRepositoryError(
      'WORKFLOW_INVALID_PROTOCOL',
      'protocol.irSchemaVersion must be a non-empty string',
    );
  }
}

/**
 * The default V2-002 repository service.
 *
 * Every mutating operation is create-or-converge (idempotent): duplicate
 * submissions converge on the existing durable identity instead of creating
 * divergent rows. Reads are visibility-checked; denied reads are typed 404s
 * so callers can answer WITHOUT leaking the existence of scoped workflows.
 */
export class DefaultWorkflowRepositoryService implements WorkflowRepositoryService {
  private readonly repo: PgWorkflowRepository;
  private readonly memberships: OrganizationMembershipResolver;

  constructor(deps: DefaultWorkflowRepositoryServiceDeps) {
    this.repo = new PgWorkflowRepository(deps.db);
    this.memberships = deps.memberships;
  }

  // --- helpers --------------------------------------------------------------

  /** The identity authority's membership fact for (userId, organizationId). */
  private async isMember(userId: string, organizationId: string): Promise<boolean> {
    return this.memberships.isMember(userId, organizationId);
  }

  /**
   * Enforce the tenant gate: acting inside an organization the principal does
   * not belong to is rejected (fail-closed) — BEFORE any scoped data is read.
   */
  private async assertOrganizationMember(
    principal: WorkflowPrincipal,
    organizationId: string,
  ): Promise<void> {
    const member = await this.isMember(principal.userId, organizationId);
    if (!member) {
      throw new WorkflowRepositoryError(
        'WORKFLOW_NOT_ORGANIZATION_MEMBER',
        `user ${principal.userId} is not a member of organization ${organizationId}`,
      );
    }
  }

  /**
   * Enforce repository read visibility (the pure policy + the membership
   * fact). Denied reads raise WORKFLOW_NOT_VISIBLE so the API layer can
   * answer a uniform typed 404 WITHOUT leaking existence.
   */
  private async assertReadVisible(
    principal: WorkflowPrincipal,
    row: WorkflowRow,
  ): Promise<void> {
    const isOrganizationMember =
      row.owner_user_id === principal.userId ||
      (await this.isMember(principal.userId, row.organization_id));
    const decision = decideWorkflowReadAccessFor(
      principal,
      {
        visibility: row.visibility,
        ownerUserId: row.owner_user_id,
        organizationId: row.organization_id,
      },
      isOrganizationMember,
    );
    if (!decision.allowed) {
      throw new WorkflowRepositoryError(
        'WORKFLOW_NOT_VISIBLE',
        `workflow ${row.id} is not visible to user ${principal.userId}`,
      );
    }
  }

  /** Load a workflow row or raise the typed 404. */
  private async requireWorkflowRow(workflowId: string): Promise<WorkflowRow> {
    const row = await this.repo.findWorkflowById(workflowId);
    if (!row) {
      throw new WorkflowRepositoryError(
        'WORKFLOW_NOT_FOUND',
        `workflow ${workflowId} does not exist`,
      );
    }
    return row;
  }

  /** Load a workflow row the principal may read (visibility-checked 404). */
  private async requireVisibleWorkflowRow(
    principal: WorkflowPrincipal,
    workflowId: string,
  ): Promise<WorkflowRow> {
    const row = await this.requireWorkflowRow(workflowId);
    await this.assertReadVisible(principal, row);
    return row;
  }

  /** Load a version that must belong to the given workflow (tuple integrity). */
  private async requireVersionRowOfWorkflow(
    workflowId: string,
    versionId: string,
  ): Promise<VersionRow> {
    const row = await this.repo.findVersionById(versionId);
    if (!row || row.workflow_id !== workflowId) {
      throw new WorkflowRepositoryError(
        'WORKFLOW_VERSION_NOT_FOUND',
        `version ${versionId} does not exist in workflow ${workflowId}`,
      );
    }
    return row;
  }

  /** The resolved parent for a new version (defaults to the current head). */
  private async resolveParentVersionId(
    workflowRow: WorkflowRow,
    requested: string | null | undefined,
  ): Promise<string | null> {
    if (requested === undefined || requested === null) {
      return workflowRow.head_version_id;
    }
    // An explicitly declared parent must belong to the SAME workflow
    // (ancestry cannot cross workflows).
    const parent = await this.repo.findVersionById(requested);
    if (!parent || parent.workflow_id !== workflowRow.id) {
      throw new WorkflowRepositoryError(
        'WORKFLOW_INVALID_PARENT_VERSION',
        `parent version ${requested} does not exist in workflow ${workflowRow.id}`,
      );
    }
    return requested;
  }

  // --- workflow lifecycle ---------------------------------------------------

  async createWorkflow(
    principal: WorkflowPrincipal,
    input: CreateWorkflowInput,
  ): Promise<CreateWorkflowResult> {
    assertSlug(input.slug);
    assertName(input.name);
    assertVisibility(input.visibility);
    assertContent(input.content);
    assertProtocol(input.protocol);
    await this.assertOrganizationMember(principal, input.organizationId);

    const workflowId = deriveWorkflowId({
      organizationId: input.organizationId,
      ownerUserId: principal.userId,
      slug: input.slug,
    });
    const contentDigest = computeContentDigest(input.content);
    const initialVersionId = deriveWorkflowVersionId({
      workflowId,
      contentDigest,
      protocol: input.protocol,
    });

    return this.repo.transaction(async (tx) => {
      const { row: workflowRow, created } = await this.repo.insertWorkflowOrConverge(tx, {
        id: workflowId,
        organizationId: input.organizationId,
        ownerUserId: principal.userId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        visibility: input.visibility,
        forkedFromWorkflowId: null,
        forkedFromVersionId: null,
      });

      if (!created) {
        // Converged creation never mutates the existing workflow. The
        // "initial version" of a converged create is the workflow's BORN
        // version (version_number = 1), read in the same transaction.
        const initial = await this.repo.findInitialVersion(workflowRow.id, tx);
        if (!initial) {
          throw new Error(
            `workflow-repository: workflow ${workflowRow.id} has no initial version (invariant violation)`,
          );
        }
        return { workflow: mapWorkflowRow(workflowRow), initialVersion: mapVersionRow(initial), created: false };
      }

      // The workflow is BORN with its immutable version 1 (content required).
      const inserted = await this.repo.insertVersionOrConverge(tx, {
        id: initialVersionId,
        workflowId: workflowRow.id,
        contentDigest,
        content: input.content,
        protocol: input.protocol,
        parentVersionId: null,
        createdByUserId: principal.userId,
      });
      if (!inserted.created) {
        throw new Error(
          `workflow-repository: freshly created workflow ${workflowRow.id} converged on a pre-existing version (invariant violation)`,
        );
      }
      await this.repo.setHeadVersion(tx, workflowRow.id, inserted.row.id);
      // Re-read INSIDE the transaction so the returned workflow carries the
      // advanced head (the insert's RETURNING snapshot predates the update).
      const withHead = await this.repo.findWorkflowById(workflowRow.id, tx);
      return {
        workflow: mapWorkflowRow(withHead ?? workflowRow),
        initialVersion: mapVersionRow(inserted.row),
        created: true,
      };
    });
  }

  async getWorkflow(
    principal: WorkflowPrincipal,
    workflowId: string,
  ): Promise<Workflow> {
    const row = await this.requireVisibleWorkflowRow(principal, workflowId);
    return mapWorkflowRow(row);
  }

  async updateWorkflow(
    principal: WorkflowPrincipal,
    workflowId: string,
    patch: UpdateWorkflowPatch,
  ): Promise<Workflow> {
    const row = await this.requireVisibleWorkflowRow(principal, workflowId);
    if (row.owner_user_id !== principal.userId) {
      // Repository metadata mutation is OWNER-ONLY (reading is broader).
      throw new WorkflowRepositoryError(
        'WORKFLOW_NOT_OWNED',
        `workflow ${workflowId} is owned by ${row.owner_user_id}, not by ${principal.userId}`,
      );
    }
    if (patch.name !== undefined) assertName(patch.name);
    if (patch.visibility !== undefined) assertVisibility(patch.visibility);

    const updated = await this.repo.updateWorkflowMetadata(workflowId, {
      name: patch.name,
      description: patch.description,
      visibility: patch.visibility,
    });
    if (!updated) {
      throw new WorkflowRepositoryError(
        'WORKFLOW_NOT_FOUND',
        `workflow ${workflowId} does not exist`,
      );
    }
    return mapWorkflowRow(updated);
  }

  async listWorkflowsInOrganization(
    principal: WorkflowPrincipal,
    organizationId: string,
  ): Promise<Workflow[]> {
    await this.assertOrganizationMember(principal, organizationId);
    const rows = await this.repo.listWorkflowsInOrganization(
      organizationId,
      principal.userId,
    );
    return rows.map(mapWorkflowRow);
  }

  // --- immutable versions -----------------------------------------------------

  async createVersion(
    principal: WorkflowPrincipal,
    workflowId: string,
    input: CreateVersionInput,
  ): Promise<CreateVersionResult> {
    assertContent(input.content);
    assertProtocol(input.protocol);

    const workflowRow = await this.requireVisibleWorkflowRow(principal, workflowId);
    if (workflowRow.owner_user_id !== principal.userId) {
      // "Editing" (creating a new immutable version) is OWNER-ONLY.
      throw new WorkflowRepositoryError(
        'WORKFLOW_NOT_OWNED',
        `workflow ${workflowId} is owned by ${workflowRow.owner_user_id}, not by ${principal.userId}`,
      );
    }
    const parentVersionId = await this.resolveParentVersionId(workflowRow, input.parentVersionId);

    const contentDigest = computeContentDigest(input.content);
    const versionId = deriveWorkflowVersionId({
      workflowId: workflowRow.id,
      contentDigest,
      protocol: input.protocol,
    });

    // Retry loop: a concurrent version-number allocation races on UNIQUE
    // (workflow_id, version_number); each attempt re-allocates from durable
    // state, so the outcome converges deterministically.
    let lastError: unknown;
    for (let attempt = 0; attempt < VERSION_NUMBER_RACE_ATTEMPTS; attempt++) {
      try {
        return await this.repo.transaction(async (tx) => {
          const { row: versionRow, created } = await this.repo.insertVersionOrConverge(tx, {
            id: versionId,
            workflowId: workflowRow.id,
            contentDigest,
            content: input.content,
            protocol: input.protocol,
            parentVersionId,
            createdByUserId: principal.userId,
          });
          // The head advances ONLY when a NEW version row was created — a
          // converged (duplicate-content) submission never moves the head.
          if (created) {
            await this.repo.setHeadVersion(tx, versionRow.workflow_id, versionRow.id);
          }
          return { version: mapVersionRow(versionRow), created };
        });
      } catch (err) {
        lastError = err;
        if (!isVersionNumberRace(err)) throw err;
      }
    }
    throw lastError;
  }

  async getVersion(
    principal: WorkflowPrincipal,
    workflowId: string,
    versionId: string,
  ): Promise<WorkflowVersion> {
    await this.requireVisibleWorkflowRow(principal, workflowId);
    const row = await this.requireVersionRowOfWorkflow(workflowId, versionId);
    return mapVersionRow(row);
  }

  async listVersions(
    principal: WorkflowPrincipal,
    workflowId: string,
  ): Promise<WorkflowVersion[]> {
    await this.requireVisibleWorkflowRow(principal, workflowId);
    const rows = await this.repo.listVersionsByWorkflow(workflowId);
    return rows.map(mapVersionRow);
  }

  // --- fork --------------------------------------------------------------------

  async forkWorkflow(
    principal: WorkflowPrincipal,
    input: ForkWorkflowInput,
  ): Promise<ForkWorkflowResult> {
    assertSlug(input.slug);
    const visibility: WorkflowVisibility = input.visibility ?? 'private';
    assertVisibility(visibility);
    const name = input.name ?? input.slug;
    assertName(name);
    // The fork is created in the FORKER's tenant — membership required.
    await this.assertOrganizationMember(principal, input.organizationId);

    // The source must be READ-visible to the forker (private/organization
    // sources do not leak; denied fork is a uniform typed 404 at the API).
    const sourceRow = await this.requireVisibleWorkflowRow(principal, input.sourceWorkflowId);
    const sourceVersionRow = await this.requireVersionRowOfWorkflow(
      input.sourceWorkflowId,
      input.sourceVersionId,
    );
    // The source version's protocol descriptor transfers with the content
    // (the fork's first version declares the SAME compatibility).
    const sourceProtocol = mapVersionRow(sourceVersionRow).protocol;

    const forkWorkflowId = deriveWorkflowId({
      organizationId: input.organizationId,
      ownerUserId: principal.userId,
      slug: input.slug,
    });
    // The fork's first version carries the source version's CONTENT as a NEW
    // version identity inside the NEW workflow (content transfers; the
    // source's immutable version identity does NOT).
    const forkVersionId = deriveWorkflowVersionId({
      workflowId: forkWorkflowId,
      contentDigest: sourceVersionRow.content_digest,
      protocol: sourceProtocol,
    });

    return this.repo.transaction(async (tx) => {
      const { row: forkRow, created: workflowCreated } = await this.repo
        .insertWorkflowOrConverge(tx, {
          id: forkWorkflowId,
          organizationId: input.organizationId,
          ownerUserId: principal.userId,
          slug: input.slug,
          name,
          description: input.description ?? null,
          visibility,
          // FORK PROVENANCE — preserved, never rewritten (constitution §14).
          forkedFromWorkflowId: sourceRow.id,
          forkedFromVersionId: sourceVersionRow.id,
        });

      const inserted = await this.repo.insertVersionOrConverge(tx, {
        id: forkVersionId,
        // NOTE: the converged fork workflow's durable id (NOT the freshly
        // derived one) — the version belongs to the EXISTING fork identity.
        workflowId: forkRow.id,
        contentDigest: sourceVersionRow.content_digest,
        content: sourceVersionRow.content,
        protocol: sourceProtocol,
        // Ancestry INSIDE the fork: a fresh fork's first version is the root
        // (the fork workflow's head is still NULL here); forking a NEWER
        // source version into an EXISTING fork appends AFTER the fork's
        // current head (the parent is the fork's own previous version).
        parentVersionId: forkRow.head_version_id,
        createdByUserId: principal.userId,
      });
      if (inserted.created) {
        await this.repo.setHeadVersion(tx, forkRow.id, inserted.row.id);
      }
      // Re-read INSIDE the transaction so the returned workflow carries the
      // (possibly advanced) head.
      const forkWithHead = await this.repo.findWorkflowById(forkRow.id, tx);
      const initialVersion: ForkInitialVersion = {
        ...mapVersionRow(inserted.row),
        created: inserted.created,
      };
      return {
        workflow: mapWorkflowRow(forkWithHead ?? forkRow),
        initialVersion,
        created: workflowCreated,
      };
    });
  }

  // --- install / pin -------------------------------------------------------------

  async installVersion(
    principal: WorkflowPrincipal,
    input: InstallVersionInput,
  ): Promise<InstallVersionResult> {
    // The installing tenant may differ from the workflow's owner tenant.
    await this.assertOrganizationMember(principal, input.organizationId);
    // The workflow must be READ-visible to the installer (cross-tenant
    // private installs are rejected — no scope leak).
    await this.requireVisibleWorkflowRow(principal, input.workflowId);
    // The pinned version must belong to exactly this workflow (tuple
    // integrity is ALSO a composite FK at the DB boundary).
    const versionRow = await this.requireVersionRowOfWorkflow(
      input.workflowId,
      input.versionId,
    );

    const installationId = deriveWorkflowInstallationId({
      organizationId: input.organizationId,
      versionId: versionRow.id,
    });

    const { row, created } = await this.repo.insertInstallationOrConverge({
      id: installationId,
      organizationId: input.organizationId,
      workflowId: versionRow.workflow_id,
      versionId: versionRow.id,
      installedByUserId: principal.userId,
    });
    return { installation: mapInstallationRow(row), created };
  }

  async setInstallationStatus(
    principal: WorkflowPrincipal,
    organizationId: string,
    installationId: string,
    action: WorkflowInstallationAction,
  ): Promise<WorkflowInstallation> {
    await this.assertOrganizationMember(principal, organizationId);
    const row = await this.repo.findInstallationById(installationId);
    if (!row || row.organization_id !== organizationId) {
      throw new WorkflowRepositoryError(
        'WORKFLOW_INSTALLATION_NOT_FOUND',
        `installation ${installationId} does not exist in organization ${organizationId}`,
      );
    }
    const status: WorkflowInstallation['status'] =
      action === 'enable'
        ? 'enabled'
        : action === 'disable'
          ? 'disabled'
          : 'uninstalled';
    const updated = await this.repo.updateInstallationStatus(installationId, status);
    if (!updated) {
      throw new WorkflowRepositoryError(
        'WORKFLOW_INSTALLATION_NOT_FOUND',
        `installation ${installationId} does not exist`,
      );
    }
    return mapInstallationRow(updated);
  }

  async getInstallation(
    principal: WorkflowPrincipal,
    organizationId: string,
    installationId: string,
  ): Promise<WorkflowInstallationDetail> {
    await this.assertOrganizationMember(principal, organizationId);
    const { installation, version } = await this.requireInstallationWithVersion(
      organizationId,
      installationId,
    );
    return mapInstallationDetailRow(installation, version);
  }

  async listInstallations(
    principal: WorkflowPrincipal,
    organizationId: string,
  ): Promise<WorkflowInstallationDetail[]> {
    await this.assertOrganizationMember(principal, organizationId);
    const rows = await this.repo.listInstallationsByOrganization(organizationId);
    const details: WorkflowInstallationDetail[] = [];
    for (const installation of rows) {
      const version = await this.repo.findVersionById(installation.version_id);
      if (!version) {
        throw new Error(
          `workflow-repository: installation ${installation.id} pins missing version ${installation.version_id} (invariant violation)`,
        );
      }
      details.push(mapInstallationDetailRow(installation, version));
    }
    return details;
  }

  /** Load an installation (scoped to the tenant) + its pinned version. */
  private async requireInstallationWithVersion(
    organizationId: string,
    installationId: string,
  ): Promise<{ installation: InstallationRow; version: VersionRow }> {
    const installation = await this.repo.findInstallationById(installationId);
    if (!installation || installation.organization_id !== organizationId) {
      throw new WorkflowRepositoryError(
        'WORKFLOW_INSTALLATION_NOT_FOUND',
        `installation ${installationId} does not exist in organization ${organizationId}`,
      );
    }
    const version = await this.repo.findVersionById(installation.version_id);
    if (!version) {
      throw new Error(
        `workflow-repository: installation ${installationId} pins missing version ${installation.version_id} (invariant violation)`,
      );
    }
    return { installation, version };
  }
}
