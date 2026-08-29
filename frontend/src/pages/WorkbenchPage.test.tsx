/**
 * WORK-048 — the WorkbenchPage test suite.
 *
 * Two layers:
 *
 *  1. The established MemoryRouter smoke convention (initial synchronous
 *     render: loading state + header; tabs once the reads settle).
 *
 *  2. THE ARCHITECT'S PR #76 REVIEW CORRECTION — the discriminating
 *     failure ≠ empty regressions. Every authoritative surface can represent
 *     loading / success(data) / error, and `success([])` (the authority
 *     genuinely answered "none") is ALWAYS distinguishable from `error`
 *     (the authority could not be reached):
 *
 *        API returns []  → "No executions"
 *        API throws      → "Executions unavailable" (never "No executions")
 *
 *     …and likewise for changes, verification, reviews, deployments,
 *     activity, the work graph, the runtime status, the maintenance health,
 *     the planner recommendations, the project identity, the "what needs
 *     attention" derivation, and the workflow authority's getNextWorkItem()
 *     (a failed query must NEVER render as "No eligible next work item").
 *
 * The api client module is mocked at the NAMESPACE level (each read function
 * is a vi.fn() over the real module) so the page's real wiring — which
 * function it calls, with which arguments, and how it settles each read —
 * is what's under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastHost } from '@/components/ui/toast';
import {
  audit,
  architecture,
  maintenance,
  planning,
  projects,
  runtime,
  workflow,
  workbench,
  type Architecture,
  type ArchitectureVersion,
  type MaintenanceHealth,
  type MaintenanceSignalItem,
  type Project,
  type ProjectRuntimeStatus,
  type VerificationRun,
  type WorkGraph,
} from '@/api/client';
import WorkbenchPage from './WorkbenchPage';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return {
    ...actual,
    projects: { ...actual.projects, get: vi.fn() },
    architecture: { ...actual.architecture, listForProject: vi.fn(), listVersions: vi.fn() },
    workbench: {
      ...actual.workbench,
      getWorkGraph: vi.fn(),
      listExecutions: vi.fn(),
      listPrAssociations: vi.fn(),
      listVerificationRuns: vi.fn(),
      listReviews: vi.fn(),
    },
    runtime: { ...actual.runtime, getStatus: vi.fn(), listDeployments: vi.fn() },
    audit: { ...actual.audit, listForProject: vi.fn() },
    workflow: { ...actual.workflow, getNextWorkItem: vi.fn() },
    planning: { ...actual.planning, listRecommendations: vi.fn() },
    maintenance: { ...actual.maintenance, getHealth: vi.fn() },
  };
});

// --- fixtures -----------------------------------------------------------------

const projectId = 'wb-test-project';
const project: Project = {
  id: projectId,
  organizationId: 'org-1',
  name: 'Workbench Test Project',
  state: 'active',
};
const emptyGraph: WorkGraph = { projectId, nodes: [], edges: [] };
const runtimeStatus = {
  github: { status: 'connected' },
  vercel: { status: 'ready' },
  architect: { status: 'ready', providers: [] },
  agent: { status: 'ready', providers: [] },
} as unknown as ProjectRuntimeStatus;
const arch = { id: 'arch-1', projectId, name: 'Arch' } as unknown as Architecture;
const frozenVersion = {
  id: 'ver-1',
  architectureId: 'arch-1',
  state: 'frozen',
  contentInline: '# a',
} as unknown as ArchitectureVersion;
const maintenanceHealth: MaintenanceHealth = {
  architectureVersionId: 'ver-1',
  totalSignals: 0,
  byCategory: {},
  bySeverity: {},
  signals: [],
};

/** Every authority read succeeds with a GENUINE empty answer by default. */
function mockAllReadsEmpty(): void {
  vi.mocked(projects.get).mockResolvedValue(project);
  vi.mocked(workbench.getWorkGraph).mockResolvedValue(emptyGraph);
  vi.mocked(runtime.getStatus).mockResolvedValue(runtimeStatus);
  vi.mocked(workbench.listExecutions).mockResolvedValue([]);
  vi.mocked(workbench.listPrAssociations).mockResolvedValue([]);
  vi.mocked(workbench.listVerificationRuns).mockResolvedValue([]);
  vi.mocked(workbench.listReviews).mockResolvedValue([]);
  vi.mocked(runtime.listDeployments).mockResolvedValue([]);
  vi.mocked(audit.listForProject).mockResolvedValue([]);
  vi.mocked(workflow.getNextWorkItem).mockResolvedValue({ nextWorkItemId: null });
  vi.mocked(architecture.listForProject).mockResolvedValue([]);
  vi.mocked(architecture.listVersions).mockResolvedValue([]);
  vi.mocked(maintenance.getHealth).mockResolvedValue(maintenanceHealth);
  vi.mocked(planning.listRecommendations).mockResolvedValue([]);
}

function renderWorkbench(tab?: string): void {
  const initial =
    tab && tab !== 'overview'
      ? `/projects/${projectId}/workbench?tab=${tab}`
      : `/projects/${projectId}/workbench`;
  render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route
          path="/projects/:projectId/workbench"
          element={
            <ToastHost>
              <WorkbenchPage />
            </ToastHost>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  mockAllReadsEmpty();
});

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

// --- 1. the established smoke convention --------------------------------------

describe('WORK-048 WorkbenchPage (initial render)', () => {
  it('renders the workbench loading state (no fabricated content before data arrives)', () => {
    renderWorkbench();
    expect(screen.getByText('Workbench')).toBeInTheDocument();
    expect(screen.getByText(/Loading the workbench/i)).toBeInTheDocument();
  });

  it('renders ALL ten workbench sections as tabs (the information architecture)', async () => {
    renderWorkbench();
    await screen.findByRole('tab', { name: /Overview/i });
    for (const label of [
      'Work Graph',
      'Executions',
      'Changes',
      'Verification',
      'Reviews',
      'Deployments',
      'Health',
      'Activity',
    ]) {
      expect(screen.getByRole('tab', { name: new RegExp(label, 'i') }), `tab ${label}`).toBeInTheDocument();
    }
  });
});

// --- 2. THE REVIEW CORRECTION: failure ≠ empty, per authoritative surface ------

describe('WORK-048 failure ≠ empty (the architect\'s PR #76 review correction)', () => {
  // The rollup surfaces: a list read either succeeds (possibly with zero
  // records — a GENUINE empty) or fails (an ERROR). The two must never
  // render the same way.
  const LIST_SURFACES = [
    {
      tab: 'executions',
      emptyTitle: 'No executions',
      unavailableTestid: 'executions-unavailable',
      unavailableText: /Executions unavailable/i,
      fail: () => vi.mocked(workbench.listExecutions).mockRejectedValueOnce(new Error('Not authorized')),
    },
    {
      tab: 'changes',
      emptyTitle: 'No changes',
      unavailableTestid: 'changes-unavailable',
      unavailableText: /Changes unavailable/i,
      fail: () => vi.mocked(workbench.listPrAssociations).mockRejectedValueOnce(new Error('Not authorized')),
    },
    {
      tab: 'verification',
      emptyTitle: 'No verification runs',
      unavailableTestid: 'verification-unavailable',
      unavailableText: /Verification runs unavailable/i,
      fail: () => vi.mocked(workbench.listVerificationRuns).mockRejectedValueOnce(new Error('Not authorized')),
    },
    {
      tab: 'reviews',
      emptyTitle: 'No reviews',
      unavailableTestid: 'reviews-unavailable',
      unavailableText: /Reviews unavailable/i,
      fail: () => vi.mocked(workbench.listReviews).mockRejectedValueOnce(new Error('Not authorized')),
    },
    {
      tab: 'deployments',
      emptyTitle: 'No deployments',
      unavailableTestid: 'deployments-unavailable',
      unavailableText: /Deployments unavailable/i,
      fail: () => vi.mocked(runtime.listDeployments).mockRejectedValueOnce(new Error('Not found')),
    },
    {
      tab: 'activity',
      emptyTitle: 'No activity',
      unavailableTestid: 'activity-tab-unavailable',
      unavailableText: /Activity unavailable/i,
      fail: () => vi.mocked(audit.listForProject).mockRejectedValueOnce(new Error('Not authorized')),
    },
  ] as const;

  describe.each(LIST_SURFACES)('the $tab rollup', ({ tab, emptyTitle, unavailableTestid, unavailableText, fail }) => {
    it(`renders "${emptyTitle}" when the authority returns an EMPTY list (genuine empty, never an error)`, async () => {
      renderWorkbench(tab);
      expect(await screen.findByText(emptyTitle)).toBeInTheDocument();
      expect(screen.queryByTestId(unavailableTestid)).not.toBeInTheDocument();
    });

    it(`renders an explicit error — never "${emptyTitle}" — when the authority read FAILS`, async () => {
      fail();
      renderWorkbench(tab);
      expect(await screen.findByTestId(unavailableTestid)).toBeInTheDocument();
      expect(screen.getByText(unavailableText)).toBeInTheDocument();
      expect(screen.queryByText(emptyTitle)).not.toBeInTheDocument();
    });
  });

  // The work graph: failure is an error banner + ErrorState tabs; genuine
  // empty (the authority answered with zero nodes) is an EmptyState.
  it('the work graph: a FAILED read renders the explicit unavailable error — never "No work items"', async () => {
    vi.mocked(workbench.getWorkGraph).mockRejectedValueOnce(new Error('Not authorized'));
    renderWorkbench('work');
    // The error is rendered EXPLICITLY (the overview banner + the tab's
    // ErrorState both carry it) — and the genuine-empty state never appears.
    const explicit = await screen.findAllByText(/The work graph is unavailable for this project/i);
    expect(explicit.length).toBeGreaterThan(0);
    expect(screen.queryByText('No work items')).not.toBeInTheDocument();
  });

  it('the work graph: a successful EMPTY read renders the genuine empty state', async () => {
    renderWorkbench('work');
    expect(await screen.findByText('No work items')).toBeInTheDocument();
  });

  // The workflow authority's next-item selection: a failed query must NEVER
  // become "there is no next item".
  it('getNextWorkItem: success(null) renders "No eligible next work item" (the authority answered none)', async () => {
    renderWorkbench();
    expect(
      await screen.findByText('No eligible next work item (the workflow authority recommends none).'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('next-work-item-unavailable')).not.toBeInTheDocument();
  });

  it('getNextWorkItem: a FAILED read renders "Next work item unavailable" — never a false "none eligible"', async () => {
    vi.mocked(workflow.getNextWorkItem).mockRejectedValueOnce(new Error('Not authorized'));
    renderWorkbench();
    expect(await screen.findByTestId('next-work-item-unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Next work item unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/No eligible next work item/i)).not.toBeInTheDocument();
  });

  // The "what needs attention" derivation: with every contributing read
  // successful and quiet, "nothing needs attention" is PROVABLE; with a
  // failed contributing read it is NOT — the page must say so.
  it('attention: all reads successful + quiet → "Nothing needs attention right now." (provable)', async () => {
    renderWorkbench();
    expect(await screen.findByText('Nothing needs attention right now.')).toBeInTheDocument();
    expect(screen.queryByTestId('attention-incomplete')).not.toBeInTheDocument();
  });

  it('attention: a FAILED contributing read → "Attention assessment incomplete" — never a false all-clear', async () => {
    vi.mocked(workbench.listVerificationRuns).mockRejectedValueOnce(new Error('Not authorized'));
    renderWorkbench();
    expect(await screen.findByTestId('attention-incomplete')).toBeInTheDocument();
    expect(screen.getByText(/Attention assessment incomplete/i)).toBeInTheDocument();
    expect(screen.queryByText('Nothing needs attention right now.')).not.toBeInTheDocument();
  });

  // The runtime authority (health summary).
  it('runtime status: a FAILED read renders "Runtime status unavailable" — never a silent blank', async () => {
    vi.mocked(runtime.getStatus).mockRejectedValueOnce(new Error('Not found'));
    renderWorkbench();
    expect(await screen.findByTestId('runtime-unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Runtime status unavailable/i)).toBeInTheDocument();
  });

  // The maintenance authority (the Health tab's maintenance-work + what-next
  // cards): three DISTINCT outcomes — error (walk or read failed),
  // success(null) (no architecture version), success(health).
  it('maintenance: the architecture walk FAILING renders an error — never "No architecture version"', async () => {
    vi.mocked(architecture.listForProject).mockRejectedValueOnce(new Error('Not authorized'));
    renderWorkbench('health');
    expect(
      await screen.findByText(/Maintenance health unavailable — the architecture authority/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('No architecture version')).not.toBeInTheDocument();
  });

  it('maintenance: no architecture version (a legitimate absence) renders "No architecture version"', async () => {
    renderWorkbench('health');
    expect(await screen.findByText('No architecture version')).toBeInTheDocument();
    expect(screen.queryByTestId('maintenance-unavailable')).not.toBeInTheDocument();
  });

  it('maintenance: the health read FAILING renders an error naming the maintenance authority', async () => {
    vi.mocked(architecture.listForProject).mockResolvedValueOnce([arch]);
    vi.mocked(architecture.listVersions).mockResolvedValueOnce([frozenVersion]);
    vi.mocked(maintenance.getHealth).mockRejectedValueOnce(new Error('Not found'));
    renderWorkbench('health');
    expect(
      await screen.findByText(/Maintenance health unavailable — the maintenance authority/i),
    ).toBeInTheDocument();
  });

  // The planner authority.
  it('planner: a FAILED read renders "Planner recommendations unavailable" (explicitly, never silently empty)', async () => {
    vi.mocked(architecture.listForProject).mockResolvedValueOnce([arch]);
    vi.mocked(architecture.listVersions).mockResolvedValueOnce([frozenVersion]);
    vi.mocked(planning.listRecommendations).mockRejectedValueOnce(new Error('Not found'));
    renderWorkbench();
    expect(await screen.findByTestId('planner-unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Planner recommendations unavailable/i)).toBeInTheDocument();
  });

  it('planner: no architecture version renders "No architecture version to plan against yet." (absence ≠ empty)', async () => {
    renderWorkbench();
    expect(await screen.findByText('No architecture version to plan against yet.')).toBeInTheDocument();
  });

  // The project identity itself.
  it('project: a FAILED read renders the explicit "Project details unavailable" description', async () => {
    vi.mocked(projects.get).mockRejectedValueOnce(new Error('Not authorized'));
    renderWorkbench();
    expect(
      await screen.findByText(/Project details unavailable — the backend could not be reached/i),
    ).toBeInTheDocument();
  });
});

// --- 3. WORK-049: the Health tab (Project Health & Maintenance UX) -------------
//
// The adversarial matrix from the work order: failed health reads are DISTINCT
// from genuine empty health; missing signals are not fabricated; open
// maintenance findings remain distinguishable from actual completed Work
// Items; the all-healthy conclusion is withheld whenever a contributing read
// failed (tenant isolation's 403 topology included).
describe('WORK-049 the Health tab (failure ≠ empty; findings vs completed work; no fabricated signals)', () => {
  const signal = (overrides: Record<string, unknown> & { workItemId: string }): MaintenanceSignalItem =>
    ({
      workItemHumanId: `WI-${overrides.workItemId.slice(3, 7)}`,
      title: `title ${overrides.workItemId}`,
      objective: null,
      scope: null,
      completed: false,
      planner: {
        source: 'maintenance',
        priority: 'medium',
        rationale: 'rationale',
        whyNow: 'why now',
        expectedImpact: 'impact',
      },
      ...overrides,
    }) as MaintenanceSignalItem;

  const maintenanceSignalFixture = (workItemId: string, severity: string | null, completed = false): MaintenanceSignalItem =>
    signal({
      workItemId,
      completed,
      title: `Maintenance ${workItemId}`,
      planner: {
        source: 'maintenance',
        priority: severity ?? 'medium',
        rationale: 'rationale',
        whyNow: `why ${workItemId}`,
        expectedImpact: 'impact',
        maintenance: { category: 'ci-regression', severity: severity ?? undefined, advisoryId: 'ADV-1', affectedCount: 3, detectorSource: 'ci-evidence' },
      },
    });

  const healthWithSignals = (...signals: MaintenanceSignalItem[]): MaintenanceHealth => {
    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    for (const s of signals) {
      const cat = s.planner.maintenance?.category ?? 'unknown';
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      const sev = s.planner.maintenance?.severity ?? 'unknown';
      bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
    }
    return { architectureVersionId: 'ver-1', totalSignals: signals.length, byCategory, bySeverity, signals };
  };

  const walkSucceeds = (): void => {
    vi.mocked(architecture.listForProject).mockResolvedValue([arch]);
    vi.mocked(architecture.listVersions).mockResolvedValue([frozenVersion]);
  };

  const failedRun = (workItemId: string): VerificationRun => ({
    id: `run-${workItemId}`, projectId, workItemId, workOrderId: null, architectureVersionId: 'ver-1',
    source: 'github-ci', sourceRef: null, status: 'failed', executionId: 'exec-1',
    startedAt: null, finishedAt: null, summary: { criteriaFail: 2 }, errorMetadata: null,
    createdAt: '', updatedAt: '',
  });

  // ADVERSARIAL #2 (health): genuine empty health vs failed health reads.
  it('health findings: all reads successful + quiet → "No health findings" (provable, lightweight)', async () => {
    walkSucceeds();
    renderWorkbench('health');
    expect(await screen.findByText(/No health findings — the authorities report nothing unhealthy/i)).toBeInTheDocument();
    expect(screen.queryByTestId('health-incomplete')).not.toBeInTheDocument();
  });

  it('health findings: a FAILED contributing read → "Health assessment incomplete" — never a false all-clear', async () => {
    walkSucceeds();
    vi.mocked(workbench.listVerificationRuns).mockRejectedValueOnce(new Error('Not authorized'));
    renderWorkbench('health');
    expect(await screen.findByTestId('health-incomplete')).toBeInTheDocument();
    expect(screen.getByText(/Health assessment incomplete/i)).toBeInTheDocument();
    expect(screen.getByText(/could not be assessed: verification\./i)).toBeInTheDocument();
    expect(screen.queryByText(/No health findings — the authorities report nothing unhealthy/i)).not.toBeInTheDocument();
  });

  // ADVERSARIAL #1/#3 (tenant isolation + no fabrication): a 403 topology —
  // EVERY authority read rejected — renders ONLY errors; no finding, no
  // empty-state all-clear, and no data is ever fabricated.
  it('health findings: EVERY read rejected (the tenant-isolation 403 topology) → errors only, never "No health findings"', async () => {
    vi.mocked(projects.get).mockRejectedValueOnce(new Error('403'));
    vi.mocked(workbench.getWorkGraph).mockRejectedValueOnce(new Error('403'));
    vi.mocked(workbench.listExecutions).mockRejectedValueOnce(new Error('403'));
    vi.mocked(workbench.listVerificationRuns).mockRejectedValueOnce(new Error('403'));
    vi.mocked(runtime.getStatus).mockRejectedValueOnce(new Error('403'));
    vi.mocked(runtime.listDeployments).mockRejectedValueOnce(new Error('403'));
    vi.mocked(architecture.listForProject).mockRejectedValueOnce(new Error('403'));
    renderWorkbench('health');
    expect(await screen.findByTestId('health-incomplete')).toBeInTheDocument();
    // The gap names EVERY failed surface (no data was assessable).
    expect(screen.getByText(/could not be assessed: work graph, executions, verification, deployments, runtime, maintenance\./i)).toBeInTheDocument();
    expect(screen.queryByText(/No health findings — the authorities report nothing unhealthy/i)).not.toBeInTheDocument();
  });

  // The findings render WHAT/WHY/SEVERITY/EVIDENCE from the authorities' own
  // records — severity is the authority's own value, never computed.
  it('health findings: render from authoritative facts with the authority\'s own severity and evidence', async () => {
    walkSucceeds();
    vi.mocked(maintenance.getHealth).mockResolvedValueOnce(healthWithSignals(maintenanceSignalFixture('wi-crit', 'critical')));
    vi.mocked(workbench.listVerificationRuns).mockResolvedValueOnce([failedRun('wi-failx')]);
    renderWorkbench('health');
    // The maintenance finding (what + why + the authority's severity).
    expect(await screen.findByText('Maintenance: Maintenance wi-crit')).toBeInTheDocument();
    expect(screen.getByText(/why wi-crit · Evidence: WI-crit \(ci-regression\) · advisory ADV-1 · 3 affected · detector: ci-evidence/i)).toBeInTheDocument();
    // The failed-verification finding (the run's own status + criteria count).
    expect(screen.getByText(/Verification failed for wi-failx/i)).toBeInTheDocument();
    expect(screen.getByText(/failed 2 acceptance criteria/i)).toBeInTheDocument();
    // Severity badges are the authorities' own values.
    expect(screen.getAllByText('Critical', { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByText('Failed', { exact: true })).toBeInTheDocument();
    // No all-clear alongside real findings.
    expect(screen.queryByTestId('health-incomplete')).not.toBeInTheDocument();
    expect(screen.queryByText(/No health findings/i)).not.toBeInTheDocument();
  });

  // ADVERSARIAL #6: maintenance findings remain distinguishable from actual
  // COMPLETED Work Items — completed maintenance work is done work, never an
  // open finding (the authority's own completed flag).
  it('maintenance work: COMPLETED maintenance work is never an open finding — open and completed are visibly distinct', async () => {
    walkSucceeds();
    vi.mocked(maintenance.getHealth).mockResolvedValueOnce(
      healthWithSignals(
        maintenanceSignalFixture('wi-open', 'high'),
        maintenanceSignalFixture('wi-done', 'critical', true),
      ),
    );
    renderWorkbench('health');
    // The OPEN signal is the finding.
    expect(await screen.findByText('Maintenance: Maintenance wi-open')).toBeInTheDocument();
    expect(screen.queryByText('Maintenance: Maintenance wi-done')).not.toBeInTheDocument();
    // The completed section carries the completed record with its own badge.
    expect(screen.getByText(/Completed maintenance work \(1\) — done, not open/i)).toBeInTheDocument();
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    // What-next lists the OPEN work item as the governed path — not the
    // completed one.
    expect(screen.getByText(/The maintenance authority's Work Item — the governed path/i)).toBeInTheDocument();
  });

  it('maintenance work: genuine empty (no signals) renders "No maintenance signals" — never a fabricated finding', async () => {
    walkSucceeds();
    renderWorkbench('health');
    expect(await screen.findByText('No maintenance signals')).toBeInTheDocument();
    expect(screen.queryByTestId('maintenance-unavailable')).not.toBeInTheDocument();
  });

  // The what-next card follows the same read-state discipline.
  it('what-next: no open maintenance work + no findings → "Nothing to act on" (the lightweight state)', async () => {
    walkSucceeds();
    renderWorkbench('health');
    expect(await screen.findByText(/Nothing to act on — no open maintenance work and no health findings/i)).toBeInTheDocument();
  });

  it('what-next: a FAILED maintenance read → "Next maintenance step unavailable" — never a false "nothing to act on"', async () => {
    walkSucceeds();
    vi.mocked(maintenance.getHealth).mockRejectedValueOnce(new Error('Not found'));
    renderWorkbench('health');
    expect(await screen.findByTestId('maintenance-next-unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Next maintenance step unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to act on/i)).not.toBeInTheDocument();
  });

  // ADVERSARIAL #7: the authoritative Work Item state comes from the backend —
  // the health view only renders the authority's own completed flag (when the
  // authority says completed, the finding is gone even if the record remains).
  it('health findings: a maintenance signal whose Work Item the authority marks completed produces NO finding (the authority decides, not the view)', async () => {
    walkSucceeds();
    vi.mocked(maintenance.getHealth).mockResolvedValueOnce(
      healthWithSignals(maintenanceSignalFixture('wi-finished', 'critical', true)),
    );
    renderWorkbench('health');
    expect(await screen.findByText(/No health findings — the authorities report nothing unhealthy/i)).toBeInTheDocument();
    // …and the completed record is still visible as completed WORK.
    expect(screen.getByText(/Completed maintenance work \(1\) — done, not open/i)).toBeInTheDocument();
  });
});
