/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastHost } from '@/components/ui/toast';
import ExecutionPreferencesPage from './ExecutionPreferencesPage';

/**
 * WORK-033 ExecutionPreferencesPage smoke tests.
 *
 * Mirrors the BenchmarkDetailPage.test.tsx convention: pure
 * render-without-crash check, no fetch mocking at the unit-test layer.
 * The page initial-renders the loading state (early-return) because it
 * has no real backend in jsdom — the assertion passes before any async
 * effect-driven state update settles.
 */
describe('ExecutionPreferencesPage smoke', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders the loading state on initial mount', () => {
    const { getByText } = render(
      <MemoryRouter initialEntries={['/projects/test-project-id/settings/execution']}>
        <ToastHost>
          <ExecutionPreferencesPage />
        </ToastHost>
      </MemoryRouter>,
    );
    expect(getByText('Loading execution preferences…')).toBeInTheDocument();
  });
});
