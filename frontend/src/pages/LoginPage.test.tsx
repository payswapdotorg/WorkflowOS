/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import LoginPage from './LoginPage';
import { auth } from '../api/client';

/**
 * WORK-074 — the human login surface.
 *
 * The LoginPage offers the WORK-063 human providers (Google / GitHub /
 * email+password) and NO API-key input: the demo key is retired from the
 * customer-facing production login path (WORK-063 invariant #9). Unconfigured
 * OAuth providers render as honestly unavailable. Signing in goes through the
 * canonical auth-state source (the backend's answer is the authority — the
 * browser never decides authorization).
 */

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('LoginPage — the human login surface', () => {
  beforeEach(() => {
    localStorage.clear();
    auth.handleUnauthorized();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders the provider buttons, the email form, and NO API-key input', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url) => {
        if (url.includes('/auth/providers')) {
          return Promise.resolve(
            jsonResponse(200, {
              providers: [
                { id: 'google', configured: true },
                { id: 'github', configured: true },
              ],
            }),
          );
        }
        return Promise.resolve(jsonResponse(404, {}));
      }),
    );
    const { getByText, getByLabelText, queryByText, queryByLabelText } = render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(getByText(/Continue with Google/)).toBeInTheDocument());
    expect(getByText(/Continue with GitHub/)).toBeInTheDocument();
    expect(getByLabelText(/Email/i)).toBeInTheDocument();
    expect(getByLabelText(/Password/i)).toBeInTheDocument();
    // The retired demo-key surface is gone.
    expect(queryByText(/API key/i)).not.toBeInTheDocument();
    expect(queryByLabelText(/API key/i)).not.toBeInTheDocument();
  });

  it('renders unconfigured providers as honestly unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url) => {
        if (url.includes('/auth/providers')) {
          return Promise.resolve(
            jsonResponse(200, {
              providers: [
                { id: 'google', configured: false },
                { id: 'github', configured: true },
              ],
            }),
          );
        }
        return Promise.resolve(jsonResponse(404, {}));
      }),
    );
    const { getByText } = render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(getByText(/Continue with Google \(unavailable\)/)).toBeInTheDocument(),
    );
    expect(getByText(/Continue with GitHub/)).toBeInTheDocument();
  });

  it('signs in with email/password and lands on the authenticated state synchronously (no reload)', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      mockFetch((url, init) => {
        if (url.includes('/auth/providers')) {
          return Promise.resolve(jsonResponse(200, { providers: [] }));
        }
        if (url.includes('/auth/password/login')) {
          expect(init?.method).toBe('POST');
          const payload = JSON.parse(String(init?.body));
          expect(payload.email).toBe('ada@example.com');
          expect(payload.password).toBe('a-long-password');
          return Promise.resolve(
            jsonResponse(200, {
              user: { id: 'u-1', displayName: 'Ada', email: 'ada@example.com' },
            }),
          );
        }
        return Promise.resolve(jsonResponse(404, {}));
      }),
    );
    const onAuthed = vi.fn();
    const unsubscribe = auth.subscribe(() => {
      if (auth.getSnapshot().status === 'authenticated') onAuthed();
    });

    const { getByLabelText, getByRole } = render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    await user.type(getByLabelText(/Email/i), 'ada@example.com');
    await user.type(getByLabelText(/Password/i), 'a-long-password');
    await user.click(getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(auth.getSnapshot().status).toBe('authenticated'));
    expect(onAuthed).toHaveBeenCalled();
    expect(auth.getSnapshot().user?.displayName).toBe('Ada');
    unsubscribe();
  });

  it('surfaces wrong credentials honestly (the backend 401 is the authority)', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      mockFetch((url) => {
        if (url.includes('/auth/providers')) {
          return Promise.resolve(jsonResponse(200, { providers: [] }));
        }
        if (url.includes('/auth/password/login')) {
          return Promise.resolve(jsonResponse(401, { error: 'invalid-credentials' }));
        }
        return Promise.resolve(jsonResponse(404, {}));
      }),
    );
    const { getByLabelText, getByRole, findByText } = render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    await user.type(getByLabelText(/Email/i), 'ada@example.com');
    await user.type(getByLabelText(/Password/i), 'wrong-password');
    await user.click(getByRole('button', { name: 'Sign in' }));
    expect(await findByText(/Invalid email or password/i)).toBeInTheDocument();
    expect(auth.getSnapshot().status).toBe('unauthenticated');
  });

  it('switches to registration and creates an account through the same canonical source', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      mockFetch((url, init) => {
        if (url.includes('/auth/providers')) {
          return Promise.resolve(jsonResponse(200, { providers: [] }));
        }
        if (url.includes('/auth/password/register')) {
          const payload = JSON.parse(String(init?.body));
          expect(payload.email).toBe('grace@example.com');
          return Promise.resolve(
            jsonResponse(201, {
              user: { id: 'u-2', displayName: 'Grace', email: 'grace@example.com' },
            }),
          );
        }
        return Promise.resolve(jsonResponse(404, {}));
      }),
    );
    const { getByLabelText, getByRole, getByText } = render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    await user.click(getByText('Create one'));
    await user.type(getByLabelText(/Name/i), 'Grace');
    await user.type(getByLabelText(/Email/i), 'grace@example.com');
    await user.type(getByLabelText(/Password/i), 'another-long-password');
    await user.click(getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(auth.getSnapshot().status).toBe('authenticated'));
    expect(auth.getSnapshot().user?.email).toBe('grace@example.com');
  });
});
