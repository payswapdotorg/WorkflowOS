import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildIdentityStack, type TestIdentityStack } from '../../helpers/test-identity-stack.js';

/**
 * WORK-074 — scoped machine identity (WORK-063 invariants #3, #6, #7, #8;
 * the proofs "machine principal scoping", "privilege separation", "tenant
 * isolation under login", "API-key automation path").
 *
 * The ONE authorization chain stays authoritative: machine principals flow
 * through the SAME DefaultAuthorizationService (the same class that decides
 * human access), with the capability → permission mapping applied INSIDE that
 * chain. Fail closed: a capability not granted — or not in the closed
 * grantable set — is a typed denial.
 *
 * Mutation-proven discriminations pinned here:
 *   - removing the scope check (treating a machine principal as unscoped)
 *     makes the ungranted-capability and privilege-separation assertions FAIL;
 *   - removing the tenant (organization anchor) check makes the
 *     cross-tenant assertion FAIL.
 */
describe('WORK-074 — scoped machine identity, capability scoping, privilege separation', () => {
  let stack: TestIdentityStack;

  // Org A owns projectA; Org B owns projectB. The service account belongs to
  // Org A. A planted cross-tenant project_access row must grant nothing.
  let projectAId: string;
  let projectBId: string;
  let serviceAccountId: string;
  let orgAId: string;

  const AGENT_CAPABILITIES = ['project.read', 'work-orders.read', 'execution.read'] as const;

  beforeAll(async () => {
    stack = await buildIdentityStack();

    const orgA = await stack.organizationRepository.create({ name: 'Machine Org A' });
    const orgB = await stack.organizationRepository.create({ name: 'Other Org B' });
    const ownerA = await stack.userRepository.upsertByExternalId({
      externalId: 'org-a-owner@example.com',
      displayName: 'Org A Owner',
    });
    const ownerB = await stack.userRepository.upsertByExternalId({
      externalId: 'org-b-owner@example.com',
      displayName: 'Org B Owner',
    });
    await stack.membershipRepository.assign({ userId: ownerA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: ownerB.id, organizationId: orgB.id, roleId: 'owner' });
    const projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Project A' });
    const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Project B' });
    projectAId = projectA.id;
    projectBId = projectB.id;
    orgAId = orgA.id;

    // The implementation-agent service account (the WORK-063 example set).
    const sa = await stack.machineIdentity.createServiceAccount({
      organizationId: orgA.id,
      name: 'z.ai worker',
      capabilities: [...AGENT_CAPABILITIES],
      actor: ownerA.id,
    });
    serviceAccountId = sa.id;

    // Planted cross-tenant row: the Org A OWNER is granted a role on Org B's
    // project. For the HUMAN owner this row alone still grants nothing
    // (AUTHZ-AC-02, unchanged). For the machine principal (Org A anchor) the
    // tenant check must deny Org B's project outright.
    await stack.projectAccessRepository.grant({
      userId: ownerA.id,
      projectId: projectB.id,
      roleId: 'owner',
    });
  });

  afterAll(async () => {
    await stack.teardown();
  });

  // --- service account + scoped key issuance ------------------------------------

  it('issues a scoped key for a service account; the raw key is returned exactly once', async () => {
    const issued = await stack.machineIdentity.issueKey({
      serviceAccountId,
      label: 'implementation agent key',
      scopes: [...AGENT_CAPABILITIES],
      actor: 'org-a-owner@example.com',
    });
    expect(issued.rawKey).toMatch(/^wfos_sk_/);
    expect(issued.scopes).toEqual([...AGENT_CAPABILITIES]);
    const keys = await stack.machineIdentity.listKeys(serviceAccountId);
    expect(keys.length).toBe(1);
    expect(keys[0]!.keyId).toBe(issued.keyId);
    expect(keys[0]!.revokedAt).toBeNull();
    stack.setKey('agent', issued.rawKey);
  });

  it('issuing a key with scopes beyond the service account capability set is a typed rejection', async () => {
    // 'branches.create' IS in the closed grantable set but is NOT in this
    // account's capability ceiling — the account-scoped check must reject it
    // even though a different account could hold it.
    await expect(
      stack.machineIdentity.issueKey({
        serviceAccountId,
        label: 'escalation attempt',
        scopes: ['branches.create'],
        actor: 'attacker',
      }),
    ).rejects.toMatchObject({ code: 'scope-not-in-account-capabilities' });
  });

  it('an unknown capability is rejected at issuance AND at service-account creation (closed set)', async () => {
    await expect(
      stack.machineIdentity.createServiceAccount({
        organizationId: orgAId,
        name: 'bad',
        capabilities: ['architecture.modify'],
        actor: 'someone',
      }),
    ).rejects.toMatchObject({ code: 'unknown-capability' });
  });

  // --- machine principal authentication -------------------------------------------

  it('the scoped key authenticates to a MACHINE principal bound to its org and scopes', async () => {
    const result = await stack.authProvider.authenticate(stack.getKey('agent')!);
    expect(result.kind).toBe('principal');
    if (result.kind !== 'principal') return;
    expect(result.principal.provider).toBe('apikey');
    expect(result.principal.machine).toBeDefined();
    expect(result.principal.machine!.serviceAccountId).toBe(serviceAccountId);
    expect(result.principal.machine!.capabilities).toEqual([...AGENT_CAPABILITIES]);
  });

  it('a machine principal NEVER becomes a human user (no wfos_users row, no user resolution)', async () => {
    const result = await stack.authProvider.authenticate(stack.getKey('agent')!);
    if (result.kind !== 'principal') throw new Error('expected principal');
    expect(result.principal.machine).toBeDefined();
    // The external id lives in the machine namespace and is NOT a user.
    const user = await stack.userRepository.findByExternalId(result.principal.externalId);
    expect(user).toBeNull();
    const allUsers = await stack.db.client.query<{ external_id: string }>(
      `SELECT external_id FROM wfos_users WHERE external_id LIKE 'service-account:%'`,
    );
    expect(allUsers.rows.length).toBe(0);
  });

  it('a revoked scoped key fails closed (invalid credentials)', async () => {
    const issued = await stack.machineIdentity.issueKey({
      serviceAccountId,
      label: 'to be revoked',
      scopes: ['project.read'],
      actor: 'org-a-owner@example.com',
    });
    expect((await stack.authProvider.authenticate(issued.rawKey)).kind).toBe('principal');
    await stack.machineIdentity.revokeKey({ keyId: issued.keyId, actor: 'org-a-owner@example.com' });
    const after = await stack.authProvider.authenticate(issued.rawKey);
    expect(after.kind).toBe('unauthenticated');
  });

  // --- capability scoping through the ONE authorization chain ----------------------

  it('a granted capability authorizes the mapped permission on an in-tenant project (CAN)', async () => {
    const result = await stack.authProvider.authenticate(stack.getKey('agent')!);
    if (result.kind !== 'principal') throw new Error('expected principal');
    const machine = result.principal.machine!;
    const decision = await stack.authorizationService.authorizeForMachinePrincipal!({
      principal: machine,
      capability: 'work-orders.read',
      permission: 'project.read',
      resource: { kind: 'project', projectId: projectAId },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.organizationId).toBe(orgAId);
  });

  it('an ungranted capability is a typed fail-closed denial (CANNOT)', async () => {
    const result = await stack.authProvider.authenticate(stack.getKey('agent')!);
    if (result.kind !== 'principal') throw new Error('expected principal');
    const machine = result.principal.machine!;
    // 'branches.create' is grantable in the closed set but NOT granted to this account.
    const decision = await stack.authorizationService.authorizeForMachinePrincipal!({
      principal: machine,
      capability: 'branches.create',
      permission: 'project.write',
      resource: { kind: 'project', projectId: projectAId },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toBe('capability-not-granted');
  });

  it('a capability outside the closed set is a typed fail-closed denial even if planted in scopes', async () => {
    const result = await stack.authProvider.authenticate(stack.getKey('agent')!);
    if (result.kind !== 'principal') throw new Error('expected principal');
    const machine = result.principal.machine!;
    const decision = await stack.authorizationService.authorizeForMachinePrincipal!({
      principal: { ...machine, capabilities: [...machine.capabilities, 'architecture.modify'] },
      capability: 'architecture.modify',
      permission: 'project.write',
      resource: { kind: 'project', projectId: projectAId },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toBe('capability-not-granted');
  });

  // --- tenant isolation ------------------------------------------------------------

  it('tenant isolation: the machine principal cannot authorize Org B projects (planted row grants nothing)', async () => {
    const result = await stack.authProvider.authenticate(stack.getKey('agent')!);
    if (result.kind !== 'principal') throw new Error('expected principal');
    const machine = result.principal.machine!;
    const decision = await stack.authorizationService.authorizeForMachinePrincipal!({
      principal: machine,
      capability: 'work-orders.read',
      permission: 'project.read',
      resource: { kind: 'project', projectId: projectBId },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toBe('not-a-member');
  });

  // --- privilege separation (the WORK-063 example set) -------------------------------

  it('the implementation-agent set cannot modify architecture (typed fail-closed denial)', async () => {
    const result = await stack.authProvider.authenticate(stack.getKey('agent')!);
    if (result.kind !== 'principal') throw new Error('expected principal');
    const machine = result.principal.machine!;
    const decision = await stack.authorizationService.authorizeForMachinePrincipal!({
      principal: machine,
      capability: 'architecture.modify',
      permission: 'project.write',
      resource: { kind: 'project', projectId: projectAId },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toBe('capability-not-granted');
  });

  it('the implementation-agent set cannot approve its own PR (typed fail-closed denial)', async () => {
    const result = await stack.authProvider.authenticate(stack.getKey('agent')!);
    if (result.kind !== 'principal') throw new Error('expected principal');
    const machine = result.principal.machine!;
    const decision = await stack.authorizationService.authorizeForMachinePrincipal!({
      principal: machine,
      capability: 'review.approve',
      permission: 'project.write',
      resource: { kind: 'project', projectId: projectAId },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toBe('capability-not-granted');
  });

  it('the implementation-agent set cannot alter verification evidence (typed fail-closed denial)', async () => {
    const result = await stack.authProvider.authenticate(stack.getKey('agent')!);
    if (result.kind !== 'principal') throw new Error('expected principal');
    const machine = result.principal.machine!;
    const decision = await stack.authorizationService.authorizeForMachinePrincipal!({
      principal: machine,
      capability: 'verification.evidence.write',
      permission: 'project.write',
      resource: { kind: 'project', projectId: projectAId },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toBe('capability-not-granted');
  });

  it('the implementation-agent set cannot change tenant (Org B project denial is the tenant check)', async () => {
    const result = await stack.authProvider.authenticate(stack.getKey('agent')!);
    if (result.kind !== 'principal') throw new Error('expected principal');
    const machine = result.principal.machine!;
    const decision = await stack.authorizationService.authorizeForMachinePrincipal!({
      principal: machine,
      capability: 'tenant.change',
      permission: 'project.admin',
      resource: { kind: 'project', projectId: projectBId },
    });
    expect(decision.allowed).toBe(false);
  });

  // --- the legacy API-key automation path (no regression) -----------------------------

  it('API-key automation keeps working: a legacy (unscoped) key authenticates and authorizes as before', async () => {
    const RAW = 'wfos_legacy_automation_key_value';
    const ENV = 'WFOS_TEST_LEGACY_AUTOMATION_KEY';
    process.env[ENV] = RAW;
    await stack.apiKeyProvisioner.provision({
      keyId: 'legacy-automation-key',
      secretRef: ENV,
      externalId: 'legacy-automation@example.com',
      label: 'Legacy Automation Key',
      rawKey: RAW,
    });
    const result = await stack.authProvider.authenticate(RAW);
    expect(result.kind).toBe('principal');
    if (result.kind !== 'principal') return;
    expect(result.principal.machine).toBeUndefined();
    const user = await stack.userRepository.upsertByExternalId({
      externalId: result.principal.externalId,
      displayName: result.principal.label,
    });
    // Grant membership + project access, then authorize through the SAME chain.
    const org = await stack.organizationRepository.create({ name: 'Legacy Automation Org' });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    const project = await stack.projectRepository.create({ organizationId: org.id, name: 'Automation Project' });
    const decision = await stack.authorizationService.authorize({
      user,
      permission: 'project.read',
      resource: { kind: 'project', projectId: project.id },
    });
    expect(decision.allowed).toBe(true);
    delete process.env[ENV];
  });
});
