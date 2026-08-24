/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BenchmarkTrialPage from './BenchmarkTrialPage';

/**
 * WORK-032 smoke test — pure render-without-crash check.
 * No fetch mocking at the unit-test layer (per the LoginPage.test.tsx
 * convention). The page initial-renders the loading state.
 */
describe('BenchmarkTrialPage smoke', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders the loading state on initial mount', () => {
    const { getByText } = render(
      <MemoryRouter initialEntries={['/benchmarks/trials/some-trial-id']}>
        <BenchmarkTrialPage />
      </MemoryRouter>,
    );
    expect(getByText('Loading trial…')).toBeInTheDocument();
  });
});
