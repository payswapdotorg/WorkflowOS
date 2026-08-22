/// <reference types="@testing-library/jest-dom" />

/**
 * WORK-022 — Rendered-router regression test (PR #21 follow-up review).
 *
 * PR #21 review found a redirect-loop bug in the ORIGINAL App.tsx (commit
 * d964af6): `/` redirected to `/projects`, the catch-all also redirected to
 * `/projects`, but NO `/projects` route existed — so any navigation to `/`
 * or any unknown path would redirect to `/projects`, hit the catch-all
 * again, redirect to `/projects`, ... → infinite loop.
 *
 * The corrected App.tsx (commit ee2dba0) fixes this by:
 *   - rendering `<ProjectListPage />` at both `/` and `/projects`
 *   - redirecting the catch-all to `/` (which renders, no loop)
 *
 * This test mounts the REAL `App` component inside a `MemoryRouter` and
 * asserts the rendered output at each path — proving the redirect loop is
 * gone and every route resolves to a real page, not a Navigate-to-nowhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

describe('App router regression — no redirect loop (PR #21 follow-up)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // -------------------------------------------------------------------------
  // Authenticated branch (API key set) — the routes that previously looped.
  // -------------------------------------------------------------------------

  describe('authenticated (API key set)', () => {
    beforeEach(() => {
      localStorage.setItem('wfos_api_key', 'test-api-key');
    });

    it('renders ProjectListPage at `/` (no redirect loop)', () => {
      const { getByTestId, queryByTestId } = render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      // The landing page renders — NOT a Navigate-to-/projects loop.
      expect(getByTestId('project-list-page')).toBeInTheDocument();
      // The login page must NOT render (we're authenticated).
      expect(queryByTestId('login-page')).not.toBeInTheDocument();
    });

    it('renders ProjectListPage at `/projects` (route now exists)', () => {
      const { getByTestId } = render(
        <MemoryRouter initialEntries={['/projects']}>
          <App />
        </MemoryRouter>,
      );
      // The `/projects` route exists and renders ProjectListPage — this was
      // the missing route that caused the original redirect loop.
      expect(getByTestId('project-list-page')).toBeInTheDocument();
    });

    it('catch-all redirects unknown routes to `/` (which renders, no loop)', () => {
      // An unknown path should hit the catch-all `<Navigate to="/" replace />`
      // and then render ProjectListPage at `/` — NOT redirect to `/projects`
      // (which would loop in the original implementation).
      const { getByTestId } = render(
        <MemoryRouter initialEntries={['/totally-unknown-path']}>
          <App />
        </MemoryRouter>,
      );
      // After the Navigate-to-`/`, ProjectListPage renders.
      expect(getByTestId('project-list-page')).toBeInTheDocument();
    });

    it('renders ProjectPage at `/projects/:projectId`', () => {
      // ProjectPage calls fetch on mount; we only assert that the App routes
      // to it (it shows "Loading project..." initially). We stub fetch as a
      // no-op so the page mounts without network errors.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() => Promise.resolve(new Response('{}', { status: 200 }))) as typeof fetch;
      try {
        const { getByText } = render(
          <MemoryRouter initialEntries={['/projects/test-project-id']}>
            <App />
          </MemoryRouter>,
        );
        expect(getByText(/Loading project/i)).toBeInTheDocument();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('renders WorkItemPage at `/work-items/:workItemId`', () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() => Promise.resolve(new Response('{}', { status: 200 }))) as typeof fetch;
      try {
        const { getByText } = render(
          <MemoryRouter initialEntries={['/work-items/test-wi-id']}>
            <App />
          </MemoryRouter>,
        );
        expect(getByText(/Loading work item/i)).toBeInTheDocument();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('renders the Layout shell (header + footer) for authenticated routes', () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      // Layout header.
      expect(getByText('WorkflowOS')).toBeInTheDocument();
      // Layout footer text.
      expect(getByText(/Backend retains all authoritative state/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Unauthenticated branch (no API key) — every path renders LoginPage.
  // -------------------------------------------------------------------------

  describe('unauthenticated (no API key)', () => {
    it('renders LoginPage at `/`', () => {
      const { getByTestId, queryByTestId } = render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      expect(getByTestId('login-page')).toBeInTheDocument();
      // ProjectListPage must NOT render when unauthenticated.
      expect(queryByTestId('project-list-page')).not.toBeInTheDocument();
    });

    it('renders LoginPage for any path when unauthenticated', () => {
      const { getByTestId } = render(
        <MemoryRouter initialEntries={['/projects/some-id']}>
          <App />
        </MemoryRouter>,
      );
      // The catch-all route renders LoginPage when no API key is set.
      expect(getByTestId('login-page')).toBeInTheDocument();
    });
  });
});
