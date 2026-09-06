/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MarketplaceListingDetail from './MarketplaceListingDetail';

/**
 * V2-017 T12 — the marketplace listing detail contract (Issue #7 dispatch;
 * UX spec §21/§22/§23 over the existing V2-012 authorities).
 *
 * The listing detail composes EXISTING authorities only:
 *   - the V2-012 listing read (current revision: pin, offers, trust
 *     metadata) through its transport routes;
 *   - the V2-012 version-access decision (entitlement = CONTENT access,
 *     never execution authorization — the frozen boundary);
 *   - the V2-012 offer acceptance (the purchase flow) — payment failure is
 *     an honest failure that grants nothing;
 *   - the EXISTING V2-002 install command (install ONE EXACT version — the
 *     pin) and the EXISTING V2-002 fork command ("Make my own").
 *
 * HONESTY RULES:
 *   - loading / error / data states are explicit; a failed read is never a
 *     successful empty;
 *   - no publisher org/user identifier ever renders (identity the wire
 *     doesn't humanize renders as "another organization");
 *   - required capabilities are DISCLOSURE ("Needs access to"), never
 *     grants, and the trust card never presents publication as
 *     verification;
 *   - a purchase is never presented as execution authorization: the §23
 *     boundary sentence renders with the entitlement AND the install
 *     result;
 *   - the install pins the EXACT listed version (pin.versionId), through
 *     the existing command, never a marketplace mutation.
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

const ORGS = () =>
  jsonResponse(200, {
    organizations: [
      { id: 'org-1', name: 'Bay Logistics', roleId: 'owner' },
      { id: 'org-2', name: 'Bay Second Org', roleId: 'member' },
    ],
  });

const ORGS_ONE = () =>
  jsonResponse(200, {
    organizations: [{ id: 'org-1', name: 'Bay Logistics', roleId: 'owner' }],
  });

const LISTING = {
  id: 'lst-1',
  publisherOrganizationId: 'org-publisher',
  publisherUserId: 'user-ada',
  workflowId: 'wf-9',
  name: 'Weekly social media report',
  description: 'Automatically creates and sends your weekly social report.',
  status: 'published',
  distribution: 'public',
  currentRevisionId: 'rev-2',
  createdAt: 1789500000000,
  updatedAt: 1789500100000,
};

const REVISION = {
  id: 'rev-2',
  listingId: 'lst-1',
  sequence: 2,
  pin: {
    workflowId: 'wf-9',
    versionId: 'ver-3',
    versionNumber: 3,
    contentDigest: 'sha256:content-v3',
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
  },
  offers: [
    {
      id: 'off-one-time',
      model: 'one_time_purchase',
      terms: {
        model: 'one_time_purchase',
        amount: '19.00',
        currency: 'USD',
        updatePolicy: 'pinned_only',
      },
      createdAt: 1789500001000,
    },
    {
      id: 'off-maint',
      model: 'maintenance_subscription',
      terms: { model: 'maintenance_subscription', amount: '5.00', currency: 'USD' },
      createdAt: 1789500002000,
    },
  ],
  trust: {
    publisherOrganizationId: 'org-publisher',
    publisherUserId: 'user-ada',
    workflowId: 'wf-9',
    versionId: 'ver-3',
    versionNumber: 3,
    contentDigest: 'sha256:content-v3',
    semanticDigest: 'sha256:semantic-v3',
    requiredCapabilities: ['github.repository.read', 'messaging.send'],
    sensitiveCapabilities: ['messaging.send'],
    placements: ['cloud_allowed'],
    dependencyGraph: [],
    provenance: { forkedFromWorkflowId: null, forkedFromVersionId: null },
  },
  createdAt: 1789500003000,
};

const LISTING_DETAIL = () =>
  jsonResponse(200, { listing: LISTING, revision: REVISION });

const DENIED = () =>
  jsonResponse(200, {
    decision: { entitled: false, reason: 'no_entitlement' },
  });

const ENTITLED_ONE_TIME = () =>
  jsonResponse(200, {
    decision: { entitled: true, basis: 'one_time_purchase', entitlementId: 'ent-1' },
  });

function renderDetail(
  routes: Record<string, RouteHandler>,
  listingId = 'lst-1',
) {
  vi.stubGlobal('fetch', mockApi(routes));
  return render(
    <MemoryRouter initialEntries={[`/explore/${listingId}`]}>
      <Routes>
        <Route path="/explore/:listingId" element={<MarketplaceListingDetail />} />
        <Route path="/explore" element={<div>Explore</div>} />
        <Route path="/workflows/:workflowId" element={<div>Workflow detail</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the listing presentation (§22)', () => {
  it('renders the listing facts from the authoritative wire — and no internal identifiers', async () => {
    renderDetail({
      '/marketplace/listings/lst-1': LISTING_DETAIL,
      '/organizations': ORGS_ONE,
      '/marketplace/listings/lst-1/version-access': DENIED,
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Weekly social media report' })).toBeVisible();
    });

    // The §22 summary: what it does, publisher identity, price, access, version.
    expect(screen.getByText('Automatically creates and sends your weekly social report.')).toBeVisible();
    // Publisher identity: honest — the wire carries no humanized name for
    // another tenant's org, so no identifier ever renders.
    expect(screen.getByText(/Listed by another organization/i)).toBeVisible();
    expect(screen.queryByText(/org-publisher/)).not.toBeInTheDocument();
    expect(screen.queryByText(/user-ada/)).not.toBeInTheDocument();

    // Offers: price + model + update rights for each.
    expect(screen.getByText('$19.00')).toBeVisible();
    expect(screen.getByText('One-time purchase')).toBeVisible();
    expect(
      screen.getByText('Pins this exact version — later updates are separate.'),
    ).toBeVisible();
    expect(screen.getByText('$5.00/month')).toBeVisible();
    expect(screen.getByText('Maintenance subscription')).toBeVisible();

    // Version + needs access + works with.
    expect(screen.getByText('Version 3')).toBeVisible();
    const access = screen.getByRole('region', { name: /needs access/i });
    expect(within(access).getByText('github.repository.read')).toBeVisible();
    expect(within(access).getByText('messaging.send')).toBeVisible();
    expect(
      within(access).getByText(/messaging\.send is sensitive/i),
    ).toBeVisible();

    // The trust card never presents publication as verification.
    expect(
      screen.getByText('Publication is not verification, authorization, or proof of safety.'),
    ).toBeVisible();

    // The entitlement boundary sentence is part of the offer presentation.
    expect(
      screen.getByText(
        'Getting this workflow gives your organization access to its content — it is not permission to run. Execution stays subject to your access and approvals.',
      ),
    ).toBeVisible();
  });

  it('a failed listing read stays visibly Unavailable with retry — never an empty success', async () => {
    renderDetail({
      '/marketplace/listings/lst-1': () => jsonResponse(500, { error: 'boom' }),
      '/organizations': ORGS_ONE,
    });

    expect(await screen.findByText(/unavailable/i)).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Weekly social media report' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeVisible();
  });
});

describe('the entitlement → install flow (§23)', () => {
  it('a denied access check shows the honest denial; the offers remain the path in', async () => {
    renderDetail({
      '/marketplace/listings/lst-1': LISTING_DETAIL,
      '/organizations': ORGS_ONE,
      '/marketplace/listings/lst-1/version-access': DENIED,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Your organization doesn't have access to this version."),
      ).toBeVisible();
    });
    expect(
      screen.getAllByRole('button', { name: /get workflow/i }).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('accepting an offer grants entitlement, then Install pins the EXACT listed version through the EXISTING V2-002 command', async () => {
    const fetchMock = vi.fn();
    let accepted = false;
    let installed = false;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, '');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/api/organizations' && method === 'GET') return Promise.resolve(ORGS_ONE());
      if (url.includes('/api/marketplace/listings/lst-1') && method === 'GET') {
        return Promise.resolve(LISTING_DETAIL());
      }
      if (url.includes('/api/marketplace/listings/lst-1/offers/off-one-time/accept') && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({ customerOrganizationId: 'org-1' });
        accepted = true;
        return Promise.resolve(
          jsonResponse(200, {
            entitlement: {
              id: 'ent-1',
              customerOrganizationId: 'org-1',
              listingId: 'lst-1',
              revisionId: 'rev-2',
              offerId: 'off-one-time',
              model: 'one_time_purchase',
              status: 'active',
              pinnedVersionId: 'ver-3',
              transactionId: 'txn-1',
              acceptedByUserId: 'user-bay',
              grantedAt: 1789500090000,
              endedAt: null,
            },
            transaction: {
              id: 'txn-1',
              listingId: 'lst-1',
              revisionId: 'rev-2',
              offerId: 'off-one-time',
              customerOrganizationId: 'org-1',
              amount: '19.00',
              currency: 'USD',
              status: 'succeeded',
              adapterReference: 'in-memory-1',
              failureCode: null,
              createdAt: 1789500090000,
              refundedAt: null,
            },
            created: true,
          }),
        );
      }
      if (url.includes('/api/organizations/org-1/marketplace/listings/lst-1/version-access') && method === 'GET') {
        return Promise.resolve(accepted ? ENTITLED_ONE_TIME() : DENIED());
      }
      if (
        url.includes('/api/organizations/org-1/workflow-repository/installations') &&
        method === 'POST'
      ) {
        // The EXISTING V2-002 install command with the EXACT pin.
        expect(JSON.parse(String(init?.body))).toEqual({
          workflowId: 'wf-9',
          versionId: 'ver-3',
        });
        installed = true;
        return Promise.resolve(
          jsonResponse(201, {
            installation: {
              id: 'inst-1',
              organizationId: 'org-1',
              workflowId: 'wf-9',
              versionId: 'ver-3',
              installedByUserId: 'user-bay',
              status: 'enabled',
              installedAt: '2026-09-05T10:00:00Z',
              updatedAt: '2026-09-05T10:00:00Z',
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(500, { error: `unmocked ${method} ${url}` }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/explore/lst-1']}>
        <Routes>
          <Route path="/explore/:listingId" element={<MarketplaceListingDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    // Initially denied → the offer CTA is the path in.
    await waitFor(() => {
      expect(
        screen.getByText("Your organization doesn't have access to this version."),
      ).toBeVisible();
    });

    // Accept the one-time offer (the first Get-workflow CTA).
    await userEvent.click(screen.getAllByRole('button', { name: /get workflow/i })[0]);

    // §23 after purchase: entitled + next install step.
    await waitFor(() => {
      expect(screen.getByText("You're entitled to this workflow.")).toBeVisible();
    });
    expect(screen.getByText('Access through your one-time purchase.')).toBeVisible();
    expect(screen.getByText('Next: Install version 3')).toBeVisible();
    expect(accepted).toBe(true);

    // Install pins the exact version.
    await userEvent.click(screen.getByRole('button', { name: /^install$/i }));
    await waitFor(() => {
      expect(screen.getByText('Installed — pinned to version 3')).toBeVisible();
    });
    expect(installed).toBe(true);
    // The boundary sentence still renders with the install result.
    expect(
      screen.getByText(
        'Getting this workflow gives your organization access to its content — it is not permission to run. Execution stays subject to your access and approvals.',
      ),
    ).toBeVisible();
  });

  it('a payment failure is an honest failure that grants nothing (never an entitlement)', async () => {
    renderDetail({
      '/marketplace/listings/lst-1': LISTING_DETAIL,
      '/organizations': ORGS_ONE,
      '/marketplace/listings/lst-1/version-access': DENIED,
      'POST /marketplace/listings/lst-1/offers/off-one-time/accept': () =>
        jsonResponse(402, {
          error: 'marketplace-payment-failed',
          code: 'MARKETPLACE_PAYMENT_FAILED',
          message: 'the payment adapter declined the charge',
        }),
    });

    await waitFor(() => {
      expect(
        screen.getByText("Your organization doesn't have access to this version."),
      ).toBeVisible();
    });

    await userEvent.click(screen.getAllByRole('button', { name: /get workflow/i })[0]);

    expect(
      await screen.findByText(/payment failed — no access was granted/i),
    ).toBeVisible();
    // Still not entitled: no install step appears.
    expect(screen.queryByText("You're entitled to this workflow.")).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^install$/i })).not.toBeInTheDocument();
  });

  it('a failed access check renders the honest unavailable state (offers stay visible)', async () => {
    renderDetail({
      '/marketplace/listings/lst-1': LISTING_DETAIL,
      '/organizations': ORGS_ONE,
      '/marketplace/listings/lst-1/version-access': () => jsonResponse(500, { error: 'boom' }),
    });

    await waitFor(() => {
      expect(screen.getByText(/access facts unavailable/i)).toBeVisible();
    });
    expect(screen.getByText('$19.00')).toBeVisible();
    expect(screen.queryByText("You're entitled to this workflow.")).not.toBeInTheDocument();
  });
});

describe('Make my own (§21 fork flow)', () => {
  it('presents the fork promises and creates the copy through the EXISTING V2-002 fork command', async () => {
    const fetchMock = vi.fn();
    let forked = false;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, '');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/api/organizations' && method === 'GET') return Promise.resolve(ORGS_ONE());
      if (url.includes('/api/marketplace/listings/lst-1') && method === 'GET') {
        return Promise.resolve(LISTING_DETAIL());
      }
      if (url.includes('/api/organizations/org-1/marketplace/listings/lst-1/version-access') && method === 'GET') {
        return Promise.resolve(DENIED());
      }
      if (url.includes('/api/organizations/org-1/workflow-repository/forks') && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          sourceWorkflowId: 'wf-9',
          sourceVersionId: 'ver-3',
          name: 'My social report',
        });
        forked = true;
        return Promise.resolve(
          jsonResponse(201, {
            workflow: {
              id: 'wf-copy',
              organizationId: 'org-1',
              ownerUserId: 'user-bay',
              slug: 'my-social-report',
              name: 'My social report',
              description: 'Automatically creates and sends your weekly social report.',
              visibility: 'private',
              headVersionId: 'ver-copy-1',
              forkedFromWorkflowId: 'wf-9',
              forkedFromVersionId: 'ver-3',
              createdAt: '2026-09-05T10:00:00Z',
              updatedAt: '2026-09-05T10:00:00Z',
            },
            initialVersion: {
              id: 'ver-copy-1',
              workflowId: 'wf-copy',
              versionNumber: 1,
              contentDigest: 'sha256:content-v3',
              content: {},
              protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
              parentVersionId: null,
              createdByUserId: 'user-bay',
              createdAt: '2026-09-05T10:00:00Z',
            },
            created: true,
          }),
        );
      }
      return Promise.resolve(jsonResponse(500, { error: `unmocked ${method} ${url}` }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/explore/lst-1']}>
        <Routes>
          <Route path="/explore/:listingId" element={<MarketplaceListingDetail />} />
          <Route path="/workflows/:workflowId" element={<div>Workflow detail</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Weekly social media report' })).toBeVisible();
    });

    // Open the Make-my-own disclosure.
    await userEvent.click(screen.getByRole('button', { name: /make (this|it) my own/i }));
    const forkRegion = screen.getByRole('region', { name: /make my own/i });
    expect(within(forkRegion).getByText('Have its own versions')).toBeVisible();
    expect(within(forkRegion).getByText('Keep the original attribution')).toBeVisible();
    expect(
      within(forkRegion).getByText('Not receive the publisher’s private data'),
    ).toBeVisible();
    expect(within(forkRegion).getByText('Not receive the publisher’s secrets')).toBeVisible();

    // Name the copy and create it.
    await userEvent.type(
      within(forkRegion).getByLabelText(/name your copy/i),
      'My social report',
    );
    await userEvent.click(within(forkRegion).getByRole('button', { name: /create copy/i }));

    const copyLink = await screen.findByRole('link', { name: /open your copy/i });
    expect(copyLink).toHaveAttribute('href', '/workflows/wf-copy');
    expect(forked).toBe(true);
  });
});

describe('the organization context (entitlement is per organization)', () => {
  it('multi-organization users choose the organization — the access check follows the selection', async () => {
    const urlsSeen: string[] = [];
    const fetchMock = vi.fn().mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input).replace(/^https?:\/\/[^/]+/, '');
        const method = (init?.method ?? 'GET').toUpperCase();
        urlsSeen.push(`${method} ${url}`);
        if (url === '/api/organizations' && method === 'GET') return Promise.resolve(ORGS());
        if (url.includes('/api/marketplace/listings/lst-1') && method === 'GET') {
          return Promise.resolve(LISTING_DETAIL());
        }
        if (url.includes('/version-access') && method === 'GET') {
          return Promise.resolve(DENIED());
        }
        return Promise.resolve(jsonResponse(500, { error: `unmocked ${method} ${url}` }));
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/explore/lst-1']}>
        <Routes>
          <Route path="/explore/:listingId" element={<MarketplaceListingDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getByText("Your organization doesn't have access to this version."),
      ).toBeVisible();
    });
    // The default selection is the first organization.
    expect(urlsSeen.some((u) => u.includes('/organizations/org-1/marketplace/listings/lst-1/version-access'))).toBe(true);

    // Switching the selection re-queries for that organization.
    await userEvent.selectOptions(screen.getByLabelText(/for organization/i), 'org-2');
    await waitFor(() => {
      expect(
        urlsSeen.some((u) => u.includes('/organizations/org-2/marketplace/listings/lst-1/version-access')),
      ).toBe(true);
    });
  });
});

/**
 * REALITY-REPAIR-002 — the zero-organization caller on the marketplace path
 * (F-002 regression: the purchase/install no-op).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-002.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-002 ACCEPT).
 *
 * F-002 at base on this surface: a fresh signup with zero organizations opens
 * a listing and the "Your access" section silently dead-ends — the access
 * decision never resolves for an organization (it is per-organization), the
 * offer/install/fork actions early-return without feedback, and the fork
 * panel's only signal is the dead sentence "Your organization is needed to
 * create the copy." There is NO path to establish the organization.
 *
 * The repair: when the organizations read succeeds and is empty, the section
 * renders the actionable organization onboarding (the EXISTING
 * POST /organizations authority); the created organization immediately
 * becomes the selection, so the access decision runs for it and the
 * offer/accept + install flows are reachable — the marketplace path no
 * longer silently no-ops.
 */
describe('REALITY-REPAIR-002 — zero-organization callers get the actionable onboarding (F-002)', () => {
  const NO_ORGS = () => jsonResponse(200, { organizations: [] });

  function renderZeroOrgListing(routes: Record<string, RouteHandler> = {}) {
    vi.stubGlobal(
      'fetch',
      mockApi({
        '/marketplace/listings/lst-1': LISTING_DETAIL,
        '/organizations': NO_ORGS,
        ...routes,
      }),
    );
    return render(
      <MemoryRouter initialEntries={['/explore/lst-1']}>
        <Routes>
          <Route path="/explore/:listingId" element={<MarketplaceListingDetail />} />
          <Route path="/explore" element={<div>Explore</div>} />
          <Route path="/workflows/:workflowId" element={<div>Workflow detail</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('replaces the silent dead end with the actionable onboarding — never a perpetual "Checking your access…"', async () => {
    renderZeroOrgListing();

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Weekly social media report' }),
      ).toBeVisible();
    });
    const access = await screen.findByRole('region', { name: 'Your access' });
    const onboarding = within(access).getByRole('region', {
      name: 'Organization onboarding',
    });
    expect(onboarding).toBeVisible();
    expect(within(onboarding).getByLabelText(/organization name/i)).toBeVisible();
    // The create entry renders immediately (disabled until a name exists —
    // the no-spurious-round-trips guard).
    expect(
      within(onboarding).getByRole('button', { name: /create organization/i }),
    ).toBeVisible();
    // The F-002 base defect: the per-org access decision can never resolve,
    // so the section must NOT sit in a perpetual checking state.
    expect(within(access).queryByText(/Checking your access/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Your organization is needed to create the copy/i)).not.toBeInTheDocument();
  });

  it('establishes the selection after onboarding — the access decision runs for the CREATED organization and install is reachable', async () => {
    let created = false;
    const orgsHandler = () =>
      jsonResponse(
        200,
        created
          ? { organizations: [{ id: 'org-fresh', name: 'Fresh Buyer Co', roleId: 'owner' }] }
          : { organizations: [] },
      );
    const urlsSeen: string[] = [];
    const fetchMock = vi.fn().mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input).replace(/^https?:\/\/[^/]+/, '');
        const method = (init?.method ?? 'GET').toUpperCase();
        urlsSeen.push(`${method} ${url}`);
        if (url === '/api/organizations' && method === 'GET') {
          return Promise.resolve(orgsHandler());
        }
        if (url === '/api/organizations' && method === 'POST') {
          created = true;
          return Promise.resolve(
            jsonResponse(201, {
              organization: { id: 'org-fresh', name: 'Fresh Buyer Co' },
              roleId: 'owner',
            }),
          );
        }
        if (url.includes('/api/marketplace/listings/lst-1') && method === 'GET' && !url.includes('version-access')) {
          return Promise.resolve(LISTING_DETAIL());
        }
        if (url.includes('/version-access')) {
          return Promise.resolve(DENIED());
        }
        return Promise.resolve(jsonResponse(500, { error: `unmocked ${method} ${url}` }));
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/explore/lst-1']}>
        <Routes>
          <Route path="/explore/:listingId" element={<MarketplaceListingDetail />} />
          <Route path="/explore" element={<div>Explore</div>} />
          <Route path="/workflows/:workflowId" element={<div>Workflow detail</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const access = await screen.findByRole('region', { name: 'Your access' });
    const onboarding = within(access).getByRole('region', {
      name: 'Organization onboarding',
    });
    await userEvent.type(
      within(onboarding).getByLabelText(/organization name/i),
      'Fresh Buyer Co',
    );
    await userEvent.click(
      within(onboarding).getByRole('button', { name: /create organization/i }),
    );

    // The exact existing command: POST /organizations { name }.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/organizations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Fresh Buyer Co' }),
      }),
    );
    // The created organization becomes the selection: the per-org access
    // decision runs for org-fresh (the silent no-op is repaired).
    await waitFor(() => {
      expect(
        screen.getByText("Your organization doesn't have access to this version."),
      ).toBeVisible();
    });
    expect(
      urlsSeen.some((u) => u.includes('/organizations/org-fresh/marketplace/listings/lst-1/version-access')),
    ).toBe(true);
    // The onboarding leaves the section once the organization exists.
    await waitFor(() => {
      expect(
        screen.queryByRole('region', { name: 'Organization onboarding' }),
      ).not.toBeInTheDocument();
    });
  });
});
