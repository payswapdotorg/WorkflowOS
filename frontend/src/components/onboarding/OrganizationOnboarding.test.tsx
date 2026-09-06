/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OrganizationOnboarding from './OrganizationOnboarding';

/**
 * REALITY-REPAIR-002 — the first-run organization onboarding contract (F-002).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-002.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-002 ACCEPT).
 *
 * F-002 (the audit's release blocker): a fresh signup reaches the product
 * shell with ZERO organizations, and every org-scoped product action silently
 * no-ops because the UI never creates or selects an organization. The repair
 * is the smallest valid onboarding composition over the EXISTING authority —
 * `POST /organizations` (the creator becomes its `owner`) — with NO new
 * authority, persistence model, or authorization semantics.
 *
 * This component is presentation plus the ONE existing command:
 *   - it never reads the organization collection itself (the mounting
 *     surface owns the zero-org condition, so there is no second read and no
 *     client-side authority over "which orgs exist");
 *   - it never fabricates an organization: the created record handed to the
 *     parent comes from the authoritative 201 response verbatim;
 *   - the create can fail (honest error + retry, the form stays usable);
 *   - the submit is disabled while the command is in flight or the name is
 *     blank (no spurious authority round-trips).
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type RouteHandler = () => Response | Promise<Response>;

function mockApi(routes: Record<string, RouteHandler>): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const [key, handler] of Object.entries(routes)) {
      const methodPrefix = /^([A-Z]+) (.*)$/.exec(key);
      if (methodPrefix) {
        if (methodPrefix[1] === method && url.includes(methodPrefix[2])) {
          return Promise.resolve(handler());
        }
        continue;
      }
      if (url.includes(key)) return Promise.resolve(handler());
    }
    return Promise.resolve(jsonResponse(500, { error: `unmocked ${method} ${url}` }));
  });
}

const createdOrg = {
  organization: {
    id: 'org-created-1',
    name: 'Lumen Studio',
    createdAt: '2026-09-06T10:00:00Z',
  },
  roleId: 'owner',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('REALITY-REPAIR-002 — the organization onboarding card (F-002)', () => {
  it('renders the explicit first-run form: a named region, the reason, and the create entry', () => {
    vi.stubGlobal('fetch', mockApi({}));
    const onCreated = vi.fn();
    render(<OrganizationOnboarding onCreated={onCreated} />);

    const region = screen.getByRole('region', { name: 'Organization onboarding' });
    expect(region).toBeVisible();
    expect(screen.getByRole('heading', { name: /set up your organization/i })).toBeVisible();
    // The F-002 explainer: the user must know WHY the org is needed — the
    // org-scoped product actions (installs, purchases, copies) need one.
    expect(
      screen.getByText(/workflows you install and buy belong to an organization/i),
    ).toBeVisible();
    expect(screen.getByLabelText(/organization name/i)).toBeVisible();
    // The create entry renders immediately (the guard: it stays disabled
    // until a non-blank name exists — no spurious authority round-trips).
    const createButton = screen.getByRole('button', { name: /create organization/i });
    expect(createButton).toBeVisible();
    expect(createButton).toBeDisabled();
  });

  it('submits the trimmed name through the EXISTING POST /organizations authority and hands the authoritative created record to the parent', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      mockApi({ 'POST /organizations': () => jsonResponse(201, createdOrg) }),
    );
    const onCreated = vi.fn();
    render(<OrganizationOnboarding onCreated={onCreated} />);

    await user.type(screen.getByLabelText(/organization name/i), '  Lumen Studio  ');
    await user.click(screen.getByRole('button', { name: /create organization/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    // The exact existing command: POST /organizations { name } (the client's
    // API base is /api — the authoritative route path is /organizations).
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/organizations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Lumen Studio' }),
      }),
    );
    // The parent receives the AUTHORITATIVE record (from the 201 response),
    // never a client-fabricated organization.
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'org-created-1', name: 'Lumen Studio' }),
    );
  });

  it('shows an honest failure (role=alert) when the create command fails, and the form stays retryable', async () => {
    const user = userEvent.setup();
    let fail = true;
    vi.stubGlobal(
      'fetch',
      mockApi({
        'POST /organizations': () =>
          fail
            ? jsonResponse(503, { error: 'unavailable' })
            : jsonResponse(201, createdOrg),
      }),
    );
    const onCreated = vi.fn();
    render(<OrganizationOnboarding onCreated={onCreated} />);

    await user.type(screen.getByLabelText(/organization name/i), 'Lumen Studio');
    await user.click(screen.getByRole('button', { name: /create organization/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toBeVisible();
    expect(onCreated).not.toHaveBeenCalled();

    // Retry succeeds once the authority answers: the failure is honest, not
    // a permanent dead end (the F-002 silent no-op is what must never return).
    fail = false;
    await user.click(screen.getByRole('button', { name: /create organization/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it('never lets an empty name reach the authority (client-side guard, no spurious 400 round-trips)', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', mockApi({}));
    const onCreated = vi.fn();
    render(<OrganizationOnboarding onCreated={onCreated} />);

    await user.type(screen.getByLabelText(/organization name/i), '   ');
    expect(screen.getByRole('button', { name: /create organization/i })).toBeDisabled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
