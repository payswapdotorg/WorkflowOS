/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BenchmarkCreatePage from './BenchmarkCreatePage';

/**
 * WORK-032 smoke test — pure render-without-crash check.
 * No fetch mocking at the unit-test layer (per the LoginPage.test.tsx
 * convention).
 */
describe('BenchmarkCreatePage smoke', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders the five creation-step cards on initial mount', () => {
    const { getByText } = render(
      <MemoryRouter>
        <BenchmarkCreatePage />
      </MemoryRouter>,
    );
    expect(getByText('New Benchmark Experiment')).toBeInTheDocument();
    expect(getByText('1. Select Project + Work Item')).toBeInTheDocument();
    expect(getByText('4. Trial Matrix')).toBeInTheDocument();
    expect(getByText('5. Randomization (optional)')).toBeInTheDocument();
    expect(getByText('Create Experiment')).toBeInTheDocument();
  });
});
