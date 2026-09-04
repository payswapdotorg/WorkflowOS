/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import WorkflowsPage from './WorkflowsPage';
import { auth } from '../api/client';

/**
 * V2-017 T3 — the workflow library contract.
 *
 * The dispatch (Issue #181) owns: My Workflows / Installed / Shared with me /
 * Drafts / Archived, contextual attention filters, and workflow cards with
 * useful human-readable metadata (purpose, state, last run, schedule,
 * environment, attention), IDs/digests secondary.
 *
 * HONESTY RULES (the same contract as T2, extended to the library):
 *   - the three wired sections (My / Installed / Shared) distinguish loading /
 *     error-with-retry / successful-empty / data EXPLICITLY;
 *   - a failed read is NEVER a successful empty state;
 *   - Drafts and Archived have NO authoritative read (the workflow model has
 *     no draft/archived state — the repository vocabulary explicitly never
 *     was a workflow state), so they render honest Unavailable panels, never
 *     fabricated empties;
 *   - every read aggregates across EVERY organization of the session user
 *     (the F-T2-001 regression carry-over), all-or-error.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = () => Response | Promise<Response>;

function mockApi(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
  // Longest fragment first: org-scoped reads must match their own handlers,
  // never the bare '/organizations' one.
  const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    for (const [fragment, handler] of ordered) {
      if (url.includes(fragment)) return Promise.resolve(handler());
    }
    return Promise.resolve(jsonResponse(500, { error: `unmocked ${url}` }));
  });
}

const SESSION_USER = { id: 'user-1', displayName: 'Ada', email: 'ada@example.com' };

const session: RouteHandler = () => jsonResponse(200, { user: SESSION_USER });
const emptyOrgs: RouteHandler = () => jsonResponse(200, { organizations: [] });
const orgsOne: RouteHandler = () =>
  jsonResponse(200, {
    organizations: [
      { id: 'org-1', name: 'Acme', roleId: 'owner' },
    ],
  });
const orgsTwo: RouteHandler = () =>
  jsonResponse(200, {
    organizations: [
      { id: 'org-1', name: 'Acme', roleId: 'owner' },
      { id: 'org-2', name: 'Globex', roleId: 'owner' },
    ],
  });

// The library fixtures: wf-a is OWNED BY the session user (My Workflows) with
// a failed run (attention), a device-local deployment (environment) and a
// daily schedule subscription (schedule). wf-b is owned by ANOTHER user
// (Shared with me), never run, cloud-deployed, and installed pinned at
// version 3 (the Installed section's card).
const workflows: RouteHandler = () =>
  jsonResponse(200, {
    workflows: [
      {
        id: 'wf-a',
        organizationId: 'org-1',
        ownerUserId: 'user-1',
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
        id: 'wf-b',
        organizationId: 'org-1',
        ownerUserId: 'user-2',
        slug: 'lead-followup',
        name: 'Lead follow-up',
        description: null,
        visibility: 'organization',
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
        workflowId: 'wf-a',
        versionId: 'ver-1',
        state: 'failed',
        createdAt: '2026-09-04T08:00:00Z',
        updatedAt: '2026-09-04T08:30:00Z',
      },
    ],
  });
const installations: RouteHandler = () =>
  jsonResponse(200, {
    installations: [
      {
        installation: {
          id: 'inst-1',
          organizationId: 'org-1',
          workflowId: 'wf-b',
          versionId: 'ver-2',
          installedByUserId: 'user-1',
          status: 'enabled',
          installedAt: '2026-09-03T09:00:00Z',
          updatedAt: '2026-09-03T09:00:00Z',
        },
        pinnedVersion: {
          id: 'ver-2',
          workflowId: 'wf-b',
          versionNumber: 3,
          contentDigest: 'sha256:abc',
          protocol: { name: 'workflowos.workflow.ir', version: 1 },
        },
      },
    ],
  });
const deployments: RouteHandler = () =>
  jsonResponse(200, {
    deployments: [
      {
        id: 'dep-1',
        organizationId: 'org-1',
        workflowId: 'wf-a',
        versionId: 'ver-1',
        installationId: null,
        name: 'Weekly invoice digest',
        description: null,
        placement: {
          placement: { required: 'device_local' },
          privacy: { localOnly: true },
        },
        enabled: true,
        enabledAt: '2026-09-01T11:00:00Z',
        disabledAt: null,
        createdByUserId: 'user-1',
        createdAt: '2026-09-01T11:00:00Z',
        updatedAt: '2026-09-01T11:00:00Z',
      },
      {
        id: 'dep-2',
        organizationId: 'org-1',
        workflowId: 'wf-b',
        versionId: 'ver-2',
        installationId: 'inst-1',
        name: 'Lead follow-up',
        description: null,
        placement: {
          placement: { required: 'cloud_preferred' },
          privacy: { localOnly: false },
        },
        enabled: true,
        enabledAt: '2026-09-02T11:00:00Z',
        disabledAt: null,
        createdByUserId: 'user-2',
        createdAt: '2026-09-02T11:00:00Z',
        updatedAt: '2026-09-02T11:00:00Z',
      },
    ],
  });
const subscriptionsDep1: RouteHandler = () =>
  jsonResponse(200, {
    subscriptions: [
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
        createdAt: '2026-09-01T11:00:00Z',
        updatedAt: '2026-09-01T11:00:00Z',
      },
    ],
  });
const subscriptionsDep2: RouteHandler = () =>
  jsonResponse(200, { subscriptions: [] });
const emptyRuns: RouteHandler = () => jsonResponse(200, { runs: [] });
const emptyInstallations: RouteHandler = () => jsonResponse(200, { installations: [] });
const emptyDeployments: RouteHandler = () => jsonResponse(200, { deployments: [] });

/** The full happy-path org-1 read set. */
function orgOneRoutes(): Record<string, RouteHandler> {
  return {
    '/auth/session': session,
    '/organizations/org-1/workflow-repository/workflows': workflows,
    '/organizations/org-1/workflow-runs/runs': runs,
    '/organizations/org-1/workflow-repository/installations': installations,
    '/organizations/org-1/workflow-deployments/deployments': deployments,
    '/workflow-deployments/deployments/dep-1/subscriptions': subscriptionsDep1,
    '/workflow-deployments/deployments/dep-2/subscriptions': subscriptionsDep2,
    '/organizations': orgsOne,
  };
}

async function renderLibrary(routes: Record<string, RouteHandler>) {
  vi.stubGlobal('fetch', mockApi(routes));
  // Resolve the session FIRST so the ownership split (My vs Shared) has the
  // authoritative session identity before the page mounts.
  await auth.fetchSession();
  return render(
    <MemoryRouter>
      <WorkflowsPage />
    </MemoryRouter>,
  );
}

async function openTab(label: string): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: label }));
  return screen.getByRole('tabpanel');
}

describe('V2-017 T3 — workflow library', () => {
  beforeEach(() => {
    auth.handleUnauthorized();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('sections', () => {
    it('renders the five approved sections with My Workflows active by default', async () => {
      await renderLibrary(orgOneRoutes());
      const tabs = await screen.findAllByRole('tab');
      expect(tabs.map((t) => t.textContent)).toEqual([
        'My Workflows',
        'Installed',
        'Shared with me',
        'Drafts',
        'Archived',
      ]);
      expect(screen.getByRole('tab', { name: 'My Workflows' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('shows the honest Unavailable panels for Drafts and Archived — never fabricated empties', async () => {
      await renderLibrary(orgOneRoutes());
      const drafts = await openTab('Drafts');
      expect(within(drafts).getByRole('status', { name: 'Unavailable' })).toBeInTheDocument();
      expect(within(drafts).queryByText(/no workflows/i)).not.toBeInTheDocument();
      const archived = await openTab('Archived');
      expect(within(archived).getByRole('status', { name: 'Unavailable' })).toBeInTheDocument();
      expect(within(archived).queryByText(/no workflows/i)).not.toBeInTheDocument();
    });
  });

  describe('honest read states — the wired sections', () => {
    it('shows a loading state while the read is in flight', async () => {
      let release!: (r: Response) => void;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      vi.stubGlobal('fetch', mockApi({ '/auth/session': session, '/organizations': () => gate }));
      await auth.fetchSession();
      render(
        <MemoryRouter>
          <WorkflowsPage />
        </MemoryRouter>,
      );
      expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
      release(jsonResponse(200, { organizations: [] }));
      await waitFor(() =>
        expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument(),
      );
    });

    it('renders the derivable empty state (no organization ⇒ no workflows anywhere)', async () => {
      await renderLibrary({
        '/auth/session': session,
        '/organizations': emptyOrgs,
      });
      const panel = screen.getByRole('tabpanel');
      await waitFor(() =>
        expect(within(panel).getByText(/No workflows yet/i)).toBeInTheDocument(),
      );
      expect(within(panel).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('renders a visible error with retry (never a fake empty) when an org-scoped read fails', async () => {
      await renderLibrary({
        ...orgOneRoutes(),
        '/organizations/org-1/workflow-repository/workflows': () =>
          jsonResponse(500, { error: 'boom' }),
      });
      const panel = screen.getByRole('tabpanel');
      await waitFor(() => expect(within(panel).getByRole('alert')).toBeInTheDocument());
      expect(within(panel).getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(within(panel).queryByText(/No workflows yet/i)).not.toBeInTheDocument();
      expect(within(panel).queryByText(/haven't created/i)).not.toBeInTheDocument();
      // The Unavailable sections are unaffected by a data read failure.
      const drafts = await openTab('Drafts');
      expect(within(drafts).getByRole('status', { name: 'Unavailable' })).toBeInTheDocument();
    });

    it('distinguishes the derivable no-workflows empty from a section-empty (Installed with none)', async () => {
      await renderLibrary({
        ...orgOneRoutes(),
        '/organizations/org-1/workflow-repository/installations': emptyInstallations,
      });
      const installed = await openTab('Installed');
      await waitFor(() =>
        expect(within(installed).getByText(/Nothing installed yet/i)).toBeInTheDocument(),
      );
      expect(within(installed).queryByRole('alert')).not.toBeInTheDocument();
      expect(
        within(installed).queryByRole('status', { name: 'Unavailable' }),
      ).not.toBeInTheDocument();
      // The derivable no-workflows empty is a DIFFERENT honest text (it means
      // no workflows exist anywhere, not "nothing in this section").
      expect(within(installed).queryByText(/No workflows yet/i)).not.toBeInTheDocument();
    });
  });

  describe('ownership split (the authoritative owner vs the session user)', () => {
    it('My Workflows lists only workflows owned by the session user; Shared with me lists the rest', async () => {
      await renderLibrary(orgOneRoutes());
      const mine = screen.getByRole('tabpanel');
      await waitFor(() => {
        const items = within(mine).getAllByRole('listitem');
        expect(items.map((i) => i.textContent)).toEqual([
          expect.stringMatching(/Weekly invoice digest/),
        ]);
      });
      const shared = await openTab('Shared with me');
      const sharedItems = within(shared).getAllByRole('listitem');
      expect(sharedItems.map((i) => i.textContent)).toEqual([
        expect.stringMatching(/Lead follow-up/),
      ]);
    });
  });

  describe('workflow cards — human-readable facts, IDs secondary', () => {
    it('communicates purpose, attention, last run, schedule, environment and the secondary slug', async () => {
      await renderLibrary(orgOneRoutes());
      const mine = screen.getByRole('tabpanel');
      await waitFor(() => {
        expect(within(mine).getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument();
      });
      expect(within(mine).getByText('Collect invoices and email the digest.')).toBeInTheDocument();
      // Attention (run-derived: failed run exists).
      expect(within(mine).getByText('Needs attention')).toBeInTheDocument();
      // Last run (run-derived: date + state).
      expect(within(mine).getByText(/Last run Sep 4, 2026 · failed/i)).toBeInTheDocument();
      // Schedule (subscription-derived: enabled daily schedule).
      expect(within(mine).getByText('Runs daily')).toBeInTheDocument();
      // Environment (placement-derived: device_local).
      expect(within(mine).getByText('This device')).toBeInTheDocument();
      // The slug is present but secondary (a muted detail line).
      expect(within(mine).getByText('weekly-invoice-digest')).toBeInTheDocument();
    });

    it('shows the honest no-run / manual / cloud facts for a workflow without runs or subscriptions', async () => {
      await renderLibrary(orgOneRoutes());
      const shared = await openTab('Shared with me');
      const card = within(shared).getByRole('heading', { name: 'Lead follow-up' }).closest('li');
      expect(card).not.toBeNull();
      expect(within(card as HTMLElement).getByText(/Not run yet/i)).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText('Runs when you start it')).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText('Cloud')).toBeInTheDocument();
      expect(within(card as HTMLElement).queryByText('Needs attention')).not.toBeInTheDocument();
    });
  });

  describe('Installed — pinned version semantics from the authoritative response', () => {
    it('shows the installed workflow with its pinned version and install status', async () => {
      await renderLibrary(orgOneRoutes());
      const installed = await openTab('Installed');
      const item = await within(installed).findByRole('listitem');
      expect(within(item).getByText(/Lead follow-up/)).toBeInTheDocument();
      expect(within(item).getByText(/Version 3/i)).toBeInTheDocument();
      expect(within(item).getByText(/pinned/i)).toBeInTheDocument();
      expect(within(item).getByText('Enabled')).toBeInTheDocument();
      // The digest NEVER appears on the card (IDs/digests secondary).
      expect(within(item).queryByText(/sha256/i)).not.toBeInTheDocument();
    });
  });

  describe('detail entry (T4)', () => {
    it('cards open the workflow detail — My/Shared workflow cards and the Installed card', async () => {
      // The library is the entry to the detail experience: every card
      // carries the authoritative workflow id forward as the product route.
      await renderLibrary(orgOneRoutes());
      // My Workflows (default): wf-a's card opens the detail.
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
      );
      expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/workflows/wf-a');
      // Shared with me: wf-b's card.
      await openTab('Shared with me');
      expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/workflows/wf-b');
      // Installed: the install card opens the pinned workflow's detail.
      await openTab('Installed');
      expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/workflows/wf-b');
    });
  });

  describe('contextual filters (presentation-level, honestly derived)', () => {
    it('Needs attention keeps only workflows with failed/paused runs', async () => {
      await renderLibrary(orgOneRoutes());
      const user = userEvent.setup();
      const attentionFilter = await screen.findByRole('button', { name: 'Needs attention' });
      await user.click(attentionFilter);
      const mine = screen.getByRole('tabpanel');
      await waitFor(() => {
        const items = within(mine).getAllByRole('listitem');
        expect(items.map((i) => i.textContent)).toEqual([
          expect.stringMatching(/Weekly invoice digest/),
        ]);
      });
      const shared = await openTab('Shared with me');
      expect(within(shared).queryAllByRole('listitem')).toHaveLength(0);
    });

    it('Runs automatically / On this device / Cloud / Shared derive from the authoritative facts', async () => {
      await renderLibrary(orgOneRoutes());
      const user = userEvent.setup();
      const automaticFilter = await screen.findByRole('button', { name: 'Runs automatically' });

      await user.click(automaticFilter);
      let mine = screen.getByRole('tabpanel');
      expect(within(mine).getAllByRole('listitem').map((i) => i.textContent)).toEqual([
        expect.stringMatching(/Weekly invoice digest/),
      ]);

      await user.click(screen.getByRole('button', { name: 'Runs automatically' }));
      await user.click(screen.getByRole('button', { name: 'On this device' }));
      mine = screen.getByRole('tabpanel');
      expect(within(mine).getAllByRole('listitem').map((i) => i.textContent)).toEqual([
        expect.stringMatching(/Weekly invoice digest/),
      ]);

      await user.click(screen.getByRole('button', { name: 'On this device' }));
      await user.click(screen.getByRole('button', { name: 'Cloud' }));
      mine = screen.getByRole('tabpanel');
      expect(within(mine).queryAllByRole('listitem')).toHaveLength(0);

      await user.click(screen.getByRole('button', { name: 'Cloud' }));
      await user.click(screen.getByRole('button', { name: 'Shared' }));
      mine = screen.getByRole('tabpanel');
      expect(within(mine).queryAllByRole('listitem')).toHaveLength(0);
      const shared = await openTab('Shared with me');
      expect(within(shared).getAllByRole('listitem').map((i) => i.textContent)).toEqual([
        expect.stringMatching(/Lead follow-up/),
      ]);
    });
  });

  describe('F-T2-001 carry-over — the library aggregates EVERY organization', () => {
    const workflowsOrg2: RouteHandler = () =>
      jsonResponse(200, {
        workflows: [
          {
            id: 'wf-g',
            organizationId: 'org-2',
            ownerUserId: 'user-1',
            slug: 'globex-report',
            name: 'Globex report',
            description: null,
            visibility: 'private',
            headVersionId: 'ver-9',
            forkedFromWorkflowId: null,
            forkedFromVersionId: null,
            createdAt: '2026-09-03T10:00:00Z',
            updatedAt: '2026-09-04T10:00:00Z',
          },
        ],
      });

    it('shows workflows and installations from BOTH organizations', async () => {
      await renderLibrary({
        '/auth/session': session,
        '/organizations/org-1/workflow-repository/workflows': workflows,
        '/organizations/org-1/workflow-runs/runs': runs,
        '/organizations/org-1/workflow-repository/installations': installations,
        '/organizations/org-1/workflow-deployments/deployments': deployments,
        '/workflow-deployments/deployments/dep-1/subscriptions': subscriptionsDep1,
        '/workflow-deployments/deployments/dep-2/subscriptions': subscriptionsDep2,
        '/organizations/org-2/workflow-repository/workflows': workflowsOrg2,
        '/organizations/org-2/workflow-runs/runs': emptyRuns,
        '/organizations/org-2/workflow-repository/installations': emptyInstallations,
        '/organizations/org-2/workflow-deployments/deployments': emptyDeployments,
        '/organizations': orgsTwo,
      });
      const mine = screen.getByRole('tabpanel');
      await waitFor(() => {
        const names = within(mine)
          .getAllByRole('listitem')
          .map((i) => i.textContent);
        expect(names).toEqual([
          expect.stringMatching(/Globex report/),
          expect.stringMatching(/Weekly invoice digest/),
        ]);
      });
      // org-2 contributed no installations; org-1's installation still shows.
      const installed = await openTab('Installed');
      expect(within(installed).getAllByRole('listitem').length).toBe(1);
    });

    it('errors the wired sections when ONE organization read fails — never a silent partial result', async () => {
      await renderLibrary({
        '/auth/session': session,
        '/organizations/org-1/workflow-repository/workflows': workflows,
        '/organizations/org-1/workflow-runs/runs': runs,
        '/organizations/org-1/workflow-repository/installations': installations,
        '/organizations/org-1/workflow-deployments/deployments': deployments,
        '/workflow-deployments/deployments/dep-1/subscriptions': subscriptionsDep1,
        '/workflow-deployments/deployments/dep-2/subscriptions': subscriptionsDep2,
        '/organizations/org-2/workflow-repository/workflows': () =>
          jsonResponse(500, { error: 'boom' }),
        '/organizations/org-2/workflow-runs/runs': emptyRuns,
        '/organizations/org-2/workflow-repository/installations': emptyInstallations,
        '/organizations/org-2/workflow-deployments/deployments': emptyDeployments,
        '/organizations': orgsTwo,
      });
      const panel = screen.getByRole('tabpanel');
      await waitFor(() => expect(within(panel).getByRole('alert')).toBeInTheDocument());
      // org-1's records must NOT be presented as a successful partial list.
      expect(within(panel).queryAllByRole('listitem')).toHaveLength(0);
      expect(within(panel).queryByText(/No workflows yet/i)).not.toBeInTheDocument();
      expect(within(panel).queryByText(/haven't created/i)).not.toBeInTheDocument();
    });
  });
});
