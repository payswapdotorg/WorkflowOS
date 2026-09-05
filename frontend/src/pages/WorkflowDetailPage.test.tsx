/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import WorkflowDetailPage from './WorkflowDetailPage';

/**
 * V2-017 T4 — the workflow detail contract (Issue #190 dispatch).
 *
 * The detail page composes over EXISTING authorities: the V2-002 workflow
 * read, the version read (immutable versions), the V2-005 runs read, the
 * installations read, and the workflow-deployments reads. HONESTY RULES:
 *   - loading / error / data states explicitly; a failed read is never a
 *     successful empty;
 *   - F-T4-001: step labels derive ONLY from the authoritative V2-003
 *     presentation layer (`presentation.nodeLabels`, nodeId → label, at
 *     the document top level) — internal WorkflowNode IDs NEVER surface
 *     in the primary consumer detail UX (neither raw nor humanized); when
 *     any node lacks a usable presentation label, the whole steps surface
 *     FAILS CLOSED to the honest steps-unavailable state (never a partial
 *     list, never the internal ID); non-IR content → the same honest
 *     unavailable state;
 *   - the primary actions (Run / Teach Me / Edit) are communicated; their
 *     deep flows belong to later tasks — Run/Teach Me carry honest
 *     arrives-with notes; Edit enters the EXISTING expert workspace;
 *   - the pinned installation version is shown verbatim; no update is
 *     implied before an authoritative action;
 *   - digests/internal IDs stay expert-only (never rendered).
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = () => Response | Promise<Response>;

function mockApi(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
  const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    for (const [fragment, handler] of ordered) {
      if (url.includes(fragment)) return Promise.resolve(handler());
    }
    return Promise.resolve(jsonResponse(500, { error: `unmocked ${url}` }));
  });
}

const WORKFLOW = {
  id: 'wf-1',
  organizationId: 'org-1',
  ownerUserId: 'user-1',
  slug: 'weekly-invoice-digest',
  name: 'Weekly invoice digest',
  description: 'Collect invoices and email the digest.',
  visibility: 'private',
  headVersionId: 'ver-2',
  forkedFromWorkflowId: null,
  forkedFromVersionId: null,
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-04T09:00:00Z',
};

const IR_CONTENT = {
  objectType: 'workflowos/workflow-ir/v1',
  irSchemaVersion: 1,
  ir: {
    start: 'fetch_open_tickets',
    nodes: [
      {
        id: 'fetch_open_tickets',
        executionClass: 'deterministic_api',
        spec: { class: 'deterministic_api', capability: 'github.repository.read' },
        capabilityRequirements: ['github.repository.read'],
        placement: 'cloud_allowed',
      },
      {
        id: 'send_followup',
        executionClass: 'agentic_computer_use',
        spec: { class: 'agentic_computer_use', capability: 'messaging.send' },
        capabilityRequirements: ['messaging.send'],
        placement: 'cloud_allowed',
      },
    ],
    edges: [],
    defaultPlacement: 'cloud_allowed',
  },
  // The V2-003 presentation layer — the ONLY source of consumer-facing
  // step labels (F-T4-001). Internal node IDs are keys, never values.
  presentation: {
    title: 'Weekly invoice digest',
    nodeLabels: {
      fetch_open_tickets: 'Collect the open tickets',
      send_followup: 'Email the weekly digest',
    },
  },
};

const VERSIONS = [
  {
    id: 'ver-1',
    workflowId: 'wf-1',
    versionNumber: 1,
    contentDigest: 'sha256:old',
    content: IR_CONTENT,
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    parentVersionId: null,
    createdByUserId: 'user-1',
    createdAt: '2026-09-01T10:00:00Z',
  },
  {
    id: 'ver-2',
    workflowId: 'wf-1',
    versionNumber: 2,
    contentDigest: 'sha256:new',
    content: IR_CONTENT,
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    parentVersionId: 'ver-1',
    createdByUserId: 'user-1',
    createdAt: '2026-09-04T09:00:00Z',
  },
];

const RUNS = [
  {
    id: 'run-1',
    organizationId: 'org-1',
    workflowId: 'wf-1',
    versionId: 'ver-2',
    state: 'failed',
    createdAt: '2026-09-04T08:00:00Z',
    updatedAt: '2026-09-04T08:30:00Z',
  },
  {
    id: 'run-2',
    organizationId: 'org-1',
    workflowId: 'wf-1',
    versionId: 'ver-2',
    state: 'completed',
    createdAt: '2026-09-03T08:00:00Z',
    updatedAt: '2026-09-03T09:00:00Z',
  },
];

const INSTALLATIONS = [
  {
    installation: {
      id: 'inst-1',
      organizationId: 'org-1',
      workflowId: 'wf-1',
      versionId: 'ver-2',
      installedByUserId: 'user-1',
      status: 'enabled',
      installedAt: '2026-09-02T09:00:00Z',
      updatedAt: '2026-09-02T09:00:00Z',
    },
    pinnedVersion: {
      id: 'ver-2',
      workflowId: 'wf-1',
      versionNumber: 2,
      contentDigest: 'sha256:new',
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    },
  },
];

const DEPLOYMENTS = [
  {
    id: 'dep-1',
    organizationId: 'org-1',
    workflowId: 'wf-1',
    versionId: 'ver-2',
    installationId: 'inst-1',
    name: 'Weekly invoice digest',
    description: null,
    placement: { placement: { required: 'cloud_allowed' }, privacy: { localOnly: false } },
    enabled: true,
    enabledAt: '2026-09-02T11:00:00Z',
    disabledAt: null,
    createdByUserId: 'user-1',
    createdAt: '2026-09-02T11:00:00Z',
    updatedAt: '2026-09-02T11:00:00Z',
  },
];

const SUBSCRIPTIONS = [
  {
    id: 'sub-1',
    organizationId: 'org-1',
    deploymentId: 'dep-1',
    kind: 'schedule',
    schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' },
    eventPattern: null,
    deliveryPolicy: { missedWindow: 'skip' },
    enabled: true,
    cursor: null,
    createdAt: '2026-09-02T11:00:00Z',
    updatedAt: '2026-09-02T11:00:00Z',
  },
];

// The organization's workflows (V2-002 read) — the name source for the
// "After another workflow" When language (T8).
const ORG_WORKFLOWS = [
  WORKFLOW,
  {
    id: 'wf-2',
    organizationId: 'org-1',
    ownerUserId: 'user-1',
    slug: 'expense-sweep',
    name: 'Expense sweep',
    description: 'Sweep the weekly expenses.',
    visibility: 'private',
    headVersionId: 'ver-9',
    forkedFromWorkflowId: null,
    forkedFromVersionId: null,
    createdAt: '2026-09-01T11:00:00Z',
    updatedAt: '2026-09-04T09:00:00Z',
  },
];

function fullRoutes(overrides: Record<string, RouteHandler> = {}): Record<string, RouteHandler> {
  return {
    '/workflow-repository/workflows/wf-1/versions': () => jsonResponse(200, { versions: VERSIONS }),
    '/workflow-runs/runs': () => jsonResponse(200, { runs: RUNS }),
    '/workflow-repository/installations': () => jsonResponse(200, { installations: INSTALLATIONS }),
    '/workflow-deployments/deployments': () => jsonResponse(200, { deployments: DEPLOYMENTS }),
    '/workflow-deployments/deployments/dep-1/subscriptions': () =>
      jsonResponse(200, { subscriptions: SUBSCRIPTIONS }),
    '/workflow-repository/workflows': () => jsonResponse(200, { workflows: ORG_WORKFLOWS }),
    '/workflow-repository/workflows/wf-1': () => jsonResponse(200, { workflow: WORKFLOW }),
    ...overrides,
  };
}

function renderDetail(workflowId: string, routes: Record<string, RouteHandler>) {
  vi.stubGlobal('fetch', mockApi(routes));
  return render(
    <MemoryRouter initialEntries={[`/workflows/${workflowId}`]}>
      <Routes>
        <Route path="/workflows/:workflowId" element={<WorkflowDetailPage />} />
        <Route path="/expert" element={<div>Expert workspace</div>} />
        <Route path="/workflows" element={<div>Workflows library</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('V2-017 T4 — workflow detail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('communicates the purpose, primary actions, state, version, when/where, activity, access, and inspection entry', async () => {
    renderDetail('wf-1', fullRoutes());
    // Purpose.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
    );
    expect(screen.getByText('Collect invoices and email the digest.')).toBeInTheDocument();
    // Primary actions (the row communicates Run / Teach Me / Edit).
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Teach Me' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit' })).toBeInTheDocument();
    // Attention state (run-derived: a failed run exists).
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    // Steps (F-T4-001): labels come ONLY from the authoritative V2-003
    // presentation layer (nodeLabels), in the authoritative node order.
    const steps = screen.getByRole('list', { name: /what it does/i });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Collect the open tickets',
      'Email the weekly digest',
    ]);
    // Internal node IDs NEVER surface in the primary consumer detail UX —
    // neither raw nor humanized (F-T4-001).
    expect(screen.queryByText(/fetch_open_tickets/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fetch open tickets/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/send_followup/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/send followup/i)).not.toBeInTheDocument();
    // When it runs (T8: the human When language over the subscription
    // facts) and where (placement).
    expect(screen.getByText('Runs every day · 9:00 AM UTC')).toBeInTheDocument();
    expect(screen.getByText('Runs when you start it')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.getByText('Cloud')).toBeInTheDocument();
    // The canonical vocabulary and identifiers stay out of the primary
    // When language (progressive disclosure).
    expect(screen.queryByText(/sub-1/)).not.toBeInTheDocument();
    // Recent activity (the authoritative runs, most recent first).
    const activity = screen.getByRole('list', { name: /recent activity/i });
    const items = within(activity).getAllByRole('listitem');
    expect(items.length).toBe(2);
    expect(within(items[0]).getByText('failed')).toBeInTheDocument();
    // Version facts: the head version is immutable; the installed pin is
    // shown verbatim (never implying an update).
    expect(screen.getByText('Version 2 — immutable')).toBeInTheDocument();
    expect(screen.getByText(/Installed: Version 2 — pinned · Enabled/)).toBeInTheDocument();
    // Access ("Needs access to" — capabilities from the IR).
    expect(screen.getByText(/Needs access to/i)).toBeInTheDocument();
    expect(screen.getByText(/github\.repository\.read/i)).toBeInTheDocument();
    expect(screen.getByText(/messaging\.send/i)).toBeInTheDocument();
    // Safety/visibility vocabulary.
    expect(screen.getByText(/Private — only you/i)).toBeInTheDocument();
    // Advanced inspection entry (the existing expert workspace).
    expect(screen.getByRole('link', { name: /inspect in the expert workspace/i })).toHaveAttribute(
      'href',
      '/expert',
    );
    // Internal digests NEVER render.
    expect(screen.queryByText(/sha256/i)).not.toBeInTheDocument();
  });

  it('shows a loading state while the reads are in flight', async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    renderDetail('wf-1', {
      '/workflow-repository/workflows/wf-1': () => gate,
      '/workflow-repository/workflows/wf-1/versions': () =>
        jsonResponse(200, { versions: VERSIONS }),
      '/workflow-runs/runs': () => jsonResponse(200, { runs: [] }),
      '/workflow-repository/installations': () => jsonResponse(200, { installations: [] }),
      '/workflow-deployments/deployments': () => jsonResponse(200, { deployments: [] }),
    });
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    release(jsonResponse(200, { workflow: WORKFLOW }));
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument(),
    );
  });

  it('renders a visible error (never empty) when the workflow read fails', async () => {
    renderDetail('wf-1', fullRoutes({
      '/workflow-repository/workflows/wf-1': () => jsonResponse(404, { error: 'workflow-not-found' }),
    }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Weekly invoice digest' })).not.toBeInTheDocument();
  });

  it('shows the honest steps-unavailable state when the version content is not WorkflowIR', async () => {
    renderDetail(
      'wf-1',
      fullRoutes({
        '/workflow-repository/workflows/wf-1/versions': () =>
          jsonResponse(200, {
            versions: [{ ...VERSIONS[1], content: { someOpaque: 'not-ir' } }],
          }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/steps aren't available in a human-readable form yet/i),
    ).toBeInTheDocument();
    // No invented steps.
    expect(screen.queryByRole('list', { name: /what it does/i })).not.toBeInTheDocument();
  });

  it('F-T4-001: no presentation nodeLabels → the honest steps-unavailable state; internal node IDs never surface', async () => {
    // A WorkflowIR document WITHOUT the presentation layer: the page must
    // fail closed (the honest unavailable state) — it must NOT fall back to
    // the internal node IDs (raw or humanized) as step names.
    const noPresentation = { ...IR_CONTENT, presentation: undefined };
    renderDetail(
      'wf-1',
      fullRoutes({
        '/workflow-repository/workflows/wf-1/versions': () =>
          jsonResponse(200, { versions: [{ ...VERSIONS[1], content: noPresentation }] }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/steps aren't available in a human-readable form yet/i),
    ).toBeInTheDocument();
    // No invented steps, and the internal node IDs never surface.
    expect(screen.queryByRole('list', { name: /what it does/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/fetch_open_tickets/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fetch open tickets/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/send_followup/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/send followup/i)).not.toBeInTheDocument();
  });

  it('F-T4-001: a partial nodeLabels map fails closed — never a partial list, never node IDs', async () => {
    // One node labeled, one unlabeled: the whole steps surface fails closed
    // (a partial step list would misrepresent the workflow; the unlabeled
    // node must never leak its internal ID).
    const partial = {
      ...IR_CONTENT,
      presentation: { nodeLabels: { fetch_open_tickets: 'Collect the open tickets' } },
    };
    renderDetail(
      'wf-1',
      fullRoutes({
        '/workflow-repository/workflows/wf-1/versions': () =>
          jsonResponse(200, { versions: [{ ...VERSIONS[1], content: partial }] }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/steps aren't available in a human-readable form yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /what it does/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/send_followup/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/send followup/i)).not.toBeInTheDocument();
  });

  it('F-T4-001: a whitespace-only label is not a usable label — the surface fails closed', async () => {
    const blank = {
      ...IR_CONTENT,
      presentation: {
        nodeLabels: { fetch_open_tickets: '   ', send_followup: 'Email the weekly digest' },
      },
    };
    renderDetail(
      'wf-1',
      fullRoutes({
        '/workflow-repository/workflows/wf-1/versions': () =>
          jsonResponse(200, { versions: [{ ...VERSIONS[1], content: blank }] }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/steps aren't available in a human-readable form yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /what it does/i })).not.toBeInTheDocument();
  });

  it('Teach Me carries its honest arrives-with state; Edit enters the expert workspace (Run is owned by the T6 run experience)', async () => {
    renderDetail('wf-1', fullRoutes());
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Teach Me' }));
    expect(screen.getByText(/teaching experience arrives with the teaching task/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/expert');
  });

  it('when no subscription exists the honest manual fact renders; no deployment → honest no-where fact', async () => {
    renderDetail(
      'wf-1',
      fullRoutes({
        '/workflow-deployments/deployments': () => jsonResponse(200, { deployments: [] }),
        '/workflow-repository/installations': () => jsonResponse(200, { installations: [] }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
    );
    expect(screen.getByText('Runs when you start it')).toBeInTheDocument();
    expect(screen.getByText(/not deployed yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No installs/i)).toBeInTheDocument();
  });
});
