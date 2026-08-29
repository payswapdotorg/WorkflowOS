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
  type Project,
  type ProjectRuntimeStatus,
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
      'Maintenance',
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

  // The maintenance authority: three DISTINCT outcomes —
  // error (walk or read failed), success(null) (no architecture version),
  // success(health) (the authority assessed the version).
  it('maintenance: the architecture walk FAILING renders an error — never "No architecture version"', async () => {
    vi.mocked(architecture.listForProject).mockRejectedValueOnce(new Error('Not authorized'));
    renderWorkbench('maintenance');
    expect(
      await screen.findByText(/Maintenance health unavailable — the architecture authority/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('No architecture version')).not.toBeInTheDocument();
  });

  it('maintenance: no architecture version (a legitimate absence) renders "No architecture version"', async () => {
    renderWorkbench('maintenance');
    expect(await screen.findByText('No architecture version')).toBeInTheDocument();
    expect(screen.queryByTestId('maintenance-unavailable')).not.toBeInTheDocument();
  });

  it('maintenance: the health read FAILING renders an error naming the maintenance authority', async () => {
    vi.mocked(architecture.listForProject).mockResolvedValueOnce([arch]);
    vi.mocked(architecture.listVersions).mockResolvedValueOnce([frozenVersion]);
    vi.mocked(maintenance.getHealth).mockRejectedValueOnce(new Error('Not found'));
    renderWorkbench('maintenance');
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
