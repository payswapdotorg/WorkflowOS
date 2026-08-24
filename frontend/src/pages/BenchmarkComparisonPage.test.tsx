/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BenchmarkComparisonPage from './BenchmarkComparisonPage';

/**
 * WORK-032 smoke test — pure render-without-crash check.
 * No fetch mocking at the unit-test layer (per the LoginPage.test.tsx
 * convention).
 */
describe('BenchmarkComparisonPage smoke', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders the empty state when no trialIds are provided', () => {
    const { getByText } = render(
      <MemoryRouter initialEntries={['/benchmarks/some-id/compare']}>
        <BenchmarkComparisonPage />
      </MemoryRouter>,
    );
    expect(getByText('Trial Comparison')).toBeInTheDocument();
    expect(getByText('No trials selected')).toBeInTheDocument();
  });

  it('renders the loading state when trialIds are provided', () => {
    const { getByText } = render(
      <MemoryRouter
        initialEntries={['/benchmarks/some-id/compare?trialIds=a,b']}
      >
        <BenchmarkComparisonPage />
      </MemoryRouter>,
    );
    expect(getByText('Loading comparison…')).toBeInTheDocument();
  });
});
