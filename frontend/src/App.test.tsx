/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

describe('App router regression — no redirect loop', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('authenticated (API key set)', () => {
    beforeEach(() => {
      localStorage.setItem('wfos_api_key', 'test-api-key');
    });

    it('renders ProjectListPage at `/` (no redirect loop)', () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      // The ProjectListPage has a "New Project" button.
      expect(getByText('New Project')).toBeInTheDocument();
    });

    it('renders ProjectListPage at `/projects` (route now exists)', () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/projects']}>
          <App />
        </MemoryRouter>,
      );
      expect(getByText('New Project')).toBeInTheDocument();
    });

    it('catch-all redirects unknown routes to `/` (which renders, no loop)', () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/totally-unknown-path']}>
          <App />
        </MemoryRouter>,
      );
      expect(getByText('New Project')).toBeInTheDocument();
    });
  });

  describe('unauthenticated (no API key)', () => {
    it('renders LoginPage at `/`', () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );
      expect(getByText(/WorkflowOS/i)).toBeInTheDocument();
      expect(getByText(/API key/i)).toBeInTheDocument();
    });

    it('renders LoginPage for any path when unauthenticated', () => {
      const { getByText } = render(
        <MemoryRouter initialEntries={['/projects/some-id']}>
          <App />
        </MemoryRouter>,
      );
      expect(getByText(/API key/i)).toBeInTheDocument();
    });
  });
});
