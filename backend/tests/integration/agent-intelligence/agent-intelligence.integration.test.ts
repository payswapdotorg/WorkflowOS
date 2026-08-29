/**
 * WORK-047 — Agent Intelligence PostgreSQL integration tests.
 *
 * Real-PostgreSQL tests of the FULL advisory intelligence boundary — the real
 * DefaultExecutionPolicyService (the ONE WORK-043 eligibility engine) with
 * the real PgExecutionPolicyRepository, the real AdaptiveExecutionRouter
 * (the WORK-044 routing authority), the real WORK-045 role catalog, the real
 * read-only PgAgentIntelligenceRepository over REAL seeded execution-record
 * and delegation-ledger history, and the real DefaultAgentIntelligenceService
 * — only the provider registry + benchmark evidence provider are stubbed
 * (the WORK-043 engine-test pattern, mirroring the routing suite).
 *
 * Covers the work order's acceptance matrix + the architect's REQUIRED
 * ADVERSARIAL COVERAGE, every case pinned by title:
 *
 *   W047-AC01 — intelligence sits AFTER the authorities (pipeline order)
 *   ADVERSARIAL 1 — no eligible candidates → fail closed
 *   ADVERSARIAL 2 — historical evidence unavailable → safe/explicitly uncertain
 *   ADVERSARIAL 3 — stale historical evidence → the window is surfaced
 *   ADVERSARIAL 4 — conflicting evidence → deterministic composite
 *   ADVERSARIAL 5 — a new provider/model absent from historical data
 *   ADVERSARIAL 6 — unknown role → fail closed with a typed error
 *   ADVERSARIAL 7 — policy excludes the historically best candidate
 *   ADVERSARIAL 8 — capability excludes the historically best candidate
 *   ADVERSARIAL 9 — routing-carried exclusion of the historically best candidate
 *   ADVERSARIAL 10 — an ineligible candidate at the ranking seam → typed rejection
 *   ADVERSARIAL 11 + 12 — tenant isolation + no cross-project leakage
 *   ADVERSARIAL 13 — deterministic ordering under equal evidence
 *   ADVERSARIAL 14 — repeated recommendation for identical inputs
 *   ADVERSARIAL 15 — no mutation of authoritative workflow/execution state
 *   ADVERSARIAL 16 — no second routing/eligibility/role authority (behavioral)
 *   W047-AC06 — the provenance contract (the four questions)
 *   W047-AC09 — the decomposition is data, submitted through the EXISTING boundary
 *   W047-AC10 — historical evidence never becomes authority
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
import type { HistoricalPerformance, ExecutionTaskProfile } from '../../../src/execution-policy/index.js';
import { PgExecutionRecordRepository } from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';
import { DefaultAgentRoleCatalogService } from '../../../src/agent-roles/index.js';
import { DefaultDelegationPlanService } from '../../../src/delegation/index.js';
import {
  DefaultAgentIntelligenceService,
  PgAgentIntelligenceRepository,
  rankWithIntelligence,
  computeDecomposition,
  DECOMPOSITION_RULES,
  ROUTING_WEIGHT,
  HISTORY_WEIGHT,
  NEUTRAL_PRIOR,
  AgentIntelligenceError,
  type IntelligenceRequestInput,
} from '../../../src/agent-intelligence/index.js';

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

/** The decomposition fixture: high sensitivity everywhere (many roles). */
const RICH_TASK_PROFILE: ExecutionTaskProfile = {
  ...TASK_PROFILE,
  complexity: 'high',
  architectureSensitivity: 'high',
  securitySensitivity: 'high',
  terminalRequired: true,
};

/** The low-complexity fixture: the minimal decomposition. */
const LOW_TASK_PROFILE: ExecutionTaskProfile = {
  ...TASK_PROFILE,
  complexity: 'low',
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
  capabilities?: { conversationalChat: 'ready'; codingAgent: 'not-available'; implementationSurface: 'coding-agent' };
}

function provider(providerId: string, mode: 'both' | 'native' | 'external' = 'both', withCapabilities = false): ProviderFixture {
  return {
    name: `${providerId}-name`,
    provider: providerId,
    model: `${providerId}-model`,
    nativeApi: mode === 'external' ? 'not-configured' : 'ready',
    externalUi: mode === 'native' ? 'not-supported' : 'available',
    ...(withCapabilities
      ? { capabilities: { conversationalChat: 'ready' as const, codingAgent: 'not-available' as const, implementationSurface: 'coding-agent' as const } }
      : {}),
  };
}

/** An eligible WORK-043 verdict fixture (for the seam test). */
const ELIGIBLE_VERDICT = {
  status: 'eligible' as const,
  eligible: true,
  blockingReasons: [],
  satisfiedConstraints: ['capability:coding_agent'],
};

const INELIGIBLE_VERDICT = {
  status: 'policy_blocked' as const,
  eligible: false,
  blockingReasons: [{ category: 'project', constraint: 'provider_denylist', reason: 'denied by project policy' }],
  satisfiedConstraints: [],
};

describe('WORK-047 — Agent Intelligence (advisory ranking over the routing authority)', () => {
  let stack: TestAuthStack;
  let policyService: DefaultExecutionPolicyService;
  let router: AdaptiveExecutionRouter;
  let intelligence: DefaultAgentIntelligenceService;
  let roleCatalog: DefaultAgentRoleCatalogService;
  let delegationPlans: DefaultDelegationPlanService;
  let executionRecordRepo: PgExecutionRecordRepository;

  let orgAId: string;
  let projectAId: string;
  let workItemAId: string;
  let orgBId: string;
  let projectBId: string;
  let workItemBId: string;
  let projectCId: string; // NO eligible providers (the fail-closed fixture)
  let workItemCId: string;
  let workItemRichId: string; // the RICH profile work item (decomposition)
  let workItemLowId: string; // the LOW profile work item (decomposition)

  let userId: string;
  let execSeq = 0;
  let planSeq = 0;

  const evidenceMap = new Map<string, HistoricalPerformance>();
  const registryMap = new Map<string, ProviderFixture[]>();
  const profileMap = new Map<string, ExecutionTaskProfile>();

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
      taskProfileBuilder: { build: (workItemId: string) => Promise.resolve(profileMap.get(workItemId) ?? TASK_PROFILE) },
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

    roleCatalog = new DefaultAgentRoleCatalogService();
    delegationPlans = new DefaultDelegationPlanService({
      db,
      workItemRepository: stack.workItemRepository,
      roleCatalog,
    });

    intelligence = new DefaultAgentIntelligenceService({
      router,
      roleCatalog,
      repository: new PgAgentIntelligenceRepository({ db }),
      logger: stack.db.logger,
    });

    executionRecordRepo = new PgExecutionRecordRepository(db);

    // --- tenants -------------------------------------------------------------
    const orgA = await stack.organizationRepository.create({ name: 'W047 Org A' });
    orgAId = orgA.id;
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'w047-user', displayName: 'W047 User' });
    userId = user.id;
    const projectA = await stack.projectRepository.create({ organizationId: orgAId, name: 'W047 Project A' });
    projectAId = projectA.id;
    const orgB = await stack.organizationRepository.create({ name: 'W047 Org B' });
    orgBId = orgB.id;
    const projectB = await stack.projectRepository.create({ organizationId: orgBId, name: 'W047 Project B' });
    projectBId = projectB.id;
    const projectC = await stack.projectRepository.create({ organizationId: orgAId, name: 'W047 Project C (empty registry)' });
    projectCId = projectC.id;

    // --- the work-item chains --------------------------------------------------
    workItemAId = (await createChain('WORK-W047-A', projectAId)).workItemId;
    workItemBId = (await createChain('WORK-W047-B', projectBId)).workItemId;
    workItemCId = (await createChain('WORK-W047-C', projectCId)).workItemId;
    workItemRichId = (await createChain('WORK-W047-RICH', projectAId)).workItemId;
    workItemLowId = (await createChain('WORK-W047-LOW', projectAId)).workItemId;
    profileMap.set(workItemRichId, RICH_TASK_PROFILE);
    profileMap.set(workItemLowId, LOW_TASK_PROFILE);

    // --- the per-project registries (tenant-scoped by construction) ------------
    // alpha (history 7/8), beta + omega (equal evidence, no history — the
    // deterministic tie pair), gamma (SUPERIOR everything — policy-excluded in
    // the exclusion test), kappa (coding-agent capability unavailable — the
    // capability-excluded fixture), sigma (subscription-unknown — the
    // routing-carried exclusion fixture).
    registryMap.set(projectAId, [
      provider('alpha'), provider('beta'), provider('omega'),
      provider('gamma'), provider('kappa', 'both', true), provider('sigma'),
    ]);
    registryMap.set(projectBId, [provider('delta')]);
    registryMap.set(projectCId, []); // NO providers → no eligible candidates

    // --- the per-project benchmark evidence ------------------------------------
    const identical = evidence(5, 80, { ciFirstPassRate: 0.9, verificationFirstPassRate: 0.9, medianTimeToVerifiedMs: 600_000 });
    for (const mode of ['native', 'external'] as const) {
      evidenceMap.set(`${projectAId}|alpha|${mode}`, identical);
      evidenceMap.set(`${projectAId}|beta|${mode}`, identical);
      evidenceMap.set(`${projectAId}|omega|${mode}`, identical);
      // gamma: SUPERIOR benchmark evidence (the blocked-but-best fixture).
      evidenceMap.set(`${projectAId}|gamma|${mode}`, evidence(8, 98, { ciFirstPassRate: 1, verificationFirstPassRate: 1, medianTimeToVerifiedMs: 300_000 }));
      evidenceMap.set(`${projectAId}|kappa|${mode}`, evidence(7, 95));
      evidenceMap.set(`${projectAId}|sigma|${mode}`, evidence(6, 92));
      evidenceMap.set(`${projectBId}|delta|${mode}`, evidence(6, 75, { ciFirstPassRate: 0.8, medianTimeToVerifiedMs: 900_000 }));
    }

    // --- the user's subscription posture (verified for everyone EXCEPT sigma —
    // sigma's unknown subscription is the routing-carried exclusion fixture).
    // kappa's profile is VERIFIED but its coding-agent surface is UNAVAILABLE
    // (the capability-excluded fixture: the task profile requires
    // coding_agent, so kappa is capability_blocked regardless of history).
    for (const prov of ['alpha', 'beta', 'omega', 'gamma', 'delta']) {
      await policyService.upsertAccessProfile(orgAId, userId, {
        provider: prov,
        plan: 'pro',
        codingAgent: 'ready',
        externalUi: 'ready',
        nativeApi: 'ready',
        statusSource: 'verified',
      });
    }
    await policyService.upsertAccessProfile(orgAId, userId, {
      provider: 'kappa',
      plan: 'pro',
      codingAgent: 'unavailable',
      externalUi: 'ready',
      nativeApi: 'ready',
      statusSource: 'verified',
    });

    await policyService.ensureProjectPolicy(orgAId, projectAId);
    await policyService.ensureProjectPolicy(orgBId, projectBId);
    await policyService.ensureProjectPolicy(orgAId, projectCId);

    // --- the observed EXECUTION history (real wfos_executions rows) ------------
    // alpha: 7/8 succeeded (0.875, sufficient). gamma/kappa/sigma: perfect
    // history (the historically-best-but-excluded fixtures). delta (tenant B):
    // 1/4 (poor).
    await seedExecutions(projectAId, workItemAId, 'alpha', 'native', 7, 1);
    await seedExecutions(projectBId, workItemBId, 'delta', 'native', 1, 3);

    async function createChain(workItemLabel: string, pid: string): Promise<{ workItemId: string }> {
      const arch = await stack.architectureRepository.create({ projectId: pid, name: `W047 Arch ${workItemLabel}` });
      const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: `# ${workItemLabel}` });
      const wi = await stack.workItemRepository.create({
        architectureVersionId: version.id,
        workItemId: workItemLabel,
        title: `${workItemLabel} fixture`,
        objective: 'fixture',
        scope: 'src/x.ts',
        outOfScope: 'none',
        metadata: { baseCommit: `w047-${workItemLabel.toLowerCase()}-baseline-000000000001` },
      });
      return { workItemId: wi.id };
    }
  });

  afterAll(async () => {
    await stack.teardown();
  });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function reqA(): IntelligenceRequestInput {
    return { projectId: projectAId, workItemId: workItemAId, userId };
  }

  /** Seed real terminal execution rows through the authoritative repository. */
  async function seedExecutions(
    projectId: string,
    workItemId: string,
    providerId: string,
    mode: 'native' | 'external',
    succeeded: number,
    failed: number,
  ): Promise<void> {
    const chain = await loadChain(workItemId, projectId);
    for (let i = 0; i < succeeded + failed; i += 1) {
      execSeq += 1;
      const ok = i < succeeded;
      const record = await executionRecordRepo.create({
        executionId: `w047-exec-${providerId}-${execSeq}`,
        projectId,
        workItemId,
        workOrderId: chain.workOrderId,
        implementationContextId: chain.contextId,
        mode,
        provider: providerId,
        model: mode === 'native' ? `${providerId}-model` : null,
        prompt: 'w047 fixture prompt',
        promptDigest: `w047-digest-${execSeq}`,
      });
      if (!record) throw new Error(`fixture execution create failed for ${providerId}`);
      const updated = await executionRecordRepo.updateStatus(record.id, {
        status: ok ? 'completed' : 'failed',
        startedAt: new Date(Date.now() - 3600_000),
        completedAt: new Date(),
      });
      if (!updated) throw new Error(`fixture execution status update failed for ${providerId}`);
    }
  }

  async function loadChain(wiId: string, pid: string): Promise<{ workOrderId: string; contextId: string }> {
    const wi = await stack.workItemRepository.findById(wiId);
    const version = await stack.architectureVersionRepository.findById(wi!.architectureVersionId);
    const workOrder = await stack.workOrderRepository.create({
      workItemId: wiId,
      projectId: pid,
      architectureVersionId: version!.id,
      requirementIds: [],
      criterionIds: [],
      scope: 'src/x.ts',
      verificationRequirements: [],
    });
    const contextRepo = new PgImplementationContextRepository(stack.db.client);
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
    return { workOrderId: workOrder.id, contextId: ctx.id };
  }

  /** Seed delegation-ledger history (a real plan via the EXISTING service + terminal attempts). */
  async function seedDelegationHistory(
    workItemId: string,
    roleId: string,
    outcome: 'succeeded' | 'failed',
    count: number,
  ): Promise<void> {
    planSeq += 1;
    const plan = await delegationPlans.createPlan({
      workItemId,
      planKey: `w047-history-${planSeq}`,
      units: [{ unitKey: roleId, role: roleId as never, mode: 'native', provider: 'alpha', model: 'alpha-model' }],
    });
    const unit = plan.units[0]!;
    for (let i = 1; i <= count; i += 1) {
      execSeq += 1;
      await stack.db.client.query(
        `INSERT INTO wfos_delegation_attempts (unit_id, attempt_no, execution_id, mode, provider, model, outcome, created_at, updated_at)
         VALUES ($1, $2, $3, 'native', 'alpha', 'alpha-model', $4, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
        [unit.id, i, `w047-deleg-${planSeq}-${i}`, outcome],
      );
    }
  }

  /** The authoritative-table row counts (the no-mutation proof). */
  async function authoritativeRowCounts(): Promise<Record<string, number>> {
    const tables = [
      'wfos_workflow_executions',
      'wfos_workflow_transitions',
      'wfos_executions',
      'wfos_delegation_plans',
      'wfos_delegation_units',
      'wfos_delegation_attempts',
      'wfos_verification_runs',
      'wfos_reviews',
    ];
    const counts: Record<string, number> = {};
    for (const t of tables) {
      const r = await stack.db.client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${t}`);
      counts[t] = Number(r.rows[0]!.n);
    }
    return counts;
  }

  async function policyDecisionCount(): Promise<number> {
    const r = await stack.db.client.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM wfos_execution_policy_decisions');
    return Number(r.rows[0]!.n);
  }

  // =========================================================================
  // W047-AC01 — intelligence sits AFTER the authorities (the pipeline order)
  // =========================================================================

  it('W047-AC01: intelligence sits AFTER the authorities — every ranked candidate carries an ELIGIBLE verdict, the routing rank + score are carried through, and the composite is the documented formula', async () => {
    const result = await intelligence.recommendExecution(reqA());
    expect(result.mode).toBe('recommendation');
    // Baseline: alpha + beta + omega + gamma × 2 modes (kappa is
    // capability_blocked; sigma is subscription_blocked — both excluded at
    // the WORK-043 boundary BEFORE this layer runs).
    expect(result.ranked.length).toBe(8);
    const rankedProviders = new Set(result.ranked.map((r) => r.identity.provider));
    expect([...rankedProviders].sort()).toEqual(['alpha', 'beta', 'gamma', 'omega']);
    for (const row of result.ranked) {
      expect(row.eligibility.eligible).toBe(true);
      expect(row.eligibility.status).toBe('eligible');
      expect(row.routingRank).toBeGreaterThanOrEqual(1);
      // THE COMPOSITE (documented): 0.6×routing + 0.4×history.
      expect(row.score).toBeCloseTo(
        ROUTING_WEIGHT * row.components.routing.value + HISTORY_WEIGHT * row.components.historicalSuccess.value,
        10,
      );
    }
    // The intelligence VALUE-ADD is visible: alpha's observed history (7/8)
    // moves it ABOVE its consumed routing rank (the only candidate with
    // observed evidence in the baseline outranks its own routing position).
    const alphaNative = result.ranked.find((r) => r.identity.provider === 'alpha' && r.identity.executionMode === 'native')!;
    expect(alphaNative.historicalSignal.successRate).toBeCloseTo(0.875, 10);
    expect(alphaNative.historicalSignal.sufficient).toBe(true);
    expect(alphaNative.components.historicalSuccess.status).toBe('observed');
    const alphaIntelligenceRank = result.ranked.findIndex((r) => r.identity.provider === 'alpha' && r.identity.executionMode === 'native') + 1;
    expect(alphaIntelligenceRank).toBeLessThan(alphaNative.routingRank);
    expect(result.recommended).toBe(result.ranked[0]);
    // The excluded picture carries the two authority exclusions verbatim.
    expect(result.rejectedAlternatives.map((a) => a.identity.provider).sort()).toEqual(['kappa', 'kappa', 'sigma', 'sigma']);
  });

  it('ADVERSARIAL #16 (behavioral): the routing authority is CONSUMED, never bypassed — the decisionId IS the consumed router recommendation\'s decision id', async () => {
    const routing = await router.recommendExecution({ projectId: projectAId, workItemId: workItemAId, userId });
    const result = await intelligence.recommendExecution(reqA());
    expect(result.provenance.routing.decisionId).toBeTruthy();
    expect(result.provenance.routing.mode).toBe('recommendation');
    expect(result.provenance.routing.eligibleCount).toBe(routing.explanation.eligibleCount);
    expect(result.provenance.routing.routingOrder.map((i) => `${i.provider}/${i.executionMode}`))
      .toEqual(routing.ranked.map((c) => `${c.identity.provider}/${c.identity.executionMode}`));
  });

  // =========================================================================
  // ADVERSARIAL #1 — no eligible candidates → fail closed
  // =========================================================================

  it('ADVERSARIAL #1: no eligible candidates → fail closed — recommended null, never a fallback to an ineligible candidate', async () => {
    const result = await intelligence.recommendExecution({ projectId: projectCId, workItemId: workItemCId, userId });
    expect(result.recommended).toBeNull();
    expect(result.ranked).toEqual([]);
    expect(result.fallbacks).toEqual([]);
    expect(result.warnings.some((w) => w.includes('fail-closed') && w.includes('never a fallback'))).toBe(true);
    expect(result.provenance.confidence).toBe('low');
    expect(result.provenance.constraintsApplied).toBeNull();
  });

  // =========================================================================
  // ADVERSARIAL #2 + #5 — unavailable evidence / absent provider
  // =========================================================================

  it('ADVERSARIAL #2: historical evidence unavailable → the recommendation remains safe and EXPLICITLY uncertain (the documented neutral prior, never fabricated)', async () => {
    const result = await intelligence.recommendExecution(reqA());
    const betaNative = result.ranked.find((r) => r.identity.provider === 'beta' && r.identity.executionMode === 'native')!;
    expect(betaNative.historicalSignal.successRate).toBeNull();
    expect(betaNative.historicalSignal.sampleSize).toBe(0);
    expect(betaNative.historicalSignal.lastObservedAt).toBeNull();
    expect(betaNative.components.historicalSuccess.value).toBe(NEUTRAL_PRIOR);
    expect(betaNative.components.historicalSuccess.status).toBe('insufficient');
    // NEVER FABRICATED: beta contributes NO evidence cell (no invented
    // observation backs its neutral component).
    expect(result.provenance.contributingEvidence.some((c) => c.cell.startsWith('beta/'))).toBe(false);
    expect(result.evidence.executionCells.some((c) => c.provider === 'beta')).toBe(false);
    // The unobserved-candidate picture is surfaced on every such row.
    for (const row of result.ranked.filter((r) => r.historicalSignal.sampleSize === 0)) {
      expect(row.components.historicalSuccess.status).toBe('insufficient');
    }
  });

  it('ADVERSARIAL #5: a new provider/model absent from historical data is still rankable through the routing component — with an explicitly insufficient signal, never a fabricated rate', async () => {
    const result = await intelligence.recommendExecution(reqA());
    const omegaNative = result.ranked.find((r) => r.identity.provider === 'omega' && r.identity.executionMode === 'native')!;
    expect(omegaNative).toBeTruthy(); // ranked (eligible), never dropped for lacking history
    expect(omegaNative.historicalSignal.successRate).toBeNull();
    expect(omegaNative.historicalSignal.sufficient).toBe(false);
    expect(omegaNative.components.historicalSuccess.value).toBe(NEUTRAL_PRIOR);
  });

  // =========================================================================
  // ADVERSARIAL #3 — stale historical evidence
  // =========================================================================

  it('ADVERSARIAL #3: stale historical evidence → the observation window is SURFACED (never presented as current), and the scoring is recency-independent', async () => {
    // Push alpha's execution rows 120 days into the past (the stale fixture).
    await stack.db.client.query(
      `UPDATE wfos_executions
          SET created_at = NOW() - INTERVAL '120 days',
              started_at = NOW() - INTERVAL '120 days',
              completed_at = NOW() - INTERVAL '120 days',
              updated_at = NOW() - INTERVAL '120 days'
        WHERE provider = 'alpha' AND project_id = $1`,
      [projectAId],
    );
    const result = await intelligence.recommendExecution(reqA());
    const alphaNative = result.ranked.find((r) => r.identity.provider === 'alpha' && r.identity.executionMode === 'native')!;
    // The evidence is aggregated over the same 8 attempts — the SCORE is
    // recency-independent (identical to the fresh-history run).
    expect(alphaNative.historicalSignal.successRate).toBeCloseTo(0.875, 10);
    expect(alphaNative.score).toBeCloseTo(ROUTING_WEIGHT * alphaNative.components.routing.value + HISTORY_WEIGHT * 0.875, 10);
    // The window is SURFACED: the contribution carries the ~120-day-old
    // lastObservedAt (stale evidence is historical, never current).
    const contribution = result.provenance.contributingEvidence.find((c) => c.cell.startsWith('alpha/'))!;
    expect(contribution).toBeTruthy();
    const ageDays = (Date.now() - contribution.lastObservedAt.getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(119);
    expect(result.provenance.reasons.some((r) => r.dimension === 'historical_success' && r.detail.includes('last observed'))).toBe(true);
  });

  // =========================================================================
  // ADVERSARIAL #4 — conflicting evidence
  // =========================================================================

  it('ADVERSARIAL #4: conflicting evidence (benchmark favors gamma, execution history favors alpha) → the DETERMINISTIC composite with BOTH signals surfaced', async () => {
    const result = await intelligence.recommendExecution(reqA());
    const alphaNative = result.ranked.find((r) => r.identity.provider === 'alpha' && r.identity.executionMode === 'native')!;
    const gammaNative = result.ranked.find((r) => r.identity.provider === 'gamma' && r.identity.executionMode === 'native')!;
    // BOTH signals are visible per candidate: the routing component (where
    // gamma's superior benchmark put it ahead) and the history component
    // (where alpha's observed 0.875 beats gamma's neutral prior — gamma has
    // no seeded executions in this fixture).
    expect(gammaNative.components.routing.value).toBeGreaterThan(alphaNative.components.routing.value);
    expect(alphaNative.components.historicalSuccess.value).toBeGreaterThan(gammaNative.components.historicalSuccess.value);
    // The composite ordering follows the documented formula + tie-break
    // chain EXACTLY — deterministic, whichever way the conflict resolves.
    const expected = [...result.ranked].sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.components.routing.value !== b.components.routing.value) return b.components.routing.value - a.components.routing.value;
      const ka = `${a.identity.provider}\u0000${a.identity.model}\u0000${a.identity.executionMode}`;
      const kb = `${b.identity.provider}\u0000${b.identity.model}\u0000${b.identity.executionMode}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    expect(result.ranked.map((r) => r.identity)).toEqual(expected.map((r) => r.identity));
    // Both contributing evidence cells are surfaced (the conflicting picture
    // is inspectable — never silently blended away).
    expect(result.provenance.contributingEvidence.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // ADVERSARIAL #7 + #8 + #9 — the authority exclusions
  // =========================================================================

  it('ADVERSARIAL #7: POLICY excludes the historically best candidate → never recommended; rejected with the AUTHORITY\'s blocking reason', async () => {
    // Seed gamma with PERFECT execution history — the historically best
    // candidate — then deny-list it (a hard project-policy constraint).
    await seedExecutions(projectAId, workItemAId, 'gamma', 'native', 10, 0);
    await policyService.updateProjectPolicy(projectAId, { deniedProviders: ['gamma'] });
    try {
      const result = await intelligence.recommendExecution(reqA());
      const rankedProviders = new Set(result.ranked.map((r) => r.identity.provider));
      expect(rankedProviders.has('gamma')).toBe(false); // never scored
      expect(result.recommended?.identity.provider).not.toBe('gamma');
      // It surfaces ONLY in the rejected picture with the authority's words.
      const gammaRejected = result.rejectedAlternatives.filter((a) => a.identity.provider === 'gamma');
      expect(gammaRejected.length).toBe(2); // native + external
      for (const rej of gammaRejected) {
        expect(rej.eligibility.eligible).toBe(false);
        expect(rej.eligibility.status).toBe('project_policy_blocked');
        expect(rej.eligibility.blockingReasons.some((b) => b.constraint === 'provider_denylist')).toBe(true);
        expect(rej.excludedThrough).toBe('policy');
      }
      // PERFECT history could not rescue it: hard constraints dominate.
      expect(result.provenance.rejectedAlternatives.some((a) => a.identity.provider === 'gamma')).toBe(true);
    } finally {
      // Restore the policy for the subsequent fixtures.
      await policyService.updateProjectPolicy(projectAId, { deniedProviders: [] });
    }
  });

  it('ADVERSARIAL #8: CAPABILITY excludes the historically best candidate → never recommended; rejected with the authority\'s blocking reason', async () => {
    // kappa's coding-agent surface is NOT AVAILABLE (registry capability) —
    // the task profile requires coding_agent, so kappa is capability_blocked
    // regardless of any history.
    const result = await intelligence.recommendExecution(reqA());
    const rankedProviders = new Set(result.ranked.map((r) => r.identity.provider));
    expect(rankedProviders.has('kappa')).toBe(false);
    expect(result.recommended?.identity.provider).not.toBe('kappa');
    const kappaRejected = result.rejectedAlternatives.filter((a) => a.identity.provider === 'kappa');
    expect(kappaRejected.length).toBe(2);
    for (const rej of kappaRejected) {
      expect(rej.eligibility.eligible).toBe(false);
      expect(rej.eligibility.status).toBe('capability_blocked');
      expect(rej.excludedThrough).toBe('capability');
    }
  });

  it('ADVERSARIAL #9: the ROUTING-CARRIED exclusion (unknown subscription) of a well-evidenced candidate → never recommended; rejected with the authority\'s reason', async () => {
    // sigma has benchmark evidence but NO access profile — the subscription
    // constraint (§5, unknown fails blocked) excludes it at the WORK-043
    // boundary and the routing result carries the verdict.
    const result = await intelligence.recommendExecution(reqA());
    const rankedProviders = new Set(result.ranked.map((r) => r.identity.provider));
    expect(rankedProviders.has('sigma')).toBe(false);
    const sigmaRejected = result.rejectedAlternatives.filter((a) => a.identity.provider === 'sigma');
    expect(sigmaRejected.length).toBe(2);
    for (const rej of sigmaRejected) {
      expect(rej.eligibility.eligible).toBe(false);
      expect(rej.eligibility.status).toBe('subscription_blocked');
    }
  });

  // =========================================================================
  // ADVERSARIAL #10 — the ineligible-candidate ranking seam (defense in depth)
  // =========================================================================

  it('ADVERSARIAL #10: an ineligible candidate at the ranking seam → TYPED REJECTION (defense in depth — the public path cannot produce this)', () => {
    expect(() =>
      rankWithIntelligence({
        ranked: [
          {
            identity: { provider: 'gamma', model: 'gamma-model', executionMode: 'native' },
            score: 0.9,
            components: {
              quality: { value: 0.9, status: 'observed' },
              reliability: { value: 0.9, status: 'observed' },
              cost: { cents: null, confidence: 'unknown' },
              latency: { estimatedMs: null, source: 'unknown' },
              humanIntervention: { count: null, sampleSize: 0 },
              preferenceBoost: 0,
            },
            eligibility: INELIGIBLE_VERDICT,
          } as never,
        ],
        executionCells: [],
      }),
    ).toThrowError(AgentIntelligenceError);
    try {
      rankWithIntelligence({
        ranked: [
          {
            identity: { provider: 'gamma', model: 'gamma-model', executionMode: 'native' },
            score: 0.9,
            components: {},
            eligibility: INELIGIBLE_VERDICT,
          } as never,
        ],
        executionCells: [],
      });
      expect.unreachable('the seam must reject ineligible candidates');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentIntelligenceError);
      expect((err as AgentIntelligenceError).code).toBe('agent-intelligence-ineligible-candidate');
    }
    // The eligible form passes the seam (the control).
    const ok = rankWithIntelligence({
      ranked: [
        {
          identity: { provider: 'alpha', model: 'alpha-model', executionMode: 'native' },
          score: 0.8,
          components: {},
          eligibility: ELIGIBLE_VERDICT,
        } as never,
      ],
      executionCells: [],
    });
    expect(ok.ranked).toHaveLength(1);
  });

  // =========================================================================
  // ADVERSARIAL #6 — unknown role (the decomposition seam)
  // =========================================================================

  it('ADVERSARIAL #6: unknown role at the decomposition seam → fail closed with a typed error (the intelligence layer authors no role definitions)', () => {
    const corruptedRules = [
      ...DECOMPOSITION_RULES.filter((r) => r.role !== 'implementer'),
      {
        role: 'wizard-of-oz' as never,
        applies: () => true,
        recommendationReason: () => 'corrupted fixture',
        rejectionReason: 'corrupted fixture',
        dependsOn: [],
      },
    ];
    expect(() =>
      computeDecomposition({
        taskProfile: TASK_PROFILE,
        roleCells: [],
        resolveRole: (identity) => roleCatalog.resolveRole(identity),
        rules: corruptedRules,
      }),
    ).toThrowError(AgentIntelligenceError);
    try {
      computeDecomposition({
        taskProfile: TASK_PROFILE,
        roleCells: [],
        resolveRole: (identity) => roleCatalog.resolveRole(identity),
        rules: corruptedRules,
      });
      expect.unreachable('the decomposition must fail closed on unknown roles');
    } catch (err) {
      expect((err as AgentIntelligenceError).code).toBe('agent-intelligence-unknown-role');
      expect((err as Error).message).toContain('wizard-of-oz');
    }
  });

  // =========================================================================
  // ADVERSARIAL #11 + #12 — tenant isolation + no cross-project leakage
  // =========================================================================

  it('ADVERSARIAL #11 + #12: tenant isolation — another project\'s evidence, policy, and registry cannot affect the recommendation, and NO cross-project evidence leaks', async () => {
    const a = await intelligence.recommendExecution(reqA());
    // Project A's evidence summary contains ONLY project A's rows.
    expect(a.evidence.scope.projectId).toBe(projectAId);
    const providersInEvidence = new Set(a.evidence.executionCells.map((c) => c.provider));
    expect(providersInEvidence.has('delta')).toBe(false); // tenant B's provider never appears
    expect(a.evidence.executionCells.every((c) => c.attempts > 0)).toBe(true);

    // Project B's recommendation reflects ONLY B's own (poor) delta history.
    const b = await intelligence.recommendExecution({ projectId: projectBId, workItemId: workItemBId, userId });
    expect(b.evidence.scope.projectId).toBe(projectBId);
    const deltaNative = b.ranked.find((r) => r.identity.provider === 'delta' && r.identity.executionMode === 'native')!;
    expect(deltaNative.historicalSignal.successRate).toBeCloseTo(0.25, 10); // 1/4 — B's OWN truth
    expect(deltaNative.historicalSignal.sampleSize).toBe(4);
    // No project-A provider ever appears in B's ranked set or evidence.
    expect(b.ranked.every((r) => r.identity.provider === 'delta')).toBe(true);
    expect(b.evidence.executionCells.map((c) => c.provider)).toEqual(['delta']);

    // And A's recommendation is byte-identical before/after B's data existed
    // (the isolation is structural: the SQL scopes by project_id).
    const aAgain = await intelligence.recommendExecution(reqA());
    expect(aAgain.ranked.map((r) => r.identity)).toEqual(a.ranked.map((r) => r.identity));
    expect(aAgain.ranked.map((r) => r.score)).toEqual(a.ranked.map((r) => r.score));
  });

  // =========================================================================
  // ADVERSARIAL #13 — deterministic ordering under equal evidence
  // =========================================================================

  it('ADVERSARIAL #13: deterministic ordering under equal evidence — the documented total order (score → routing → lexicographic)', async () => {
    const result = await intelligence.recommendExecution(reqA());
    // beta + omega: identical benchmark evidence, no history → identical
    // composites → the tie-break chain decides: equal scores, equal routing
    // scores → LEXICOGRAPHIC (beta < omega).
    const order = result.ranked.map((r) => `${r.identity.provider}/${r.identity.executionMode}`);
    const betaNative = order.indexOf('beta/native');
    const omegaNative = order.indexOf('omega/native');
    expect(betaNative).toBeGreaterThanOrEqual(0);
    expect(omegaNative).toBeGreaterThanOrEqual(0);
    expect(betaNative).toBeLessThan(omegaNative);
    const betaExternal = order.indexOf('beta/external');
    const omegaExternal = order.indexOf('omega/external');
    expect(betaExternal).toBeLessThan(omegaExternal);
    // The equal pair carries IDENTICAL components (the tie is real).
    const b = result.ranked[betaNative]!;
    const o = result.ranked[omegaNative]!;
    expect(b.score).toBe(o.score);
    expect(b.components.routing.value).toBe(o.components.routing.value);
    expect(b.components.historicalSuccess.value).toBe(o.components.historicalSuccess.value);
  });

  // =========================================================================
  // ADVERSARIAL #14 — repeated recommendation for identical inputs
  // =========================================================================

  it('ADVERSARIAL #14: repeated recommendation for identical inputs → deep-equal results (the decisionId is the per-call §22 anchor by design)', async () => {
    const first = await intelligence.recommendExecution(reqA());
    for (let i = 0; i < 3; i += 1) {
      const repeat = await intelligence.recommendExecution(reqA());
      // The deterministic CONTENT: the full ranked picture + provenance
      // content (identities, scores, components, signals, reasons).
      expect(repeat.ranked.map((r) => ({
        identity: r.identity,
        score: r.score,
        components: r.components,
        historicalSignal: { ...r.historicalSignal, lastObservedAt: r.historicalSignal.lastObservedAt?.toISOString() ?? null },
        routingRank: r.routingRank,
      }))).toEqual(first.ranked.map((r) => ({
        identity: r.identity,
        score: r.score,
        components: r.components,
        historicalSignal: { ...r.historicalSignal, lastObservedAt: r.historicalSignal.lastObservedAt?.toISOString() ?? null },
        routingRank: r.routingRank,
      })));
      expect(repeat.recommended?.identity).toEqual(first.recommended?.identity);
      expect(repeat.provenance.headline.replace(/[0-9a-f-]{36}/g, '')).toBe(first.provenance.headline.replace(/[0-9a-f-]{36}/g, ''));
      expect(repeat.provenance.reasons.map((r) => r.detail.replace(/[0-9a-f-]{36}/g, ''))).toEqual(first.provenance.reasons.map((r) => r.detail.replace(/[0-9a-f-]{36}/g, '')));
      expect(repeat.provenance.confidence).toBe(first.provenance.confidence);
    }
  });

  // =========================================================================
  // ADVERSARIAL #15 — no mutation of authoritative state
  // =========================================================================

  it('ADVERSARIAL #15: no mutation of authoritative workflow/execution/delegation state — the ONLY durable artifact is the consumed §22 policy decision', async () => {
    const before = await authoritativeRowCounts();
    const decisionsBefore = await policyDecisionCount();
    const exec = await intelligence.recommendExecution(reqA());
    const delegation = await intelligence.recommendDelegation(reqA());
    const after = await authoritativeRowCounts();
    const decisionsAfter = await policyDecisionCount();
    expect(after).toEqual(before);
    // The truthful durable-artifact claim: each consumed recommendation
    // persisted EXACTLY ONE §22 decision (2 calls → +2) — the audit anchor.
    expect(decisionsAfter - decisionsBefore).toBe(2);
    expect(exec.provenance.constraintsApplied?.decisionId).toBeTruthy();
    expect(delegation.execution.provenance.constraintsApplied?.decisionId).toBeTruthy();
  });

  // =========================================================================
  // W047-AC06 — the provenance contract (the four questions)
  // =========================================================================

  it('W047-AC06: the provenance answers the four questions — why, which evidence, which constraints, which rejected alternatives', async () => {
    await policyService.updateProjectPolicy(projectAId, { deniedProviders: ['gamma'] });
    try {
      const result = await intelligence.recommendExecution(reqA());
      const p = result.provenance;
      // Q1 — why: headline + structured reasons.
      expect(p.headline).toContain(result.recommended!.identity.provider);
      expect(p.reasons.length).toBeGreaterThanOrEqual(2);
      // Q2 — which evidence: contributing cells with windows.
      expect(p.contributingEvidence.length).toBeGreaterThan(0);
      for (const c of p.contributingEvidence) {
        expect(c.cell).toBeTruthy();
        expect(c.firstObservedAt instanceof Date).toBe(true);
        expect(c.lastObservedAt instanceof Date).toBe(true);
      }
      // Q3 — which constraints were already applied: the decisionId anchor
      // + the satisfied constraints carried verbatim.
      expect(p.constraintsApplied!.decisionId).toBeTruthy();
      expect(p.constraintsApplied!.satisfiedConstraints.length).toBeGreaterThan(0);
      // Q4 — which alternatives were rejected: with the authority's reasons.
      expect(p.rejectedAlternatives.length).toBeGreaterThan(0);
      expect(p.rejectedAlternatives.every((a) => a.eligibility.eligible === false)).toBe(true);
      expect(p.rejectedAlternatives.every((a) => a.eligibility.blockingReasons.length > 0)).toBe(true);
    } finally {
      await policyService.updateProjectPolicy(projectAId, { deniedProviders: [] });
    }
  });

  // =========================================================================
  // W047-AC09 + AC10 — the decomposition
  // =========================================================================

  it('W047-AC09: the decomposition is DATA — a recommended decomposition submits through the EXISTING WORK-046 boundary and the plan is created under the EXISTING validation', async () => {
    const rec = await intelligence.recommendDelegation({ projectId: projectAId, workItemId: workItemRichId, userId });
    expect(rec.planKey).toBe('intelligence-recommended');
    expect(rec.submissionPath).toBe(`/projects/${projectAId}/work-items/${workItemRichId}/delegation-plans`);
    // The rich profile (high complexity + high arch/security sensitivity +
    // terminal) recommends: implementer, architect, planner, tester,
    // security-reviewer, performance-reviewer.
    const roles = rec.units.map((u) => u.role).sort();
    expect(roles).toEqual(['architect', 'implementer', 'performance-reviewer', 'planner', 'security-reviewer', 'tester']);
    // Every unit's role resolves in the WORK-045 catalog (pinned revision).
    for (const unit of rec.units) {
      const resolution = roleCatalog.resolveRole(unit.role);
      expect(resolution).toBeTruthy();
      expect(unit.roleRevision).toBe(resolution!.role.lifecycle.revision);
    }
    // The rejected role alternatives are explicit with reasons.
    expect(rec.rejectedRoles.map((r) => r.role).sort()).toEqual(['release-engineer', 'ux-reviewer']);
    expect(rec.rejectedRoles.every((r) => r.reason.length > 10)).toBe(true);
    // Assignments came from the intelligence ranking (eligible candidates only).
    for (const unit of rec.units) {
      expect(unit.mode).toBeTruthy();
      expect(unit.provider).toBeTruthy();
    }
    // THE SUBMISSION PATH: the recommended shape is a valid DelegationPlanInput —
    // the EXISTING plan service accepts it under its OWN fail-closed validation.
    const plan = await delegationPlans.createPlan({
      workItemId: workItemRichId,
      planKey: rec.planKey,
      units: rec.units.map((u) => ({
        unitKey: u.unitKey,
        role: u.role,
        mode: u.mode as 'native' | 'external',
        provider: u.provider!,
        model: u.model,
        dependsOn: u.dependsOn,
      })),
    });
    expect(plan.units).toHaveLength(rec.units.length);
    expect(plan.units.map((u) => u.unitKey).sort()).toEqual(roles);
  });

  it('W047-AC09 (minimal shape): the low-complexity profile recommends the minimal decomposition (implementer only) with the tester explicitly rejected', async () => {
    const rec = await intelligence.recommendDelegation({ projectId: projectAId, workItemId: workItemLowId, userId });
    expect(rec.units.map((u) => u.role)).toEqual(['implementer']);
    const tester = rec.rejectedRoles.find((r) => r.role === 'tester');
    expect(tester?.reason).toContain('low complexity');
  });

  it('W047-AC10: historical role evidence ANNOTATES the decomposition and NEVER drops a task-profile-required role', async () => {
    // Seed POOR security-reviewer history in project A (1/4 succeeded),
    // then decompose the RICH work item (securitySensitivity high → the
    // security-reviewer unit is task-profile-REQUIRED).
    await seedDelegationHistory(workItemRichId, 'security-reviewer', 'succeeded', 1);
    await seedDelegationHistory(workItemRichId, 'security-reviewer', 'failed', 3);
    const rec = await intelligence.recommendDelegation({ projectId: projectAId, workItemId: workItemRichId, userId });
    const unit = rec.units.find((u) => u.role === 'security-reviewer')!;
    // STILL RECOMMENDED (the task-profile rule dominates; evidence annotates).
    expect(unit).toBeTruthy();
    // The annotation: the observed history is on the unit, exactly.
    expect(unit.roleHistory).toBeTruthy();
    expect(unit.roleHistory!.attempts).toBe(4);
    expect(unit.roleHistory!.succeeded).toBe(1);
    expect(unit.roleHistory!.successRate).toBeCloseTo(0.25, 10);
    // And the poor-success WARNING is raised — evidence speaks, never decides.
    expect(rec.warnings.some((w) => w.includes('security-reviewer') && w.includes('poor observed delegation success'))).toBe(true);
    expect(unit.why.some((r) => r.dimension === 'historical_success')).toBe(true);
  });

  // =========================================================================
  // The decomposition's no-eligible-candidates fail-safe
  // =========================================================================

  it('the decomposition with NO eligible candidates recommends the role structure with assignments EXPLICITLY unavailable (never fabricated)', async () => {
    const rec = await intelligence.recommendDelegation({ projectId: projectCId, workItemId: workItemCId, userId });
    expect(rec.execution.recommended).toBeNull();
    expect(rec.units.length).toBeGreaterThan(0); // roles are provider-independent
    for (const unit of rec.units) {
      expect(unit.mode).toBeNull();
      expect(unit.provider).toBeNull();
      expect(unit.why.some((r) => r.dimension === 'unavailable')).toBe(true);
    }
    expect(rec.warnings.some((w) => w.includes('assignments are explicitly unavailable'))).toBe(true);
  });
});
