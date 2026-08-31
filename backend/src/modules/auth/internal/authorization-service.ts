import { createHash } from 'node:crypto';
import type {
  AuthorizationService,
  AuthorizationDecision,
  OrganizationAuthorizationDecision,
  ProtectedResource,
  MachinePrincipalContext,
} from './auth.types.js';
import type { User } from '@modules/users/index.js';
import type { MembershipRepository, RolePermissionRepository } from '@modules/organizations/index.js';
import type { ProjectRepository, ProjectAccessRepository } from '@modules/projects/index.js';

/**
 * WORK-074: the CLOSED capability → permissions mapping for machine
 * principals (WORK-063: "authorization decisions for machine principals flow
 * through the SAME server-side AuthorizationService path (capability →
 * permission mapping), never a parallel authorization mechanism").
 *
 * The mapping is intentionally TOTAL over the closed grantable capability set
 * and TOTAL NOWHERE ELSE: a capability outside the grantable set (or a scope
 * planted in a credential that the service account never held) maps to NO
 * permission and is a typed fail-closed denial. Governance surfaces —
 * modifying architecture, approving own PR, altering verification evidence,
 * changing tenant — have NO capability mapping at all (privilege separation,
 * invariant #7).
 */
export const MACHINE_CAPABILITY_TO_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  'project.read': ['project.read'],
  'project.write': ['project.write'],
  'work-orders.read': ['project.read'],
  'execution.read': ['project.read'],
  'branches.create': ['project.write'],
  'prs.create': ['project.write'],
};

/**
 * Default backend {@link AuthorizationService} (AUTHZ-AC-01..03).
 *
 * Reusable: later modules ask it "may this user exercise permission P on
 * resource R?" rather than reimplementing checks per route. Decisions are
 * server-side, independent of frontend state, and testable without HTTP.
 *
 * Decision chain (architecture §15, WORK-002 §15):
 *
 *   user → membership in the resource's owning org → role → permission
 *       → explicit project_access for the user on the project
 *
 * Tenant isolation (AUTHZ-AC-02): a cross-tenant project_access row alone is
 * NOT sufficient. The user MUST be a member of the organization that owns
 * the project. This prevents identifier substitution attacks: User A
 * (Org A) cannot access Project B (Org B) even if a stray project_access row
 * exists, because User A has no membership in Org B.
 */
export class DefaultAuthorizationService implements AuthorizationService {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly rolePermissions: RolePermissionRepository,
    private readonly projects: ProjectRepository,
    private readonly projectAccess: ProjectAccessRepository,
  ) {}

  async authorize(input: {
    user: User;
    permission: string;
    resource: ProtectedResource;
  }): Promise<AuthorizationDecision> {
    const { user, permission, resource } = input;
    if (resource.kind !== 'project') {
      // Only project resources are protected in WORK-002. Future resource
      // kinds are added by later work items.
      return {
        allowed: false,
        userId: user.id,
        permission,
        resource,
        organizationId: null,
        deniedReason: 'resource-not-found',
      };
    }

    // 1. Resolve the resource's owning organization.
    const project = await this.projects.findById(resource.projectId);
    if (!project) {
      return {
        allowed: false,
        userId: user.id,
        permission,
        resource,
        organizationId: null,
        deniedReason: 'resource-not-found',
      };
    }

    // 2. The user MUST be a member of the owning organization (AUTHZ-AC-02).
    const membership = await this.memberships.findByUserAndOrganization(
      user.id,
      project.organizationId,
    );
    if (!membership) {
      return {
        allowed: false,
        userId: user.id,
        permission,
        resource,
        organizationId: project.organizationId,
        deniedReason: 'not-a-member',
      };
    }

    // 3. The user's role (org-level OR project-level) MUST grant the permission.
    //    Org-level role: the membership role itself.
    //    Project-level role: a project_access row on this project.
    const orgPermissionIds = await this.rolePermissions.listPermissionsForUserInOrganization(
      user.id,
      project.organizationId,
    );
    const hasOrgPermission = orgPermissionIds.includes(permission);

    let hasProjectPermission = false;
    const projectAccess = await this.projectAccess.findByUserAndProject(
      user.id,
      project.id,
    );
    if (projectAccess) {
      const projectRolePermissions = await this.rolePermissions.listPermissionsForRole(
        projectAccess.roleId,
      );
      hasProjectPermission = projectRolePermissions.includes(permission);
    }

    if (!hasOrgPermission && !hasProjectPermission) {
      return {
        allowed: false,
        userId: user.id,
        permission,
        resource,
        organizationId: project.organizationId,
        deniedReason: 'missing-permission',
      };
    }

    // 4. The user MUST have explicit project_access OR an org-level role that
    //    includes the permission. For WORK-002 we require project_access for
    //    project-scoped actions (so a fresh org member does not automatically
    //    get every project). Org-level owners/admins still need project_access
    //    granted, EXCEPT they implicitly have access to all projects in their
    //    org (architecture §7 — org ownership implies project access). We
    //    implement this by allowing org-level `owner`/`admin` roles to satisfy
    //    project access when they hold the permission.
    const isOrgPrivileged = membership.roleId === 'owner' || membership.roleId === 'admin';
    if (projectAccess || (isOrgPrivileged && hasOrgPermission)) {
      return {
        allowed: true,
        userId: user.id,
        permission,
        resource,
        organizationId: project.organizationId,
      };
    }

    return {
      allowed: false,
      userId: user.id,
      permission,
      resource,
      organizationId: project.organizationId,
      deniedReason: 'no-project-access',
    };
  }

  async authorizeForOrganization(input: {
    user: User;
    permission: string;
    organizationId: string;
  }): Promise<OrganizationAuthorizationDecision> {
    const { user, permission, organizationId } = input;

    // 1. The user MUST be a member of the requested organization (AUTHZ-AC-02).
    //    This is the direct org-membership check — no synthetic project id.
    const membership = await this.memberships.findByUserAndOrganization(
      user.id,
      organizationId,
    );
    if (!membership) {
      return {
        allowed: false,
        userId: user.id,
        permission,
        organizationId,
        deniedReason: 'not-a-member',
      };
    }

    // 2. The user's role in this org MUST grant the permission.
    const permissionIds = await this.rolePermissions.listPermissionsForUserInOrganization(
      user.id,
      organizationId,
    );
    if (!permissionIds.includes(permission)) {
      return {
        allowed: false,
        userId: user.id,
        permission,
        organizationId,
        deniedReason: 'missing-permission',
      };
    }

    return {
      allowed: true,
      userId: user.id,
      permission,
      organizationId,
    };
  }

  /**
   * WORK-074: the machine-principal decision path INSIDE the same service and
   * the same chain. Steps (see the interface documentation):
   *
   *   1. resolve the resource's owning organization (same as `authorize`);
   *   2. tenant anchor: the machine principal's organization IS its
   *      membership — a project owned by any OTHER organization is denied
   *      with `not-a-member` (AUTHZ-AC-02, unchanged and unweakened; a
   *      planted cross-tenant row grants nothing because machine principals
   *      have no project_access rows at all);
   *   3. capability gate: the route's declared capability must be granted in
   *      the credential's scopes AND must map to the requested permission in
   *      the closed mapping — otherwise a typed `capability-not-granted`
   *      denial. No declared capability (undefined) denies unconditionally:
   *      machine access requires explicit route opt-in (fail closed).
   */
  async authorizeForMachinePrincipal(input: {
    principal: MachinePrincipalContext;
    capability?: string;
    permission: string;
    resource: ProtectedResource;
  }): Promise<AuthorizationDecision> {
    const { principal, capability, permission, resource } = input;
    const machineUserId = `service-account:${principal.serviceAccountId}`;

    if (resource.kind !== 'project') {
      return {
        allowed: false,
        userId: machineUserId,
        permission,
        resource,
        organizationId: null,
        deniedReason: 'resource-not-found',
      };
    }

    // 1. Resolve the resource's owning organization (same chain as humans).
    const project = await this.projects.findById(resource.projectId);
    if (!project) {
      return {
        allowed: false,
        userId: machineUserId,
        permission,
        resource,
        organizationId: null,
        deniedReason: 'resource-not-found',
      };
    }

    // 2. Tenant isolation (AUTHZ-AC-02 for machine principals — unweakened).
    if (principal.organizationId !== project.organizationId) {
      return {
        allowed: false,
        userId: machineUserId,
        permission,
        resource,
        organizationId: project.organizationId,
        deniedReason: 'not-a-member',
      };
    }

    // 3. Capability gate (fail closed): explicit route capability, granted in
    //    the credential's scopes, mapped to the requested permission.
    const capabilityGranted =
      capability !== undefined &&
      MACHINE_CAPABILITY_TO_PERMISSIONS[capability]?.includes(permission) === true &&
      principal.capabilities.includes(capability);
    if (!capabilityGranted) {
      return {
        allowed: false,
        userId: machineUserId,
        permission,
        resource,
        organizationId: project.organizationId,
        deniedReason: 'capability-not-granted',
      };
    }

    return {
      allowed: true,
      userId: machineUserId,
      permission,
      resource,
      organizationId: project.organizationId,
    };
  }
}

/**
 * Provision an API-key credential (AUTH-001).
 *
 * Stores ONLY the digest + an opaque SecretStore reference; the raw key is
 * placed in the SecretStore by the caller (or by the environment in dev).
 * This is the ONLY sanctioned way to create a credential row; raw keys never
 * touch domain records (SEC-AC-02).
 */
export interface ProvisionApiKeyInput {
  keyId: string;
  /** Opaque SecretStore reference (e.g. env var name). NOT the raw key. */
  secretRef: string;
  externalId: string;
  label: string;
  /** Raw key value, used only to compute the digest; never persisted. */
  rawKey: string;
}

export interface ProvisionedApiKey {
  keyId: string;
  /** The opaque reference persisted; safe to log. */
  secretRef: string;
  externalId: string;
  label: string;
}

export class ApiKeyCredentialProvisioner {
  constructor(private readonly db: import('@platform/index.js').DatabaseClient) {}

  async provision(input: ProvisionApiKeyInput): Promise<ProvisionedApiKey> {
    const digest = sha256Hex(input.rawKey);
    await this.db.query(
      `INSERT INTO wfos_api_key_credentials (key_id, secret_ref, external_id, label, key_digest)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key_id) DO UPDATE
         SET secret_ref = EXCLUDED.secret_ref,
             external_id = EXCLUDED.external_id,
             label = EXCLUDED.label,
             key_digest = EXCLUDED.key_digest`,
      [input.keyId, input.secretRef, input.externalId, input.label, digest],
    );
    return {
      keyId: input.keyId,
      secretRef: input.secretRef,
      externalId: input.externalId,
      label: input.label,
    };
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
