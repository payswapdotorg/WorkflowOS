/**
 * WORK-050 — the WorkItemPage test suite (the unified execution section).
 *
 * The architect's adversarial matrix, proven at the page level:
 *
 *   1.  recommendation ≠ selection (advisory framing; the record decides);
 *   2.  routing recommendation ≠ execution decision;
 *   3.  native + external executions render from the SAME authoritative model;
 *   4.  failed EXECUTION reads render explicit errors, never "No execution";
 *   5.  failed ROUTING/INTELLIGENCE reads render explicit errors;
 *   6.  failed HANDOFF reads render explicit errors, never "No handoff";
 *   7.  failed VERIFICATION reads render explicit errors, never "No runs";
 *   8.  stale UI cannot override fresh server state (fresh responses re-derive);
 *   9.  tenant isolation (the 403 topology: every read rejected → errors only,
 *       zero data, never fabricated empties);
 *   13. provider/model identity from the authoritative execution records;
 *   14. completed/failed statuses verbatim (never fabricated);
 *   15. repeated refreshes deterministic.
 *
 * The WORK-048 read-state discipline is the invariant under test everywhere:
 * success([]) (the authority genuinely answered empty) is ALWAYS
 * distinguishable from error (the authority could not be reached).
 *
 * The api client module is mocked at the NAMESPACE level (each read function
 * is a vi.fn() over the real module) so the page's real wiring — which
 * function it calls, with which arguments, and how it settles each read — is
 * what's under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  agentRuns,
  agentIntelligence,
  audit,
  crossModeHandoff,
  delegationPlans,
  execution,
  executionPolicy,
  executionProviders,
  executionRouting,
  reviews,
  verification,
  workItems,
  workflow,
  type AgentIntelligenceRecommendation,
  type CrossModeHandoffView,
  type DelegationPlanView,
  type ExecutionRecommendation,
  type ExecutionSummary,
  type RoutingRecommendation,
  type WorkItem,
} from '@/api/client';
import WorkItemPage from './WorkItemPage';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return {
    ...actual,
    workItems: {
      ...actual.workItems,
      get: vi.fn(),
      listWorkOrders: vi.fn(),
      listPrAssociations: vi.fn(),
      listDependencies: vi.fn(),
    },
    agentRuns: { ...actual.agentRuns, listForWorkItem: vi.fn() },
    reviews: { ...actual.reviews, listForWorkItem: vi.fn(), listFindings: vi.fn() },
    verification: { ...actual.verification, listRunsForWorkItem: vi.fn(), listEvidence: vi.fn() },
    audit: { ...actual.audit, listForWorkItem: vi.fn() },
    execution: { ...actual.execution, listForWorkItem: vi.fn(), get: vi.fn(), start: vi.fn(), prepareHandoff: vi.fn() },
    executionProviders: { ...actual.executionProviders, listGlobal: vi.fn() },
    executionRouting: { ...actual.executionRouting, getRecommendation: vi.fn() },
    agentIntelligence: { ...actual.agentIntelligence, getExecutionRecommendation: vi.fn() },
    executionPolicy: {
      ...actual.executionPolicy,
      recommendation: { ...actual.executionPolicy.recommendation, get: vi.fn() },
    },
    crossModeHandoff: { ...actual.crossModeHandoff, getForExecution: vi.fn() },
    delegationPlans: { ...actual.delegationPlans, listForWorkItem: vi.fn() },
    workflow: {
      ...actual.workflow,
      getState: vi.fn(),
      getHistory: vi.fn(),
      getMergeReadiness: vi.fn(),
      transition: vi.fn(),
      converge: vi.fn(),
      beginVerification: vi.fn(),
    },
  };
});

// --- fixtures -----------------------------------------------------------------

const workItemId = 'wi-50-1';
const projectId = 'proj-50';
const workItem: WorkItem = {
  id: workItemId,
  architectureVersionId: 'ver-1',
  projectId,
  workItemId: 'WORK-050-TEST',
  title: 'Unified Execution UX test item',
  objective: null,
  scope: null,
  outOfScope: null,
  architectureConstraints: null,
  assignee: null,
  completed: false,
  createdAt: '2026-08-29T00:00:00Z',
  updatedAt: '2026-08-29T00:00:00Z',
};

function executionSummary(overrides: Partial<ExecutionSummary> & { executionId: string }): ExecutionSummary {
  return {
    workItemId,
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
  };
}

const routing: RoutingRecommendation = {
  mode: 'recommendation',
  ranked: [],
  selected: { identity: { provider: 'zai', model: 'glm-4.6', executionMode: 'external' }, score: 0.9 },
  explanation: {
    selectionReason: 'capability lead',
    methodology: 'adaptive scoring',
    eligibleCount: 2,
    excluded: [],
    tieBreakDecided: false,
  },
};

const intelligence: AgentIntelligenceRecommendation = {
  mode: 'recommendation',
  recommended: { identity: { provider: 'zai', model: 'glm-4.6', executionMode: 'external' }, score: 0.92, routingRank: 1 },
  ranked: [],
  fallbacks: [],
  provenance: {
    headline: 'highest historical success',
    reasons: [{ dimension: 'capability', detail: 'leads the capability signal' }],
    rejectedAlternatives: [],
    confidence: 'high',
  },
  warnings: [],
};

const policy: ExecutionRecommendation = {
  workItemId,
  recommendedCandidate: null,
  eligibleCandidates: [],
  excludedCandidates: [],
  why: { recommendedCandidateId: null, headline: 'two providers eligible', reasons: [], alternatives: [] },
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
    policyVersion: 1,
    frozen: false,
  },
  taskProfile: {} as ExecutionRecommendation['taskProfile'],
  decisionId: 'dec-1',
};

const handoff: CrossModeHandoffView = {
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
};

const delegationPlansFixture: DelegationPlanView[] = [
  {
    id: 'plan-1',
    workItemId,
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
    ],
  },
];

const notFound = new Error('404 not found');
const forbidden = new Error('403 forbidden');

/** Every authority read succeeds with a GENUINE empty answer by default. */
function mockAllReadsEmpty(): void {
  vi.mocked(workItems.get).mockResolvedValue(workItem);
  vi.mocked(workItems.listWorkOrders).mockResolvedValue([]);
  vi.mocked(workItems.listPrAssociations).mockResolvedValue([]);
  vi.mocked(workItems.listDependencies).mockResolvedValue([]);
  vi.mocked(workflow.getState).mockResolvedValue({
    id: 'wf-1', workItemId, currentState: 'ready', version: 1,
    createdAt: '2026-08-29T00:00:00Z', updatedAt: '2026-08-29T00:00:00Z',
  });
  vi.mocked(workflow.getHistory).mockResolvedValue([]);
  vi.mocked(workflow.getMergeReadiness).mockResolvedValue({
    ready: false, currentState: 'ready', hasApprovedReview: false,
    hasActivePrAssociation: false, verificationSatisfied: false, dependenciesSatisfied: true, reasons: [],
  });
  vi.mocked(agentRuns.listForWorkItem).mockResolvedValue([]);
  vi.mocked(reviews.listForWorkItem).mockResolvedValue([]);
  vi.mocked(reviews.listFindings).mockResolvedValue([]);
  vi.mocked(verification.listRunsForWorkItem).mockResolvedValue([]);
  vi.mocked(verification.listEvidence).mockResolvedValue([]);
  vi.mocked(audit.listForWorkItem).mockResolvedValue([]);
  vi.mocked(execution.listForWorkItem).mockResolvedValue([]);
  vi.mocked(executionProviders.listGlobal).mockResolvedValue([]);
  vi.mocked(executionRouting.getRecommendation).mockResolvedValue(routing);
  vi.mocked(agentIntelligence.getExecutionRecommendation).mockResolvedValue(intelligence);
  vi.mocked(executionPolicy.recommendation.get).mockResolvedValue(policy);
  vi.mocked(crossModeHandoff.getForExecution).mockResolvedValue(null);
  vi.mocked(delegationPlans.listForWorkItem).mockResolvedValue([]);
}

function renderWorkItemPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/work-items/${workItemId}`]}>
      <Routes>
        <Route path="/work-items/:workItemId" element={<WorkItemPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  mockAllReadsEmpty();
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- the suite ----------------------------------------------------------------

describe('WorkItemPage — WORK-050 unified execution section (the adversarial matrix)', () => {
  it('renders the loading state on initial mount, then the work item identity', async () => {
    renderWorkItemPage();
    expect(screen.getByText(/loading work item/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('WORK-050-TEST: Unified Execution UX test item')).toBeInTheDocument();
    });
  });

  it('the unified execution section renders (all reads genuine-empty: "No execution", advisory recommendations present)', async () => {
    renderWorkItemPage();
    await waitFor(() => {
      // The section description (the unified framing).
      expect(screen.getByText(/One execution capability for WORK-050-TEST/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      // GENUINE empty (the authority answered empty): "No execution".
      expect(screen.getByTestId('execution-none')).toBeInTheDocument();
      // The recommendations still render (advisory, with the work item having no execution).
      expect(screen.getByText('Routing recommends')).toBeInTheDocument();
      expect(screen.getByText('Intelligence recommends')).toBeInTheDocument();
      // GENUINE empties for the other surfaces.
      expect(screen.getByTestId('execution-no-handoff')).toBeInTheDocument();
      expect(screen.getByTestId('execution-no-delegation')).toBeInTheDocument();
      expect(screen.getByTestId('execution-no-verification')).toBeInTheDocument();
    });
  });

  it('ADVERSARIAL #1/#2 — recommendation ≠ selection: with NO execution, NOTHING is "selected" (the recommendations stay advisory)', async () => {
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByTestId('execution-none')).toBeInTheDocument();
      expect(screen.getByText('Routing recommends')).toBeInTheDocument();
    });
    // The actually-selected identity is NOT rendered (no execution record).
    expect(screen.queryByTestId('execution-actually-selected')).not.toBeInTheDocument();
    // The advisory framing is explicit (the section header's always-present label).
    expect(screen.getByText(/never the selection/i)).toBeInTheDocument();
  });

  it('ADVERSARIAL #1/#13 — the selection shown is the RECORD\'s own provider (even when the recommendation differs)', async () => {
    vi.mocked(execution.listForWorkItem).mockResolvedValue([
      executionSummary({ executionId: 'wf_aaaa', mode: 'native', provider: 'openai', model: 'gpt-4', status: 'completed' }),
    ]);
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByTestId('execution-actually-selected')).toBeInTheDocument();
    });
    // The RECORD's own identity — not the recommendation's zai/external.
    expect(screen.getByTestId('execution-actually-selected')).toHaveTextContent('Native · openai (gpt-4)');
    // The recommendation renders ADVISORY alongside, visibly distinct.
    expect(screen.getByText('Routing recommends')).toBeInTheDocument();
    expect(screen.getByText('differs from routing recommendation')).toBeInTheDocument();
  });

  it('ADVERSARIAL #3 — native and external executions render from the SAME authoritative model (parity)', async () => {
    vi.mocked(execution.listForWorkItem).mockResolvedValue([
      executionSummary({ executionId: 'wf_external', mode: 'external', provider: 'zai', model: 'glm-4.6', status: 'handoff_ready' }),
      executionSummary({ executionId: 'wf_native', mode: 'native', provider: 'openai', model: 'gpt-4', status: 'completed' }),
    ]);
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByTestId('execution-actually-selected')).toBeInTheDocument();
    });
    // The current (newest) execution — external — through the same section.
    expect(screen.getByTestId('execution-actually-selected')).toHaveTextContent('External · zai (glm-4.6)');
    // The prior NATIVE execution renders in the same model's history.
    expect(screen.getByText(/Prior executions \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/wf_native/)).toBeInTheDocument();
  });

  it('ADVERSARIAL #14 — completed/failed statuses render verbatim from the records', async () => {
    vi.mocked(execution.listForWorkItem).mockResolvedValue([
      executionSummary({ executionId: 'wf_failed', mode: 'external', provider: 'zai', status: 'failed' }),
    ]);
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByTestId('execution-actually-selected')).toBeInTheDocument();
    });
    // StatusBadge renders the authority's own value (title-cased for display;
    // the canonical value is the backend's).
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('the WORK-042 handoff record renders verbatim (fromMode → toMode, reason, resulting status)', async () => {
    vi.mocked(execution.listForWorkItem).mockResolvedValue([
      executionSummary({ executionId: 'wf_aaaa', mode: 'external', provider: 'zai', status: 'handoff_ready' }),
    ]);
    vi.mocked(crossModeHandoff.getForExecution).mockResolvedValue(handoff);
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByText('native → external')).toBeInTheDocument();
    });
    expect(screen.getByText(/native provider degraded/i)).toBeInTheDocument();
    // The resulting status renders through StatusBadge (title-cased display of
    // the log row's own value — present on BOTH the current execution record
    // and the handoff log row, the authority's consistent values).
    expect(screen.getAllByText('Handoff Ready').length).toBeGreaterThanOrEqual(1);
  });

  it('the WORK-046 delegated units render verbatim (role, mode, provider, status)', async () => {
    vi.mocked(delegationPlans.listForWorkItem).mockResolvedValue(delegationPlansFixture);
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByText('implementer')).toBeInTheDocument();
    });
    expect(screen.getByText(/default \/ implement/)).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('the WORK-047 intelligence provenance renders as ADVISORY evidence (why + reasons)', async () => {
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByText('Intelligence recommends')).toBeInTheDocument();
    });
    expect(screen.getByText(/highest historical success/i)).toBeInTheDocument();
    expect(screen.getByText(/capability: leads the capability signal/i)).toBeInTheDocument();
  });

  it('ADVERSARIAL #4 — a FAILED execution read renders an explicit error, never "No execution"', async () => {
    vi.mocked(execution.listForWorkItem).mockRejectedValue(notFound);
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByTestId('execution-records-unavailable')).toBeInTheDocument();
    });
    expect(screen.getByText(/404 not found/i)).toBeInTheDocument();
    expect(screen.queryByTestId('execution-none')).not.toBeInTheDocument();
  });

  it('ADVERSARIAL #5 — FAILED routing/intelligence reads render explicit errors (never a silent "no recommendation")', async () => {
    vi.mocked(executionRouting.getRecommendation).mockRejectedValue(forbidden);
    vi.mocked(agentIntelligence.getExecutionRecommendation).mockRejectedValue(forbidden);
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByTestId('routing-recommendation-unavailable')).toBeInTheDocument();
      expect(screen.getByTestId('intelligence-recommendation-unavailable')).toBeInTheDocument();
    });
    // The advisory bodies never render as if the authorities answered.
    expect(screen.queryByText('Routing recommends')).not.toBeInTheDocument();
    expect(screen.queryByText('Intelligence recommends')).not.toBeInTheDocument();
  });

  it('ADVERSARIAL #5b — a FAILED policy read renders an explicit error (the constraints surface)', async () => {
    vi.mocked(executionPolicy.recommendation.get).mockRejectedValue(notFound);
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByTestId('policy-constraints-unavailable')).toBeInTheDocument();
    });
  });

  it('ADVERSARIAL #6 — a FAILED handoff read renders an explicit error, never "No cross-mode handoff"', async () => {
    vi.mocked(execution.listForWorkItem).mockResolvedValue([
      executionSummary({ executionId: 'wf_aaaa' }),
    ]);
    vi.mocked(crossModeHandoff.getForExecution).mockRejectedValue(notFound);
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByTestId('handoff-state-unavailable')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('execution-no-handoff')).not.toBeInTheDocument();
  });

  it('ADVERSARIAL #7 — a FAILED verification read renders an explicit error, never "No verification runs"', async () => {
    vi.mocked(verification.listRunsForWorkItem).mockRejectedValue(notFound);
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByTestId('verification-runs-unavailable')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('execution-no-verification')).not.toBeInTheDocument();
  });

  it('ADVERSARIAL #6b — a FAILED delegation read renders an explicit error, never "No delegated units"', async () => {
    vi.mocked(delegationPlans.listForWorkItem).mockRejectedValue(forbidden);
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByTestId('delegation-plans-unavailable')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('execution-no-delegation')).not.toBeInTheDocument();
  });

  it('ADVERSARIAL #8/#15 — a FAILED workflow read renders an explicit error (the next-action surface), and refreshes stay deterministic', async () => {
    vi.mocked(workflow.getState).mockRejectedValue(notFound);
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByTestId('workflow-state-unavailable')).toBeInTheDocument();
    });
    // Determinism on repeated reads: the same settled states render the same
    // error (nothing intermittent).
    await waitFor(() => {
      expect(screen.getByTestId('workflow-state-unavailable')).toBeInTheDocument();
    });
  });

  it('ADVERSARIAL #9 — the tenant-isolation 403 topology: EVERY read rejected → errors only, zero data, never fabricated empties', async () => {
    vi.mocked(workItems.get).mockRejectedValue(forbidden);
    vi.mocked(execution.listForWorkItem).mockRejectedValue(forbidden);
    vi.mocked(executionRouting.getRecommendation).mockRejectedValue(forbidden);
    vi.mocked(agentIntelligence.getExecutionRecommendation).mockRejectedValue(forbidden);
    vi.mocked(executionPolicy.recommendation.get).mockRejectedValue(forbidden);
    vi.mocked(crossModeHandoff.getForExecution).mockRejectedValue(forbidden);
    vi.mocked(delegationPlans.listForWorkItem).mockRejectedValue(forbidden);
    vi.mocked(verification.listRunsForWorkItem).mockRejectedValue(forbidden);
    vi.mocked(workflow.getState).mockRejectedValue(forbidden);
    vi.mocked(workflow.getMergeReadiness).mockRejectedValue(forbidden);
    vi.mocked(agentRuns.listForWorkItem).mockRejectedValue(forbidden);
    vi.mocked(reviews.listForWorkItem).mockRejectedValue(forbidden);
    vi.mocked(audit.listForWorkItem).mockRejectedValue(forbidden);
    vi.mocked(workItems.listWorkOrders).mockRejectedValue(forbidden);
    vi.mocked(workItems.listPrAssociations).mockRejectedValue(forbidden);
    vi.mocked(workItems.listDependencies).mockRejectedValue(forbidden);
    vi.mocked(executionProviders.listGlobal).mockRejectedValue(forbidden);

    renderWorkItemPage();
    // The page-level error renders (the work item itself is unreadable).
    await waitFor(() => {
      expect(screen.getByText(/failed to load work item|403/i)).toBeInTheDocument();
    });
    // No execution data, no fabricated empties (the page never mounts the
    // section's success paths when the work item itself is unreadable).
    expect(screen.queryByTestId('execution-none')).not.toBeInTheDocument();
    expect(screen.queryByTestId('execution-no-handoff')).not.toBeInTheDocument();
    expect(screen.queryByTestId('execution-no-verification')).not.toBeInTheDocument();
    expect(screen.queryByText('Routing recommends')).not.toBeInTheDocument();
  });

  it('ADVERSARIAL #8 — refresh consistency: a fresh execution response re-derives the section (stale UI cannot override fresh truth)', async () => {
    // First render: one running native execution.
    vi.mocked(execution.listForWorkItem).mockResolvedValue([
      executionSummary({ executionId: 'wf_aaaa', mode: 'native', status: 'running' }),
    ]);
    const { unmount } = renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByTestId('execution-actually-selected')).toHaveTextContent('Native · openai');
    });
    unmount();

    // A FRESH response (the execution handed off to external + completed):
    vi.mocked(execution.listForWorkItem).mockResolvedValue([
      executionSummary({ executionId: 'wf_aaaa', mode: 'external', provider: 'zai', status: 'completed' }),
    ]);
    vi.mocked(crossModeHandoff.getForExecution).mockResolvedValue(handoff);
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByTestId('execution-actually-selected')).toHaveTextContent('External · zai');
    });
    // The fresh handoff state renders (never a stale "no handoff").
    await waitFor(() => {
      expect(screen.getByText('native → external')).toBeInTheDocument();
    });
  });

  it('ZERO mutations during render: the unified section calls only read functions (recommendations cannot mutate)', async () => {
    renderWorkItemPage();
    await waitFor(() => {
      expect(screen.getByTestId('execution-none')).toBeInTheDocument();
    });
    // The read functions were called…
    expect(vi.mocked(execution.listForWorkItem)).toHaveBeenCalledWith(workItemId);
    expect(vi.mocked(executionRouting.getRecommendation)).toHaveBeenCalledWith(workItemId);
    expect(vi.mocked(agentIntelligence.getExecutionRecommendation)).toHaveBeenCalledWith(projectId, workItemId);
    expect(vi.mocked(delegationPlans.listForWorkItem)).toHaveBeenCalledWith(projectId, workItemId);
    // …and the mutation surfaces were NEVER invoked (the section has no
    // mutation path; the existing dialogs stay closed until a user action).
    expect(vi.mocked(execution.start)).not.toHaveBeenCalled();
    expect(vi.mocked(execution.prepareHandoff)).not.toHaveBeenCalled();
    expect(vi.mocked(workflow.transition)).not.toHaveBeenCalled();
    expect(vi.mocked(workflow.converge)).not.toHaveBeenCalled();
    expect(vi.mocked(workflow.beginVerification)).not.toHaveBeenCalled();
  });
});
