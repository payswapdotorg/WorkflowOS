/**
 * organizations module — public interface.
 *
 * Canonical name: /organizations
 * Responsibility (spec/architecture.md): Organizations, membership, project ownership hierarchy.
 *
 * This file is the ONLY surface other modules may import. Files under
 * `internal/` are private to this module; cross-module imports of
 * `internal/` are forbidden and enforced statically (PLAT-AC-02).
 *
 * WORK-002: exposes organization, membership, role, and permission contracts
 * consumed by /auth for authorization decisions (AUTH-002, AUTH2-AC-02).
 */
import type { ModuleContract } from '@platform/module-contract.js';
export type {
  Organization,
  CreateOrganizationInput,
  OrganizationMembership,
  AssignMembershipInput,
  Permission,
  RolePermissions,
  OrganizationRepository,
  MembershipRepository,
  RolePermissionRepository,
} from './internal/organization.types.js';

/**
 * Public capabilities exposed by the /organizations module to other modules.
 */
export interface OrganizationsModuleApi {
  // future: additional organization-domain methods
}

/**
 * Frozen module contract for /organizations.
 */
export const organizationsModule: ModuleContract & OrganizationsModuleApi = {
  name: '/organizations',
};

export default organizationsModule;
