/**
 * WORK-045 — Agent Roles PostgreSQL integration tests.
 *
 * Real-PostgreSQL tests of the role layer's composability with the EXISTING
 * authorities — the real DefaultExecutionPolicyService (the ONE WORK-043
 * eligibility engine) with the real PgExecutionPolicyRepository + the real
 * AdaptiveExecutionRouter (the WORK-044 routing authority). Only the
 * provider registry + benchmark evidence provider are stubbed (the
 * established engine-test pattern).
 *
 * Proves the WORK-045 acceptance matrix end-to-end:
 *
 *   W045-AC09 — reusable role semantics: TWO DIFFERENT eligible candidates
 *               (different providers AND different execution modes) receive
 *               the IDENTICAL role contract — byte-for-byte, same revision,
 *               unmutated — while the routing itself is decided solely by
 *               the existing eligibility/routing policy.
 *   W045-AC10 — stable versioning: the revision is identical across the
 *               whole flow (before routing, after routing, after policy
 *               changes, fresh service instances) and is the deterministic
 *               content digest.
 *   W045-AC11 — tenant-safe resolution: resolving from two different
 *               tenant/project contexts returns the IDENTICAL frozen
 *               catalog objects; no tenant-scoped role metadata exists or
 *               can affect the result.
 *   W045-AC05/AC06/AC08 (integration half) — the role layer never mutates
 *               workflow state and never interferes with routing: the
 *               router's output is byte-identical before/after role
 *               resolution.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import {
  DefaultExecutionPolicyService,
  DefaultExecutionEligibilityService,
  DefaultExecutionRecommendationService,
  PgExecutionPolicyRepository,
} from '../../../src/execution-policy/index.js';
import { AdaptiveExecutionRouter } from '../../../src/execution-routing/index.js';
import {
  DefaultAgentRoleCatalogService,
  computeRoleRevision,
  type AgentRoleDefinition,
  type AgentRoleContract,
} from '../../../src/agent-roles/index.js';
import type { HistoricalPerformance } from '../../../src/execution-policy/index.js';
import type { ExecutionTaskProfile } from '../../../src/execution-policy/types.js';

// ============================================================================
// fixtures
// ============================================================================

const TASK_PROFILE: ExecutionTaskProfile = {
  language: 'typescript',
  framework: 'nextjs',
  repositorySize: 'medium',
  complexity: 'medium',
  architectureSensitivity: 'low',
  securitySensitivity: 'low',
  browserRequired: false,
  terminalRequired: false,
  repositoryAccess: true,
  externalExecutionAllowed: true,
  nativeExecutionAllowed: true,
  requiredCapabilities: ['coding_agent'],
  humanInterventionLikely: false,
};

function evidence(
  sampleSize: number,
  observedQuality: number | null,
  overrides: Partial<HistoricalPerformance> = {},
): HistoricalPerformance {
  return {
    sampleSize,
    sufficient: sampleSize >= 3,
    observedQuality,
    ciFirstPassRate: null,
    verificationFirstPassRate: null,
    medianCorrectionCycles: null,
    medianTimeToVerifiedMs: null,
    humanInterventionCount: null,
    evidenceCells: [],
    ...overrides,
  };
}

interface ProviderFixture {
  name: string;
  provider: string;
  model: string;
  nativeApi: 'ready' | 'not-configured';
  externalUi: 'available' | 'not-supported';
}

function provider(providerId: string, mode: 'both' | 'native' | 'external' = 'both'): ProviderFixture {
  return {
    name: `${providerId}-name`,
    provider: providerId,
    model: `${providerId}-model`,
    nativeApi: mode === 'external' ? 'not-configured' : 'ready',
    externalUi: mode === 'native' ? 'not-supported' : 'available',
  };
}

describe('WORK-045 — Agent Roles (PG)', () => {
  let stack: TestAuthStack;
  let router: AdaptiveExecutionRouter;
  let policyService: DefaultExecutionPolicyService;
  let roleService: DefaultAgentRoleCatalogService;

  let orgAId: string;
  let projectAId: string;
  let workItemAId: string;
  let orgBId: string;
  let projectBId: string;
  let workItemBId: string;
  let userId: string;

  const evidenceMap = new Map<string, HistoricalPerformance>();
  const registryMap = new Map<string, ProviderFixture[]>();

  beforeAll(async () => {
    stack = await buildAuthStack();
    const db = stack.db.client;
    roleService = new DefaultAgentRoleCatalogService();

    const repository = new PgExecutionPolicyRepository(db);
    policyService = new DefaultExecutionPolicyService({
      db,
      logger: stack.db.logger,
      repository,
      projectOrganizationResolver: {
        resolveProjectOrganization: async (pid: string) => {
          const project = await stack.projectRepository.findById(pid);
          return project?.organizationId ?? null;
        },
      },
      eligibilityService: new DefaultExecutionEligibilityService(),
      recommendationService: new DefaultExecutionRecommendationService(),
      taskProfileBuilder: { build: () => Promise.resolve(TASK_PROFILE) },
      agentProviderRegistry: {
        getExecutionProviders: (pid?: string) =>
          Promise.resolve((pid != null ? registryMap.get(pid) : undefined) ?? []),
        isExternalProviderSupported: () => Promise.resolve(true),
      },
      benchmarkEvidenceProvider: {
        historicalPerformanceForCell: (pid: string, prov: string, mode: 'native' | 'external') =>
          Promise.resolve(evidenceMap.get(`${pid}|${prov}|${mode}`) ?? evidence(0, null)),
        aggregateForProject: () => Promise.resolve(evidence(0, null)),
      },
    });

    router = new AdaptiveExecutionRouter({
      executionPolicyService: policyService,
      projectOrganizationResolver: {
        resolveProjectOrganization: async (pid: string) => {
          const project = await stack.projectRepository.findById(pid);
          return project?.organizationId ?? null;
        },
      },
      logger: stack.db.logger,
    });

    // --- tenant A (main): alpha + beta, both modes, real evidence ----------
    const orgA = await stack.organizationRepository.create({ name: 'W045 Org A' });
    orgAId = orgA.id;
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'w045-user', displayName: 'W045 User' });
    userId = user.id;
    const projectA = await stack.projectRepository.create({ organizationId: orgAId, name: 'W045 Project A' });
    projectAId = projectA.id;

    // --- tenant B (separate org/project): delta only ------------------------
    const orgB = await stack.organizationRepository.create({ name: 'W045 Org B' });
    orgBId = orgB.id;
    const projectB = await stack.projectRepository.create({ organizationId: orgBId, name: 'W045 Project B' });
    projectBId = projectB.id;

    workItemAId = (await createChain('WORK-W045-A', projectAId)).workItemId;
    workItemBId = (await createChain('WORK-W045-B', projectBId)).workItemId;

    registryMap.set(projectAId, [provider('alpha'), provider('beta')]);
    registryMap.set(projectBId, [provider('delta')]);

    const alphaEvidence = evidence(5, 88, { ciFirstPassRate: 0.9, medianTimeToVerifiedMs: 600_000 });
    const betaEvidence = evidence(4, 82, { ciFirstPassRate: 0.8, medianTimeToVerifiedMs: 700_000 });
    const deltaEvidence = evidence(6, 75, { ciFirstPassRate: 0.7, medianTimeToVerifiedMs: 900_000 });
    for (const mode of ['native', 'external'] as const) {
      evidenceMap.set(`${projectAId}|alpha|${mode}`, alphaEvidence);
      evidenceMap.set(`${projectAId}|beta|${mode}`, betaEvidence);
      evidenceMap.set(`${projectBId}|delta|${mode}`, deltaEvidence);
    }

    // Verified subscription access for every fixture provider.
    for (const prov of ['alpha', 'beta', 'delta']) {
      await policyService.upsertAccessProfile(orgAId, userId, {
        provider: prov,
        plan: 'pro',
        codingAgent: 'ready',
        externalUi: 'ready',
        nativeApi: 'ready',
        statusSource: 'verified',
      });
      await policyService.upsertAccessProfile(orgBId, userId, {
        provider: prov,
        plan: 'pro',
        codingAgent: 'ready',
        externalUi: 'ready',
        nativeApi: 'ready',
        statusSource: 'verified',
      });
    }

    async function createChain(workItemLabel: string, pid: string): Promise<{ workItemId: string }> {
      const arch = await stack.architectureRepository.create({ projectId: pid, name: `W045 Arch ${workItemLabel}` });
      const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: `# ${workItemLabel}` });
      const wi = await stack.workItemRepository.create({
        architectureVersionId: version.id,
        workItemId: workItemLabel,
        title: `${workItemLabel} fixture`,
        objective: 'fixture',
        scope: 'src/x.ts',
        outOfScope: 'none',
        metadata: { baseCommit: `w045-${workItemLabel.toLowerCase()}-baseline-000000000001` },
      });
      return { workItemId: wi.id };
    }
  });

  afterAll(async () => {
    await stack.teardown();
  });

  function routeA() {
    return router.recommendExecution({ projectId: projectAId, workItemId: workItemAId, userId });
  }

  // =========================================================================
  // W045-AC09 — reusable role semantics (two different candidates, ONE contract)
  // =========================================================================

  it('W045-AC09: TWO DIFFERENT eligible candidates (different provider AND different mode) receive the IDENTICAL role contract — unmutated, same revision', async () => {
    const recommendation = await routeA();
    expect(recommendation.ranked.length).toBeGreaterThanOrEqual(4); // alpha+beta × native+external

    // Pick two candidates that differ in BOTH provider and mode.
    const candidateOne = recommendation.ranked.find(
      (r) => r.identity.provider === 'alpha' && r.identity.executionMode === 'native',
    );
    const candidateTwo = recommendation.ranked.find(
      (r) => r.identity.provider === 'beta' && r.identity.executionMode === 'external',
    );
    expect(candidateOne).toBeTruthy();
    expect(candidateTwo).toBeTruthy();

    // "Executing the role": the SAME role contract is handed to each
    // candidate's execution — subject ONLY to the eligibility/routing policy
    // that selected them (nothing role-side changes between the two).
    const contractForOne = roleService.resolveRole('implementer')!;
    const contractForTwo = roleService.resolveRole('implementer')!;

    // The SAME frozen object (global immutable truth — no per-execution copy
    // that could drift, no provider-specific rewriting).
    expect(contractForTwo.role).toBe(contractForOne.role);
    expect(JSON.stringify(contractForTwo.role)).toBe(JSON.stringify(contractForOne.role));
    expect(contractForTwo.role.lifecycle.revision).toBe(contractForOne.role.lifecycle.revision);

    // The contract carries no trace of EITHER executor: no provider/model
    // field, no provider token. (The advisory supportedModes declaration
    // legitimately names BOTH modes — symmetric, never a binding.)
    const serialized = JSON.stringify(contractForOne.role);
    expect(serialized).not.toContain('alpha');
    expect(serialized).not.toContain('beta');
    expect(serialized).not.toContain('"provider"');
    expect(serialized).not.toContain('"model"');
    expect(contractForOne.role.execution.supportedModes).toEqual(['native', 'external']);
  });

  it('W045-AC09: when the eligibility/routing policy changes WHO is eligible, the role contract for the remaining candidate is UNCHANGED (roles never participate in selection)', async () => {
    const before = roleService.resolveRole('implementer')!.role;

    // A hard policy change: deny-list alpha (a WORK-043 project constraint).
    await policyService.updateProjectPolicy(projectAId, { deniedProviders: ['alpha'] });
    const afterDeny = await routeA();
    // Every ranked candidate is now beta (both modes) — the POLICY decided.
    for (const row of afterDeny.ranked) expect(row.identity.provider).toBe('beta');
    // The role contract is byte-identical to before the policy change.
    const during = roleService.resolveRole('implementer')!.role;
    expect(during).toBe(before);
    expect(JSON.stringify(during)).toBe(JSON.stringify(before));

    // Restore.
    await policyService.updateProjectPolicy(projectAId, { deniedProviders: [] });
    const restored = await routeA();
    expect(restored.ranked.some((r) => r.identity.provider === 'alpha')).toBe(true);
    expect(roleService.resolveRole('implementer')!.role).toBe(before);
  });

  it('W045-AC08/AC09 (integration half): role resolution does NOT interfere with routing — the router output is identical before/after resolution', async () => {
    const before = await routeA();
    // Resolve every role repeatedly (the full catalog).
    for (const resolution of roleService.listRoles()) {
      expect(resolution.role.identity).toBeTruthy();
    }
    for (let i = 0; i < 3; i += 1) {
      expect(roleService.resolveRole('architect')).not.toBeNull();
    }
    const after = await routeA();
    const line = (r: { identity: { provider: string; model: string; executionMode: string }; score: number }) =>
      `${r.identity.provider}/${r.identity.model}/${r.identity.executionMode}:${r.score}`;
    expect(after.ranked.map(line)).toEqual(before.ranked.map(line));
    expect(after.decisionId).not.toBe(before.decisionId); // a NEW §22 audit decision per routing
  });

  // =========================================================================
  // W045-AC10 — stable versioning across the flow
  // =========================================================================

  it('W045-AC10: the revision is STABLE across the whole flow (before/after routing + policy changes + fresh instances) and equals the deterministic content digest', async () => {
    const before = roleService.resolveRole('security-reviewer')!.role;
    await routeA();
    await policyService.updateProjectPolicy(projectAId, { externalExecutionAllowed: false });
    await routeA();
    await policyService.updateProjectPolicy(projectAId, { externalExecutionAllowed: true });

    const after = roleService.resolveRole('security-reviewer')!.role;
    expect(after.lifecycle.revision).toBe(before.lifecycle.revision);

    // A FRESH service instance (a different "process" of resolution) sees the
    // same revision — the digest is derived from content, not instance state.
    const fresh = new DefaultAgentRoleCatalogService().resolveRole('security-reviewer')!.role;
    expect(fresh.lifecycle.revision).toBe(before.lifecycle.revision);

    // The stored revision equals the recomputed content digest.
    const recomputed = computeRoleRevision({
      ...before,
      lifecycle: { contractVersion: before.lifecycle.contractVersion, status: 'stable' },
    } as AgentRoleDefinition);
    expect(recomputed).toBe(before.lifecycle.revision);
  });

  // =========================================================================
  // W045-AC11 — tenant-safe resolution
  // =========================================================================

  it('W045-AC11: resolving from TWO different tenant/project contexts returns the IDENTICAL frozen catalog objects (no tenant metadata can affect the result)', async () => {
    // Route BOTH tenants (their policies/registries differ — delta-only for B).
    const resultA = await routeA();
    const resultB = await router.recommendExecution({ projectId: projectBId, workItemId: workItemBId, userId });
    expect([...new Set(resultB.ranked.map((r) => r.identity.provider))]).toEqual(['delta']);
    expect(resultA.ranked.some((r) => r.identity.provider === 'alpha')).toBe(true);

    // The role resolution is IDENTICAL from both tenant contexts: the SAME
    // frozen objects (===), not merely equal copies — no tenant-scoped role
    // metadata exists to differentiate them.
    for (const id of ['architect', 'implementer', 'release-engineer'] as const) {
      const fromA = roleService.resolveRole(id)!;
      const fromB = roleService.resolveRole(id)!;
      expect(fromB.role).toBe(fromA.role);
    }

    // Even the tenant-specific ROUTING evidence never bleeds into the role
    // contract: the contract is provider-free regardless of which providers
    // each tenant's registry carries.
    const contract = roleService.resolveRole('implementer')!.role as AgentRoleContract;
    const serialized = JSON.stringify(contract);
    for (const tenantProvider of ['alpha', 'beta', 'delta']) {
      expect(serialized).not.toContain(tenantProvider);
    }
  });

  it('W045-AC11: the catalog service accepts NO tenant/project/org/user context (structurally context-free)', async () => {
    // The service contract takes ONLY the stable role identity — there is no
    // tenant surface to spoof. (Pinned structurally by the static
    // architecture test; here the behavioral half: resolution inside a
    // tenant-scoped flow behaves exactly like resolution outside one.)
    const insideTenantFlow = roleService.resolveRole('planner')!;
    const outsideAnyFlow = new DefaultAgentRoleCatalogService().resolveRole('planner')!;
    expect(outsideAnyFlow.role).toBe(insideTenantFlow.role);
    expect(outsideAnyFlow.declarationSemantics).toBe(insideTenantFlow.declarationSemantics);
  });
});
