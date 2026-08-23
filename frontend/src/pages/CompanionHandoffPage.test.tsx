/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CompanionHandoffPage from './CompanionHandoffPage';
import {
  buildCompanionHandoffPath,
} from '@/components/execution/ExternalExecutionDialog';

/**
 * WORK-028 §27 frontend tests:
 *   - the handoff deep link carries ONLY the one-time ref (+ exec id);
 *   - the page renders the waiting state;
 *   - shows "not installed" when no Companion pong arrives;
 *   - shows the connected state when the Companion answers;
 *   - the ExternalExecutionDialog exposes "Open with Companion".
 */

function renderAtHash(hash: string) {
  return render(
    <MemoryRouter initialEntries={[`/companion/handoff${hash}`]}>
      <CompanionHandoffPage />
    </MemoryRouter>,
  );
}

describe('companion handoff deep link', () => {
  it('carries ONLY the one-time ref + execution id (never prompt/token material)', () => {
    const path = buildCompanionHandoffPath('wfht_' + 'a'.repeat(32), 'wf_abc12345');
    expect(path).toMatch(/^\/companion\/handoff#/);
    expect(path).toContain('ref=wfht_');
    expect(path).toContain('exec=wf_abc12345');
    expect(path).not.toMatch(/wfct_/); // callback token never in the URL
    expect(path).not.toMatch(/prompt/i);
  });
});

describe('CompanionHandoffPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    document.documentElement.removeAttribute('data-workflowos-companion');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.removeAttribute('data-workflowos-companion');
  });

  it('renders the waiting state with the execution reference', () => {
    const { getByText } = renderAtHash('#ref=wfht_' + 'b'.repeat(32) + '&exec=wf_1');
    expect(getByText(/Checking for Companion/i)).toBeInTheDocument();
    expect(getByText('wf_1')).toBeInTheDocument();
  });

  it('shows "not installed" + installation help when no Companion answers', async () => {
    const { getByText } = renderAtHash('#ref=wfht_' + 'c'.repeat(32) + '&exec=wf_1');
    // No pong will arrive; the handshake gives up after ~5 pings.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(getByText(/WorkflowOS Companion not installed/i)).toBeInTheDocument();
    expect(getByText(/Companion installation & security guide/i)).toBeInTheDocument();
  });

  it('shows the connected state when the Companion answers the ping', async () => {
    const { getByText } = renderAtHash('#ref=wfht_' + 'd'.repeat(32) + '&exec=wf_1');
    await act(async () => {
      // The content script sets the document marker + fires the pong event.
      document.documentElement.setAttribute('data-workflowos-companion', '0.1.0');
      window.dispatchEvent(new CustomEvent('workflowos:companion-pong'));
      await vi.advanceTimersByTimeAsync(500);
    });
    await waitFor(() =>
      expect(getByText(/Companion connected/i)).toBeInTheDocument(),
    );
    expect(getByText(/Waiting for the Companion to redeem the handoff/i)).toBeInTheDocument();
  });

  it('shows the opened-session state when the Companion reports success', async () => {
    const { getByText } = renderAtHash('#ref=wfht_' + 'e'.repeat(32) + '&exec=wf_1');
    await act(async () => {
      document.documentElement.setAttribute('data-workflowos-companion', '0.1.0');
      window.dispatchEvent(new CustomEvent('workflowos:companion-pong'));
      window.dispatchEvent(
        new CustomEvent('workflowos:companion-status', {
          detail: { ok: true, executionId: 'wf_1', provider: 'fake' },
        }),
      );
      await vi.advanceTimersByTimeAsync(500);
    });
    await waitFor(() =>
      expect(getByText(/Session opened with provider/i)).toBeInTheDocument(),
    );
  });

  it('surfaces Companion-reported handoff errors', async () => {
    const { getByText } = renderAtHash('#ref=wfht_' + 'f'.repeat(32) + '&exec=wf_1');
    await act(async () => {
      document.documentElement.setAttribute('data-workflowos-companion', '0.1.0');
      window.dispatchEvent(new CustomEvent('workflowos:companion-pong'));
      window.dispatchEvent(
        new CustomEvent('workflowos:companion-status', {
          detail: { ok: false, error: 'handoff-token-already-used' },
        }),
      );
      await vi.advanceTimersByTimeAsync(500);
    });
    await waitFor(() =>
      expect(getByText(/handoff-token-already-used/i)).toBeInTheDocument(),
    );
  });
});
