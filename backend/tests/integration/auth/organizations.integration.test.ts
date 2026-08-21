import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';

/**
 * AUTH2-AC-01 — Organization membership persists.
 * AUTH2-AC-02 — Roles resolve to explicit permissions.
 *
 * Evidence: membership rows persist in PostgreSQL; role → permission
 * resolution is explicit (via wfos_role_permissions), not inferred from
 * controller logic.
 */
describe('AUTH2-AC-01 / AUTH2-AC-02 — organizations, roles, permissions', () => {
  let stack: TestAuthStack;

  beforeAll(async () => {
    stack = await buildAuthStack();
  });
  afterAll(async () => {
    await stack.teardown();
  });

  it('AUTH2-AC-01: organization membership persists', async () => {
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'org-user-1',
      displayName: 'Org User 1',
    });
    const org = await stack.organizationRepository.create({ name: 'Org 1' });
    const membership = await stack.membershipRepository.assign({
      userId: user.id,
      organizationId: org.id,
      roleId: 'owner',
    });
    expect(membership.userId).toBe(user.id);
    expect(membership.organizationId).toBe(org.id);
    expect(membership.roleId).toBe('owner');

    // Membership is recoverable by user + org.
    const found = await stack.membershipRepository.findByUserAndOrganization(user.id, org.id);
    expect(found).not.toBeNull();
    expect(found!.roleId).toBe('owner');

    // The user's membership list includes it.
    const list = await stack.membershipRepository.listForUser(user.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.organizationId).toBe(org.id);
  });

  it('AUTH2-AC-01: membership assignment is idempotent (upsert on user+org)', async () => {
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'org-user-2',
      displayName: 'Org User 2',
    });
    const org = await stack.organizationRepository.create({ name: 'Org 2' });
    await stack.membershipRepository.assign({
      userId: user.id,
      organizationId: org.id,
      roleId: 'member',
    });
    // Re-assign with a different role — should update, not duplicate.
    const updated = await stack.membershipRepository.assign({
      userId: user.id,
      organizationId: org.id,
      roleId: 'admin',
    });
    expect(updated.roleId).toBe('admin');
    const list = await stack.membershipRepository.listForUser(user.id);
    expect(list.filter((m) => m.organizationId === org.id)).toHaveLength(1);
  });

  it('AUTH2-AC-02: roles resolve to explicit permissions', async () => {
    const ownerPerms = await stack.rolePermissionRepository.listPermissionsForRole('owner');
    expect(ownerPerms).toContain('project.read');
    expect(ownerPerms).toContain('project.write');
    expect(ownerPerms).toContain('project.admin');
    expect(ownerPerms).toContain('org.admin');

    const memberPerms = await stack.rolePermissionRepository.listPermissionsForRole('member');
    expect(memberPerms).toContain('project.read');
    expect(memberPerms).toContain('project.write');
    expect(memberPerms).not.toContain('project.admin');
    expect(memberPerms).not.toContain('org.admin');
  });

  it('AUTH2-AC-02: a user with the member role does not get admin permissions', async () => {
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'member-user',
      displayName: 'Member User',
    });
    const org = await stack.organizationRepository.create({ name: 'Member Org' });
    await stack.membershipRepository.assign({
      userId: user.id,
      organizationId: org.id,
      roleId: 'member',
    });
    const perms = await stack.rolePermissionRepository.listPermissionsForUserInOrganization(
      user.id,
      org.id,
    );
    expect(perms).toContain('project.read');
    expect(perms).toContain('project.write');
    expect(perms).not.toContain('project.admin');
    expect(perms).not.toContain('org.admin');
  });

  it('AUTH2-AC-02: permission resolution is driven by the role_permissions table, not hard-coded', async () => {
    // The owner role should have ALL seeded permissions; the set comes from
    // the database, not from controller logic.
    const ownerPerms = new Set(
      await stack.rolePermissionRepository.listPermissionsForRole('owner'),
    );
    const expected = new Set([
      'project.read',
      'project.write',
      'project.admin',
      'org.admin',
      'org.members',
    ]);
    expect(ownerPerms).toEqual(expected);
  });
});
