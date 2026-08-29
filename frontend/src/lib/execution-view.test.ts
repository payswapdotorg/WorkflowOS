/**
 * WORK-050 — the pure unified-execution view derivation.
 *
 * These tests prove the derivation is PURE over the authoritative facts:
 * `actuallySelected` comes ONLY from the execution record's own identity
 * fields (a recommendation NEVER becomes the selection — structurally
 * impossible in the view model), native and external executions derive from
 * the SAME model (parity), statuses are the authorities' own values rendered
 * verbatim (never fabricated), the SAME facts always produce the SAME view
 * (fresh facts produce the fresh view — refresh consistency), and absent
 * facts contribute NOTHING (no handoff/delegation/verification is invented).
 */
import { describe, it, expect } from 'vitest';
import { deriveExecutionView, type ExecutionViewFacts } from './execution-view';
import type {
  ExecutionSummary,
  RoutingRecommendation,
  AgentIntelligenceRecommendation,
  ExecutionRecommendation,
  CrossModeHandoffView,
  DelegationPlanView,
  VerificationRun,
  MergeGateResult,
} from '@/api/client';

// --- fixtures -----------------------------------------------------------------

function execution(overrides: Partial<ExecutionSummary> & { executionId: string }): ExecutionSummary {
  return {
    mode: 'native',
    provider: 'openai',
    model: 'gpt-4',
    status: 'running',
    agentRunId: null,
    externalSessionRef: null,
    repository: null,
    branch: null,
    promptDigest: 'digest',
    benchmarkMetadata: {},
    startedAt: '2026-08-29T10:00:00Z',
    completedAt: null,
    expiresAt: null,
    createdAt: '2026-08-29T10:00:00Z',
    updatedAt: '2026-08-29T10:00:00Z',
    ...overrides,
  } as ExecutionSummary;
}

function routing(overrides: Partial<RoutingRecommendation> = {}): RoutingRecommendation {
  return {
    mode: 'recommendation',
    ranked: [
      { identity: { provider: 'zai', model: 'glm-4.6', executionMode: 'external' }, score: 0.9 },
      { identity: { provider: 'openai', model: 'gpt-4', executionMode: 'native' }, score: 0.8 },
    ],
    selected: { identity: { provider: 'zai', model: 'glm-4.6', executionMode: 'external' }, score: 0.9 },
    explanation: {
      selectionReason: 'higher capability score under the current benchmark mode',
      methodology: 'adaptive scoring over eligible candidates',
      eligibleCount: 2,
      excluded: [{ identity: { provider: 'slow', model: 'x', executionMode: 'native' } }],
      tieBreakDecided: false,
    },
    ...overrides,
  };
}

function intelligence(overrides: Partial<AgentIntelligenceRecommendation> = {}): AgentIntelligenceRecommendation {
  return {
    mode: 'recommendation',
    recommended: { identity: { provider: 'zai', model: 'glm-4.6', executionMode: 'external' }, score: 0.92, routingRank: 1 },
    ranked: [],
    fallbacks: [{ provider: 'openai', model: 'gpt-4', executionMode: 'native' }],
    provenance: {
      headline: 'highest historical success on similar tasks',
      reasons: [{ dimension: 'capability', detail: 'glm-4.6 leads the capability signal' }],
      rejectedAlternatives: [{ provider: 'slow', model: 'x', executionMode: 'native', reason: 'latency floor' }],
      confidence: 'high',
    },
    warnings: [],
    ...overrides,
  };
}

function policy(overrides: Partial<ExecutionRecommendation> = {}): ExecutionRecommendation {
  return {
    workItemId: 'wi-1',
    recommendedCandidate: null,
    eligibleCandidates: [],
    excludedCandidates: [],
    why: { recommendedCandidateId: null, headline: 'two providers eligible under the current policy', reasons: [], alternatives: [] },
    benchmarkEvidence: {} as ExecutionRecommendation['benchmarkEvidence'],
    policy: {
      benchmarkMode: 'maximum_capability',
      maxCostCents: null,
      maxDurationMs: null,
      requiredCapabilities: [],
      allowedProviders: ['zai', 'openai'],
      allowedModes: ['native', 'external'],
      privacyRequirements: {} as ExecutionRecommendation['policy']['privacyRequirements'],
      subscriptionRequirement: {} as ExecutionRecommendation['policy']['subscriptionRequirement'],
      toolPolicy: {} as ExecutionRecommendation['policy']['toolPolicy'],
      humanInterventionPolicy: {} as ExecutionRecommendation['policy']['humanInterventionPolicy'],
      policyVersion: 3,
      frozen: false,
    },
    taskProfile: {} as ExecutionRecommendation['taskProfile'],
    decisionId: 'dec-1',
    ...overrides,
  };
}

function handoff(overrides: Partial<CrossModeHandoffView> = {}): CrossModeHandoffView {
  return {
    id: 'h-1',
    executionId: 'wf_aaaa',
    fromMode: 'native',
    toMode: 'external',
    reason: 'native provider degraded',
    actor: 'user-1',
    source: 'execution-cross-mode-handoff-route',
    previousStatus: 'running',
    resultingStatus: 'handoff_ready',
    authorized: true,
    policyDecision: 'allowed',
    idempotencyKey: 'idem-1',
    createdAt: '2026-08-29T11:00:00Z',
    ...overrides,
  };
}

function delegationPlan(overrides: Partial<DelegationPlanView> = {}): DelegationPlanView {
  return {
    id: 'plan-1',
    workItemId: 'wi-1',
    planKey: 'default',
    status: 'active',
    createdAt: '2026-08-29T09:00:00Z',
    updatedAt: '2026-08-29T09:00:00Z',
    units: [
      {
        id: 'u-1', unitKey: 'implement', role: { roleId: 'implementer', roleRevision: 'rev-1' },
        mode: 'native', provider: 'openai', model: 'gpt-4', dependsOn: [],
        status: 'completed', attemptCount: 1, createdAt: '2026-08-29T09:00:00Z', updatedAt: '2026-08-29T09:00:00Z',
      },
      {
        id: 'u-2', unitKey: 'review', role: { roleId: 'reviewer', roleRevision: 'rev-1' },
        mode: 'external', provider: 'zai', model: null, dependsOn: ['implement'],
        status: 'pending', attemptCount: 0, createdAt: '2026-08-29T09:00:00Z', updatedAt: '2026-08-29T09:00:00Z',
      },
    ],
    ...overrides,
  };
}

function verificationRun(overrides: Partial<VerificationRun> & { id: string }): VerificationRun {
  return {
    projectId: 'p1',
    workItemId: 'wi-1',
    workOrderId: null,
    architectureVersionId: 'ver-1',
    source: 'manual',
    sourceRef: null,
    status: 'failed',
    executionId: 'wf_aaaa',
    startedAt: '2026-08-29T12:00:00Z',
    finishedAt: '2026-08-29T12:05:00Z',
    summary: null,
    errorMetadata: null,
    createdAt: '2026-08-29T12:00:00Z',
    updatedAt: '2026-08-29T12:00:00Z',
    ...overrides,
  } as VerificationRun;
}

const mergeReadiness: MergeGateResult = {
  ready: false,
  currentState: 'implementing',
  hasApprovedReview: false,
  hasActivePrAssociation: false,
  verificationSatisfied: false,
  dependenciesSatisfied: true,
  reasons: ['no approved review', 'verification not satisfied'],
};

const quietFacts: ExecutionViewFacts = {
  executions: [],
  handoff: null,
  routing: null,
  intelligence: null,
  policy: null,
  delegationPlans: [],
  verificationRuns: [],
  workflowState: null,
  mergeReadiness: null,
};

// --- the derivation -----------------------------------------------------------

describe('WORK-050 execution-view derivation (pure presentation over authoritative facts)', () => {
  it('DETERMINISM: the SAME facts always produce the SAME view (repeated refreshes remain deterministic)', () => {
    const facts: ExecutionViewFacts = {
      ...quietFacts,
      executions: [execution({ executionId: 'wf_aaaa' })],
      routing: routing(),
    };
    expect(deriveExecutionView(facts)).toEqual(deriveExecutionView(facts));
  });

  it('REFRESH CONSISTENCY: fresh facts produce the fresh view — a stale verdict cannot survive a refresh', () => {
    // First render: a running native execution.
    const stale = deriveExecutionView({
      ...quietFacts,
      executions: [execution({ executionId: 'wf_aaaa', mode: 'native', status: 'running' })],
    });
    expect(stale.currentExecution?.status).toBe('running');
    expect(stale.actuallySelected?.mode).toBe('native');
    // The SAME derivation over FRESH facts (the execution completed externally
    // after a cross-mode handoff) produces the fresh view — never cached.
    const fresh = deriveExecutionView({
      ...quietFacts,
      executions: [execution({ executionId: 'wf_aaaa', mode: 'external', status: 'completed', provider: 'zai' })],
      handoff: handoff(),
    });
    expect(fresh.currentExecution?.status).toBe('completed');
    expect(fresh.actuallySelected?.mode).toBe('external');
    expect(fresh.actuallySelected?.provider).toBe('zai');
    expect(fresh.handoff?.fromMode).toBe('native');
  });

  it('ADVERSARIAL #1/#2 — recommendation ≠ selection: with NO execution, NOTHING is selected (the recommendation stays advisory)', () => {
    const view = deriveExecutionView({
      ...quietFacts,
      routing: routing(),          // recommends zai/glm-4.6 external
      intelligence: intelligence(), // recommends zai/glm-4.6 external
    });
    // No execution record → no selection. The recommendations exist but the
    // view's actuallySelected is null — a recommendation is NOT a selection.
    expect(view.currentExecution).toBeNull();
    expect(view.actuallySelected).toBeNull();
    expect(view.routingAdvisory.recommends?.provider).toBe('zai');
    expect(view.intelligenceAdvisory.recommends?.provider).toBe('zai');
    // Nothing to compare → no "differs" claim.
    expect(view.selectionDiffersFromRoutingRecommendation).toBeNull();
  });

  it('ADVERSARIAL #1/#2/#13 — the selection shown is the RECORD\'s own identity, even when the recommendation says otherwise', () => {
    const view = deriveExecutionView({
      ...quietFacts,
      // The routing authority recommends zai/external — but the AUTHORITATIVE
      // record says openai/native (the caller dispatched differently).
      executions: [execution({ executionId: 'wf_aaaa', mode: 'native', provider: 'openai', model: 'gpt-4', status: 'completed' })],
      routing: routing(),
      intelligence: intelligence(),
    });
    // The selection is the RECORD's own identity — never the recommendation's.
    expect(view.actuallySelected).toEqual({ provider: 'openai', model: 'gpt-4', mode: 'native' });
    expect(view.routingAdvisory.recommends?.provider).toBe('zai');
    // The comparison is a presentation fact (the badge), never a substitution.
    expect(view.selectionDiffersFromRoutingRecommendation).toBe(true);
  });

  it('ADVERSARIAL #13 — provider/model identity comes from the authoritative execution record (verbatim)', () => {
    const view = deriveExecutionView({
      ...quietFacts,
      executions: [execution({ executionId: 'wf_aaaa', mode: 'external', provider: 'zai', model: 'glm-4.6', status: 'submitted' })],
    });
    expect(view.actuallySelected).toEqual({ provider: 'zai', model: 'glm-4.6', mode: 'external' });
    expect(view.currentExecution?.executionId).toBe('wf_aaaa');
  });

  it('ADVERSARIAL #3 — native and external render from the SAME model (parity: identical shape, no mode-specific derivation)', () => {
    const native = deriveExecutionView({
      ...quietFacts,
      executions: [execution({ executionId: 'wf_native', mode: 'native', provider: 'openai', status: 'running' })],
    });
    const external = deriveExecutionView({
      ...quietFacts,
      executions: [execution({ executionId: 'wf_external', mode: 'external', provider: 'zai', status: 'handoff_ready' })],
    });
    // Both derive through the SAME fields with the SAME semantics — only the
    // authority's own mode value differs.
    expect(native.actuallySelected?.mode).toBe('native');
    expect(external.actuallySelected?.mode).toBe('external');
    expect(Object.keys(native)).toEqual(Object.keys(external));
    expect(native.currentExecution?.executionId).toBe('wf_native');
    expect(external.currentExecution?.executionId).toBe('wf_external');
  });

  it('ADVERSARIAL #14 — completed/failed statuses are the authority\'s own values, verbatim (never fabricated)', () => {
    const view = deriveExecutionView({
      ...quietFacts,
      executions: [
        execution({ executionId: 'wf_failed', mode: 'native', status: 'failed' }),
        execution({ executionId: 'wf_completed', mode: 'external', status: 'completed' }),
      ],
      verificationRuns: [verificationRun({ id: 'vr-1', status: 'failed' })],
    });
    expect(view.currentExecution?.status).toBe('failed');       // the newest record's own status
    expect(view.executionHistory.map((e) => e.status)).toEqual(['failed', 'completed']);
    expect(view.verification.latestStatus).toBe('failed');       // the verification authority's own value
  });

  it('ABSENT FACTS CONTRIBUTE NOTHING: no handoff, no delegation, no verification, no recommendation is invented', () => {
    const view = deriveExecutionView({
      ...quietFacts,
      executions: [execution({ executionId: 'wf_aaaa' })],
    });
    expect(view.handoff).toBeNull();
    expect(view.delegatedUnits).toEqual([]);
    expect(view.delegatedUnitCount).toBe(0);
    expect(view.verification).toEqual({ latestStatus: null, runCount: 0, latestRunId: null });
    expect(view.routingAdvisory.recommends).toBeNull();
    expect(view.intelligenceAdvisory.recommends).toBeNull();
    expect(view.constraints.eligibleCount).toBe(0);
  });

  it('QUIET FACTS (a never-started work item): the authority\'s empty answer renders as empty — nothing fabricated', () => {
    const view = deriveExecutionView(quietFacts);
    expect(view.currentExecution).toBeNull();
    expect(view.actuallySelected).toBeNull();
    expect(view.executionHistory).toEqual([]);
    expect(view.nextAction.currentState).toBeNull();
  });

  it('the handoff is the WORK-042 log row\'s OWN values, verbatim (fromMode → toMode, reason, resulting status)', () => {
    const view = deriveExecutionView({
      ...quietFacts,
      executions: [execution({ executionId: 'wf_aaaa', mode: 'external', status: 'handoff_ready' })],
      handoff: handoff(),
    });
    expect(view.handoff).toEqual({
      fromMode: 'native',
      toMode: 'external',
      reason: 'native provider degraded',
      resultingStatus: 'handoff_ready',
      authorized: true,
      createdAt: '2026-08-29T11:00:00Z',
    });
  });

  it('the delegated units are the WORK-046 records\' OWN values, verbatim (roles, modes, statuses)', () => {
    const view = deriveExecutionView({
      ...quietFacts,
      delegationPlans: [delegationPlan()],
    });
    expect(view.delegatedUnitCount).toBe(2);
    expect(view.delegatedUnits[0]).toMatchObject({
      planKey: 'default', unitKey: 'implement', roleId: 'implementer',
      mode: 'native', provider: 'openai', status: 'completed', attemptCount: 1,
    });
    expect(view.delegatedUnits[1]).toMatchObject({
      planKey: 'default', unitKey: 'review', roleId: 'reviewer',
      mode: 'external', provider: 'zai', status: 'pending',
    });
  });

  it('the constraints are the WORK-043 policy authority\'s OWN facts, verbatim', () => {
    const view = deriveExecutionView({
      ...quietFacts,
      policy: policy(),
    });
    expect(view.constraints.eligibleCount).toBe(0);
    expect(view.constraints.excludedCount).toBe(0);
    expect(view.constraints.benchmarkMode).toBe('maximum_capability');
    expect(view.constraints.allowedModes).toEqual(['native', 'external']);
    expect(view.constraints.frozen).toBe(false);
    expect(view.constraints.headline).toBe('two providers eligible under the current policy');
  });

  it('the next action is the workflow authority\'s OWN facts (state + merge gates), never a frontend decision', () => {
    const view = deriveExecutionView({
      ...quietFacts,
      workflowState: 'implementing',
      mergeReadiness,
    });
    expect(view.nextAction.currentState).toBe('implementing');
    expect(view.nextAction.mergeReady).toBe(false);
    expect(view.nextAction.reasons).toEqual(['no approved review', 'verification not satisfied']);
  });

  it('the routing advisory carries the routing authority\'s own explanation (eligible/excluded/reason/methodology)', () => {
    const view = deriveExecutionView({
      ...quietFacts,
      routing: routing(),
    });
    expect(view.routingAdvisory.eligibleCount).toBe(2);
    expect(view.routingAdvisory.excludedCount).toBe(1);
    expect(view.routingAdvisory.rankedCount).toBe(2);
    expect(view.routingAdvisory.selectionReason).toBe('higher capability score under the current benchmark mode');
    expect(view.routingAdvisory.methodology).toBe('adaptive scoring over eligible candidates');
  });

  it('the intelligence advisory carries the WORK-047 authority\'s own provenance (headline, reasons, fallbacks, warnings)', () => {
    const view = deriveExecutionView({
      ...quietFacts,
      intelligence: intelligence({ warnings: ['signal coverage is partial'] }),
    });
    expect(view.intelligenceAdvisory.headline).toBe('highest historical success on similar tasks');
    expect(view.intelligenceAdvisory.reasons).toEqual([
      { dimension: 'capability', detail: 'glm-4.6 leads the capability signal' },
    ]);
    expect(view.intelligenceAdvisory.fallbackCount).toBe(1);
    expect(view.intelligenceAdvisory.rejectedAlternatives).toEqual([
      { provider: 'slow', model: 'x', executionMode: 'native', reason: 'latency floor' },
    ]);
    expect(view.intelligenceAdvisory.warnings).toEqual(['signal coverage is partial']);
    expect(view.intelligenceAdvisory.confidence).toBe('high');
  });

  it('when the recommendation MATCHES the record, the "differs" badge is false (the comparison is honest, not always-differs)', () => {
    const view = deriveExecutionView({
      ...quietFacts,
      executions: [execution({ executionId: 'wf_aaaa', mode: 'external', provider: 'zai', model: 'glm-4.6', status: 'running' })],
      routing: routing(),
    });
    expect(view.actuallySelected).toEqual({ provider: 'zai', model: 'glm-4.6', mode: 'external' });
    expect(view.selectionDiffersFromRoutingRecommendation).toBe(false);
  });
});
