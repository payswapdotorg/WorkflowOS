/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BenchmarkDetailPage from './BenchmarkDetailPage';

/**
 * WORK-032 smoke test — pure render-without-crash check.
 * No fetch mocking at the unit-test layer (per the LoginPage.test.tsx
 * convention). The page initial-renders the loading state because it has
 * no experiment yet (the route param is undefined when no real backend
 * is available in the unit-test environment).
 */
describe('BenchmarkDetailPage smoke', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders the loading state on initial mount', () => {
    const { getByText } = render(
      <MemoryRouter initialEntries={['/benchmarks/some-experiment-id']}>
        <BenchmarkDetailPage />
      </MemoryRouter>,
    );
    expect(getByText('Loading experiment…')).toBeInTheDocument();
  });
});
