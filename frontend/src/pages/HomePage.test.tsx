/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import HomePage from './HomePage';

/**
 * V2-017 T2 — the workflow-first Home contract.
 *
 * The dispatch (Issue #179) owns: the primary goal/search/creation entry,
 * the Describe it / Show me / Describe + show entry points, recent
 * workflows, needs-attention, pending approvals, updates, and device
 * issues — each wired surface distinguishing EXPLICITLY between loading,
 * error, successful-empty, and data; surfaces without an exposed
 * authoritative read render an honest "Unavailable" state instead of a
 * fabricated empty one. Failed reads never become successful empty states.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = () => Response | Promise<Response>;

function mockApi(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
  // Longest fragment first: '/organizations/org-1/workflow-repository/workflows'
  // must match its own handler, not the bare '/organizations' one. Keys may
  // carry a method prefix ('POST /path') that matches only that HTTP verb
  // (the REALITY-REPAIR-002 onboarding command needs GET /organizations and
  // POST /organizations to answer differently).
  const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const [fragment, handler] of ordered) {
      const methodPrefix = /^([A-Z]+) (.*)$/.exec(fragment);
      if (methodPrefix) {
        if (methodPrefix[1] === method && url.includes(methodPrefix[2])) {
          return Promise.resolve(handler());
        }
        continue;
      }
      if (url.includes(fragment)) return Promise.resolve(handler());
    }
    return Promise.resolve(jsonResponse(500, { error: `unmocked ${method} ${url}` }));
  });
}

function locationProbe() {
  return function LocationProbe() {
    const location = useLocation();
    return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
  };
}

function renderHome(routes: Record<string, RouteHandler>) {
  vi.stubGlobal('fetch', mockApi(routes));
  const Probe = locationProbe();
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/create" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const emptyOrgs: RouteHandler = () => jsonResponse(200, { organizations: [] });
const orgsOne: RouteHandler = () =>
  jsonResponse(200, { organizations: [{ id: 'org-1', name: 'Acme', roleId: 'owner' }] });
const workflows: RouteHandler = () =>
  jsonResponse(200, {
    workflows: [
      {
        id: 'wf-1',
        organizationId: 'org-1',
        ownerUserId: 'u-1',
        slug: 'weekly-invoice-digest',
        name: 'Weekly invoice digest',
        description: 'Collect invoices and email the digest.',
        visibility: 'private',
        headVersionId: 'ver-1',
        forkedFromWorkflowId: null,
        forkedFromVersionId: null,
        createdAt: '2026-09-01T10:00:00Z',
        updatedAt: '2026-09-04T09:00:00Z',
      },
      {
        id: 'wf-2',
        organizationId: 'org-1',
        ownerUserId: 'u-1',
        slug: 'lead-followup',
        name: 'Lead follow-up',
        description: null,
        visibility: 'private',
        headVersionId: 'ver-2',
        forkedFromWorkflowId: null,
        forkedFromVersionId: null,
        createdAt: '2026-09-02T10:00:00Z',
        updatedAt: '2026-09-03T08:00:00Z',
      },
    ],
  });
const runs: RouteHandler = () =>
  jsonResponse(200, {
    runs: [
      {
        id: 'run-1',
        organizationId: 'org-1',
        workflowId: 'wf-1',
        versionId: 'ver-1',
        state: 'failed',
        createdAt: '2026-09-04T08:00:00Z',
        updatedAt: '2026-09-04T08:30:00Z',
      },
      {
        id: 'run-2',
        organizationId: 'org-1',
        workflowId: 'wf-1',
        versionId: 'ver-1',
        state: 'paused',
        createdAt: '2026-09-04T07:00:00Z',
        updatedAt: '2026-09-04T07:10:00Z',
      },
      {
        id: 'run-3',
        organizationId: 'org-1',
        workflowId: 'wf-2',
        versionId: 'ver-2',
        state: 'completed',
        createdAt: '2026-09-03T07:00:00Z',
        updatedAt: '2026-09-03T09:00:00Z',
      },
      {
        id: 'run-4',
        organizationId: 'org-1',
        workflowId: 'wf-2',
        versionId: 'ver-2',
        state: 'running',
        createdAt: '2026-09-04T09:00:00Z',
        updatedAt: '2026-09-04T09:05:00Z',
      },
    ],
  });

describe('V2-017 T2 — workflow-first Home', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockApi({ '/organizations': emptyOrgs }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('primary goal/search/creation entry', () => {
    it('renders the goal heading with the search entry and the three entry modes', async () => {
      renderHome({ '/organizations': emptyOrgs });
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: /What do you want to get done\?/i })).toBeInTheDocument(),
      );
      expect(screen.getByRole('search')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /goal or search/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Describe it' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show me' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Describe + show' })).toBeInTheDocument();
    });

    it('navigates each entry mode to Create with its mode parameter', async () => {
      renderHome({ '/organizations': emptyOrgs });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Show me' }));
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/create?mode=show'));
    });

    it('starts creation from a typed goal through the search entry', async () => {
      renderHome({ '/organizations': emptyOrgs });
      const user = userEvent.setup();
      await user.type(screen.getByRole('textbox', { name: /goal or search/i }), 'invoice processing');
      await user.click(screen.getByRole('button', { name: 'Start' }));
      await waitFor(() => {
        const probe = screen.getByTestId('location');
        const params = new URLSearchParams(probe.textContent?.replace('/create?', '') ?? '');
        expect(probe.textContent).toContain('/create');
        expect(params.get('mode')).toBe('tell');
        expect(params.get('q')).toBe('invoice processing');
      });
    });
  });

  describe('recent workflows — explicit honest states', () => {
    it('shows a loading state while the read is in flight', async () => {
      let release!: (r: Response) => void;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      renderHome({ '/organizations': () => gate });
      expect(screen.getAllByRole('status', { name: /loading/i }).length).toBe(2);
      release(jsonResponse(200, { organizations: [] }));
      await waitFor(() =>
        expect(screen.queryAllByRole('status', { name: /loading/i }).length).toBe(0),
      );
    });

    it('renders a successful empty state (no organization ⇒ derivably no workflows)', async () => {
      renderHome({ '/organizations': emptyOrgs });
      const section = await screen.findByRole('region', { name: 'Recent workflows' });
      await waitFor(() => expect(within(section).getByText(/No workflows yet/i)).toBeInTheDocument());
      expect(within(section).queryByText(/Unavailable/i)).not.toBeInTheDocument();
      expect(within(section).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('renders real workflow records, most recent first, linking to the library', async () => {
      renderHome({
        '/workflow-repository/workflows': workflows,
        '/workflow-runs/runs': () => jsonResponse(200, { runs: [] }),
        '/organizations': orgsOne,
      });
      const section = await screen.findByRole('region', { name: 'Recent workflows' });
      const names = await within(section).findAllByRole('listitem');
      expect(names.map((n) => n.textContent)).toEqual([
        expect.stringMatching(/Weekly invoice digest/),
        expect.stringMatching(/Lead follow-up/),
      ]);
      expect(within(section).getByRole('link', { name: /see all/i })).toHaveAttribute('href', '/workflows');
      expect(within(section).queryByText(/No workflows yet/i)).not.toBeInTheDocument();
    });

    it('renders a visible error (never a fake empty) when the organization read fails', async () => {
      renderHome({ '/organizations': () => jsonResponse(500, { error: 'boom' }) });
      const section = await screen.findByRole('region', { name: 'Recent workflows' });
      await waitFor(() => expect(within(section).getByRole('alert')).toBeInTheDocument());
      expect(within(section).getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(within(section).queryByText(/No workflows yet/i)).not.toBeInTheDocument();
      expect(within(section).queryByText(/Unavailable/i)).not.toBeInTheDocument();
    });

    it('renders a visible error when the workflow read itself fails', async () => {
      renderHome({
        '/organizations': orgsOne,
        '/workflow-repository/workflows': () => jsonResponse(500, { error: 'boom' }),
      });
      const section = await screen.findByRole('region', { name: 'Recent workflows' });
      await waitFor(() => expect(within(section).getByRole('alert')).toBeInTheDocument());
      expect(within(section).queryByText(/No workflows yet/i)).not.toBeInTheDocument();
    });
  });

  describe('needs attention — derived from the run read', () => {
    it('lists failed and paused runs (not completed or running)', async () => {
      renderHome({
        '/workflow-repository/workflows': workflows,
        '/workflow-runs/runs': runs,
        '/organizations': orgsOne,
      });
      const section = await screen.findByRole('region', { name: 'Needs attention' });
      const items = await within(section).findAllByRole('listitem');
      expect(items.length).toBe(2);
      expect(within(items[0]).getByText('Failed')).toBeInTheDocument();
      expect(within(items[1]).getByText('Paused')).toBeInTheDocument();
      expect(within(section).getByRole('link', { name: /see all/i })).toHaveAttribute('href', '/activity');
    });

    it('renders the honest empty state when nothing needs attention', async () => {
      renderHome({
        '/workflow-repository/workflows': workflows,
        '/workflow-runs/runs': () => jsonResponse(200, { runs: [] }),
        '/organizations': orgsOne,
      });
      const section = await screen.findByRole('region', { name: 'Needs attention' });
      await waitFor(() =>
        expect(within(section).getByText(/Nothing needs your attention/i)).toBeInTheDocument(),
      );
      expect(within(section).queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('F-T2-001 regression — Home aggregates EVERY organization of the session user', () => {
    const orgsTwo: RouteHandler = () =>
      jsonResponse(200, {
        organizations: [
          { id: 'org-1', name: 'Acme', roleId: 'owner' },
          { id: 'org-2', name: 'Globex', roleId: 'owner' },
        ],
      });
    const acmeWorkflows: RouteHandler = () =>
      jsonResponse(200, {
        workflows: [
          {
            id: 'wf-acme-1',
            organizationId: 'org-1',
            ownerUserId: 'u-1',
            slug: 'acme-invoice-digest',
            name: 'Acme invoice digest',
            description: null,
            visibility: 'private',
            headVersionId: 'ver-1',
            forkedFromWorkflowId: null,
            forkedFromVersionId: null,
            createdAt: '2026-09-01T10:00:00Z',
            updatedAt: '2026-09-02T08:00:00Z',
          },
        ],
      });
    const globexWorkflows: RouteHandler = () =>
      jsonResponse(200, {
        workflows: [
          {
            id: 'wf-globex-1',
            organizationId: 'org-2',
            ownerUserId: 'u-1',
            slug: 'globex-weekly-report',
            name: 'Globex weekly report',
            description: null,
            visibility: 'private',
            headVersionId: 'ver-2',
            forkedFromWorkflowId: null,
            forkedFromVersionId: null,
            createdAt: '2026-09-03T10:00:00Z',
            updatedAt: '2026-09-04T09:00:00Z',
          },
        ],
      });
    const acmeRuns: RouteHandler = () =>
      jsonResponse(200, {
        runs: [
          {
            id: 'run-acme-1',
            organizationId: 'org-1',
            workflowId: 'wf-acme-1',
            versionId: 'ver-1',
            state: 'failed',
            createdAt: '2026-09-04T08:00:00Z',
            updatedAt: '2026-09-04T08:30:00Z',
          },
        ],
      });
    const globexRuns: RouteHandler = () =>
      jsonResponse(200, {
        runs: [
          {
            id: 'run-globex-1',
            organizationId: 'org-2',
            workflowId: 'wf-globex-1',
            versionId: 'ver-2',
            state: 'paused',
            createdAt: '2026-09-04T07:00:00Z',
            updatedAt: '2026-09-04T07:10:00Z',
          },
        ],
      });
    const noItems: RouteHandler = () => jsonResponse(200, { workflows: [], runs: [] });
    const failure: RouteHandler = () => jsonResponse(500, { error: 'boom' });

    it('shows workflow records from BOTH organizations, keeping the recent ordering across orgs', async () => {
      renderHome({
        '/organizations/org-1/workflow-repository/workflows': acmeWorkflows,
        '/organizations/org-2/workflow-repository/workflows': globexWorkflows,
        '/organizations/org-1/workflow-runs/runs': noItems,
        '/organizations/org-2/workflow-runs/runs': noItems,
        '/organizations': orgsTwo,
      });
      const section = await screen.findByRole('region', { name: 'Recent workflows' });
      const items = await within(section).findAllByRole('listitem');
      // Most recent first across the aggregate: Globex (09-04) precedes Acme (09-02)
      // even though Acme is the first organization in the collection.
      expect(items.map((n) => n.textContent)).toEqual([
        expect.stringMatching(/Globex weekly report/),
        expect.stringMatching(/Acme invoice digest/),
      ]);
    });

    it('shows attention runs from BOTH organizations', async () => {
      renderHome({
        '/organizations/org-1/workflow-repository/workflows': acmeWorkflows,
        '/organizations/org-2/workflow-repository/workflows': globexWorkflows,
        '/organizations/org-1/workflow-runs/runs': acmeRuns,
        '/organizations/org-2/workflow-runs/runs': globexRuns,
        '/organizations': orgsTwo,
      });
      const section = await screen.findByRole('region', { name: 'Needs attention' });
      const items = await within(section).findAllByRole('listitem');
      expect(items.length).toBe(2);
      expect(within(items[0]).getByText('Failed')).toBeInTheDocument();
      expect(within(items[1]).getByText('Paused')).toBeInTheDocument();
    });

    it('renders Error for the affected surface when one organization read fails — never a silent partial success', async () => {
      renderHome({
        // org-1's workflow read succeeds, org-2's fails: the aggregate must
        // be an ERROR for Recent workflows — the org-1 records must NOT be
        // presented as a successful (partial) result, and never as empty.
        '/organizations/org-1/workflow-repository/workflows': acmeWorkflows,
        '/organizations/org-2/workflow-repository/workflows': failure,
        '/organizations/org-1/workflow-runs/runs': noItems,
        '/organizations/org-2/workflow-runs/runs': noItems,
        '/organizations': orgsTwo,
      });
      const workflowsSection = await screen.findByRole('region', { name: 'Recent workflows' });
      await waitFor(() => expect(within(workflowsSection).getByRole('alert')).toBeInTheDocument());
      expect(within(workflowsSection).getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(within(workflowsSection).queryAllByRole('listitem')).toHaveLength(0);
      expect(within(workflowsSection).queryByText(/No workflows yet/i)).not.toBeInTheDocument();
      // The error is scoped to the affected surface: the run reads all
      // succeeded, so Needs attention stays honestly empty.
      const attentionSection = await screen.findByRole('region', { name: 'Needs attention' });
      await waitFor(() =>
        expect(within(attentionSection).getByText(/Nothing needs your attention/i)).toBeInTheDocument(),
      );
      expect(within(attentionSection).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('renders Error for Needs attention when one organization run read fails — never partial, never empty', async () => {
      renderHome({
        '/organizations/org-1/workflow-repository/workflows': acmeWorkflows,
        '/organizations/org-2/workflow-repository/workflows': globexWorkflows,
        // org-1's run read succeeds, org-2's fails: Needs attention must be
        // an ERROR — org-1's attention run must not silently stand in.
        '/organizations/org-1/workflow-runs/runs': acmeRuns,
        '/organizations/org-2/workflow-runs/runs': failure,
        '/organizations': orgsTwo,
      });
      const attentionSection = await screen.findByRole('region', { name: 'Needs attention' });
      await waitFor(() => expect(within(attentionSection).getByRole('alert')).toBeInTheDocument());
      expect(within(attentionSection).getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(within(attentionSection).queryAllByRole('listitem')).toHaveLength(0);
      expect(within(attentionSection).queryByText(/Nothing needs your attention/i)).not.toBeInTheDocument();
      // The workflow reads all succeeded: Recent workflows shows real data.
      const workflowsSection = await screen.findByRole('region', { name: 'Recent workflows' });
      await waitFor(() => expect(within(workflowsSection).getAllByRole('listitem').length).toBe(2));
      expect(within(workflowsSection).queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('surfaces without an exposed read stay honestly Unavailable', () => {
    it('marks pending approvals, updates, and device issues Unavailable — never fake-empty', async () => {
      renderHome({
        '/workflow-repository/workflows': workflows,
        '/workflow-runs/runs': runs,
        '/organizations': orgsOne,
      });
      const approvals = await screen.findByRole('region', { name: 'Pending approvals' });
      const updates = await screen.findByRole('region', { name: 'Updates' });
      const devices = await screen.findByRole('region', { name: 'Device issues' });
      for (const section of [approvals, updates, devices]) {
        expect(within(section).getByRole('status', { name: 'Unavailable' })).toBeInTheDocument();
        expect(within(section).queryByText(/no items yet/i)).not.toBeInTheDocument();
        expect(within(section).queryByText(/nothing yet/i)).not.toBeInTheDocument();
      }
    });
  });
});

/**
 * REALITY-REPAIR-002 — the fresh-user zero-org condition (F-002 regression).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-002.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-002 ACCEPT).
 *
 * F-002 (the audit's release blocker): a fresh signup reaches Home with ZERO
 * organizations while org-scoped product capabilities silently become
 * ineffective — the UI renders "No workflows yet" (a derivably-empty state
 * presented as though the user had simply not created anything) with NO path
 * to create or select the organization every product action is scoped to.
 *
 * The repair: Home — the first-run landing — renders the explicit
 * organization onboarding card when the organizations read succeeds and is
 * empty. Creation goes through the EXISTING POST /organizations authority
 * only; on success the Home surfaces re-aggregate across the created
 * organization (the org-scoped reads now target it). The onboarding card
 * NEVER renders for a failed read (that stays an honest error, never a fake
 * empty) and never for a user who already has an organization.
 */
describe('REALITY-REPAIR-002 — fresh-user zero-org onboarding (F-002)', () => {
  it('renders the explicit organization onboarding when the fresh user has zero organizations (the silent no-op repaired)', async () => {
    renderHome({
      '/organizations': emptyOrgs,
      '/workflow-runs/runs': () => jsonResponse(200, { runs: [] }),
    });
    // The F-002 defect at base: zero orgs rendered ONLY the generic empty
    // copy — no onboarding, no actionable target for any org-scoped action.
    const onboarding = await screen.findByRole('region', {
      name: 'Organization onboarding',
    });
    expect(onboarding).toBeVisible();
    expect(
      screen.getByRole('heading', { name: /set up your organization/i }),
    ).toBeVisible();
    expect(screen.getByLabelText(/organization name/i)).toBeVisible();
    expect(
      screen.getByRole('button', { name: /create organization/i }),
    ).toBeVisible();
    // The derivably-empty workflow copy may coexist (it is honest), but the
    // onboarding states the real first-run reason: an organization is needed.
    const workflowsSection = await screen.findByRole('region', {
      name: 'Recent workflows',
    });
    await waitFor(() =>
      expect(within(workflowsSection).getByText(/No workflows yet/i)).toBeInTheDocument(),
    );
  });

  it('creates the organization through the EXISTING POST /organizations authority and re-scopes the Home reads to the created organization', async () => {
    const user = userEvent.setup();
    // The orgs read succeeds empty until the create command lands; the 201
    // response is the authoritative record the surfaces then re-read.
    let created = false;
    const orgsHandler = () =>
      jsonResponse(
        200,
        created
          ? {
              organizations: [
                { id: 'org-new', name: 'Fresh User Co', roleId: 'owner' },
              ],
            }
          : { organizations: [] },
      );
    const orgWorkflowReads: string[] = [];
    const orgRunReads: string[] = [];
    renderHome({
      '/organizations': orgsHandler,
      'POST /organizations': () => {
        created = true;
        return jsonResponse(201, {
          organization: { id: 'org-new', name: 'Fresh User Co' },
          roleId: 'owner',
        });
      },
      '/workflow-repository/workflows': () => {
        orgWorkflowReads.push('called');
        return jsonResponse(200, { workflows: [] });
      },
      '/workflow-runs/runs': () => {
        orgRunReads.push('called');
        return jsonResponse(200, { runs: [] });
      },
    });

    const onboarding = await screen.findByRole('region', {
      name: 'Organization onboarding',
    });
    await user.type(
      within(onboarding).getByLabelText(/organization name/i),
      'Fresh User Co',
    );
    await user.click(
      within(onboarding).getByRole('button', { name: /create organization/i }),
    );

    // The exact existing command: POST /organizations { name }.
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/organizations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Fresh User Co' }),
      }),
    );
    // The onboarding resolves (the card leaves the landing — the zero-org
    // condition is gone), and the Home surfaces re-aggregate across the
    // CREATED organization: the org-scoped reads now run for it.
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Organization onboarding' }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(orgWorkflowReads.length).toBeGreaterThan(0));
    await waitFor(() => expect(orgRunReads.length).toBeGreaterThan(0));
    // Home remains honest: no fabricated workflows for the new org — the
    // derivably-empty copy renders from the successful re-read.
    const workflowsSection = await screen.findByRole('region', {
      name: 'Recent workflows',
    });
    await waitFor(() =>
      expect(within(workflowsSection).getByText(/No workflows yet/i)).toBeInTheDocument(),
    );
  });

  it('renders NO onboarding when organizations exist (no unrelated UX for tenanted users)', async () => {
    renderHome({
      '/workflow-repository/workflows': workflows,
      '/workflow-runs/runs': () => jsonResponse(200, { runs: [] }),
      '/organizations': orgsOne,
    });
    await screen.findByRole('region', { name: 'Recent workflows' });
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Organization onboarding' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('renders NO onboarding when the organizations read itself fails — a failed read is never a fake onboarding-empty', async () => {
    renderHome({
      '/organizations': () => jsonResponse(503, { error: 'unavailable' }),
    });
    await screen.findByRole('region', { name: 'Recent workflows' });
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Organization onboarding' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /create organization/i })).not.toBeInTheDocument();
  });
});
