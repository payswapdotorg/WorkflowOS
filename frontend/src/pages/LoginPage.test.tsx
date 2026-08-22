/// <reference types="@testing-library/jest-dom" />

/**
 * WORK-022 frontend smoke test.
 *
 * Verifies the LoginPage renders without crashing and that the UI never
 * stores or displays the API key as visible text. The deep rendered-UI /
 * end-to-end tests that exercise the real Fastify backend live in
 * `backend/tests/integration/frontend/rendered-ui.integration.test.tsx`
 * (they need backend test helpers + service wiring).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LoginPage from '../pages/LoginPage';

describe('LoginPage smoke', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders the sign-in prompt without exposing any stored API key', () => {
    localStorage.setItem('wfos_api_key', 'super-secret-key');
    const { getByText, queryByText, getByPlaceholderText } = render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    // The sign-in prompt renders.
    expect(getByText(/Enter your API key/i)).toBeInTheDocument();
    // The stored API key is NEVER rendered as visible text (SECURITY).
    expect(queryByText(/super-secret-key/)).not.toBeInTheDocument();
    // The input field exists and is a password type (masked).
    const input = getByPlaceholderText(/API Key/i) as HTMLInputElement;
    expect(input.type).toBe('password');
  });
});
