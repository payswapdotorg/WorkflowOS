/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LoginPage from './LoginPage';

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
    expect(getByText(/API key/i)).toBeInTheDocument();
    expect(queryByText(/super-secret-key/)).not.toBeInTheDocument();
    const input = getByPlaceholderText(/Enter your API key/i) as HTMLInputElement;
    expect(input.type).toBe('password');
  });
});
