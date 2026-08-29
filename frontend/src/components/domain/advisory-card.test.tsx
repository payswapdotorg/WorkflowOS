/**
 * WORK-048 — the ADVISORY recommendation card.
 *
 * ADVERSARIAL #3 (recommendation ≠ decision) + #6 (failed API requests never
 * fabricate success): the card renders recommendations with explicit advisory
 * framing, and when the advisory request fails (jsdom has no backend) it
 * degrades to the explicit UNAVAILABLE state — never a fabricated
 * recommendation, never a selection.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdvisoryCard } from './advisory-card';
import { ToastHost } from '@/components/ui/toast';

function renderCard() {
  return render(
    <MemoryRouter>
      <ToastHost>
        <AdvisoryCard workItemId="wi-1" workItemLabel="WI-TEST" />
      </ToastHost>
    </MemoryRouter>,
  );
}

describe('WORK-048 AdvisoryCard (recommendation ≠ decision; failures never fabricate)', () => {
  it('renders with explicit ADVISORY framing — never a decision', () => {
    renderCard();
    // The card title + framing make the advisory nature explicit.
    expect(screen.getByText('Routing Recommendation')).toBeInTheDocument();
    expect(
      screen.getByText(/Advisory only — the routing authority ranks the eligible candidates/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/never decides/i)).toBeInTheDocument();
  });

  it('ADVERSARIAL #6: a failed advisory request degrades to UNAVAILABLE — never a fabricated recommendation', async () => {
    renderCard();
    // jsdom has no backend: the real fetch fails. Wait for the failure path.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const unavailable = screen.getByTestId('advisory-unavailable');
    expect(unavailable).toBeInTheDocument();
    expect(unavailable.textContent).toMatch(/Recommendation unavailable/i);
    // No fabricated recommendation content is EVER shown for a failed request.
    expect(screen.queryByTestId('advisory-content')).not.toBeInTheDocument();
    expect(screen.queryByText(/Recommends/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ranked alternatives/i)).not.toBeInTheDocument();
  });

  it('shows the loading state before the request settles (no flash of fabricated content)', () => {
    renderCard();
    expect(screen.getByTestId('advisory-loading')).toBeInTheDocument();
  });
});
