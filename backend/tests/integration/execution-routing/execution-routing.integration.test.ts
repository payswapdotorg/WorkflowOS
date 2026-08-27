/**
 * WORK-044 — Adaptive Execution Router PostgreSQL integration tests.
 *
 * Real-PostgreSQL tests of the FULL routing boundary — the real
 * DefaultExecutionPolicyService (the ONE WORK-043 eligibility engine) with
 * the real PgExecutionPolicyRepository + the real eligibility +
 * recommendation services, the real AdaptiveExecutionRouter, and the real
 * project→organization resolver — only the provider registry + benchmark
 * evidence provider are stubbed (the WORK-043 engine-test pattern).
 *
 * Proves the WORK-044 acceptance matrix end-to-end:
 *
 *   W044-AC01 — eligibility precedes ranking: every ranked candidate
 *               carried an eligible WORK-043 verdict; the blocked provider
 *               never reaches the ranking input.
 *   W044-AC02 — hard constraints cannot be overridden by quality: the
 *               deny-listed provider with SUPERIOR benchmark evidence is
 *               never selected or ranked ahead of an eligible candidate.
 *   W044-AC03 — deterministic ranking: repeated routing produces the
 *               identical ordered result and selection.
 *   W044-AC07 — preferences reorder eligible candidates only: a mode
 *               preference flips equal-evidence ordering, but CANNOT
 *               resurrect a hard-blocked candidate.
 *   W044-AC08 — recommendation vs automatic selection are explicit:
 *               both shapes returned; NEITHER mutates workflow state,
 *               execution records, or dispatches.
 *   W044-AC09 — explainability: selected candidate, ranked alternatives,
 *               eligibility status (incl. the excluded with reasons),
 *               per-dimension signals, and the win reason.
 *   W044-AC10 — failure-safe: insufficient evidence → the documented
 *               neutral-prior handling (never fabricated); zero eligible
 *               candidates → the documented empty result (never a fallback
 *               to an ineligible candidate).
 *   W044-AC13 — tenant/project scoping: routing inputs + evidence stay
 *               scoped to the routed project; another tenant's registry,
 *               evidence, and policy restrictions cannot affect the
 *               ranking; the §22 decision is persisted under the routed
 *               tenant.
 *   W044-AC14 — stable tie-breaking: identical evidence → the documented
 *               lexicographic total order, stable across repeated routing.
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
import type { HistoricalPerformance } from '../../../src/execution-policy/index.js';
import { PgExecutionRecordRepository } from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';
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

describe('WORK-044 — Adaptive Execution Router (PG)', () => {
  let stack: TestAuthStack;
  let router: AdaptiveExecutionRouter;
  let policyService: DefaultExecutionPolicyService;
  let executionRecordRepo: PgExecutionRecordRepository;

  // Tenant A (the main project): alpha + beta (identical evidence), gamma
  // (SUPERIOR evidence — the blocked-but-high-quality fixture), omega (NO
  // evidence — the insufficient-evidence fixture).
  let orgAId: string;
  let projectAId: string;
  let workItemAId: string;
  let workOrderAId: string;
  let contextAId: string;
  // Tenant B: a separate org/project whose policy PROHIBITS external
  // execution and whose registry has only 'delta'.
  let orgBId: string;
  let projectBId: string;
  let workItemBId: string;
  // Project C (same user, separate project): external remains allowed —
  // proves tenant B's restrictions cannot leak across projects.
  let orgCId: string;
  let projectCId: string;
  let workItemCId: string;

  let userId: string;
  let execCount = 0;

  // The per-project evidence map: `${projectId}|${provider}|${mode}` →
  // HistoricalPerformance. Tenant-scoped BY KEY — a provider's evidence in
  // one project NEVER bleeds into another project's routing.
  const evidenceMap = new Map<string, HistoricalPerformance>();
  // Every evidence-provider call's projectId (the tenant-scope log).
  const evidenceProjectCalls: string[] = [];

  // The per-project registry: projectId → providers.
  const registryMap = new Map<string, ProviderFixture[]>();

  beforeAll(async () => {
    stack = await buildAuthStack();
    const db = stack.db.client;

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
        historicalPerformanceForCell: (pid: string, prov: string, mode: 'native' | 'external') => {
          evidenceProjectCalls.push(pid);
          return Promise.resolve(
            evidenceMap.get(`${pid}|${prov}|${mode}`) ?? evidence(0, null),
          );
        },
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

    executionRecordRepo = new PgExecutionRecordRepository(db);

    // --- tenant A (main) ---------------------------------------------------
    const orgA = await stack.organizationRepository.create({ name: 'W044 Org A' });
    orgAId = orgA.id;
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'w044-user', displayName: 'W044 User' });
    userId = user.id;
    const projectA = await stack.projectRepository.create({ organizationId: orgAId, name: 'W044 Project A' });
    projectAId = projectA.id;

    // --- tenant B (external PROHIBITED; only 'delta') ----------------------
    const orgB = await stack.organizationRepository.create({ name: 'W044 Org B' });
    orgBId = orgB.id;
    const projectB = await stack.projectRepository.create({ organizationId: orgBId, name: 'W044 Project B' });
    projectBId = projectB.id;

    // --- project C (same org as B is fine — separate PROJECT scope) --------
    const orgC = await stack.organizationRepository.create({ name: 'W044 Org C' });
    orgCId = orgC.id;
    const projectC = await stack.projectRepository.create({ organizationId: orgCId, name: 'W044 Project C' });
    projectCId = projectC.id;

    // The work-item chains (project → arch → version → work item).
    workItemAId = (await createChain('WORK-W044-A', projectAId)).workItemId;
    const chainA = await loadChainIds(workItemAId, projectAId);
    workOrderAId = chainA.workOrderId;
    contextAId = chainA.contextId;
    workItemBId = (await createChain('WORK-W044-B', projectBId)).workItemId;
    workItemCId = (await createChain('WORK-W044-C', projectCId)).workItemId;

    // The per-project registries (tenant-scoped by construction).
    registryMap.set(projectAId, [provider('alpha'), provider('beta'), provider('gamma'), provider('omega')]);
    registryMap.set(projectBId, [provider('delta')]);
    registryMap.set(projectCId, [provider('alpha')]);

    // The per-project evidence (tenant-scoped by key).
    const identical = evidence(5, 80, { ciFirstPassRate: 0.9, verificationFirstPassRate: 0.9, medianTimeToVerifiedMs: 600_000 });
    for (const mode of ['native', 'external'] as const) {
      evidenceMap.set(`${projectAId}|alpha|${mode}`, identical);
      evidenceMap.set(`${projectAId}|beta|${mode}`, identical);
      // gamma: SUPERIOR evidence — the blocked-but-high-quality fixture.
      evidenceMap.set(`${projectAId}|gamma|${mode}`, evidence(8, 98, { ciFirstPassRate: 1, verificationFirstPassRate: 1, medianTimeToVerifiedMs: 300_000 }));
      // omega: NO evidence — the insufficient-evidence fixture (neutral priors).
      evidenceMap.set(`${projectAId}|omega|${mode}`, evidence(0, null));
      evidenceMap.set(`${projectBId}|delta|${mode}`, evidence(6, 75, { ciFirstPassRate: 0.8, medianTimeToVerifiedMs: 900_000 }));
      evidenceMap.set(`${projectCId}|alpha|${mode}`, identical);
    }

    // The user's subscription posture (verified access profiles — the §5
    // subscription constraint passes for every fixture provider).
    for (const prov of ['alpha', 'beta', 'gamma', 'omega', 'delta']) {
      await policyService.upsertAccessProfile(orgAId, userId, {
        provider: prov,
        plan: 'pro',
        codingAgent: 'ready',
        externalUi: 'ready',
        nativeApi: 'ready',
        statusSource: 'verified',
      });
    }

    // Tenant B's policy: external execution PROHIBITED (a hard constraint
    // scoped to project B ONLY).
    await policyService.ensureProjectPolicy(orgBId, projectBId);
    await policyService.updateProjectPolicy(projectBId, { externalExecutionAllowed: false });
    await policyService.ensureProjectPolicy(orgCId, projectCId);

    async function createChain(workItemLabel: string, pid: string): Promise<{ workItemId: string }> {
      const arch = await stack.architectureRepository.create({ projectId: pid, name: `W044 Arch ${workItemLabel}` });
      const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: `# ${workItemLabel}` });
      const wi = await stack.workItemRepository.create({
        architectureVersionId: version.id,
        workItemId: workItemLabel,
        title: `${workItemLabel} fixture`,
        objective: 'fixture',
        scope: 'src/x.ts',
        outOfScope: 'none',
        metadata: { baseCommit: `w044-${workItemLabel.toLowerCase()}-baseline-000000000001` },
      });
      return { workItemId: wi.id };
    }

    async function loadChainIds(wiId: string, pid: string): Promise<{ workOrderId: string; contextId: string }> {
      const wi = await stack.workItemRepository.findById(wiId);
      const version = await stack.architectureVersionRepository.findById(wi!.architectureVersionId);
      const arch = await stack.architectureRepository.findById(version!.architectureId);
      const workOrder = await stack.workOrderRepository.create({
        workItemId: wiId,
        projectId: pid,
        architectureVersionId: version!.id,
        requirementIds: [],
        criterionIds: [],
        scope: 'src/x.ts',
        verificationRequirements: [],
      });
      const contextRepo = new PgImplementationContextRepository(db);
      const contextBuilder = new DefaultImplementationContextBuilder(
        stack.workItemRepository,
        stack.workOrderRepository,
        stack.workItemRequirementRepository,
        stack.workItemCriterionRepository,
        stack.workItemDependencyRepository,
        stack.requirementRepository,
        stack.acceptanceCriterionRepository,
        stack.architectureVersionRepository,
        stack.architectureRepository,
        contextRepo,
        async () => null,
        async () => null,
        async () => [],
        async () => [],
      );
      const ctx = await contextBuilder.build(wiId);
      void arch;
      return { workOrderId: workOrder.id, contextId: ctx.id };
    }
  });

  afterAll(async () => {
    await stack.teardown();
  });

  function routeA() {
    return router.recommendExecution({ projectId: projectAId, workItemId: workItemAId, userId });
  }
  function selectA() {
    return router.selectExecution({ projectId: projectAId, workItemId: workItemAId, userId });
  }

  // =========================================================================
  // W044-AC01 — eligibility precedes ranking (the baseline routing)
  // =========================================================================

  it('W044-AC01: every ranked candidate carries an ELIGIBLE WORK-043 verdict (all eight candidates ranked; no ineligible scored)', async () => {
    const result = await routeA();
    expect(result.ranked.length).toBe(8); // 4 providers × 2 modes, all eligible
    for (const row of result.ranked) {
      expect(row.eligibility.eligible).toBe(true);
      expect(row.eligibility.status).toBe('eligible');
      expect(row.eligibility.blockingReasons).toEqual([]);
    }
    expect(result.explanation.excluded).toEqual([]);
    expect(result.explanation.eligibleCount).toBe(8);
  });

  // =========================================================================
  // W044-AC02 — hard constraints cannot be overridden by quality
  // =========================================================================

  it('W044-AC02: the deny-listed provider with SUPERIOR benchmark quality is never selected or ranked (quality never overrides hard constraints)', async () => {
    // gamma has quality 98 + perfect first-pass rates — the BEST evidence in
    // the fixture. Deny-list it (a hard WORK-043 project constraint).
    await policyService.updateProjectPolicy(projectAId, { deniedProviders: ['gamma'] });

    const result = await routeA();
    const rankedProviders = new Set(result.ranked.map((r) => r.identity.provider));
    expect(rankedProviders.has('gamma')).toBe(false); // never ranked
    expect(rankedProviders.has('omega')).toBe(true);  // insufficient evidence, still eligible → ranked

    // gamma surfaces ONLY in the excluded picture, with the structured
    // project-policy blocking reason.
    const gammaExcluded = result.explanation.excluded.filter((e) => e.identity.provider === 'gamma');
    expect(gammaExcluded.length).toBe(2); // native + external
    for (const ex of gammaExcluded) {
      expect(ex.eligibility.eligible).toBe(false);
      expect(ex.eligibility.status).toBe('project_policy_blocked');
      expect(ex.eligibility.blockingReasons.some((b) => b.constraint === 'provider_denylist')).toBe(true);
    }

    // The selected candidate is NOT the superior-quality blocked one —
    // and the ranked winner's quality (80) < gamma's (98): quality lost to
    // the hard constraint, exactly as the boundary requires.
    expect(result.recommended?.identity.provider).not.toBe('gamma');
    expect(result.explanation.selectionReason).not.toContain('gamma');
  });

  // =========================================================================
  // W044-AC03 — deterministic ranking
  // =========================================================================

  it('W044-AC03: repeated routing produces the IDENTICAL ordered result and selection', async () => {
    const first = await routeA();
    const line = (r: { identity: { provider: string; model: string; executionMode: string }; score: number }) =>
      `${r.identity.provider}/${r.identity.model}/${r.identity.executionMode}:${r.score}`;
    for (let i = 0; i < 3; i += 1) {
      const repeat = await routeA();
      expect(repeat.ranked.map(line)).toEqual(first.ranked.map(line));
      expect(repeat.recommended?.identity).toEqual(first.recommended?.identity);
      expect(repeat.explanation.selectionReason).toBe(first.explanation.selectionReason);
    }
  });

  // =========================================================================
  // W044-AC08 — recommendation vs automatic selection (+ no workflow mutation)
  // =========================================================================

  it('W044-AC08: recommendation mode returns the inspectable ranking WITHOUT mutating workflow state, execution records, or dispatching', async () => {
    const countsBefore = await authoritativeRowCounts(workItemAId);
    const result = await routeA();
    expect(result.mode).toBe('recommendation');
    expect(result.recommended).toBe(result.ranked[0] ?? null);
    expect(result.decisionId).toBeTruthy(); // the §22 audit anchor
    const countsAfter = await authoritativeRowCounts(workItemAId);
    expect(countsAfter).toEqual(countsBefore);
  });

  it('W044-AC08: automatic-selection mode returns the SELECTED candidate + the alternatives it beat — still no workflow mutation, no dispatch', async () => {
    const countsBefore = await authoritativeRowCounts(workItemAId);
    const selection = await selectA();
    expect(selection.mode).toBe('automatic_selection');
    expect(selection.selected).toBeTruthy();
    expect(selection.selected?.identity).toBeTruthy();
    expect(selection.alternatives.length).toBeGreaterThan(0);
    // The selected candidate is NOT among the alternatives; the union is the
    // full eligible ranking.
    const all = [selection.selected!, ...selection.alternatives];
    expect(all.length).toBe(new Set(all.map((r) => `${r.identity.provider}/${r.identity.executionMode}`)).size);
    expect(selection.explanation.selectionReason).toContain(selection.selected!.identity.provider);
    const countsAfter = await authoritativeRowCounts(workItemAId);
    expect(countsAfter).toEqual(countsBefore);
  });

  it('W044-AC08: the two modes agree (the same top candidate, the same order) — distinct intents, one deterministic ranking', async () => {
    const rec = await routeA();
    const sel = await selectA();
    expect(sel.selected?.identity).toEqual(rec.recommended?.identity);
    expect(sel.alternatives.map((r) => r.identity)).toEqual(rec.ranked.slice(1).map((r) => r.identity));
  });

  // =========================================================================
  // W044-AC09 — explainability
  // =========================================================================

  it('W044-AC09: the routing output identifies the selected candidate, ranked alternatives, eligibility status, ranking signals, and the win reason', async () => {
    const result = await routeA();
    // Selected + alternatives.
    expect(result.recommended?.identity.provider).toBeTruthy();
    expect(result.ranked.length).toBeGreaterThan(1);
    // Eligibility status: every ranked row eligible; the excluded (gamma)
    // with its structured blocking reasons.
    for (const row of result.ranked) expect(row.eligibility.eligible).toBe(true);
    expect(result.explanation.excluded.length).toBe(2);
    // Ranking signals: every documented dimension per candidate.
    for (const row of result.ranked) {
      for (const dim of ['quality', 'reliability', 'cost', 'latency', 'humanIntervention'] as const) {
        expect(row.components[dim].value).toBeGreaterThanOrEqual(0);
        expect(row.components[dim].value).toBeLessThanOrEqual(1);
        expect(['observed', 'insufficient']).toContain(row.components[dim].status);
      }
    }
    // The win reason names the winner + the runner-up.
    expect(result.explanation.selectionReason).toContain(result.recommended!.identity.provider);
    expect(result.explanation.methodology).toContain('lexicographic');
    // The ranked evidence-backed candidates sit ABOVE the neutral-prior one
    // (omega — no evidence — deterministically last among the alpha/beta
    // tier by score): inspectability of the signal tiers.
    const providers = result.ranked.map((r) => r.identity.provider);
    expect(providers.indexOf('omega')).toBeGreaterThan(providers.lastIndexOf('beta'));
  });

  // =========================================================================
  // W044-AC07 — preferences reorder eligible candidates only
  // =========================================================================

  it('W044-AC07: an explicit mode preference reorders EQUAL-evidence eligible candidates (the bounded advisory boost)', async () => {
    await policyService.updateUserPreferences(userId, {
      preferredMode: 'external',
      externalPreferred: true,
    });
    const result = await routeA();
    // alpha native vs alpha external: identical evidence → the preference
    // boost must put the EXTERNAL alpha on top.
    expect(result.recommended?.identity.provider).toBe('alpha');
    expect(result.recommended?.identity.executionMode).toBe('external');
    expect(result.recommended?.components.preferenceBoost).toBe(0.1); // preferredMode + externalPreferred
    await policyService.updateUserPreferences(userId, {
      preferredMode: null,
      externalPreferred: false,
      nativePreferred: false,
    });
  });

  it('W044-AC07: the STRONGEST preference CANNOT resurrect a hard-blocked candidate (external prohibited → external absent; native selected)', async () => {
    await policyService.updateUserPreferences(userId, {
      preferredMode: 'external',
      externalPreferred: true,
    });
    await policyService.updateProjectPolicy(projectAId, { externalExecutionAllowed: false });

    const result = await routeA();
    // Every external candidate is excluded (hard block) — the preference
    // did not resurrect any of them.
    for (const row of result.ranked) expect(row.identity.executionMode).toBe('native');
    expect(result.explanation.excluded.every((e) => e.eligibility.eligible === false)).toBe(true);
    expect(result.recommended?.identity.executionMode).toBe('native');
    // Restore neutral preferences for the later scenarios.
    await policyService.updateUserPreferences(userId, {
      preferredMode: null,
      externalPreferred: false,
      nativePreferred: false,
    });
  });

  // =========================================================================
  // W044-AC10 — failure-safe behavior
  // =========================================================================

  it('W044-AC10: insufficient evidence is handled by the DOCUMENTED neutral-prior policy (deterministic; never fabricated; the candidate still ranked as eligible)', async () => {
    const result = await routeA();
    const omega = result.ranked.find((r) => r.identity.provider === 'omega');
    expect(omega).toBeTruthy();
    expect(omega?.components.quality).toEqual({ value: 0.5, status: 'insufficient' });
    expect(omega?.components.reliability).toEqual({ value: 0.5, status: 'insufficient' });
    expect(omega?.components.cost).toEqual({ value: 0.5, status: 'insufficient' });
    expect(omega?.components.latency).toEqual({ value: 0.5, status: 'insufficient' });
    expect(omega?.components.humanIntervention).toEqual({ value: 0.5, status: 'insufficient' });
    // Deterministic across repeats.
    const repeat = await routeA();
    const omegaRepeat = repeat.ranked.find((r) => r.identity.provider === 'omega');
    expect(omegaRepeat?.score).toBe(omega?.score);
  });

  it('W044-AC10: ZERO eligible candidates → the documented empty result (selected null; NEVER a fallback to an ineligible candidate)', async () => {
    // Exhaust the project's monthly quota with ONE real dispatched
    // execution (an execution row + its AgentRun ledger row — the
    // AR-043-01 dispatch predicate counts it) under a max of 1.
    const executionId = `wf-w044-${++execCount}`;
    const record = await executionRecordRepo.create({
      executionId,
      projectId: projectAId,
      workItemId: workItemAId,
      workOrderId: workOrderAId,
      implementationContextId: contextAId,
      mode: 'native',
      provider: 'alpha',
      model: 'alpha-model',
      prompt: `p-${executionId}`,
      promptDigest: `d-${executionId}`,
      branch: null,
    });
    await stack.db.client.query(
      `INSERT INTO wfos_agent_runs (execution_id, work_item_id, work_order_id, provider, status, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [executionId, workItemAId, workOrderAId, 'alpha', 'success'],
    );
    await policyService.updateProjectPolicy(projectAId, { maxExecutionsPerMonth: 1 });

    const selection = await selectA();
    expect(selection.selected).toBeNull();
    expect(selection.alternatives).toEqual([]);
    expect(selection.explanation.eligibleCount).toBe(0);
    expect(selection.explanation.selectionReason).toContain('No eligible execution candidate exists');
    expect(selection.explanation.selectionReason).toContain('never falls back');
    // EVERY candidate is excluded (a hard block on each). The native
    // candidates carry the structured QUOTA reason (gamma-native ALSO
    // carries its earlier deny-list block — the engine's status precedence
    // reports the composite as project_policy_blocked; both families are
    // hard blocks the router never bypasses).
    expect(selection.explanation.excluded.length).toBeGreaterThan(0);
    for (const ex of selection.explanation.excluded) {
      expect(ex.eligibility.eligible).toBe(false);
    }
    const nativeExcluded = selection.explanation.excluded.filter((e) => e.identity.executionMode === 'native');
    expect(nativeExcluded.length).toBe(4); // alpha + beta + gamma + omega natives
    for (const ex of nativeExcluded) {
      expect(ex.eligibility.blockingReasons.some((b) => b.category === 'quota' && b.constraint === 'monthly_quota_exhausted')).toBe(true);
    }
    const pureQuota = nativeExcluded.filter((e) => e.identity.provider !== 'gamma');
    for (const ex of pureQuota) {
      expect(ex.eligibility.status).toBe('quota_exhausted');
    }
    void record;
  });

  // =========================================================================
  // W044-AC13 — tenant/project scoping
  // =========================================================================

  it('W044-AC13: routing is tenant/project scoped — only the routed project\'s registry + evidence are read, and another project\'s hard restrictions cannot leak in', async () => {
    evidenceProjectCalls.length = 0;

    // Route project C (external ALLOWED there): project B's external
    // prohibition must NOT leak into project C's routing.
    const resultC = await router.recommendExecution({ projectId: projectCId, workItemId: workItemCId, userId });
    const modesC = new Set(resultC.ranked.map((r) => r.identity.executionMode));
    expect(modesC.has('native')).toBe(true);
    expect(modesC.has('external')).toBe(true); // B's restriction did not leak

    // Route project B (external PROHIBITED there — B's OWN policy applies).
    evidenceProjectCalls.length = 0;
    const resultB = await router.recommendExecution({ projectId: projectBId, workItemId: workItemBId, userId });
    for (const row of resultB.ranked) expect(row.identity.executionMode).toBe('native');
    expect(resultB.ranked.map((r) => r.identity.provider)).toEqual(['delta']); // B's OWN registry only
    expect(resultB.explanation.excluded.some((e) => e.identity.executionMode === 'external')).toBe(true);

    // The evidence reads were scoped to the ROUTED project ONLY — project
    // A's (or C's) evidence was never consulted for B's routing.
    for (const pid of evidenceProjectCalls) expect(pid).toBe(projectBId);

    // The §22 decision record for B's routing is persisted under B's OWN
    // tenant (org B + project B) — the audit trail is tenant-scoped too.
    const decisionRow = await stack.db.client.query(
      'SELECT organization_id, project_id FROM wfos_execution_policy_decisions WHERE id = $1',
      [resultB.decisionId],
    );
    expect(decisionRow.rows[0]?.organization_id).toBe(orgBId);
    expect(decisionRow.rows[0]?.project_id).toBe(projectBId);
  });

  it('W044-AC13: an unresolvable organization scope FAILS CLOSED (typed error — never an unconstrained routing)', async () => {
    const brokenRouter = new AdaptiveExecutionRouter({
      executionPolicyService: policyService,
      projectOrganizationResolver: { resolveProjectOrganization: async () => null },
      logger: stack.db.logger,
    });
    await expect(
      brokenRouter.recommendExecution({ projectId: '00000000-0000-0000-0000-000000000000', workItemId: workItemAId, userId }),
    ).rejects.toThrow('execution-routing-organization-unresolved');
  });

  // =========================================================================
  // W044-AC14 — stable tie-breaking (repeated integration routing)
  // =========================================================================

  it('W044-AC14: identical evidence ties break on the documented lexicographic total order — stable across repeated routing', async () => {
    // Project C: 'alpha' native + external with IDENTICAL evidence and no
    // mode preference → identical scores → the lexicographic identity order
    // (alpha/alpha-model/external before alpha/alpha-model/native) decides,
    // identically, on every repeat.
    const first = await router.recommendExecution({ projectId: projectCId, workItemId: workItemCId, userId });
    expect(first.ranked.length).toBe(2);
    expect(first.ranked[0]?.score).toBe(first.ranked[1]?.score);
    expect(first.ranked.map((r) => r.identity.executionMode)).toEqual(['external', 'native']);
    expect(first.explanation.tieBreakDecided).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      const repeat = await router.recommendExecution({ projectId: projectCId, workItemId: workItemCId, userId });
      expect(repeat.ranked.map((r) => r.identity.executionMode)).toEqual(['external', 'native']);
      expect(repeat.ranked.map((r) => r.score)).toEqual(first.ranked.map((r) => r.score));
    }
  });

  // =========================================================================
  // helpers
  // =========================================================================

  /**
   * The authoritative mutation surfaces the router must NEVER touch:
   * workflow state (executions + transitions) and execution records. (The
   * §22 append-only decision audit is NOT workflow state — it is the
   * decision trail the routing legitimately anchors to.)
   */
  async function authoritativeRowCounts(workItemId: string): Promise<[number, number, number]> {
    const workflow = await stack.db.client.query(
      'SELECT COUNT(*)::int AS n FROM wfos_workflow_executions WHERE work_item_id = $1',
      [workItemId],
    );
    const transitions = await stack.db.client.query(
      'SELECT COUNT(*)::int AS n FROM wfos_workflow_transitions WHERE work_item_id = $1',
      [workItemId],
    );
    const executions = await stack.db.client.query(
      'SELECT COUNT(*)::int AS n FROM wfos_executions WHERE work_item_id = $1',
      [workItemId],
    );
    return [
      workflow.rows[0]?.n ?? 0,
      transitions.rows[0]?.n ?? 0,
      executions.rows[0]?.n ?? 0,
    ];
  }
});
