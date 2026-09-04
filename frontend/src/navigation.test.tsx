/// <reference types="@testing-library/jest-dom" />

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { UniversalProductShell } from './components/shell/UniversalProductShell';
import { auth } from './api/client';

/**
 * V2-017 Task 1 — the universal product navigation contract.
 *
 * Primary navigation is Home / Workflows / Explore / Activity with a
 * universal Create entry (the approved human-facing model). The existing
 * developer/engineering workspace stays reachable through an intentional
 * expert entry — progressive disclosure, never primary navigation.
 *
 * These tests mock the backend fetch (the backend's authority is the
 * subject of the backend suites) and pin the frontend navigation
 * contract: the product routes render, the nav links target the approved
 * model, the expert surface is reachable, and the session auth gate
 * still protects every product route.
 */

// The Workbench is a heavy, data-driven expert page; the navigation
// contract only needs to prove its ROUTE still renders. Mock the page
// module (route contract, not page internals).
vi.mock('./pages/WorkbenchPage', () => ({
  default: () => <div>Developer Workbench</div>,
}));

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

describe('V2-017 Task 1 — universal product navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the canonical auth-state source between tests.
    auth.handleUnauthorized();
    vi.stubGlobal(
      'fetch',
      mockSessionResponse(200, {
        user: { id: 'u-1', displayName: 'Alice', email: 'alice@example.com' },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe('primary product routes', () => {
    it.each([
      ['/', /What do you want to get done\?/i],
      ['/workflows', 'Workflows'],
      ['/explore', 'Explore'],
      ['/activity', 'Activity'],
      ['/create', /Create a workflow/i],
      ['/expert', /Expert workspace/i],
    ])('renders the product route %s', async (path, heading) => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument(),
      );
    });
  });

  describe('primary navigation model', () => {
    it('exposes Home / Workflows / Explore / Activity plus the universal Create entry', async () => {
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
      expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
      expect(screen.getByRole('link', { name: 'Workflows' })).toHaveAttribute('href', '/workflows');
      expect(screen.getByRole('link', { name: 'Explore' })).toHaveAttribute('href', '/explore');
      expect(screen.getByRole('link', { name: 'Activity' })).toHaveAttribute('href', '/activity');
      expect(screen.getByRole('link', { name: 'Create' })).toHaveAttribute('href', '/create');
    });
  });

  describe('expert workspace access (progressive disclosure)', () => {
    it('links the expert workspace from the product shell (not primary navigation)', async () => {
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

    it('renders the expert entry with the developer workspace link', async () => {
      render(
        <MemoryRouter initialEntries={['/expert']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: /Expert workspace/i })).toBeInTheDocument(),
      );
      expect(
        screen.getByRole('link', { name: /Open developer workspace/i }),
      ).toHaveAttribute('href', '/projects');
    });

    it('preserves the existing developer workbench route behind the expert surface', async () => {
      render(
        <MemoryRouter initialEntries={['/projects/project-1/workbench']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(screen.getByText('Developer Workbench')).toBeInTheDocument(),
      );
    });
  });

  describe('auth gate semantics preserved', () => {
    it('renders the session sign-out affordance on the product shell', async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Sign Out' })).toBeInTheDocument(),
      );
    });

    it('renders the LoginPage for a product route when unauthenticated', async () => {
      vi.stubGlobal('fetch', mockSessionResponse(401, { error: 'unauthenticated' }));
      render(
        <MemoryRouter initialEntries={['/workflows']}>
          <App />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(screen.getAllByText(/Sign in/i).length).toBeGreaterThan(0),
      );
    });
  });

  describe('implementation-authority language stays out of the product shell', () => {
    // The approved UX authority keeps architectural machinery behind the
    // interface: the backend-authority principle is a governance invariant,
    // never human-facing product copy. Deterministic regression for the
    // architect HOLD (PR #173, review 5108140185): the human-facing shell
    // must not render authority/implementation language. The scope is the
    // SHELL — page content is governed by the later frozen tasks.
    const FORBIDDEN_PATTERNS: RegExp[] = [
      /backend retains/i,
      /authoritative/i,
      /\bauthorit(?:y|ies)\b/i,
    ];

    it('renders the shell itself without authority-language leaks', async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <UniversalProductShell>
            <div>Page content</div>
          </UniversalProductShell>
        </MemoryRouter>,
      );
      // The shell renders synchronously (it owns no product state).
      expect(screen.getByRole('banner')).toBeInTheDocument();
      expect(screen.getByRole('contentinfo')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Expert workspace/i })).toHaveAttribute(
        'href',
        '/expert',
      );
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(screen.queryAllByText(pattern)).toHaveLength(0);
      }
    });

    it('keeps the composed product footer free of authority language', async () => {
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
      const footer = screen.getByRole('contentinfo');
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(footer.textContent ?? '').not.toMatch(pattern);
      }
    });
  });
});
