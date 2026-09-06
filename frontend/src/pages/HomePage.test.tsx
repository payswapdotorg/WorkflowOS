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
      // Four reads gate on the organizations read: recent workflows,
      // needs attention, and the two REALITY-REPAIR-005 composed surfaces
      // (Pending approvals and Updates aggregate the same org-scoped
      // reads). The orgs read itself has no visible loading state.
      expect(screen.getAllByRole('status', { name: /loading/i }).length).toBe(4);
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
    // REALITY-REPAIR-005 narrowed this contract to Device issues (F-006:
    // no public device-status read exists — an explicit deferral). Pending
    // approvals and Updates are COMPOSED surfaces now (the F-005 repair
    // above) — their honest states are pinned in the REALITY-REPAIR-005
    // block.
    it('marks device issues Unavailable — never fake-empty (the F-006 deferral preserved)', async () => {
      renderHome({
        '/workflow-repository/workflows': workflows,
        '/workflow-runs/runs': runs,
        '/organizations': orgsOne,
      });
      const devices = await screen.findByRole('region', { name: 'Device issues' });
      expect(within(devices).getByRole('status', { name: 'Unavailable' })).toBeInTheDocument();
      expect(within(devices).queryByText(/no items yet/i)).not.toBeInTheDocument();
      expect(within(devices).queryByText(/nothing yet/i)).not.toBeInTheDocument();
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

/**
 * REALITY-REPAIR-005 — Home approvals/updates composition (F-005 regression).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-005.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-005 ACCEPT;
 * GitHub dispatch Issue #26).
 *
 * F-005 (the audited UX defect): Home rendered "Pending approvals" and
 * "Updates" as Unavailable surfaces claiming approvals/updates "aren't part
 * of the product" — FALSE: the V2-005 approval gates ARE the product (the
 * RunExperience status surface already derives "Waiting for you" from a
 * paused run's history + the pinned version's approval nodes), and the
 * VersionsExperience §19 update banner already derives
 * installed-behind-head from the installation + versions reads.
 *
 * The repair composes BOTH Home surfaces from the EXISTING reads and the
 * SAME derivations (no aggregate authority, no duplicated attention state):
 *   - Pending approvals = the paused runs of every caller org (the V2-005
 *     run read, F-T2-001 all-or-error) + each paused run's history read
 *     (the workflow.run.paused entry's detail.atStepId — never guessed) +
 *     the run-pinned version's IR approval nodes; the item links "Open the
 *     run" to /workflows/:workflowId?run=:runId (the T10 F02 pattern).
 *   - Updates = the installation read across every caller org + the public
 *     versions read: an installation whose pinned version number is behind
 *     the workflow's head version number is the update item, carrying the
 *     honest §19 "pinned, never auto-updated" vocabulary and a link to the
 *     workflow detail — where the real adoption action lives (NEVER
 *     duplicated on Home).
 *   - Device issues STAYS the honest Unavailable surface (F-006: no public
 *     device-status read exists — an explicit deferral, not a defect).
 *
 * State honesty per surface (the frozen contract): loading / error with
 * retry / successful empty / data — a failed read is NEVER a successful
 * empty; all-or-error aggregation (a partial collection is never a
 * success).
 */
describe('REALITY-REPAIR-005 — Home approvals/updates composition (F-005)', () => {
  // --- the fixtures (the wire shapes the existing surfaces consume) --------

  /** IR content whose review_gate node IS an approval node (the consent facts). */
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

  const versionRow = (id: string, versionNumber: number, content: unknown) => ({
    id,
    workflowId: 'wf-1',
    versionNumber,
    contentDigest: `sha256:${id}`,
    content,
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    parentVersionId: versionNumber === 1 ? null : `ver-${versionNumber - 1}`,
    createdByUserId: 'u-1',
    createdAt: `2026-09-0${versionNumber}T10:00:00Z`,
  });

  /** wf-1's versions where ver-1 (run-2's pin) declares the approval node. */
  const wf1ApprovalVersions: RouteHandler = () =>
    jsonResponse(200, { versions: [versionRow('ver-1', 1, APPROVAL_IR_CONTENT)] });

  /** wf-1's versions: ver-1 plain + ver-2 plain (head 2 > pin 1). */
  const wf1Versions12: RouteHandler = () =>
    jsonResponse(200, { versions: [versionRow('ver-1', 1, {}), versionRow('ver-2', 2, {})] });

  /** wf-1's versions: ver-1 approval + ver-2 plain (both surfaces' fixtures). */
  const wf1ApprovalThenPlainVersions: RouteHandler = () =>
    jsonResponse(200, {
      versions: [versionRow('ver-1', 1, APPROVAL_IR_CONTENT), versionRow('ver-2', 2, {})],
    });

  /** wf-1's versions: only the installed pin (at head — no update). */
  const wf1Version1Only: RouteHandler = () =>
    jsonResponse(200, { versions: [versionRow('ver-1', 1, {})] });

  /** The public workflow read of wf-1 (the V2-002 public name source). */
  const workflowWf1: RouteHandler = () =>
    jsonResponse(200, {
      workflow: {
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
    });

  const emptyTimeline = {
    attempts: [],
    steps: [],
    invocations: [],
    evidence: [],
    attestations: [],
    attestationRejections: [],
    commands: [],
  };

  /** run-2's history: the pause rides detail.atStepId at the approval step. */
  const run2ApprovalHistory: RouteHandler = () =>
    jsonResponse(200, {
      run: { id: 'run-2', state: 'paused' },
      timeline: [
        {
          id: 'tl-2',
          runId: 'run-2',
          attemptNumber: 1,
          stepId: null,
          eventName: 'workflow.run.started',
          occurredAt: '2026-09-04T07:00:10Z',
          sequence: 1,
          detail: null,
        },
        {
          id: 'tl-2b',
          runId: 'run-2',
          attemptNumber: 1,
          stepId: null,
          eventName: 'workflow.run.paused',
          occurredAt: '2026-09-04T07:10:00Z',
          sequence: 2,
          detail: { atStepId: 'review_gate' },
        },
      ],
      ...emptyTimeline,
    });

  /** run-2's history when the pause is NOT at an approval step. */
  const run2PlainPauseHistory: RouteHandler = () =>
    jsonResponse(200, {
      run: { id: 'run-2', state: 'paused' },
      timeline: [
        {
          id: 'tl-2b',
          runId: 'run-2',
          attemptNumber: 1,
          stepId: null,
          eventName: 'workflow.run.paused',
          occurredAt: '2026-09-04T07:10:00Z',
          sequence: 2,
          detail: { atStepId: 'send_followup' },
        },
      ],
      ...emptyTimeline,
    });

  /** The consumer org's installations: one enabled installation pinning ver-1. */
  const installationsBehindHead: RouteHandler = () =>
    jsonResponse(200, {
      installations: [
        {
          installation: {
            id: 'inst-1',
            organizationId: 'org-1',
            workflowId: 'wf-1',
            versionId: 'ver-1',
            installedByUserId: 'u-1',
            status: 'enabled',
            installedAt: '2026-09-03T10:00:00Z',
            updatedAt: '2026-09-03T10:00:00Z',
          },
          pinnedVersion: {
            id: 'ver-1',
            workflowId: 'wf-1',
            versionNumber: 1,
            contentDigest: 'sha256:ver-1',
            protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
          },
        },
      ],
    });

  const noRuns: RouteHandler = () => jsonResponse(200, { runs: [] });
  const noInstallations: RouteHandler = () => jsonResponse(200, { installations: [] });

  // --- Pending approvals: the composed data state ---------------------------

  it('lists the approval-waiting run (paused at an IR approval step) with the Open-the-run direct link', async () => {
    renderHome({
      '/workflow-runs/runs/run-2/history': run2ApprovalHistory,
      '/workflow-repository/workflows/wf-1/versions': wf1ApprovalVersions,
      '/workflow-repository/workflows/wf-1': workflowWf1,
      '/workflow-repository/workflows': workflows,
      '/workflow-runs/runs': runs,
      '/organizations': orgsOne,
    });
    const section = await screen.findByRole('region', { name: 'Pending approvals' });
    // The SAME derivation the RunExperience status surface uses: paused
    // run-2 + the history's atStepId + the pinned version's approval node.
    await waitFor(() =>
      expect(within(section).getByText('Waiting for you')).toBeInTheDocument(),
    );
    expect(within(section).getByText('Weekly invoice digest')).toBeInTheDocument();
    expect(within(section).getByText(/paused for your approval/i)).toBeInTheDocument();
    // T10 F02: the run-level direct link — ?run= selects THIS run on the
    // workflow's run-status surface.
    const link = within(section).getByRole('link', { name: 'Open the run' });
    expect(link).toHaveAttribute('href', '/workflows/wf-1?run=run-2');
    // The surface is composed from the existing reads — never Unavailable.
    expect(within(section).queryByRole('status', { name: 'Unavailable' })).not.toBeInTheDocument();
  });

  it('approvals: a paused run NOT at an approval step is the honest empty — no evidence, no claim (the run stays in Needs attention)', async () => {
    renderHome({
      '/workflow-runs/runs/run-2/history': run2PlainPauseHistory,
      '/workflow-repository/workflows/wf-1/versions': wf1ApprovalVersions,
      '/workflow-repository/workflows/wf-1': workflowWf1,
      '/workflow-repository/workflows': workflows,
      '/workflow-runs/runs': runs,
      '/organizations': orgsOne,
    });
    const section = await screen.findByRole('region', { name: 'Pending approvals' });
    await waitFor(() =>
      expect(within(section).getByText(/No run is waiting at an approval step/i)).toBeInTheDocument(),
    );
    expect(within(section).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(section).queryByText('Waiting for you')).not.toBeInTheDocument();
    // The paused run is NOT hidden: the record fact stays in Needs attention.
    const attention = screen.getByRole('region', { name: 'Needs attention' });
    expect(within(attention).getByText('Paused')).toBeInTheDocument();
  });

  it('approvals: a failed history read renders the visible error with retry — never a fake empty', async () => {
    renderHome({
      '/workflow-runs/runs/run-2/history': () => jsonResponse(500, { error: 'boom' }),
      '/workflow-repository/workflows/wf-1/versions': wf1ApprovalVersions,
      '/workflow-repository/workflows/wf-1': workflowWf1,
      '/workflow-repository/workflows': workflows,
      '/workflow-runs/runs': runs,
      '/organizations': orgsOne,
    });
    const section = await screen.findByRole('region', { name: 'Pending approvals' });
    await waitFor(() => expect(within(section).getByRole('alert')).toBeInTheDocument());
    expect(within(section).getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(within(section).queryByText(/No run is waiting at an approval step/i)).not.toBeInTheDocument();
    expect(within(section).queryByText('Waiting for you')).not.toBeInTheDocument();
  });

  // --- Updates: the composed data state --------------------------------------

  it('lists the installed-behind-head workflow with the workflow-detail link (the §19 pin vocabulary; no adoption action on Home)', async () => {
    renderHome({
      '/organizations/org-1/workflow-repository/installations': installationsBehindHead,
      '/workflow-runs/runs/run-2/history': run2PlainPauseHistory,
      '/workflow-repository/workflows/wf-1/versions': wf1Versions12,
      '/workflow-repository/workflows/wf-1': workflowWf1,
      '/workflow-repository/workflows': workflows,
      '/workflow-runs/runs': runs,
      '/organizations': orgsOne,
    });
    const section = await screen.findByRole('region', { name: 'Updates' });
    await waitFor(() =>
      expect(within(section).getByText('Update available')).toBeInTheDocument(),
    );
    expect(within(section).getByText('Weekly invoice digest')).toBeInTheDocument();
    // The §19 derivation semantics: head 2 vs the pinned 1, the honest
    // pinned-never-auto-updated vocabulary.
    expect(within(section).getByText(/Version 2 is available/i)).toBeInTheDocument();
    expect(within(section).getByText(/stays pinned/i)).toBeInTheDocument();
    expect(
      within(section).getByText(/Nothing changes until you approve the update/i),
    ).toBeInTheDocument();
    // The link goes to the workflow detail — where the real adoption action
    // lives (never duplicated here: no Approve/Install button on Home).
    const link = within(section).getByRole('link', { name: 'Open the workflow' });
    expect(link).toHaveAttribute('href', '/workflows/wf-1');
    expect(within(section).queryByRole('button', { name: /approve|install|update/i })).not.toBeInTheDocument();
    expect(within(section).queryByRole('status', { name: 'Unavailable' })).not.toBeInTheDocument();
  });

  it('updates: an installation at head renders the honest empty — no fabricated update', async () => {
    renderHome({
      '/organizations/org-1/workflow-repository/installations': installationsBehindHead,
      '/workflow-runs/runs/run-2/history': run2PlainPauseHistory,
      '/workflow-repository/workflows/wf-1/versions': wf1Version1Only,
      '/workflow-repository/workflows/wf-1': workflowWf1,
      '/workflow-repository/workflows': workflows,
      '/workflow-runs/runs': runs,
      '/organizations': orgsOne,
    });
    const section = await screen.findByRole('region', { name: 'Updates' });
    await waitFor(() =>
      expect(within(section).getByText(/No updates available right now/i)).toBeInTheDocument(),
    );
    expect(within(section).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(section).queryByText('Update available')).not.toBeInTheDocument();
  });

  it('updates: a failed installations read renders the visible error with retry — never a fake empty', async () => {
    renderHome({
      '/organizations/org-1/workflow-repository/installations': () =>
        jsonResponse(500, { error: 'boom' }),
      '/workflow-runs/runs/run-2/history': run2PlainPauseHistory,
      '/workflow-repository/workflows/wf-1/versions': wf1Versions12,
      '/workflow-repository/workflows/wf-1': workflowWf1,
      '/workflow-repository/workflows': workflows,
      '/workflow-runs/runs': runs,
      '/organizations': orgsOne,
    });
    const section = await screen.findByRole('region', { name: 'Updates' });
    await waitFor(() => expect(within(section).getByRole('alert')).toBeInTheDocument());
    expect(within(section).getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(within(section).queryByText(/No updates available right now/i)).not.toBeInTheDocument();
    expect(within(section).queryByText('Update available')).not.toBeInTheDocument();
  });

  // --- F-T2-001: the new surfaces aggregate EVERY caller organization -------

  const orgsTwo: RouteHandler = () =>
    jsonResponse(200, {
      organizations: [
        { id: 'org-1', name: 'Acme', roleId: 'owner' },
        { id: 'org-2', name: 'Globex', roleId: 'owner' },
      ],
    });

  const org2ApprovalRun: RouteHandler = () =>
    jsonResponse(200, {
      runs: [
        {
          id: 'run-org2',
          organizationId: 'org-2',
          workflowId: 'wf-2',
          versionId: 'ver-2',
          state: 'paused',
          createdAt: '2026-09-04T07:00:00Z',
          updatedAt: '2026-09-04T07:10:00Z',
        },
      ],
    });

  const runOrg2ApprovalHistory: RouteHandler = () =>
    jsonResponse(200, {
      run: { id: 'run-org2', state: 'paused' },
      timeline: [
        {
          id: 'tl-org2',
          runId: 'run-org2',
          attemptNumber: 1,
          stepId: null,
          eventName: 'workflow.run.paused',
          occurredAt: '2026-09-04T07:10:00Z',
          sequence: 2,
          detail: { atStepId: 'review_gate' },
        },
      ],
      ...emptyTimeline,
    });

  const wf2ApprovalVersions: RouteHandler = () =>
    jsonResponse(200, {
      versions: [
        {
          id: 'ver-2',
          workflowId: 'wf-2',
          versionNumber: 1,
          contentDigest: 'sha256:ver-2',
          content: APPROVAL_IR_CONTENT,
          protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
          parentVersionId: null,
          createdByUserId: 'u-1',
          createdAt: '2026-09-01T10:00:00Z',
        },
      ],
    });

  const workflowWf2: RouteHandler = () =>
    jsonResponse(200, {
      workflow: {
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
    });

  it('approvals: aggregates approval-waiting runs across EVERY caller organization (F-T2-001)', async () => {
    renderHome({
      '/workflow-runs/runs/run-org2/history': runOrg2ApprovalHistory,
      '/workflow-repository/workflows/wf-2/versions': wf2ApprovalVersions,
      '/workflow-repository/workflows/wf-2': workflowWf2,
      '/organizations/org-1/workflow-runs/runs': noRuns,
      '/organizations/org-2/workflow-runs/runs': org2ApprovalRun,
      '/workflow-repository/workflows': workflows,
      '/organizations': orgsTwo,
    });
    const section = await screen.findByRole('region', { name: 'Pending approvals' });
    const link = await within(section).findByRole('link', { name: 'Open the run' });
    expect(link).toHaveAttribute('href', '/workflows/wf-2?run=run-org2');
    expect(within(section).getByText('Lead follow-up')).toBeInTheDocument();
  });

  it('approvals: one organization’s failed run read errors the surface — never a partial success', async () => {
    renderHome({
      '/workflow-runs/runs/run-org2/history': runOrg2ApprovalHistory,
      '/workflow-repository/workflows/wf-2/versions': wf2ApprovalVersions,
      '/workflow-repository/workflows/wf-2': workflowWf2,
      // org-1’s run read fails; org-2’s succeeds with the approval-waiting
      // run: the aggregate must be an ERROR — org-2’s item must NOT be
      // presented as a successful (partial) result, and never as empty.
      '/organizations/org-1/workflow-runs/runs': () => jsonResponse(500, { error: 'boom' }),
      '/organizations/org-2/workflow-runs/runs': org2ApprovalRun,
      '/workflow-repository/workflows': workflows,
      '/organizations': orgsTwo,
    });
    const section = await screen.findByRole('region', { name: 'Pending approvals' });
    await waitFor(() => expect(within(section).getByRole('alert')).toBeInTheDocument());
    expect(within(section).queryAllByRole('listitem')).toHaveLength(0);
    expect(within(section).queryByText(/No run is waiting at an approval step/i)).not.toBeInTheDocument();
  });

  const org2InstallationBehindHead: RouteHandler = () =>
    jsonResponse(200, {
      installations: [
        {
          installation: {
            id: 'inst-org2',
            organizationId: 'org-2',
            workflowId: 'wf-2',
            versionId: 'ver-2',
            installedByUserId: 'u-1',
            status: 'enabled',
            installedAt: '2026-09-03T10:00:00Z',
            updatedAt: '2026-09-03T10:00:00Z',
          },
          pinnedVersion: {
            id: 'ver-2',
            workflowId: 'wf-2',
            versionNumber: 1,
            contentDigest: 'sha256:ver-2',
            protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
          },
        },
      ],
    });

  const wf2Versions12: RouteHandler = () =>
    jsonResponse(200, {
      versions: [
        {
          id: 'ver-2',
          workflowId: 'wf-2',
          versionNumber: 1,
          contentDigest: 'sha256:ver-2',
          content: {},
          protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
          parentVersionId: null,
          createdByUserId: 'u-1',
          createdAt: '2026-09-01T10:00:00Z',
        },
        {
          id: 'ver-2b',
          workflowId: 'wf-2',
          versionNumber: 2,
          contentDigest: 'sha256:ver-2b',
          content: {},
          protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
          parentVersionId: 'ver-2',
          createdByUserId: 'u-1',
          createdAt: '2026-09-04T10:00:00Z',
        },
      ],
    });

  it('updates: aggregates installed-behind-head workflows across EVERY caller organization (F-T2-001)', async () => {
    renderHome({
      '/organizations/org-1/workflow-repository/installations': noInstallations,
      '/organizations/org-2/workflow-repository/installations': org2InstallationBehindHead,
      '/workflow-repository/workflows/wf-2/versions': wf2Versions12,
      '/workflow-repository/workflows/wf-2': workflowWf2,
      '/workflow-runs/runs': noRuns,
      '/workflow-repository/workflows': workflows,
      '/organizations': orgsTwo,
    });
    const section = await screen.findByRole('region', { name: 'Updates' });
    const link = await within(section).findByRole('link', { name: 'Open the workflow' });
    expect(link).toHaveAttribute('href', '/workflows/wf-2');
    expect(within(section).getByText('Lead follow-up')).toBeInTheDocument();
  });

  // --- Device issues stays the honest Unavailable surface (F-006) -----------

  it('Device issues STAYS the honest Unavailable surface (the F-006 deferral preserved — no public device-status read exists)', async () => {
    renderHome({
      '/workflow-runs/runs/run-2/history': run2ApprovalHistory,
      '/organizations/org-1/workflow-repository/installations': installationsBehindHead,
      '/workflow-repository/workflows/wf-1/versions': wf1ApprovalThenPlainVersions,
      '/workflow-repository/workflows/wf-1': workflowWf1,
      '/workflow-repository/workflows': workflows,
      '/workflow-runs/runs': runs,
      '/organizations': orgsOne,
    });
    // The composed surfaces render their data (both fixtures combined)…
    const approvals = await screen.findByRole('region', { name: 'Pending approvals' });
    await waitFor(() =>
      expect(within(approvals).getByText('Waiting for you')).toBeInTheDocument(),
    );
    const updates = screen.getByRole('region', { name: 'Updates' });
    await waitFor(() =>
      expect(within(updates).getByText('Update available')).toBeInTheDocument(),
    );
    // …while Device issues keeps its HONEST unavailable state (an explicit
    // product deferral, unlike the two repaired false claims).
    const devices = screen.getByRole('region', { name: 'Device issues' });
    expect(within(devices).getByRole('status', { name: 'Unavailable' })).toBeInTheDocument();
    expect(
      within(devices).getByText(/device status becomes part of the product/i),
    ).toBeInTheDocument();
  });

  it('no false “not part of the product” claims remain on approvals and updates (the F-005 copy defect)', async () => {
    renderHome({
      '/workflow-runs/runs/run-2/history': run2ApprovalHistory,
      '/organizations/org-1/workflow-repository/installations': installationsBehindHead,
      '/workflow-repository/workflows/wf-1/versions': wf1ApprovalThenPlainVersions,
      '/workflow-repository/workflows/wf-1': workflowWf1,
      '/workflow-repository/workflows': workflows,
      '/workflow-runs/runs': runs,
      '/organizations': orgsOne,
    });
    const approvals = await screen.findByRole('region', { name: 'Pending approvals' });
    const updates = await screen.findByRole('region', { name: 'Updates' });
    for (const section of [approvals, updates]) {
      // The FALSE unavailability claims are gone (approvals and updates ARE
      // part of the product — V2-005 approval gates; the V2-002 versions).
      expect(within(section).queryByText(/becomes? part of the product/i)).not.toBeInTheDocument();
      expect(within(section).queryByRole('status', { name: 'Unavailable' })).not.toBeInTheDocument();
    }
    // Device issues keeps its TRUE deferral copy (F-006 as-is).
    const devices = screen.getByRole('region', { name: 'Device issues' });
    expect(within(devices).getByText(/becomes? part of the product/i)).toBeInTheDocument();
  });
});
