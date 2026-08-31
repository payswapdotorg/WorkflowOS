/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { auth } from './api/client';

/**
 * WORK-074 — the App auth gate over the ONE canonical auth-state source.
 *
 * The frontend tests mock the backend fetch (the backend's authority is the
 * subject of the backend suites); these tests pin the frontend state-ownership
 * behavior: the auth gate reflects the backend's answer, and no credential
 * material is stored client-side.
 */

function mockSessionResponse(status: number, body?: unknown) {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/session')) {
      return Promise.resolve(
        new Response(JSON.stringify(body ?? {}), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    // Product reads (projects list etc.) — empty success payloads.
    return Promise.resolve(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

describe('App router regression — no redirect loop (session-based gate)', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the canonical auth-state source between tests.
    auth.handleUnauthorized();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe('authenticated (backend reports a session)', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        mockSessionResponse(200, {
          user: { id: 'u-1', displayName: 'Alice', email: 'alice@example.com' },
        }),
      );
    });

    it('renders ProjectListPage at `/` (no redirect loop)', async () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() => expect(getByText('New Project')).toBeInTheDocument());
    });

    it('renders ProjectListPage at `/projects` (route now exists)', async () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/projects']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() => expect(getByText('New Project')).toBeInTheDocument());
    });

    it('catch-all redirects unknown routes to `/` (which renders, no loop)', async () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/totally-unknown-path']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() => expect(getByText('New Project')).toBeInTheDocument());
    });
  });

  describe('unauthenticated (backend reports 401)', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', mockSessionResponse(401, { error: 'unauthenticated' }));
    });

    it('renders the human LoginPage at `/`', async () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() => expect(getByText(/WorkflowOS/i)).toBeInTheDocument());
      expect(getByText(/Continue with GitHub/i)).toBeInTheDocument();
      expect(getByText('Sign in')).toBeInTheDocument();
    });

    it('renders the LoginPage for any protected path when unauthenticated', async () => {
      render(
        <MemoryRouter initialEntries={['/projects/some-id']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getAllByText(/Sign in/i).length).toBeGreaterThan(0));
    });

    it('never stores credential material client-side (the session is an HttpOnly cookie)', async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByText(/Sign in/i)).toBeInTheDocument());
      expect(localStorage.getItem('wfos_api_key')).toBeNull();
      expect(localStorage.getItem('wfos_session')).toBeNull();
      // The cookie cleanup contract exists on the client (best-effort clear).
      expect(document.cookie).not.toContain('wfos_session=valid');
    });
  });
});
