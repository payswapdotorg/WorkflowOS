import type { DatabaseClient } from '@platform/index.js';
import type {
  MembershipRepository,
  RolePermissionRepository,
  OrganizationMembership,
  AssignMembershipInput,
} from './organization.types.js';

/**
 * PostgreSQL-backed {@link MembershipRepository}.
 */
export class PgMembershipRepository implements MembershipRepository {
  constructor(private readonly db: DatabaseClient) {}

  async assign(input: AssignMembershipInput): Promise<OrganizationMembership> {
    const result = await this.db.query<MembershipRow>(
      `INSERT INTO wfos_organization_memberships (user_id, organization_id, role_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, organization_id) DO UPDATE
         SET role_id = EXCLUDED.role_id
       RETURNING id, user_id, organization_id, role_id, created_at`,
      [input.userId, input.organizationId, input.roleId],
    );
    return mapRow(result.rows[0]!);
  }

  async findByUserAndOrganization(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationMembership | null> {
    const result = await this.db.query<MembershipRow>(
      `SELECT id, user_id, organization_id, role_id, created_at
       FROM wfos_organization_memberships
       WHERE user_id = $1 AND organization_id = $2`,
      [userId, organizationId],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]!);
  }

  async listForUser(userId: string): Promise<OrganizationMembership[]> {
    const result = await this.db.query<MembershipRow>(
      `SELECT id, user_id, organization_id, role_id, created_at
       FROM wfos_organization_memberships WHERE user_id = $1`,
      [userId],
    );
    return result.rows.map(mapRow);
  }
}

/**
 * PostgreSQL-backed {@link RolePermissionRepository}. Resolves explicit
 * permissions (AUTH2-AC-02) — never infers from controller logic.
 */
export class PgRolePermissionRepository implements RolePermissionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async listPermissionsForRole(roleId: string): Promise<string[]> {
    const result = await this.db.query<{ permission_id: string }>(
      'SELECT permission_id FROM wfos_role_permissions WHERE role_id = $1',
      [roleId],
    );
    return result.rows.map((r) => r.permission_id);
  }

  async listPermissionsForUser(userId: string): Promise<string[]> {
    const result = await this.db.query<{ permission_id: string }>(
      `SELECT DISTINCT rp.permission_id
       FROM wfos_organization_memberships m
       JOIN wfos_role_permissions rp ON rp.role_id = m.role_id
       WHERE m.user_id = $1`,
      [userId],
    );
    return result.rows.map((r) => r.permission_id);
  }

  async listPermissionsForUserInOrganization(
    userId: string,
    organizationId: string,
  ): Promise<string[]> {
    const result = await this.db.query<{ permission_id: string }>(
      `SELECT DISTINCT rp.permission_id
       FROM wfos_organization_memberships m
       JOIN wfos_role_permissions rp ON rp.role_id = m.role_id
       WHERE m.user_id = $1 AND m.organization_id = $2`,
      [userId, organizationId],
    );
    return result.rows.map((r) => r.permission_id);
  }
}

interface MembershipRow {
  id: string;
  user_id: string;
  organization_id: string;
  role_id: string;
  created_at: Date;
}

function mapRow(row: MembershipRow): OrganizationMembership {
  return {
    id: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    roleId: row.role_id,
    createdAt: row.created_at,
  };
}
