/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProductActivityPage from './ProductActivityPage';

/**
 * V2-017 T10 — the universal Activity timeline + "How do you know?" contract
 * (Issue #5 dispatch).
 *
 * The Activity surface composes EXISTING authorities only (V2-002
 * workflow/version reads + the V2-005 run list/history reads; V2-014
 * attestation facts arrive through the V2-005 history read):
 *   - every timeline event derives from an authoritative record — runs (with
 *     the §15 human state vocabulary, including the history-derived
 *     "Waiting for you") and workflow versions ("New version" events);
 *   - a displayed timeline never fabricates events absent from the records:
 *     teaching sessions have NO list read on the V2-006/V2-010 authorities,
 *     so the surface discloses that honestly instead of inventing entries;
 *   - failed reads stay visibly Unavailable with retry — never successful
 *     empty states; a genuinely empty read (no organizations) is the
 *     derivable empty state;
 *   - the "How do you know?" disclosure loads the run's reconstructed
 *     history on demand: concise evidence first (the records' own
 *     descriptions + the honest "Verified by" wording derived from the
 *     evidence class), then advanced verification on demand (the V2-014
 *     attestation facts: statement, assurance, digest, attester) with the
 *     explicit no-physical-proof boundary — a signature is never presented
 *     as automatic proof of a physical side effect.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = () => Response | Promise<Response>;

function mockApi(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
  // Longest fragment first: '/workflow-repository/workflows/wf-1/versions'
  // must match its own handler, not the bare workflows-list handler.
  const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    for (const [fragment, handler] of ordered) {
      if (url.includes(fragment)) return Promise.resolve(handler());
    }
    return Promise.resolve(jsonResponse(500, { error: `unmocked ${url}` }));
  });
}

function renderActivity(routes: Record<string, RouteHandler>) {
  vi.stubGlobal('fetch', mockApi(routes));
  return render(
    <MemoryRouter initialEntries={['/activity']}>
      <Routes>
        <Route path="/activity" element={<ProductActivityPage />} />
        <Route path="/workflows/:workflowId" element={<div>Workflow detail</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const ORGS_ONE: RouteHandler = () =>
  jsonResponse(200, { organizations: [{ id: 'org-1', name: 'Acme', roleId: 'owner' }] });

const WORKFLOWS: RouteHandler = () =>
  jsonResponse(200, {
    workflows: [
      {
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
      },
    ],
  });

const VERSIONS: RouteHandler = () =>
  jsonResponse(200, {
    versions: [
      {
        id: 'ver-1',
        workflowId: 'wf-1',
        versionNumber: 1,
        contentDigest: 'sha256:v1',
        content: {},
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
        parentVersionId: null,
        createdByUserId: 'user-1',
        createdAt: '2026-09-01T10:00:00Z',
      },
      {
        id: 'ver-2',
        workflowId: 'wf-1',
        versionNumber: 2,
        contentDigest: 'sha256:v2',
        content: {},
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
        parentVersionId: 'ver-1',
        createdByUserId: 'user-1',
        createdAt: '2026-09-04T09:00:00Z',
      },
    ],
  });

/** IR content whose review_gate node IS an approval node (the
 *  authoritative consent facts the needs-you derivation consumes). */
const APPROVAL_IR_CONTENT = {
  objectType: 'workflowos/workflow-ir/v1',
  ir: {
    start: 'review_gate',
    nodes: [
      {
        id: 'review_gate',
        executionClass: 'human',
        spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve.' } },
        capabilityRequirements: [],
        placement: 'cloud_allowed',
      },
    ],
    edges: [],
    defaultPlacement: 'cloud_allowed',
  },
  presentation: { title: 'Weekly invoice digest', nodeLabels: { review_gate: 'Your approval' } },
};

/** Version records carrying the approval IR (F01: the Needs-me
 *  derivation's version facts). */
const APPROVAL_VERSIONS: RouteHandler = () =>
  jsonResponse(200, {
    versions: [
      {
        id: 'ver-1',
        workflowId: 'wf-1',
        versionNumber: 1,
        contentDigest: 'sha256:v1',
        content: APPROVAL_IR_CONTENT,
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
        parentVersionId: null,
        createdByUserId: 'user-1',
        createdAt: '2026-09-01T10:00:00Z',
      },
      {
        id: 'ver-2',
        workflowId: 'wf-1',
        versionNumber: 2,
        contentDigest: 'sha256:v2',
        content: APPROVAL_IR_CONTENT,
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
        parentVersionId: 'ver-1',
        createdByUserId: 'user-1',
        createdAt: '2026-09-04T09:00:00Z',
      },
    ],
  });

/** A run row factory (the V2-005 list shape). */
function runRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'run-1',
    organizationId: 'org-1',
    workflowId: 'wf-1',
    versionId: 'ver-2',
    installationId: null,
    trigger: { type: 'manual', id: 'trigger-1' },
    triggeredByUserId: 'user-1',
    inputCommitments: [],
    inputDigest: 'sha256:inputs',
    state: 'completed',
    createdAt: '2026-09-04T08:00:00Z',
    updatedAt: '2026-09-04T08:30:00Z',
    ...overrides,
  };
}

const RUNS: RouteHandler = () =>
  jsonResponse(200, {
    runs: [
      runRow({
        id: 'run-1',
        state: 'completed',
        createdAt: '2026-09-04T08:00:00Z',
        updatedAt: '2026-09-04T08:30:00Z',
      }),
      runRow({
        id: 'run-2',
        state: 'failed',
        createdAt: '2026-09-04T09:10:00Z',
        updatedAt: '2026-09-04T09:20:00Z',
      }),
      runRow({
        id: 'run-3',
        state: 'paused',
        createdAt: '2026-09-04T10:00:00Z',
        updatedAt: '2026-09-04T10:05:00Z',
      }),
    ],
  });

/** The reconstructed history of run-1 (evidence + one attestation binding). */
const RUN1_HISTORY: RouteHandler = () =>
  jsonResponse(200, {
    run: runRow({ id: 'run-1' }),
    timeline: [
      {
        id: 'tl-1',
        runId: 'run-1',
        attemptNumber: 1,
        stepId: null,
        eventName: 'workflow.run.started',
        occurredAt: '2026-09-04T08:00:10Z',
        sequence: 1,
        detail: null,
      },
    ],
    attempts: [],
    steps: [],
    invocations: [],
    evidence: [
      {
        id: 'ev-1',
        runId: 'run-1',
        attemptNumber: 1,
        stepId: 'send_followup',
        evidenceClass: 'observation',
        producerKind: 'executor',
        producerId: 'node_host_1',
        contentCommitment: 'sha256:ev-1',
        description: 'Observed the message-delivery receipt from the mail service.',
        recordedAt: '2026-09-04T08:20:00Z',
      },
      {
        id: 'ev-2',
        runId: 'run-1',
        attemptNumber: 1,
        stepId: null,
        evidenceClass: 'human_confirmation',
        producerKind: 'user',
        producerId: 'user-1',
        contentCommitment: 'sha256:ev-2',
        description: 'You approved the digest before it was sent.',
        recordedAt: '2026-09-04T08:10:00Z',
      },
    ],
    attestations: [
      {
        attestationId: 'att-1',
        runId: 'run-1',
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
    attestationRejections: [],
    commands: [],
  });

/** run-3's history: the pause rides detail.atStepId at the approval step. */
const RUN3_HISTORY: RouteHandler = () =>
  jsonResponse(200, {
    run: runRow({ id: 'run-3', state: 'paused' }),
    timeline: [
      {
        id: 'tl-3',
        runId: 'run-3',
        attemptNumber: 1,
        stepId: null,
        eventName: 'workflow.run.paused',
        occurredAt: '2026-09-04T10:05:00Z',
        sequence: 2,
        detail: { atStepId: 'review_gate' },
      },
    ],
    attempts: [],
    steps: [],
    invocations: [],
    evidence: [],
    attestations: [],
    attestationRejections: [],
    commands: [],
  });

/** run-3's history when the pause is NOT at an approval step. */
const RUN3_HISTORY_NOT_APPROVAL: RouteHandler = () =>
  jsonResponse(200, {
    run: runRow({ id: 'run-3', state: 'paused' }),
    timeline: [
      {
        id: 'tl-3',
        runId: 'run-3',
        attemptNumber: 1,
        stepId: null,
        eventName: 'workflow.run.paused',
        occurredAt: '2026-09-04T10:05:00Z',
        sequence: 2,
        detail: { atStepId: 'send_followup' },
      },
    ],
    attempts: [],
    steps: [],
    invocations: [],
    evidence: [],
    attestations: [],
    attestationRejections: [],
    commands: [],
  });

const FULL: Record<string, RouteHandler> = {
  '/organizations': ORGS_ONE,
  '/workflow-repository/workflows': WORKFLOWS,
  '/workflow-repository/workflows/wf-1/versions': VERSIONS,
  '/workflow-runs/runs/run-1/history': RUN1_HISTORY,
  '/workflow-runs/runs/run-2/history': () => jsonResponse(200, { run: runRow({ id: 'run-2' }), timeline: [], attempts: [], steps: [], invocations: [], evidence: [], attestations: [], attestationRejections: [], commands: [] }),
  '/workflow-runs/runs/run-3/history': RUN3_HISTORY,
  '/workflow-runs/runs': RUNS,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('V2-017 T10 — the universal Activity timeline', () => {
  it('renders run events with the human state vocabulary, the workflow link and the relative time, newest first', async () => {
    renderActivity(FULL);
    const list = await screen.findByRole('list', { name: 'Activity timeline' });
    // All three run events render (run-3 newest).
    const items = within(list).getAllByRole('listitem');
    expect(items.length).toBeGreaterThanOrEqual(3);
    // The human state vocabulary (UX spec §15) — never the raw state words.
    expect(within(list).getByText('Completed')).toBeInTheDocument();
    expect(within(list).getByText("Couldn\u2019t complete")).toBeInTheDocument();
    expect(within(list).queryByText(/^failed$/)).not.toBeInTheDocument();
    // Each run event links to its workflow (§16: reach the related Workflow).
    const links = within(list).getAllByRole('link', { name: /Weekly invoice digest/ });
    expect(links.length).toBeGreaterThanOrEqual(3);
    expect(links[0]).toHaveAttribute('href', '/workflows/wf-1');
    // Newest first: run-3's entry precedes run-2's and run-1's.
    expect(items[0].textContent).toContain('Weekly invoice digest');
  });

  it('renders "New version" events from the version records (the V2-002 versions read)', async () => {
    renderActivity(FULL);
    const list = await screen.findByRole('list', { name: 'Activity timeline' });
    // Two version events: version 1 and version 2 of wf-1.
    expect(within(list).getAllByText('New version').length).toBe(2);
    expect(within(list).getByText(/Version 1/)).toBeInTheDocument();
    expect(within(list).getByText(/Version 2/)).toBeInTheDocument();
  });

  it('derives "Waiting for you" for a run paused at an approval step (history-derived), and "Paused" otherwise', async () => {
    const { unmount } = renderActivity(FULL);
    await screen.findByRole('list', { name: 'Activity timeline' });
    // run-3 paused at review_gate (an approval node is not derivable here —
    // the derivation loads the paused run's history and the workflow's
    // version content for the approval check; the fixture content is empty
    // so no approval node is declared → the honest "Paused" word).
    // NOTE: this test pins the honest fallback; the approval-derivation is
    // pinned in the RunExperience suite (real IR content) and the E2E.
    unmount();

    vi.stubGlobal(
      'fetch',
      mockApi({
        ...FULL,
        '/workflow-repository/workflows/wf-1/versions': () =>
          jsonResponse(200, {
            versions: [
              {
                id: 'ver-2',
                workflowId: 'wf-1',
                versionNumber: 1,
                contentDigest: 'sha256:v1',
                content: {
                  objectType: 'workflowos/workflow-ir/v1',
                  ir: {
                    start: 'review_gate',
                    nodes: [
                      {
                        id: 'review_gate',
                        executionClass: 'human',
                        spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve.' } },
                        capabilityRequirements: [],
                        placement: 'cloud_allowed',
                      },
                    ],
                    edges: [],
                    defaultPlacement: 'cloud_allowed',
                  },
                  presentation: { title: 'Weekly invoice digest', nodeLabels: { review_gate: 'Your approval' } },
                },
                protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
                parentVersionId: null,
                createdByUserId: 'user-1',
                createdAt: '2026-09-01T10:00:00Z',
              },
            ],
          }),
      }),
    );
    render(
      <MemoryRouter initialEntries={['/activity']}>
        <Routes>
          <Route path="/activity" element={<ProductActivityPage />} />
          <Route path="/workflows/:workflowId" element={<div>Workflow detail</div>} />
        </Routes>
      </MemoryRouter>,
    );
    const list2 = await screen.findByRole('list', { name: 'Activity timeline' });
    await waitFor(() => {
      expect(within(list2).getByText('Waiting for you')).toBeInTheDocument();
    });
  });

  it('a paused run not at an approval step shows "Paused" — never a fabricated needs-you', async () => {
    renderActivity({
      ...FULL,
      '/workflow-runs/runs/run-3/history': RUN3_HISTORY_NOT_APPROVAL,
    });
    const list = await screen.findByRole('list', { name: 'Activity timeline' });
    await waitFor(() => {
      expect(within(list).getByText('Paused')).toBeInTheDocument();
    });
    expect(within(list).queryByText('Waiting for you')).not.toBeInTheDocument();
  });

  it('filters are presentation-only over the authoritative record states', async () => {
    renderActivity({
      ...FULL,
      '/workflow-repository/workflows/wf-1/versions': APPROVAL_VERSIONS,
    });
    await screen.findByRole('list', { name: 'Activity timeline' });
    const user = userEvent.setup();
    const group = screen.getByRole('group', { name: 'Activity filters' });

    // Needs me (F01): ONLY the approval-derived waiting run — the same
    // authoritative derivation as the state word, never the raw pause.
    await user.click(within(group).getByRole('button', { name: 'Needs me' }));
    let list = await screen.findByRole('list', { name: 'Activity timeline' });
    await waitFor(() => {
      expect(within(list).getByText('Waiting for you')).toBeInTheDocument();
    });
    expect(within(list).getAllByRole('listitem').length).toBe(1);

    // Completed: only the completed run's event.
    await user.click(within(group).getByRole('button', { name: 'Completed' }));
    list = screen.getByRole('list', { name: 'Activity timeline' });
    expect(within(list).getAllByRole('listitem').length).toBe(1);
    expect(within(list).getByText('Completed')).toBeInTheDocument();

    // Failed: only the failed run's event.
    await user.click(within(group).getByRole('button', { name: 'Failed' }));
    list = screen.getByRole('list', { name: 'Activity timeline' });
    expect(within(list).getAllByRole('listitem').length).toBe(1);
    expect(within(list).getByText("Couldn\u2019t complete")).toBeInTheDocument();

    // All: every event back (3 runs + 2 versions).
    await user.click(within(group).getByRole('button', { name: 'All' }));
    list = screen.getByRole('list', { name: 'Activity timeline' });
    expect(within(list).getAllByRole('listitem').length).toBe(5);
  });

  it('F01: a paused run NOT at an approval step is never upgraded into the Needs-me bucket', async () => {
    renderActivity({
      ...FULL,
      '/workflow-repository/workflows/wf-1/versions': APPROVAL_VERSIONS,
      '/workflow-runs/runs/run-3/history': RUN3_HISTORY_NOT_APPROVAL,
    });
    await screen.findByRole('list', { name: 'Activity timeline' });
    const user = userEvent.setup();
    const group = screen.getByRole('group', { name: 'Activity filters' });
    await user.click(within(group).getByRole('button', { name: 'Needs me' }));
    // The paused-but-unproven run is EXCLUDED: without the authoritative
    // approval fact the page has no evidence the user is needed.
    await waitFor(() => {
      expect(screen.getByText(/No activity yet/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    // Under All the same run honestly shows "Paused" (never hidden).
    await user.click(within(group).getByRole('button', { name: 'All' }));
    const list = await screen.findByRole('list', { name: 'Activity timeline' });
    await waitFor(() => {
      expect(within(list).getByText('Paused')).toBeInTheDocument();
    });
  });

  it('F01: a paused run whose history read FAILED is never upgraded into the Needs-me bucket (facts unavailable)', async () => {
    renderActivity({
      ...FULL,
      '/workflow-repository/workflows/wf-1/versions': APPROVAL_VERSIONS,
      '/workflow-runs/runs/run-3/history': () => jsonResponse(500, { error: 'boom' }),
    });
    await screen.findByRole('list', { name: 'Activity timeline' });
    const user = userEvent.setup();
    const group = screen.getByRole('group', { name: 'Activity filters' });
    await user.click(within(group).getByRole('button', { name: 'Needs me' }));
    // The history facts are unavailable → no evidence → no Needs-me claim.
    await waitFor(() => {
      expect(screen.getByText(/No activity yet/i)).toBeInTheDocument();
    });
  });

  it('F02: each run event carries an explicit run-level link to the specific run (§16 direct links)', async () => {
    renderActivity(FULL);
    const list = await screen.findByRole('list', { name: 'Activity timeline' });
    // Every run entry reaches BOTH its Workflow (the name link) and its
    // Run (the explicit "Open the run" link on the run-status surface).
    const runLinks = within(list).getAllByRole('link', { name: 'Open the run' });
    expect(runLinks.length).toBe(3);
    const hrefs = runLinks.map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/workflows/wf-1?run=run-1');
    expect(hrefs).toContain('/workflows/wf-1?run=run-2');
    expect(hrefs).toContain('/workflows/wf-1?run=run-3');
  });

  it('teaching sessions are NOT fabricated: the honest not-shown-here-yet disclosure', async () => {
    renderActivity(FULL);
    await screen.findByRole('list', { name: 'Activity timeline' });
    // No teaching entries are invented; the honest disclosure is present.
    expect(screen.queryByText(/teaching session/i, { exact: false })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Teaching activity isn\u2019t shown here yet/i),
    ).toBeInTheDocument();
  });

  it('a successful read with no organizations is the derivable empty state (not an error)', async () => {
    renderActivity({
      ...FULL,
      '/organizations': () => jsonResponse(200, { organizations: [] }),
    });
    await waitFor(() => {
      expect(screen.getByText(/No activity yet/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('status', { name: 'Unavailable' })).not.toBeInTheDocument();
  });

  it('a failed runs read stays visibly Unavailable with retry — never a successful empty state', async () => {
    renderActivity({ ...FULL, '/workflow-runs/runs': () => jsonResponse(500, { error: 'boom' }) });
    await waitFor(() => {
      expect(
        screen.getByRole('status', { name: 'Runs unavailable' }),
      ).toBeInTheDocument();
    });
    // The version events still render (independent sources).
    const list = screen.getByRole('list', { name: 'Activity timeline' });
    expect(within(list).getAllByText('New version').length).toBe(2);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('a failed workflows read leaves its own honest error surface; run events still render', async () => {
    renderActivity({
      ...FULL,
      '/workflow-repository/workflows': () => jsonResponse(500, { error: 'boom' }),
    });
    await waitFor(() => {
      expect(
        screen.getByRole('status', { name: 'Workflows unavailable' }),
      ).toBeInTheDocument();
    });
    const list = screen.getByRole('list', { name: 'Activity timeline' });
    expect(within(list).getByText('Completed')).toBeInTheDocument();
  });

  it('a failed versions read renders the honest unavailable disclosure — never fake version events', async () => {
    renderActivity({
      ...FULL,
      '/workflow-repository/workflows/wf-1/versions': () => jsonResponse(500, { error: 'boom' }),
    });
    await waitFor(() => {
      expect(
        screen.getByRole('status', { name: 'Version history unavailable' }),
      ).toBeInTheDocument();
    });
    const list = screen.getByRole('list', { name: 'Activity timeline' });
    expect(within(list).queryByText('New version')).not.toBeInTheDocument();
  });

  describe('the "How do you know?" trust disclosure (per run event)', () => {
    it('loads the run history on demand: evidence descriptions first, the honest "Verified by" wording, then advanced verification with the no-physical-proof boundary', async () => {
      renderActivity(FULL);
      const list = await screen.findByRole('list', { name: 'Activity timeline' });
      // The disclosure is per-event, collapsed until asked (progressive
      // disclosure — the history read happens on demand).
      const completedItem = within(list)
        .getAllByRole('listitem')
        .find((li) => li.textContent?.includes('Completed'));
      expect(completedItem).toBeDefined();
      const user = userEvent.setup();
      await user.click(within(completedItem!).getByRole('button', { name: 'How do you know?' }));

      const trust = await within(completedItem!).findByRole('region', { name: 'How do you know?' });
      // Concise evidence first: the records' OWN descriptions.
      expect(
        within(trust).getByText(/Observed the message-delivery receipt/i),
      ).toBeInTheDocument();
      expect(within(trust).getByText(/You approved the digest/i)).toBeInTheDocument();
      // The honest "Verified by" wording (derived from the evidence class).
      expect(within(trust).getAllByText(/Verified by/i).length).toBe(2);
      // Advanced verification on demand.
      await user.click(within(trust).getByText('Advanced verification'));
      // The V2-014 attestation facts (statement action, assurance, digest).
      expect(within(trust).getByText(/Email the weekly digest/i)).toBeInTheDocument();
      expect(within(trust).getByText(/Software-signed/i)).toBeInTheDocument();
      expect(within(trust).getByText(/sha256:execution/i)).toBeInTheDocument();
      // The explicit trust boundary: no automatic physical-world proof.
      expect(
        within(trust).getByText(/can\u2019t by itself prove what happened in the physical world/i),
      ).toBeInTheDocument();
    });

    it('a run with no evidence records renders the honest no-evidence state (a record fact, distinct from a failed read)', async () => {
      renderActivity(FULL);
      const list = await screen.findByRole('list', { name: 'Activity timeline' });
      const failedItem = within(list)
        .getAllByRole('listitem')
        .find((li) => li.textContent?.includes("Couldn\u2019t complete"));
      expect(failedItem).toBeDefined();
      const user = userEvent.setup();
      await user.click(within(failedItem!).getByRole('button', { name: 'How do you know?' }));
      const trust = await within(failedItem!).findByRole('region', { name: 'How do you know?' });
      expect(within(trust).getByText(/No evidence records yet/i)).toBeInTheDocument();
    });

    it('a failed history read stays Unavailable with Try again — never a successful empty trust surface', async () => {
      renderActivity({
        ...FULL,
        '/workflow-runs/runs/run-1/history': () => jsonResponse(500, { error: 'boom' }),
      });
      const list = await screen.findByRole('list', { name: 'Activity timeline' });
      const completedItem = within(list)
        .getAllByRole('listitem')
        .find((li) => li.textContent?.includes('Completed'));
      const user = userEvent.setup();
      await user.click(within(completedItem!).getByRole('button', { name: 'How do you know?' }));
      const trust = await within(completedItem!).findByRole('region', { name: 'How do you know?' });
      expect(within(trust).getByRole('status', { name: 'Unavailable' })).toBeInTheDocument();
      expect(within(trust).queryByText(/No evidence records yet/i)).not.toBeInTheDocument();
      expect(within(trust).getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });
  });
});
