/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import App from './App';
import WorkflowDetailPage from './pages/WorkflowDetailPage';

/**
 * V2-017 T14 — responsive/mobile adaptation contract.
 *
 * The dispatch (Issue #2): adapt the EXISTING product shell and shared
 * consumer surfaces to platform-appropriate mobile/tablet layouts while
 * preserving accessibility, semantics, and desktop behavior. No new
 * business logic, no second navigation model, no semantic changes.
 *
 * These jsdom tests pin the STRUCTURAL contract:
 *   - the mobile primary navigation is a bottom bar carrying the SAME
 *     approved model (Home / Workflows / Explore / Activity + the
 *     universal Create entry) at thumb reach;
 *   - the two Primary surfaces are separated purely by viewport (CSS
 *     display) — each real viewport exposes exactly one navigation
 *     landmark, and the destinations/hrefs are identical on both
 *     surfaces (no mobile-only destinations, no drift);
 *   - touch targets are platform-appropriate and the home-indicator safe
 *     area is reserved;
 *   - the fixed bottom bar never covers content (clearance below the
 *     footer);
 *   - the desktop (sm+) header navigation, the Create entry, and the
 *     expert-workspace progressive disclosure are unchanged;
 *   - the workflow-detail primary actions stack full-width below sm and
 *     stay inline above; the title scales; the tablet two-column grid
 *     is preserved.
 *
 * The real responsive BEHAVIOR at actual viewports (what is visible at
 * 375/768/1280 px) is proven by the browser E2E suite
 * (backend/tests/e2e-browser/t14-responsive-adaptation.spec.ts).
 */

// The Workbench is a heavy, data-driven expert page; this contract only
// needs the product shell + navigation structure.
vi.mock('./pages/WorkbenchPage', () => ({
  default: () => <div>Developer Workbench</div>,
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockSessionResponse(status: number, body?: unknown) {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/session')) {
      return Promise.resolve(jsonResponse(status, body ?? {}));
    }
    // Product reads (orgs, workflows, runs, …) — empty success payloads.
    return Promise.resolve(jsonResponse(200, {}));
  });
}

type RouteHandler = () => Response | Promise<Response>;

function mockApi(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
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

const SESSION = {
  user: { id: 'user-1', email: 'juno@example.com', displayName: 'Juno' },
};

describe('V2-017 T14 — responsive/mobile adaptation of the product shell', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', mockSessionResponse(200, SESSION));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('the mobile primary navigation (platform-appropriate bottom bar)', () => {
    it('renders the approved destinations plus the universal Create entry as a bottom navigation', async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(
          screen.getByRole('heading', { name: /What do you want to get done\?/i }),
        ).toBeInTheDocument(),
      );

      const bottomNav = screen.getByTestId('mobile-primary-nav');
      expect(bottomNav).toBeInTheDocument();
      expect(bottomNav.tagName).toBe('NAV');
      expect(bottomNav).toHaveAttribute('aria-label', 'Primary');

      // The SAME approved model — nothing mobile-only, nothing dropped.
      expect(within(bottomNav).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
      expect(within(bottomNav).getByRole('link', { name: 'Workflows' })).toHaveAttribute(
        'href',
        '/workflows',
      );
      expect(within(bottomNav).getByRole('link', { name: 'Explore' })).toHaveAttribute(
        'href',
        '/explore',
      );
      expect(within(bottomNav).getByRole('link', { name: 'Activity' })).toHaveAttribute(
        'href',
        '/activity',
      );
      expect(within(bottomNav).getByRole('link', { name: 'Create' })).toHaveAttribute(
        'href',
        '/create',
      );
    });

    it('separates the two Primary surfaces purely by viewport (CSS display — each real viewport exposes exactly one)', async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(
          screen.getByRole('heading', { name: /What do you want to get done\?/i }),
        ).toBeInTheDocument(),
      );

      const headerNav = screen.getByTestId('header-primary-nav');
      const bottomNav = screen.getByTestId('mobile-primary-nav');

      // The header surface is hidden below sm and becomes the inline row
      // at sm+ (the desktop contract is unchanged for every sm+ viewport).
      expect(headerNav.className).toMatch(/\bhidden\b/);
      expect(headerNav.className).toMatch(/sm:flex/);
      // The bottom surface exists only below sm.
      expect(bottomNav.className).toMatch(/sm:hidden/);
      expect(bottomNav.className).toMatch(/\bfixed\b/);
      expect(bottomNav.className).toMatch(/bottom-0/);
    });

    it('carries the active-destination state on BOTH surfaces (aria-current parity — no drift between surfaces)', async () => {
      render(
        <MemoryRouter initialEntries={['/workflows']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(screen.getByTestId('mobile-primary-nav')).toBeInTheDocument(),
      );

      const headerNav = screen.getByTestId('header-primary-nav');
      const bottomNav = screen.getByTestId('mobile-primary-nav');

      const headerActive = within(headerNav)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page')
        .map((link) => link.textContent);
      const bottomActive = within(bottomNav)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page')
        .map((link) => link.textContent);

      // Exactly Workflows is active — on both surfaces, identically.
      expect(headerActive).toEqual(['Workflows']);
      expect(bottomActive).toEqual(['Workflows']);
    });

    it('gives every bottom-bar destination a touch-appropriate target and reserves the home-indicator safe area', async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(
          screen.getByRole('heading', { name: /What do you want to get done\?/i }),
        ).toBeInTheDocument(),
      );

      const bottomNav = screen.getByTestId('mobile-primary-nav');
      const links = within(bottomNav).getAllByRole('link');
      expect(links.length).toBe(5);
      for (const link of links) {
        // The platform minimum touch target (44px) with real margin:
        // min-h-14 = 56px on every destination.
        expect(link.className).toMatch(/min-h-14/);
      }
      // The bar reserves the iOS home-indicator / Android gesture inset.
      expect(bottomNav).toHaveAttribute('data-safe-area', 'true');
      expect(bottomNav.className).toMatch(/env\(safe-area-inset-bottom\)/);
    });

    it('reserves clearance below the footer so the fixed bottom bar never covers content', async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(
          screen.getByRole('heading', { name: /What do you want to get done\?/i }),
        ).toBeInTheDocument(),
      );

      // The spacer follows the footer in the layout flow (below sm only)
      // and reserves the bar height + margin + the safe inset.
      const spacer = screen.getByTestId('mobile-nav-clearance');
      expect(spacer).toHaveAttribute('aria-hidden', 'true');
      expect(spacer.className).toContain('h-[calc(4rem+1.25rem)]');
      expect(spacer.className).toMatch(/sm:hidden/);
    });
  });

  describe('desktop and tablet behavior preserved', () => {
    it('keeps the header primary navigation with the approved model and the Create entry for sm+ viewports', async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(
          screen.getByRole('heading', { name: /What do you want to get done\?/i }),
        ).toBeInTheDocument(),
      );

      const headerNav = screen.getByTestId('header-primary-nav');
      expect(within(headerNav).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
      expect(within(headerNav).getByRole('link', { name: 'Workflows' })).toHaveAttribute(
        'href',
        '/workflows',
      );
      expect(within(headerNav).getByRole('link', { name: 'Explore' })).toHaveAttribute(
        'href',
        '/explore',
      );
      expect(within(headerNav).getByRole('link', { name: 'Activity' })).toHaveAttribute(
        'href',
        '/activity',
      );
      // The universal Create entry stays in the header for sm+ (hidden
      // below sm only because the bottom bar carries it there).
      const headerCreate = screen.getByTestId('header-create-entry');
      expect(headerCreate.tagName).toBe('A');
      expect(headerCreate).toHaveAttribute('href', '/create');
      expect(headerCreate.className).toMatch(/\bhidden\b/);
      expect(headerCreate.className).toMatch(/sm:inline-flex/);
    });

    it('keeps the expert-workspace progressive disclosure in the footer (semantics unchanged)', async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(
          screen.getByRole('heading', { name: /What do you want to get done\?/i }),
        ).toBeInTheDocument(),
      );
      expect(screen.getByRole('link', { name: /Expert workspace/i })).toHaveAttribute(
        'href',
        '/expert',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// The workflow-detail responsive contract (the other named T14 surface).
// ---------------------------------------------------------------------------

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
        spec: { class: 'agentic_computer_use', task: 'Send the digest' },
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
      send_followup: 'Email the weekly digest',
    },
  },
};

const VERSIONS = [
  {
    id: 'ver-2',
    workflowId: 'wf-1',
    versionNumber: 2,
    contentDigest: 'sha256:new',
    content: IR_CONTENT,
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    parentVersionId: null,
    createdByUserId: 'user-1',
    createdAt: '2026-09-04T09:00:00Z',
  },
];

function detailRoutes(): Record<string, RouteHandler> {
  return {
    // REALITY-REPAIR-003 (F-003): the caller's organizations (the
    // product-shell selection the detail page composes).
    '/organizations': () =>
      jsonResponse(200, {
        organizations: [{ id: 'org-1', name: 'Bay Logistics', roleId: 'owner' }],
      }),
    '/workflow-repository/workflows/wf-1/versions': () =>
      jsonResponse(200, { versions: VERSIONS }),
    '/workflow-runs/runs': () => jsonResponse(200, { runs: [] }),
    '/workflow-repository/installations': () => jsonResponse(200, { installations: [] }),
    '/workflow-deployments/deployments': () => jsonResponse(200, { deployments: [] }),
    '/workflow-repository/workflows': () => jsonResponse(200, { workflows: [WORKFLOW] }),
    '/workflow-repository/workflows/wf-1': () => jsonResponse(200, { workflow: WORKFLOW }),
  };
}

describe('V2-017 T14 — workflow-detail responsive adaptation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stacks the primary actions full-width below sm and keeps them inline above (platform-appropriate primary actions)', async () => {
    vi.stubGlobal('fetch', mockApi(detailRoutes()));
    render(
      <MemoryRouter initialEntries={['/workflows/wf-1']}>
        <Routes>
          <Route path="/workflows/:workflowId" element={<WorkflowDetailPage />} />
          <Route path="/expert" element={<div>Expert workspace</div>} />
          <Route path="/workflows" element={<div>Workflows library</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
    );

    const actions = screen.getByRole('button', { name: 'Teach Me' }).closest('div');
    expect(actions).not.toBeNull();
    // Full-width stacked below sm; the desktop row from sm+.
    expect(actions!.className).toMatch(/\bflex-col\b/);
    expect(actions!.className).toMatch(/sm:flex-row/);
    expect(screen.getByRole('link', { name: 'Edit' })).toBeInTheDocument();
  });

  it('scales the workflow title for mobile (text-2xl at mobile, the desktop scale from sm+)', async () => {
    vi.stubGlobal('fetch', mockApi(detailRoutes()));
    render(
      <MemoryRouter initialEntries={['/workflows/wf-1']}>
        <Routes>
          <Route path="/workflows/:workflowId" element={<WorkflowDetailPage />} />
          <Route path="/expert" element={<div>Expert workspace</div>} />
          <Route path="/workflows" element={<div>Workflows library</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const heading = await screen.findByRole('heading', { name: 'Weekly invoice digest' });
    expect(heading.className).toMatch(/text-2xl/);
    expect(heading.className).toMatch(/sm:text-3xl/);
  });

  it('preserves the tablet/desktop two-column fact grid (md:grid-cols-2 unchanged)', async () => {
    vi.stubGlobal('fetch', mockApi(detailRoutes()));
    render(
      <MemoryRouter initialEntries={['/workflows/wf-1']}>
        <Routes>
          <Route path="/workflows/:workflowId" element={<WorkflowDetailPage />} />
          <Route path="/expert" element={<div>Expert workspace</div>} />
          <Route path="/workflows" element={<div>Workflows library</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Weekly invoice digest' })).toBeInTheDocument(),
    );
    const grid = screen.getByRole('region', { name: /What it does/i }).parentElement;
    expect(grid).not.toBeNull();
    expect(grid!.className).toMatch(/md:grid-cols-2/);
  });
});
