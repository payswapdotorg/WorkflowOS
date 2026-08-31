/**
 * Organization, membership, role, and permission types (AUTH-002, AUTH2-AC-02).
 * Provider-independent contracts owned by /organizations. Persistence is an
 * implementation detail under /organizations/internal/.
 */

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface CreateOrganizationInput {
  name: string;
}

/** A user's membership in an organization with an assigned role. */
export interface OrganizationMembership {
  readonly id: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly roleId: string;
  readonly createdAt: Date;
}

export interface AssignMembershipInput {
  userId: string;
  organizationId: string;
  roleId: string;
}

/** A system-defined permission (e.g. `project.read`). */
export interface Permission {
  readonly id: string;
  readonly name: string;
}

/** The set of permissions granted to a role. */
export interface RolePermissions {
  readonly roleId: string;
  readonly permissionIds: string[];
}

/**
 * Repository contract for organization persistence.
 */
export interface OrganizationRepository {
  create(input: CreateOrganizationInput): Promise<Organization>;
  findById(id: string): Promise<Organization | null>;
}

/**
 * Repository contract for organization membership persistence.
 */
export interface MembershipRepository {
  /** Assign a role to a user within an organization (idempotent on user+org). */
  assign(input: AssignMembershipInput): Promise<OrganizationMembership>;
  /** Find a user's membership in a specific organization. */
  findByUserAndOrganization(userId: string, organizationId: string): Promise<OrganizationMembership | null>;
  /** List all organizations a user belongs to with their roles. */
  listForUser(userId: string): Promise<OrganizationMembership[]>;
  /**
   * WORK-074: list all memberships of an organization (the membership
   * management surface).
   */
  listForOrganization(organizationId: string): Promise<OrganizationMembership[]>;
  /**
   * WORK-074: remove a user's membership in an organization. Returns whether a
   * row was removed (false when the user was not a member).
   */
  remove(userId: string, organizationId: string): Promise<boolean>;
}

/**
 * Repository contract for role → permission resolution (AUTH2-AC-02).
 */
export interface RolePermissionRepository {
  /** List the permission ids granted to a role. */
  listPermissionsForRole(roleId: string): Promise<string[]>;
  /** List the permission ids granted to a user across all their memberships. */
  listPermissionsForUser(userId: string): Promise<string[]>;
  /** List the permission ids granted to a user within a specific organization. */
  listPermissionsForUserInOrganization(userId: string, organizationId: string): Promise<string[]>;
}
