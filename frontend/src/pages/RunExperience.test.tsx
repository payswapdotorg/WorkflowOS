/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import WorkflowDetailPage from './WorkflowDetailPage';

/**
 * V2-017 T6 — the run experience contract (Issue #193 dispatch).
 *
 * The run experience composes over the EXISTING authorities only:
 *   - the preview's steps come from the V2-003 presentation layer
 *     (nodeLabels — the F-T4-001 rule; internal node IDs never render);
 *   - the "Approval required" fact comes from the version's IR approval
 *     nodes (spec.human.kind === 'approval' — the consent boundary);
 *   - "Needs access to" stays the canonical capability language, kept
 *     SEPARATE from consent (approval) and authorization (the backend's
 *     typed command decisions);
 *   - the where-it-runs options + availability reasons derive from the
 *     workflow-deployments placement policy (V2-004's consumed facts);
 *   - the Run command preserves the authoritative semantics: the real
 *     POST /organizations/:org/workflow-runs/runs request (the command
 *     envelope + the manual trigger) followed by the real start command —
 *     no parallel run model, no invented success;
 *   - the status states use the human vocabulary (UX spec §15) derived
 *     ONLY from authoritative facts: Ready (requested) / Running /
 *     Waiting for you (paused at an approval step — history-derived) /
 *     Paused / Completed / Couldn't complete (failed) / Cancelled, with
 *     Needs attention (the T2/T4 badge) and the honest Unavailable
 *     surface when the run-detail read fails;
 *   - internal run-state terminology appears ONLY in Advanced details
 *     (progressive disclosure).
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = () => Response | Promise<Response>;

function mockApi(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
  // Keys may carry a method prefix ('POST /path'); the longest fragment
  // wins, and a method-prefixed key matches only that HTTP verb.
  const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const [key, handler] of ordered) {
      const methodPrefix = /^([A-Z]+) (.*)$/.exec(key);
      if (methodPrefix) {
        if (methodPrefix[1] === method && url.includes(methodPrefix[2])) {
          return Promise.resolve(handler());
        }
        continue;
      }
      if (url.includes(key)) return Promise.resolve(handler());
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

/** The IR content: three nodes INCLUDING an approval (human) node. */
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
        id: 'review_gate',
        executionClass: 'human',
        spec: {
          class: 'human',
          human: { kind: 'approval', instruction: 'Approve the digest before it is sent.' },
        },
        capabilityRequirements: [],
        placement: 'cloud_allowed',
      },
      {
        id: 'send_followup',
        executionClass: 'deterministic_api',
        spec: { class: 'deterministic_api', capability: 'messaging.send' },
        capabilityRequirements: ['messaging.send'],
        placement: 'cloud_allowed',
      },
    ],
    edges: [],
    defaultPlacement: 'cloud_allowed',
  },
  presentation: {
    title: 'Weekly invoice digest',
    nodeLabels: {
      fetch_open_tickets: 'Collect the open tickets',
      review_gate: 'Your approval before sending',
      send_followup: 'Email the weekly digest',
    },
  },
};

/** The IR content WITHOUT an approval node (the no-approval-line case). */
const IR_CONTENT_NO_APPROVAL = {
  ...IR_CONTENT,
  ir: {
    ...IR_CONTENT.ir,
    nodes: IR_CONTENT.ir.nodes.filter((n) => n.id !== 'review_gate'),
  },
  presentation: {
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

/** Cloud placement (the default where-facts fixture). */
const DEPLOYMENTS_CLOUD = [
  {
    id: 'dep-1',
    organizationId: 'org-1',
    workflowId: 'wf-1',
    versionId: 'ver-2',
    installationId: 'inst-1',
    name: 'Weekly invoice digest',
    description: null,
    placement: { placement: { required: 'cloud_preferred' }, privacy: { localOnly: false } },
    enabled: true,
    enabledAt: '2026-09-02T11:00:00Z',
    disabledAt: null,
    createdByUserId: 'user-1',
    createdAt: '2026-09-02T11:00:00Z',
    updatedAt: '2026-09-02T11:00:00Z',
  },
];

/** Device-only placement (privacy: local). */
const DEPLOYMENTS_DEVICE = [
  {
    ...DEPLOYMENTS_CLOUD[0],
    placement: { placement: { required: 'device_local' }, privacy: { localOnly: true } },
  },
];

const SUBSCRIPTIONS: unknown[] = [];

/** A run row factory. */
function run(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'run-3',
    organizationId: 'org-1',
    workflowId: 'wf-1',
    versionId: 'ver-2',
    installationId: 'inst-1',
    trigger: { type: 'manual', id: 'trigger-abc' },
    triggeredByUserId: 'user-1',
    inputCommitments: [],
    inputDigest: 'sha256:inputs',
    state: 'running',
    createdAt: '2026-09-04T08:00:00Z',
    updatedAt: '2026-09-04T08:30:00Z',
    ...overrides,
  };
}

/** The history fixture: the pause timeline entries per test. */
function history(timeline: Array<Record<string, unknown>>) {
  return {
    run: run({}),
    timeline,
    attempts: [],
    steps: [],
    invocations: [],
    evidence: [],
    attestations: [],
    attestationRejections: [],
    commands: [],
  };
}

const PAUSED_AT_REVIEW = history([
  {
    id: 'tl-1',
    runId: 'run-3',
    attemptNumber: 1,
    stepId: null,
    eventName: 'workflow.run.started',
    occurredAt: '2026-09-04T08:00:10Z',
    sequence: 1,
    detail: null,
  },
  {
    id: 'tl-2',
    runId: 'run-3',
    attemptNumber: 1,
    stepId: null,
    eventName: 'workflow.run.paused',
    occurredAt: '2026-09-04T08:10:00Z',
    sequence: 2,
    // The authoritative wire shape: the pause point rides detail.atStepId.
    detail: { atStepId: 'review_gate' },
  },
]);

const PAUSED_AT_SEND = history([
  {
    id: 'tl-2',
    runId: 'run-3',
    attemptNumber: 1,
    stepId: null,
    eventName: 'workflow.run.paused',
    occurredAt: '2026-09-04T08:10:00Z',
    sequence: 2,
    detail: { atStepId: 'send_followup' },
  },
]);

/** The full route set (overrides win). */
function fullRoutes(overrides: Record<string, RouteHandler> = {}): Record<string, RouteHandler> {
  return {
    // REALITY-REPAIR-003 (F-003): the caller's organizations (the
    // product-shell selection the detail page composes).
    '/organizations': () =>
      jsonResponse(200, {
        organizations: [{ id: 'org-1', name: 'Bay Logistics', roleId: 'owner' }],
      }),
    '/workflow-repository/workflows/wf-1/versions': () => jsonResponse(200, { versions: VERSIONS }),
    '/organizations/org-1/workflow-runs/runs': () => jsonResponse(200, { runs: [] }),
    '/workflow-repository/installations': () => jsonResponse(200, { installations: INSTALLATIONS }),
    '/workflow-deployments/deployments': () => jsonResponse(200, { deployments: DEPLOYMENTS_CLOUD }),
    '/workflow-deployments/deployments/dep-1/subscriptions': () =>
      jsonResponse(200, { subscriptions: SUBSCRIPTIONS }),
    // T8: the detail page's org-workflow read (the When name source).
    '/workflow-repository/workflows': () => jsonResponse(200, { workflows: [WORKFLOW] }),
    '/workflow-repository/workflows/wf-1': () => jsonResponse(200, { workflow: WORKFLOW }),
    ...overrides,
  };
}

function renderDetail(routes: Record<string, RouteHandler>, initialEntry = '/workflows/wf-1') {
  vi.stubGlobal('fetch', mockApi(routes));
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/workflows/:workflowId" element={<WorkflowDetailPage />} />
        <Route path="/expert" element={<div>Expert workspace</div>} />
        <Route path="/workflows" element={<div>Workflows library</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openPreview(routes: Record<string, RouteHandler>) {
  renderDetail(routes);
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Run' }));
  await waitFor(() =>
    expect(screen.getByRole('region', { name: 'Run preview' })).toBeInTheDocument(),
  );
  return user;
}

describe('V2-017 T6 — the run experience', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('the consequential-action preview', () => {
    it('shows the steps, version, approval, where-it-runs and access facts; Cancel dismisses', async () => {
      await openPreview(fullRoutes());
      const preview = screen.getByRole('region', { name: 'Run preview' });
      // The consequential action, named.
      expect(within(preview).getByText('Run Weekly invoice digest?')).toBeInTheDocument();
      // The steps from the authoritative presentation layer, in order.
      const steps = within(preview).getByRole('list', { name: 'This will' });
      expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
        'Collect the open tickets',
        'Your approval before sending',
        'Email the weekly digest',
      ]);
      // Internal node IDs never render (F-T4-001 carries over).
      expect(screen.queryByText(/review_gate/i)).not.toBeInTheDocument();
      // The version fact.
      expect(within(preview).getByText(/Version 2/i)).toBeInTheDocument();
      // The approval (consent) fact — the IR declares an approval node.
      expect(within(preview).getByText(/Approval required/i)).toBeInTheDocument();
      // The canonical capability language (kept separate from consent).
      expect(within(preview).getByText(/Needs access to/i)).toBeInTheDocument();
      expect(within(preview).getByText(/github\.repository\.read/i)).toBeInTheDocument();
      expect(within(preview).getByText(/messaging\.send/i)).toBeInTheDocument();
      // Cancel dismisses without any command.
      const user = userEvent.setup();
      await user.click(within(preview).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('region', { name: 'Run preview' })).not.toBeInTheDocument();
    });

    it('no approval node → no approval line (never a fabricated approval requirement)', async () => {
      await openPreview(
        fullRoutes({
          '/workflow-repository/workflows/wf-1/versions': () =>
            jsonResponse(200, {
              versions: [
                { ...VERSIONS[0], content: IR_CONTENT_NO_APPROVAL },
                { ...VERSIONS[1], content: IR_CONTENT_NO_APPROVAL },
              ],
            }),
        }),
      );
      const preview = screen.getByRole('region', { name: 'Run preview' });
      expect(within(preview).queryByText(/Approval required/i)).not.toBeInTheDocument();
    });
  });

  describe('where it runs (placement facts + explicit reasons)', () => {
    it('cloud placement: Cloud available; This device not available with the explicit reason', async () => {
      await openPreview(fullRoutes());
      const where = screen.getByRole('list', { name: 'Where it runs' });
      expect(within(where).getByText('Cloud')).toBeInTheDocument();
      expect(
        within(where).getByText(/Available · preferred by this workflow/i),
      ).toBeInTheDocument();
      expect(within(where).getByText('This device')).toBeInTheDocument();
      expect(
        within(where).getByText(/Not available — this workflow runs in the cloud only/i),
      ).toBeInTheDocument();
    });

    it('device-only placement: This device available; Cloud not available with the locality reason', async () => {
      await openPreview(
        fullRoutes({
          '/workflow-deployments/deployments': () =>
            jsonResponse(200, { deployments: DEPLOYMENTS_DEVICE }),
        }),
      );
      const where = screen.getByRole('list', { name: 'Where it runs' });
      expect(within(where).getByText('This device')).toBeInTheDocument();
      expect(within(where).getByText(/Available · required/i)).toBeInTheDocument();
      expect(within(where).getByText('Cloud')).toBeInTheDocument();
      expect(
        within(where).getByText(/Not available — this workflow runs on your device only/i),
      ).toBeInTheDocument();
    });

    it('no deployment: the honest not-set-up fact — never a fabricated available choice', async () => {
      await openPreview(
        fullRoutes({
          '/workflow-deployments/deployments': () => jsonResponse(200, { deployments: [] }),
        }),
      );
      const preview = screen.getByRole('region', { name: 'Run preview' });
      expect(
        within(preview).getByText(/Where it runs isn't set up yet/i),
      ).toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Where it runs' })).not.toBeInTheDocument();
    });

    it('cloud_allowed: BOTH environments admitted — never an invented unavailability', async () => {
      await openPreview(
        fullRoutes({
          '/workflow-deployments/deployments': () =>
            jsonResponse(200, {
              deployments: [
                {
                  ...DEPLOYMENTS_CLOUD[0],
                  placement: { placement: { required: 'cloud_allowed' }, privacy: { localOnly: false } },
                },
              ],
            }),
        }),
      );
      const where = screen.getByRole('list', { name: 'Where it runs' });
      expect(within(where).getByText('This device')).toBeInTheDocument();
      expect(within(where).getByText('Cloud')).toBeInTheDocument();
      expect(within(where).getAllByText(/^Available$/).length).toBe(2);
      // No unavailable option was invented.
      expect(within(where).queryByText(/Not available/i)).not.toBeInTheDocument();
    });

    it('any_supported_node: BOTH environments admitted', async () => {
      await openPreview(
        fullRoutes({
          '/workflow-deployments/deployments': () =>
            jsonResponse(200, {
              deployments: [
                {
                  ...DEPLOYMENTS_CLOUD[0],
                  placement: {
                    placement: { required: 'any_supported_node' },
                    privacy: { localOnly: false },
                  },
                },
              ],
            }),
        }),
      );
      const where = screen.getByRole('list', { name: 'Where it runs' });
      expect(within(where).getAllByText(/^Available$/).length).toBe(2);
      expect(within(where).queryByText(/Not available/i)).not.toBeInTheDocument();
    });

    it('device_preferred with an explicit cloud fallback: device preferred, cloud admitted as an explicit fallback', async () => {
      await openPreview(
        fullRoutes({
          '/workflow-deployments/deployments': () =>
            jsonResponse(200, {
              deployments: [
                {
                  ...DEPLOYMENTS_CLOUD[0],
                  placement: {
                    placement: { required: 'device_preferred', fallbackOrder: ['cloud_allowed'] },
                    privacy: { localOnly: false },
                  },
                },
              ],
            }),
        }),
      );
      const where = screen.getByRole('list', { name: 'Where it runs' });
      expect(within(where).getByText('This device')).toBeInTheDocument();
      expect(
        within(where).getByText(/Available · preferred by this workflow/i),
      ).toBeInTheDocument();
      expect(within(where).getByText(/Available · as an explicit fallback/i)).toBeInTheDocument();
    });

    it('device_preferred WITHOUT a cloud fallback: cloud stays honestly unavailable', async () => {
      await openPreview(
        fullRoutes({
          '/workflow-deployments/deployments': () =>
            jsonResponse(200, {
              deployments: [
                {
                  ...DEPLOYMENTS_CLOUD[0],
                  placement: {
                    placement: { required: 'device_preferred' },
                    privacy: { localOnly: false },
                  },
                },
              ],
            }),
        }),
      );
      const where = screen.getByRole('list', { name: 'Where it runs' });
      expect(
        within(where).getByText(/Available · preferred by this workflow/i),
      ).toBeInTheDocument();
      expect(
        within(where).getByText(/Not available — this workflow runs on your device only/i),
      ).toBeInTheDocument();
    });

    it('multiple enabled policies COMBINE: each admitted environment stays available (no invented unavailability)', async () => {
      await openPreview(
        fullRoutes({
          '/workflow-deployments/deployments': () =>
            jsonResponse(200, {
              deployments: [
                {
                  ...DEPLOYMENTS_CLOUD[0],
                  id: 'dep-1',
                  placement: { placement: { required: 'device_local' }, privacy: { localOnly: true } },
                },
                {
                  ...DEPLOYMENTS_CLOUD[0],
                  id: 'dep-2',
                  placement: {
                    placement: { required: 'cloud_required' },
                    privacy: { localOnly: false },
                  },
                },
              ],
            }),
        }),
      );
      const where = screen.getByRole('list', { name: 'Where it runs' });
      expect(within(where).getByText('This device')).toBeInTheDocument();
      expect(within(where).getByText('Cloud')).toBeInTheDocument();
      // Each environment is admitted by one policy — with its own qualifier.
      expect(within(where).getAllByText(/Available · required/i).length).toBe(2);
      // Neither admitted environment is invented away.
      expect(within(where).queryByText(/Not available/i)).not.toBeInTheDocument();
    });
  });

  describe('the Run command (the authoritative command semantics)', () => {
    it('requests the run through the real route (envelope + manual trigger + the installation pin), then starts it, then refetches', async () => {
      // The authority's state changes after the command: the runs list is
      // empty until the request lands, then carries the new run.
      let runRequested = false;
      const routes = fullRoutes({
        'POST /organizations/org-1/workflow-runs/runs': () => {
          runRequested = true;
          return jsonResponse(201, { run: run({ state: 'requested' }), created: true, executed: true });
        },
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, { runs: runRequested ? [run({ state: 'requested' })] : [] }),
        '/workflow-runs/runs/run-3/start': () =>
          jsonResponse(200, { run: run({ state: 'running' }), attempt: null, executed: true }),
        '/workflow-runs/runs/run-3/history': () => jsonResponse(200, history([])),
      });
      const user = await openPreview(routes);
      await user.click(screen.getByRole('button', { name: 'Run' }));
      // The two REAL commands fired with the authoritative shapes.
      await waitFor(() => {
        const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
          (c) => String(c[0]),
        );
        expect(
          calls.some((c) => c.includes('/organizations/org-1/workflow-runs/runs')),
        ).toBe(true);
        expect(calls.some((c) => c.includes('/workflow-runs/runs/run-3/start'))).toBe(true);
      });
      const bodies = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => (c[1] as RequestInit | undefined)?.body)
        .filter(Boolean)
        .map((b) => JSON.parse(String(b)) as Record<string, unknown>);
      // T11: the page's versions experience also POSTs (the analysis)
      // carrying workflowId — the RUN envelope is the body carrying the
      // authoritative trigger (uniquely).
      const requestCall = bodies.find(
        (b) => b.workflowId === 'wf-1' && b.trigger !== undefined,
      );
      expect(requestCall).toMatchObject({
        workflowId: 'wf-1',
        versionId: 'ver-2',
        installationId: 'inst-1',
        trigger: { type: 'manual' },
        inputCommitments: [],
      });
      expect(typeof requestCall?.commandId).toBe('string');
      expect(typeof requestCall?.correlationId).toBe('string');
      const startCall = bodies.find((b) => 'commandId' in b && !('workflowId' in b));
      expect(typeof startCall?.commandId).toBe('string');
      expect(typeof startCall?.correlationId).toBe('string');
      // The preview closes after the command sequence; the status shows the
      // authoritative state (refetched runs → the run record).
      await waitFor(() =>
        expect(screen.queryByRole('region', { name: 'Run preview' })).not.toBeInTheDocument(),
      );
    });

    it('the exact run THIS command created is started — a concurrent sibling run (newer updatedAt) is never started', async () => {
      // The race the architect found: the request creates 'run-created';
      // the re-read list ALSO carries a sibling manual run of the SAME
      // workflow with a NEWER updatedAt. The start command must target the
      // EXACT run the request returned — never the newest heuristic.
      const routes = fullRoutes({
        'POST /organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(201, {
            run: run({ id: 'run-created', state: 'requested', updatedAt: '2026-09-04T08:00:30Z' }),
            created: true,
            executed: true,
          }),
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, {
            runs: [
              // The concurrent sibling: same workflow, NEWER updatedAt.
              run({ id: 'run-sibling', state: 'requested', updatedAt: '2026-09-04T09:00:00Z' }),
              run({ id: 'run-created', state: 'requested', updatedAt: '2026-09-04T08:00:30Z' }),
            ],
          }),
        '/workflow-runs/runs/run-created/start': () =>
          jsonResponse(200, { run: run({ id: 'run-created', state: 'running' }), attempt: null, executed: true }),
        '/workflow-runs/runs/run-sibling/start': () =>
          jsonResponse(200, { run: run({ id: 'run-sibling', state: 'running' }), attempt: null, executed: true }),
        '/workflow-runs/runs/run-created/history': () => jsonResponse(200, history([])),
      });
      const user = await openPreview(routes);
      await user.click(screen.getByRole('button', { name: 'Run' }));
      await waitFor(() => {
        const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
          (c) => String(c[0]),
        );
        // The start command targeted the EXACT created run.
        expect(calls.some((c) => c.includes('/workflow-runs/runs/run-created/start'))).toBe(true);
        expect(calls.some((c) => c.includes('/workflow-runs/runs/run-sibling/start'))).toBe(false);
      });
    });

    it('fail closed: when the exact returned run is absent from the re-read list, NO start is sent', async () => {
      const routes = fullRoutes({
        'POST /organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(201, {
            run: run({ id: 'run-ghost', state: 'requested' }),
            created: true,
            executed: true,
          }),
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, {
            runs: [run({ id: 'run-other', state: 'requested', updatedAt: '2026-09-04T09:00:00Z' })],
          }),
        '/workflow-runs/runs/run-ghost/start': () =>
          jsonResponse(200, { run: run({ id: 'run-ghost', state: 'running' }), attempt: null, executed: true }),
      });
      const user = await openPreview(routes);
      await user.click(screen.getByRole('button', { name: 'Run' }));
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(
        screen.getByText(/the requested run is not in the runs list/i),
      ).toBeInTheDocument();
      // The start command was NEVER sent for any run.
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
        String(c[0]),
      );
      expect(calls.some((c) => c.includes('/start'))).toBe(false);
      // The preview stays open with the honest error.
      expect(screen.getByRole('region', { name: 'Run preview' })).toBeInTheDocument();
    });

    it('a typed command failure is a visible error — never a fabricated success', async () => {
      const routes = fullRoutes({
        'POST /organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(409, {
            error: 'workflow-run-invalid-state-transition',
            code: 'RUN_INVALID_STATE_TRANSITION',
            message: 'the pinned version does not accept a new run in this state',
          }),
      });
      const user = await openPreview(routes);
      await user.click(screen.getByRole('button', { name: 'Run' }));
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(screen.getByText(/couldn't start this run/i)).toBeInTheDocument();
      // The typed authority decision is shown verbatim — authorization
      // stays the backend's; the frontend never fabricates success.
      expect(screen.getByText(/workflow-run-invalid-state-transition/i)).toBeInTheDocument();
      // No fabricated Running status appeared.
      expect(screen.queryByText(/^Running$/)).not.toBeInTheDocument();
    });
  });

  describe('the run states (the human vocabulary, derived from authoritative facts)', () => {
    const cases: Array<[string, string, Record<string, RouteHandler>]> = [
      ['requested → Ready', 'Ready', fullRoutes({
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, { runs: [run({ state: 'requested' })] }),
        '/workflow-runs/runs/run-3/history': () => jsonResponse(200, history([])),
      })],
      ['running → Running', 'Running', fullRoutes({
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, { runs: [run({ state: 'running' })] }),
        '/workflow-runs/runs/run-3/history': () => jsonResponse(200, history([])),
      })],
      ['completed → Completed', 'Completed', fullRoutes({
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, { runs: [run({ state: 'completed' })] }),
        '/workflow-runs/runs/run-3/history': () => jsonResponse(200, history([])),
      })],
      ['failed → Couldn\u2019t complete (with the Needs attention badge)', 'Couldn\u2019t complete', fullRoutes({
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, { runs: [run({ state: 'failed' })] }),
        '/workflow-runs/runs/run-3/history': () => jsonResponse(200, history([])),
      })],
      ['cancelled → Cancelled', 'Cancelled', fullRoutes({
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, { runs: [run({ state: 'cancelled' })] }),
        '/workflow-runs/runs/run-3/history': () => jsonResponse(200, history([])),
      })],
      ['paused at a non-approval step → Paused', 'Paused', fullRoutes({
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, { runs: [run({ state: 'paused' })] }),
        '/workflow-runs/runs/run-3/history': () => jsonResponse(200, PAUSED_AT_SEND),
      })],
      ['paused at the approval step → Waiting for you', 'Waiting for you', fullRoutes({
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, { runs: [run({ state: 'paused' })] }),
        '/workflow-runs/runs/run-3/history': () => jsonResponse(200, PAUSED_AT_REVIEW),
      })],
    ];

    it.each(cases)('%s', async (_label, expected, routes) => {
      renderDetail(routes);
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
      );
      const status = await screen.findByRole('region', { name: 'Run status' });
      await waitFor(() => expect(within(status).getByText(expected)).toBeInTheDocument());
      if (expected === 'Couldn\u2019t complete') {
        expect(screen.getByText('Needs attention')).toBeInTheDocument();
      }
    });

    it('the history read fails → the honest Unavailable surface for the run details (the record state stays factual)', async () => {
      renderDetail(
        fullRoutes({
          '/organizations/org-1/workflow-runs/runs': () =>
            jsonResponse(200, { runs: [run({ state: 'running' })] }),
          '/workflow-runs/runs/run-3/history': () =>
            jsonResponse(500, { error: 'workflow-runs-internal-error' }),
        }),
      );
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
      );
      const status = await screen.findByRole('region', { name: 'Run status' });
      // The record-derived state word stays (a known fact is never hidden).
      await waitFor(() => expect(within(status).getByText('Running')).toBeInTheDocument());
      // The run-detail facts are honestly Unavailable — never guessed.
      await waitFor(() =>
        expect(
          within(status).getByRole('status', { name: 'Unavailable' }),
        ).toBeInTheDocument(),
      );
      expect(
        within(status).getByText(/run details unavailable/i),
      ).toBeInTheDocument();
    });
  });

  describe('progressive disclosure (internal terminology stays expert-only)', () => {
    it('the internal state word and run id appear ONLY inside Advanced details', async () => {
      renderDetail(
        fullRoutes({
          '/organizations/org-1/workflow-runs/runs': () =>
            jsonResponse(200, { runs: [run({ state: 'requested' })] }),
          '/workflow-runs/runs/run-3/history': () => jsonResponse(200, history([])),
        }),
      );
      const status = await screen.findByRole('region', { name: 'Run status' });
      await waitFor(() => expect(within(status).getByText('Ready')).toBeInTheDocument());
      // Primary surface: the human word only — the internal state word and
      // the run id are NOT in the primary text.
      expect(within(status).queryByText(/^requested$/)).not.toBeInTheDocument();
      expect(within(status).queryByText(/run-3/)).not.toBeInTheDocument();
      // Advanced details discloses them on demand.
      const user = userEvent.setup();
      await user.click(screen.getByText('Advanced details'));
      expect(await within(status).findByText(/^requested$/)).toBeInTheDocument();
      expect(within(status).getByText(/run-3/)).toBeInTheDocument();
      expect(within(status).getByText(/manual/)).toBeInTheDocument();
    });
  });

  // T10 (V2-017): the "How do you know?" trust presentation composed into
  // the run-status surface (the same history read the Waiting-for-you
  // derivation already consumes — no second evidence authority).
  describe('T10 — "How do you know?" (the trust disclosure in the run status)', () => {
    const TRUST_HISTORY = {
      ...history([]),
      evidence: [
        {
          id: 'ev-1',
          runId: 'run-3',
          attemptNumber: 1,
          stepId: 'send_followup',
          evidenceClass: 'observation',
          producerKind: 'executor',
          producerId: 'node_host_1',
          contentCommitment: 'sha256:ev-1',
          description: 'Observed the message-delivery receipt from the mail service.',
          recordedAt: '2026-09-04T08:20:00Z',
        },
      ],
      attestations: [
        {
          attestationId: 'att-1',
          runId: 'run-3',
          attemptNumber: 1,
          stepId: 'send_followup',
          executionDigest: 'sha256:execution',
          attesterKeyId: 'key-att-1',
          assurance: 'software_signed',
          nonce: 'nonce-1',
          statement: {
            objectType: 'workflowos/execution-statement/v1',
            action: 'Email the weekly digest',
            outcome: 'succeeded',
          },
          verifiedAt: '2026-09-04T08:25:00Z',
          attachedAt: '2026-09-04T08:25:01Z',
        },
      ],
    };

    it('shows the concise evidence (the records\u2019 own descriptions + the honest "Verified by" wording) inside the run status', async () => {
      renderDetail(
        fullRoutes({
          '/organizations/org-1/workflow-runs/runs': () =>
            jsonResponse(200, { runs: [run({ state: 'completed' })] }),
          '/workflow-runs/runs/run-3/history': () =>
            jsonResponse(200, TRUST_HISTORY),
        }),
      );
      const status = await screen.findByRole('region', { name: 'Run status' });
      await waitFor(() => expect(within(status).getByText('Completed')).toBeInTheDocument());
      const trust = within(status).getByRole('region', { name: 'How do you know?' });
      expect(
        within(trust).getByText(/Observed the message-delivery receipt/i),
      ).toBeInTheDocument();
      expect(within(trust).getByText(/Verified by/i)).toBeInTheDocument();
    });

    it('advanced verification discloses the V2-014 attestation facts (statement action, assurance, digest) with the no-physical-proof boundary', async () => {
      renderDetail(
        fullRoutes({
          '/organizations/org-1/workflow-runs/runs': () =>
            jsonResponse(200, { runs: [run({ state: 'completed' })] }),
          '/workflow-runs/runs/run-3/history': () =>
            jsonResponse(200, TRUST_HISTORY),
        }),
      );
      const status = await screen.findByRole('region', { name: 'Run status' });
      const trust = within(status).getByRole('region', { name: 'How do you know?' });
      const user = userEvent.setup();
      await user.click(within(trust).getByText('Advanced verification'));
      expect(within(trust).getByText(/Email the weekly digest/i)).toBeInTheDocument();
      expect(within(trust).getByText(/Software-signed/i)).toBeInTheDocument();
      expect(within(trust).getByText(/sha256:execution/i)).toBeInTheDocument();
      // The trust boundary: a signature is never automatic physical proof.
      expect(
        within(trust).getByText(/can\u2019t by itself prove what happened in the physical world/i),
      ).toBeInTheDocument();
    });

    it('no evidence records → the honest no-evidence state (a record fact, never a failed-read mask)', async () => {
      renderDetail(
        fullRoutes({
          '/organizations/org-1/workflow-runs/runs': () =>
            jsonResponse(200, { runs: [run({ state: 'running' })] }),
          '/workflow-runs/runs/run-3/history': () => jsonResponse(200, history([])),
        }),
      );
      const status = await screen.findByRole('region', { name: 'Run status' });
      const trust = within(status).getByRole('region', { name: 'How do you know?' });
      expect(within(trust).getByText(/No evidence records yet/i)).toBeInTheDocument();
      // No attestations either — the honest absence, not an error.
      const user = userEvent.setup();
      await user.click(within(trust).getByText('Advanced verification'));
      expect(within(trust).getByText(/No attestations attached/i)).toBeInTheDocument();
    });
  });

  // T10 F02 (V2-017): the run-level direct link — a ?run= param on the
  // EXISTING workflow route selects the run the run-status surface
  // presents (the Activity entries' "Open the run" link). The
  // authoritative runs read governs: an unknown id presents the newest
  // run (never a fabricated run), and an earlier run is disclosed as
  // such (never mistaken for the current status).
  describe('T10 F02 — the run-level navigation (?run= selects the presented run)', () => {
    const RUNS_TWO = () =>
      jsonResponse(200, {
        runs: [
          run({ state: 'completed', updatedAt: '2026-09-04T08:30:00Z' }),
          run({
            id: 'run-2',
            state: 'failed',
            createdAt: '2026-09-04T06:00:00Z',
            updatedAt: '2026-09-04T07:00:00Z',
          }),
        ],
      });
    const ROUTES_TWO: Record<string, RouteHandler> = fullRoutes({
      '/organizations/org-1/workflow-runs/runs': RUNS_TWO,
      '/workflow-runs/runs/run-3/history': () => jsonResponse(200, history([])),
      '/workflow-runs/runs/run-2/history': () =>
        jsonResponse(200, {
          ...history([]),
          run: run({ id: 'run-2', state: 'failed' }),
        }),
    });

    it('presents the SELECTED run with the honest earlier-run note — never the newest run status', async () => {
      renderDetail(ROUTES_TWO, '/workflows/wf-1?run=run-2');
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
      );
      const status = await screen.findByRole('region', { name: 'Run status' });
      // The SELECTED run's human state (run-2 failed → Couldn't complete).
      await waitFor(() =>
        expect(within(status).getByText("Couldn\u2019t complete")).toBeInTheDocument(),
      );
      // The newest run's status is NOT presented for this run.
      expect(within(status).queryByText(/^Completed$/)).not.toBeInTheDocument();
      // The honest disclosure: an earlier run, never the current status.
      expect(within(status).getByText(/An earlier run/i)).toBeInTheDocument();
    });

    it('an unknown ?run= id presents the newest run (the runs read governs — no fabricated run)', async () => {
      renderDetail(ROUTES_TWO, '/workflows/wf-1?run=run-ghost');
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
      );
      const status = await screen.findByRole('region', { name: 'Run status' });
      await waitFor(() => expect(within(status).getByText('Completed')).toBeInTheDocument());
      expect(within(status).queryByText(/An earlier run/i)).not.toBeInTheDocument();
    });

    it('no ?run= param presents the newest run (the T6 default, unchanged)', async () => {
      renderDetail(ROUTES_TWO);
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
      );
      const status = await screen.findByRole('region', { name: 'Run status' });
      await waitFor(() => expect(within(status).getByText('Completed')).toBeInTheDocument());
      expect(within(status).queryByText(/An earlier run/i)).not.toBeInTheDocument();
    });
  });

  // REALITY-REPAIR-007 (F-008, CRITICAL): the run lifecycle controls.
  // The audit's defect: a run that pauses at an approval gate can NEVER
  // be resumed through the product — RunExperience derives and renders
  // "Waiting for you" but it is display-only; there is no
  // Approve/Resume/Pause/Stop control anywhere in the run UX (the
  // command side was left to executor fixtures). The repair composes the
  // EXISTING V2-005 lifecycle commands (pause/resume/cancel) through
  // their command envelope:
  //   - "Approve" is the user-facing LABEL for the existing
  //     resume-with-human-confirmation semantics at an approval gate —
  //     V2-005 has NO separate approval command and none is invented
  //     (verified against the route/service surface);
  //   - the offered actions only FOLLOW the frozen transition table
  //     (running → Pause; paused → Approve/Resume; non-terminal → Stop;
  //     terminal → nothing) — idempotency and forbidden transitions stay
  //     enforced SERVER-SIDE by the command envelopes; typed rejections
  //     render verbatim, never as state, never as a fabricated success.
  describe('REALITY-REPAIR-007 — the run lifecycle controls (F-008)', () => {
    /** The POST-body envelope assertion (commandId + correlationId). */
    function expectEnvelope(url: string): Record<string, unknown> {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => ({
        url: String(c[0]),
        body: (c[1] as RequestInit | undefined)?.body,
      }));
      const call = calls.find((c) => c.url.includes(url));
      expect(call, `no POST to ${url}`).toBeDefined();
      const body = JSON.parse(String(call?.body)) as Record<string, unknown>;
      expect(typeof body.commandId).toBe('string');
      expect(typeof body.correlationId).toBe('string');
      return body;
    }

    function countPosts(url: string): number {
      return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => String(c[0]).includes(url),
      ).length;
    }

    it('the waiting-for-you state offers the Approve control (the F-008 defect: display-only)', async () => {
      renderDetail(
        fullRoutes({
          '/organizations/org-1/workflow-runs/runs': () =>
            jsonResponse(200, { runs: [run({ state: 'paused' })] }),
          '/workflow-runs/runs/run-3/history': () => jsonResponse(200, PAUSED_AT_REVIEW),
        }),
      );
      const status = await screen.findByRole('region', { name: 'Run status' });
      await waitFor(() => expect(within(status).getByText('Waiting for you')).toBeInTheDocument());
      // THE F-008 assertion: the human can act on the waiting state.
      expect(within(status).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
      // Safe stop is offered where the state permits cancellation.
      expect(within(status).getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    });

    it('Approve sends the REAL V2-005 resume command (the envelope), then the refetched record shows Running', async () => {
      let resumed = false;
      const routes = fullRoutes({
        'POST /workflow-runs/runs/run-3/resume': () => {
          resumed = true;
          return jsonResponse(200, {
            run: run({ state: 'running' }),
            attempt: null,
            resumedAtStepId: 'review_gate',
            newAttempt: false,
            executed: true,
          });
        },
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, { runs: [run({ state: resumed ? 'running' : 'paused' })] }),
        '/workflow-runs/runs/run-3/history': () =>
          jsonResponse(200, resumed ? history([]) : PAUSED_AT_REVIEW),
      });
      renderDetail(routes);
      const status = await screen.findByRole('region', { name: 'Run status' });
      await waitFor(() => expect(within(status).getByText('Waiting for you')).toBeInTheDocument());
      const user = userEvent.setup();
      await user.click(within(status).getByRole('button', { name: 'Approve' }));
      // The REAL lifecycle command fired with the deterministic envelope.
      await waitFor(() => expect(resumed).toBe(true));
      expectEnvelope('/workflow-runs/runs/run-3/resume');
      // The run returns to execution — from the AUTHORITATIVE refetched
      // record, never from the command's echo.
      await waitFor(() => expect(within(status).getByText('Running')).toBeInTheDocument());
    });

    it('a typed resume rejection renders verbatim — never a fabricated success (the envelope stays the authority)', async () => {
      renderDetail(
        fullRoutes({
          '/organizations/org-1/workflow-runs/runs': () =>
            jsonResponse(200, { runs: [run({ state: 'paused' })] }),
          '/workflow-runs/runs/run-3/history': () => jsonResponse(200, PAUSED_AT_REVIEW),
          // The run was cancelled concurrently: the envelope rejects the
          // stale Approve with the typed terminal decision (409).
          'POST /workflow-runs/runs/run-3/resume': () =>
            jsonResponse(409, {
              error: 'workflow-run-terminal',
              code: 'RUN_TERMINAL',
              message: 'the run is in terminal state "cancelled" — the lifecycle is immutable',
            }),
        }),
      );
      const status = await screen.findByRole('region', { name: 'Run status' });
      await waitFor(() => expect(within(status).getByText('Waiting for you')).toBeInTheDocument());
      const user = userEvent.setup();
      await user.click(within(status).getByRole('button', { name: 'Approve' }));
      // The typed authority decision renders verbatim — the UI never
      // fakes the success the backend refused.
      await waitFor(() => expect(within(status).getByRole('alert')).toBeInTheDocument());
      expect(within(status).getByText(/couldn't continue this run/i)).toBeInTheDocument();
      expect(within(status).getByText(/workflow-run-terminal/i)).toBeInTheDocument();
      // No fabricated Running appeared.
      expect(within(status).queryByText('Running')).not.toBeInTheDocument();
    });

    it('a running run offers Pause where the state permits it, and Pause sends the REAL command', async () => {
      let paused = false;
      const routes = fullRoutes({
        'POST /workflow-runs/runs/run-3/pause': () => {
          paused = true;
          return jsonResponse(200, { run: run({ state: 'paused' }), attempt: null, executed: true });
        },
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, { runs: [run({ state: paused ? 'paused' : 'running' })] }),
        '/workflow-runs/runs/run-3/history': () =>
          jsonResponse(200, paused ? PAUSED_AT_SEND : history([])),
      });
      renderDetail(routes);
      const status = await screen.findByRole('region', { name: 'Run status' });
      await waitFor(() => expect(within(status).getByText('Running')).toBeInTheDocument());
      const user = userEvent.setup();
      await user.click(within(status).getByRole('button', { name: 'Pause' }));
      await waitFor(() => expect(paused).toBe(true));
      expectEnvelope('/workflow-runs/runs/run-3/pause');
      // The authoritative record now shows the paused state.
      await waitFor(() => expect(within(status).getByText('Paused')).toBeInTheDocument());
    });

    it('a paused run NOT at an approval gate offers the generic Resume label (the same real command)', async () => {
      renderDetail(
        fullRoutes({
          '/organizations/org-1/workflow-runs/runs': () =>
            jsonResponse(200, { runs: [run({ state: 'paused' })] }),
          '/workflow-runs/runs/run-3/history': () => jsonResponse(200, PAUSED_AT_SEND),
        }),
      );
      const status = await screen.findByRole('region', { name: 'Run status' });
      await waitFor(() => expect(within(status).getByText('Paused')).toBeInTheDocument());
      expect(within(status).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
      // The approval label never appears without the approval fact.
      expect(within(status).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    });

    it('Stop requires the §2.4 explicit choice, then sends the REAL cancel command; the terminal state offers nothing', async () => {
      let cancelled = false;
      const routes = fullRoutes({
        'POST /workflow-runs/runs/run-3/cancel': () => {
          cancelled = true;
          return jsonResponse(200, {
            run: run({ state: 'cancelled' }),
            attempt: null,
            executed: true,
          });
        },
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, { runs: [run({ state: cancelled ? 'cancelled' : 'paused' })] }),
        '/workflow-runs/runs/run-3/history': () =>
          jsonResponse(200, cancelled ? history([]) : PAUSED_AT_REVIEW),
      });
      renderDetail(routes);
      const status = await screen.findByRole('region', { name: 'Run status' });
      await waitFor(() => expect(within(status).getByText('Waiting for you')).toBeInTheDocument());
      const user = userEvent.setup();
      // No command before the explicit choice.
      await user.click(within(status).getByRole('button', { name: 'Stop' }));
      expect(countPosts('/workflow-runs/runs/run-3/cancel')).toBe(0);
      expect(
        within(status).getByText(/This ends the run — it can't be restarted/i),
      ).toBeInTheDocument();
      await user.click(within(status).getByRole('button', { name: 'Stop it' }));
      await waitFor(() => expect(cancelled).toBe(true));
      expectEnvelope('/workflow-runs/runs/run-3/cancel');
      // The authoritative terminal record + terminal honesty: no
      // lifecycle control remains on a cancelled run.
      await waitFor(() => expect(within(status).getByText('Cancelled')).toBeInTheDocument());
      await waitFor(() =>
        expect(within(status).queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument(),
      );
      expect(within(status).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
      expect(within(status).queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
      expect(within(status).queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    });

    it('a requested (Ready) run offers Stop only — pause is not a legal transition from requested (the frozen table)', async () => {
      renderDetail(
        fullRoutes({
          '/organizations/org-1/workflow-runs/runs': () =>
            jsonResponse(200, { runs: [run({ state: 'requested' })] }),
          '/workflow-runs/runs/run-3/history': () => jsonResponse(200, history([])),
        }),
      );
      const status = await screen.findByRole('region', { name: 'Run status' });
      await waitFor(() => expect(within(status).getByText('Ready')).toBeInTheDocument());
      expect(within(status).getByRole('button', { name: 'Stop' })).toBeInTheDocument();
      expect(within(status).queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
      expect(within(status).queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
      expect(within(status).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    });

    it('terminal runs (completed) offer no lifecycle controls — the lifecycle is immutable', async () => {
      renderDetail(
        fullRoutes({
          '/organizations/org-1/workflow-runs/runs': () =>
            jsonResponse(200, { runs: [run({ state: 'completed' })] }),
          '/workflow-runs/runs/run-3/history': () => jsonResponse(200, history([])),
        }),
      );
      const status = await screen.findByRole('region', { name: 'Run status' });
      await waitFor(() => expect(within(status).getByText('Completed')).toBeInTheDocument());
      expect(within(status).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
      expect(within(status).queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
      expect(within(status).queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
      expect(within(status).queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    });

    it('while a lifecycle command is in flight the control disables — no double command', async () => {
      let resolveResume: ((r: Response) => void) | undefined;
      let resumed = false;
      const routes = fullRoutes({
        'POST /workflow-runs/runs/run-3/resume': () =>
          new Promise<Response>((resolve) => {
            resolveResume = resolve;
          }),
        '/organizations/org-1/workflow-runs/runs': () =>
          jsonResponse(200, { runs: [run({ state: resumed ? 'running' : 'paused' })] }),
        '/workflow-runs/runs/run-3/history': () =>
          jsonResponse(200, resumed ? history([]) : PAUSED_AT_REVIEW),
      });
      renderDetail(routes);
      const status = await screen.findByRole('region', { name: 'Run status' });
      await waitFor(() => expect(within(status).getByText('Waiting for you')).toBeInTheDocument());
      const user = userEvent.setup();
      await user.click(within(status).getByRole('button', { name: 'Approve' }));
      // In flight: disabled, honestly labeled, ONE command.
      await waitFor(() =>
        expect(within(status).getByRole('button', { name: 'Approving…' })).toBeDisabled(),
      );
      expect(countPosts('/workflow-runs/runs/run-3/resume')).toBe(1);
      // A second click on the disabled control sends nothing.
      await user.click(within(status).getByRole('button', { name: 'Approving…' })).catch(() => undefined);
      expect(countPosts('/workflow-runs/runs/run-3/resume')).toBe(1);
      // The authority answers; the refetched record shows Running.
      resumed = true;
      resolveResume?.(
        jsonResponse(200, {
          run: run({ state: 'running' }),
          attempt: null,
          resumedAtStepId: 'review_gate',
          newAttempt: false,
          executed: true,
        }),
      );
      await waitFor(() => expect(within(status).getByText('Running')).toBeInTheDocument());
      expect(countPosts('/workflow-runs/runs/run-3/resume')).toBe(1);
    });
  });
});
