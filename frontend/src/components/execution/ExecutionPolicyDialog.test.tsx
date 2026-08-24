/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { ExecutionPolicyDialog } from '@/components/execution/ExecutionPolicyDialog';

/**
 * WORK-033 ExecutionPolicyDialog smoke tests.
 *
 * Mirrors the ExternalExecutionDialog.test.tsx + BenchmarkDetailPage.test.tsx
 * convention: pure render-without-crash check, no fetch mocking at the
 * unit-test layer. The dialog initial-renders the loading skeleton (because
 * no real backend is wired in jsdom) before any async effect settles.
 */
describe('ExecutionPolicyDialog smoke', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders without crashing when opened with a work item id', () => {
    const { getByText } = render(
      <ExecutionPolicyDialog
        open
        onOpenChange={() => undefined}
        workItemId="work-item-001"
        workItemLabel="WORK-033 Sample"
        busy={false}
        error={null}
        onSubmit={() => undefined}
      />,
    );
    // The dialog header includes the work item label.
    expect(getByText(/Execution Policy/)).toBeInTheDocument();
    expect(getByText(/WORK-033 Sample/)).toBeInTheDocument();
  });

  it('renders the recommendation blurb + cancel button', () => {
    const { getByText } = render(
      <ExecutionPolicyDialog
        open
        onOpenChange={() => undefined}
        workItemId="work-item-002"
        workItemLabel="WORK-1"
        busy={false}
        error={null}
        onSubmit={() => undefined}
      />,
    );
    // The description mentions the hard-filter invariant.
    expect(getByText(/hard filter/i)).toBeInTheDocument();
    // The cancel button is always rendered in the footer.
    expect(getByText('Cancel')).toBeInTheDocument();
  });

  it('renders the Start Implementation button (disabled until a candidate is selected)', () => {
    const { getByText } = render(
      <ExecutionPolicyDialog
        open
        onOpenChange={() => undefined}
        workItemId="work-item-003"
        workItemLabel="WORK-2"
        busy={false}
        error={null}
        onSubmit={() => undefined}
      />,
    );
    const submit = getByText('Start Implementation');
    expect(submit).toBeInTheDocument();
    // No candidate has been loaded yet — submit is disabled.
    expect(submit).toBeDisabled();
  });
});
