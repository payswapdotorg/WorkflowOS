/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CreatePage from './CreatePage';

/**
 * V2-017 T2 — the creation entry-point landing contract.
 *
 * The Home entry buttons and the search box navigate to /create carrying
 * the chosen entry mode (tell / show / tell-show) and the typed goal (q).
 * CreatePage receives them: the matching entry mode is marked active and
 * the goal is shown as the starting context. Without parameters the page
 * stays neutral — no fabricated selection or goal.
 */

function renderCreate(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/create${search}`]}>
      <CreatePage />
    </MemoryRouter>,
  );
}

describe('V2-017 T2 — Create entry-point landing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks the Show entry mode active and shows the typed goal', () => {
    renderCreate('?mode=show&q=invoice%20processing');
    const modes = screen.getByRole('list', { name: /creation entry modes/i });
    expect(within(modes).getByText('Show').closest('li')?.getAttribute('aria-current')).toBe('true');
    expect(within(modes).getByText('Tell').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(within(modes).getByText('Tell + Show').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(screen.getByText(/invoice processing/i)).toBeInTheDocument();
  });

  it('marks the Tell + Show entry mode active for mode=tell-show', () => {
    renderCreate('?mode=tell-show');
    const modes = screen.getByRole('list', { name: /creation entry modes/i });
    expect(within(modes).getByText('Tell + Show').closest('li')?.getAttribute('aria-current')).toBe('true');
  });

  it('stays neutral without mode or goal parameters', () => {
    renderCreate('');
    const modes = screen.getByRole('list', { name: /creation entry modes/i });
    expect(within(modes).getByText('Show').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(within(modes).getByText('Tell').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(within(modes).getByText('Tell + Show').closest('li')?.getAttribute('aria-current')).toBeNull();
    expect(screen.queryByText(/your goal/i)).not.toBeInTheDocument();
  });
});
