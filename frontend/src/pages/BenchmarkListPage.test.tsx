/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BenchmarkListPage from './BenchmarkListPage';

/**
 * WORK-032 smoke tests — pure render-without-crash checks.
 * No fetch mocking at the unit-test layer (per the LoginPage.test.tsx
 * convention). The page mounts, the initial render shows the header +
 * project selector loading state, and the assertion passes before any
 * async effect-driven state update settles.
 */
describe('BenchmarkListPage smoke', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders the page header on initial mount', () => {
    const { getByText, getAllByText } = render(
      <MemoryRouter>
        <BenchmarkListPage />
      </MemoryRouter>,
    );
    expect(getByText('Execution Benchmarks')).toBeInTheDocument();
    // "New Benchmark" appears on both the header button and the empty-state CTA.
    expect(getAllByText('New Benchmark').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the project selector loading state before any data arrives', () => {
    const { getByText } = render(
      <MemoryRouter>
        <BenchmarkListPage />
      </MemoryRouter>,
    );
    expect(getByText('Project')).toBeInTheDocument();
  });
});
