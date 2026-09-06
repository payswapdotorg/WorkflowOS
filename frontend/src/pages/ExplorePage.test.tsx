/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ExplorePage from './ExplorePage';

/**
 * V2-017 T12 — the Explore marketplace browse contract (Issue #7 dispatch;
 * UX spec §22 over the existing V2-012 listing browse authority).
 *
 * Explore renders the listings visible to the caller through the V2-012
 * browse read (public distribution, plus restricted listings shared with
 * the caller's organizations). HONESTY RULES:
 *   - loading / error-with-retry / successful-empty / data are distinct
 *     states — a failed read is never a successful empty;
 *   - each card fact (name, description, price, version) derives from the
 *     authoritative listing + current revision;
 *   - no internal identifier (org id, user id, offer id) ever renders;
 *   - publication is never presented as verification (the trust sentence).
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

const LISTING_CARD = {
  listing: {
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
  },
  revision: {
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
      requiredCapabilities: ['github.repository.read'],
      sensitiveCapabilities: [],
      placements: ['cloud_allowed'],
      dependencyGraph: [],
      provenance: { forkedFromWorkflowId: null, forkedFromVersionId: null },
    },
    createdAt: 1789500003000,
  },
};

const FREE_CARD = {
  ...LISTING_CARD,
  listing: {
    ...LISTING_CARD.listing,
    id: 'lst-2',
    name: 'Invoice collector',
    description: 'Collects invoices into one spreadsheet.',
    workflowId: 'wf-10',
    currentRevisionId: 'rev-3',
  },
  revision: {
    ...LISTING_CARD.revision,
    id: 'rev-3',
    listingId: 'lst-2',
    pin: {
      workflowId: 'wf-10',
      versionId: 'ver-7',
      versionNumber: 1,
      contentDigest: 'sha256:content-v7',
      protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
    },
    offers: [
      { id: 'off-free', model: 'free', terms: { model: 'free' }, createdAt: 1789500004000 },
    ],
  },
};

const ORGS = () =>
  jsonResponse(200, {
    organizations: [{ id: 'org-1', name: 'Bay Logistics', roleId: 'owner' }],
  });

function renderExplore(routes: Record<string, RouteHandler>) {
  vi.stubGlobal('fetch', mockApi({ '/organizations': ORGS, ...routes }));
  return render(
    <MemoryRouter initialEntries={['/explore']}>
      <Routes>
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/explore/:listingId" element={<div>Listing detail</div>} />
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

describe('the listings browse (§22 discovery)', () => {
  it('renders listing cards from the authoritative browse read — no internal identifiers', async () => {
    renderExplore({
      '/marketplace/listings': () => jsonResponse(200, { listings: [LISTING_CARD, FREE_CARD] }),
    });

    expect(
      await screen.findByRole('heading', { name: 'Weekly social media report' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Invoice collector' })).toBeVisible();

    // Card facts: description, price, version.
    expect(
      screen.getByText('Automatically creates and sends your weekly social report.'),
    ).toBeVisible();
    expect(screen.getByText('$19.00')).toBeVisible();
    expect(screen.getByText('$5.00/month')).toBeVisible();
    expect(screen.getByText('Free')).toBeVisible();
    expect(screen.getAllByText('Version 3').length).toBeGreaterThan(0);

    // No identifiers ever render.
    expect(screen.queryByText(/org-publisher/)).not.toBeInTheDocument();
    expect(screen.queryByText(/user-ada/)).not.toBeInTheDocument();
    expect(screen.queryByText(/off-one-time/)).not.toBeInTheDocument();
    expect(screen.queryByText(/lst-1/)).not.toBeInTheDocument();

    // Publication is never presented as verification.
    expect(
      screen.getByText('Publication is not verification, authorization, or proof of safety.'),
    ).toBeVisible();
  });

  it('a card links to its listing detail', async () => {
    renderExplore({
      '/marketplace/listings': () => jsonResponse(200, { listings: [LISTING_CARD] }),
    });

    const link = await screen.findByRole('link', { name: /weekly social media report/i });
    expect(link).toHaveAttribute('href', '/explore/lst-1');
  });

  it('a successful read with zero listings is the honest empty state', async () => {
    renderExplore({
      '/marketplace/listings': () => jsonResponse(200, { listings: [] }),
    });

    expect(await screen.findByText(/nothing is published for you yet/i)).toBeVisible();
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
  });

  it('a failed read stays visibly Unavailable with retry — never an empty success', async () => {
    renderExplore({
      '/marketplace/listings': () => jsonResponse(500, { error: 'boom' }),
    });

    expect(await screen.findByText(/unavailable/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /try again/i })).toBeVisible();
    expect(screen.queryByText(/nothing is published for you yet/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Weekly social media report' })).not.toBeInTheDocument();
  });

  it('retry recovers to data', async () => {
    let failing = true;
    renderExplore({
      '/marketplace/listings': () =>
        failing
          ? jsonResponse(500, { error: 'boom' })
          : jsonResponse(200, { listings: [LISTING_CARD] }),
    });

    expect(await screen.findByText(/unavailable/i)).toBeVisible();
    failing = false;
    await screen.getByRole('button', { name: /try again/i }).click();
    expect(
      await screen.findByRole('heading', { name: 'Weekly social media report' }),
    ).toBeVisible();
  });
});
