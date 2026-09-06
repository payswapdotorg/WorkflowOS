/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ShareExperience from './ShareExperience';
import type { ProductWorkflow, ProductWorkflowVersion } from '../../api/client';

/**
 * V2-017 T12 — the Share experience contract (Issue #7 dispatch; UX spec
 * §21/§22 over the existing V2-002 + V2-012 authorities).
 *
 * Share composes EXISTING authorities only:
 *   - the V2-002 visibility facts + the EXISTING visibility PATCH (a
 *     private workflow must become public before it can be listed — the
 *     V2-012 publish precondition, surfaced honestly);
 *   - the V2-012 listing creation + publication through its transport
 *     routes (create converges on the publisher workflow — a duplicate
 *     share converges, it never creates a second listing);
 *   - the head version pin: the listing pins the EXACT current version
 *     (immutable-version semantics preserved — no draft/floating pin).
 *
 * HONESTY RULES:
 *   - the entitlement boundary sentence renders with the published state
 *     (a listing is access, never execution authorization);
 *   - a publish failure renders as an honest error — never a fabricated
 *     published state;
 *   - converge (created=false) is presented as "already listed", never as
 *     a fresh publication.
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

const PRIVATE_WORKFLOW: ProductWorkflow = {
  id: 'wf-1',
  organizationId: 'org-1',
  ownerUserId: 'user-1',
  slug: 'weekly-social-report',
  name: 'Weekly social media report',
  description: 'Automatically creates and sends your weekly social report.',
  visibility: 'private',
  headVersionId: 'ver-1',
  forkedFromWorkflowId: null,
  forkedFromVersionId: null,
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-04T09:00:00Z',
};

const PUBLIC_WORKFLOW: ProductWorkflow = {
  ...PRIVATE_WORKFLOW,
  visibility: 'public',
};

const HEAD_VERSION: ProductWorkflowVersion = {
  id: 'ver-1',
  workflowId: 'wf-1',
  versionNumber: 3,
  contentDigest: 'sha256:content-v3',
  content: {},
  protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
  parentVersionId: null,
  createdByUserId: 'user-1',
  createdAt: '2026-09-04T09:00:00Z',
};

const CREATED_LISTING = {
  listing: {
    id: 'lst-1',
    publisherOrganizationId: 'org-1',
    publisherUserId: 'user-1',
    workflowId: 'wf-1',
    name: 'Weekly social media report',
    description: 'Automatically creates and sends your weekly social report.',
    status: 'published',
    distribution: 'public',
    currentRevisionId: 'rev-1',
    createdAt: 1789500000000,
    updatedAt: 1789500100000,
  },
  revision: {
    id: 'rev-1',
    listingId: 'lst-1',
    sequence: 1,
    pin: {
      workflowId: 'wf-1',
      versionId: 'ver-1',
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
    ],
    trust: {
      publisherOrganizationId: 'org-1',
      publisherUserId: 'user-1',
      workflowId: 'wf-1',
      versionId: 'ver-1',
      versionNumber: 3,
      contentDigest: 'sha256:content-v3',
      semanticDigest: 'sha256:semantic-v3',
      requiredCapabilities: ['github.repository.read'],
      sensitiveCapabilities: [],
      placements: ['cloud_allowed'],
      dependencyGraph: [],
      provenance: { forkedFromWorkflowId: null, forkedFromVersionId: null },
    },
    createdAt: 1789500002000,
  },
};

function renderShare(
  routes: Record<string, RouteHandler>,
  workflow: ProductWorkflow,
  version: ProductWorkflowVersion | null = HEAD_VERSION,
) {
  vi.stubGlobal('fetch', mockApi(routes));
  return render(
    <MemoryRouter>
      <Routes>
        <Route
          path="/"
          element={
            <ShareExperience workflow={workflow} headVersion={version} onRefresh={() => {}} />
          }
        />
        <Route path="/explore/:listingId" element={<div>Explore listing</div>} />
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

describe('the visibility precondition (V2-002 + the V2-012 publish rule)', () => {
  it('a private workflow shows who can use it today and the honest publish precondition', () => {
    renderShare({}, PRIVATE_WORKFLOW);

    expect(screen.getByText('Private — only you')).toBeVisible();
    expect(
      screen.getByText('Publishing to Explore requires this workflow to be public.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: /make it public/i })).toBeVisible();
    // The listing form is NOT offered while private.
    expect(screen.queryByRole('button', { name: /publish to explore/i })).not.toBeInTheDocument();
  });

  it('Make it public uses the EXISTING V2-002 visibility command, then offers the listing form', async () => {
    let madePublic = false;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, '');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/api/workflow-repository/workflows/wf-1') && method === 'PATCH') {
        expect(JSON.parse(String(init?.body))).toEqual({ visibility: 'public' });
        madePublic = true;
        return Promise.resolve(
          jsonResponse(200, { workflow: { ...PRIVATE_WORKFLOW, visibility: 'public' } }),
        );
      }
      return Promise.resolve(jsonResponse(500, { error: `unmocked ${method} ${url}` }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter>
        <ShareExperience
          workflow={PRIVATE_WORKFLOW}
          headVersion={HEAD_VERSION}
          onRefresh={() => {}}
        />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: /make it public/i }));

    expect(await screen.findByText('Public — any signed-in user')).toBeVisible();
    expect(madePublic).toBe(true);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /publish to explore/i })).toBeVisible();
    });
  });

  it('a visibility-command failure stays honest (never a fake public state)', async () => {
    renderShare(
      {
        'PATCH /workflow-repository/workflows/wf-1': () =>
          jsonResponse(403, { error: 'workflow-not-owned' }),
      },
      PRIVATE_WORKFLOW,
    );

    await userEvent.click(screen.getByRole('button', { name: /make it public/i }));

    expect(await screen.findByText(/couldn't make the workflow public/i)).toBeVisible();
    expect(screen.getByText('Private — only you')).toBeVisible();
    expect(screen.queryByRole('button', { name: /publish to explore/i })).not.toBeInTheDocument();
  });
});

describe('publishing the listing (the V2-012 create + publish commands)', () => {
  it('publishes with pricing the publisher chose, pinning the EXACT head version', async () => {
    let createInput: Record<string, unknown> | null = null;
    let published = false;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, '');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/api/marketplace/listings') && method === 'POST' && !url.includes('/lst-1')) {
        createInput = JSON.parse(String(init?.body));
        return Promise.resolve(jsonResponse(201, { ...CREATED_LISTING, created: true }));
      }
      if (url.includes('/api/marketplace/listings/lst-1/publish') && method === 'POST') {
        published = true;
        return Promise.resolve(jsonResponse(200, CREATED_LISTING));
      }
      return Promise.resolve(jsonResponse(500, { error: `unmocked ${method} ${url}` }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter>
        <ShareExperience
          workflow={PUBLIC_WORKFLOW}
          headVersion={HEAD_VERSION}
          onRefresh={() => {}}
        />
      </MemoryRouter>,
    );

    // The form pre-fills from the workflow facts.
    expect(screen.getByDisplayValue('Weekly social media report')).toBeVisible();

    // Choose the one-time price and publish.
    await userEvent.type(
      screen.getByLabelText(/one-time price/i),
      '19',
    );
    await userEvent.click(screen.getByRole('button', { name: /publish to explore/i }));

    // The create command pins the exact head version for the owning org.
    await waitFor(() => {
      expect(published).toBe(true);
    });
    expect(createInput).toMatchObject({
      organizationId: 'org-1',
      workflowId: 'wf-1',
      versionId: 'ver-1',
      name: 'Weekly social media report',
    });
    const offers = (createInput as unknown as { offers?: unknown[] } | null)?.offers ?? [];
    expect(offers).toEqual([
      {
        model: 'one_time_purchase',
        terms: { model: 'one_time_purchase', amount: '19.00', currency: 'USD', updatePolicy: 'pinned_only' },
      },
    ]);

    // The published state: link + the entitlement boundary sentence.
    expect(await screen.findByText(/published to explore/i)).toBeVisible();
    const viewLink = screen.getByRole('link', { name: /view on explore/i });
    expect(viewLink).toHaveAttribute('href', '/explore/lst-1');
    expect(
      screen.getByText(
        'Getting this workflow gives your organization access to its content — it is not permission to run. Execution stays subject to your access and approvals.',
      ),
    ).toBeVisible();
  });

  it('a free listing needs no price; a maintenance price is offered alongside', async () => {
    let createInput: Record<string, unknown> | null = null;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, '');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/api/marketplace/listings' && method === 'POST') {
        createInput = JSON.parse(String(init?.body));
        return Promise.resolve(jsonResponse(201, { ...CREATED_LISTING, created: true }));
      }
      if (url.includes('/api/marketplace/listings/lst-1/publish') && method === 'POST') {
        return Promise.resolve(jsonResponse(200, CREATED_LISTING));
      }
      return Promise.resolve(jsonResponse(500, { error: `unmocked ${method} ${url}` }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter>
        <ShareExperience
          workflow={PUBLIC_WORKFLOW}
          headVersion={HEAD_VERSION}
          onRefresh={() => {}}
        />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByLabelText(/free/i));
    await userEvent.click(screen.getByRole('button', { name: /publish to explore/i }));

    await waitFor(() => {
      expect(screen.getByText(/published to explore/i)).toBeVisible();
    });
    expect((createInput as unknown as { offers?: unknown[] } | null)?.offers).toEqual([
      { model: 'free', terms: { model: 'free' } },
    ]);
  });

  it('an already-listed workflow converges honestly (never a second listing)', async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, '');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/api/marketplace/listings') && method === 'POST') {
        // The create-or-converge answer: created=false, the EXISTING listing.
        return Promise.resolve(jsonResponse(200, { ...CREATED_LISTING, created: false }));
      }
      if (url.includes('/api/marketplace/listings/lst-1/publish') && method === 'POST') {
        // Idempotent publish of the already-listed workflow.
        return Promise.resolve(jsonResponse(200, CREATED_LISTING));
      }
      return Promise.resolve(jsonResponse(500, { error: `unmocked ${method} ${url}` }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter>
        <ShareExperience
          workflow={PUBLIC_WORKFLOW}
          headVersion={HEAD_VERSION}
          onRefresh={() => {}}
        />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByLabelText(/free/i));
    await userEvent.click(screen.getByRole('button', { name: /publish to explore/i }));

    expect(await screen.findByText(/already listed/i)).toBeVisible();
    expect(screen.getByRole('link', { name: /view on explore/i })).toHaveAttribute(
      'href',
      '/explore/lst-1',
    );
  });

  it('a publish failure renders as an honest error — never a fabricated published state', async () => {
    renderShare(
      {
        'POST /marketplace/listings': () =>
          jsonResponse(403, {
            error: 'marketplace-not-organization-member',
            code: 'MARKETPLACE_NOT_ORGANIZATION_MEMBER',
            message: 'the principal is not a member of the publisher organization',
          }),
      },
      PUBLIC_WORKFLOW,
    );

    await userEvent.click(screen.getByLabelText(/free/i));
    await userEvent.click(screen.getByRole('button', { name: /publish to explore/i }));

    expect(await screen.findByText(/couldn't publish/i)).toBeVisible();
    expect(screen.queryByText(/published to explore/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /view on explore/i })).not.toBeInTheDocument();
  });

  it('without a head version the share surface discloses the pin honestly (no floating listing)', () => {
    renderShare({}, PUBLIC_WORKFLOW, null);

    expect(screen.getByText(/version facts unavailable/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /publish to explore/i })).not.toBeInTheDocument();
  });
});

describe('the Make-my-own disclosure on the share surface (§21)', () => {
  it('tells recipients what a copy does and does not inherit', () => {
    renderShare({}, PUBLIC_WORKFLOW);

    const promises = screen.getByRole('list', { name: /what a copy inherits/i });
    expect(within(promises).getByText('Have its own versions')).toBeVisible();
    expect(within(promises).getByText('Keep the original attribution')).toBeVisible();
    expect(
      within(promises).getByText('Not receive the publisher’s private data'),
    ).toBeVisible();
    expect(within(promises).getByText('Not receive the publisher’s secrets')).toBeVisible();
  });
});

