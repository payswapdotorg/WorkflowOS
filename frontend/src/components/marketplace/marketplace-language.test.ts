import { describe, expect, it } from 'vitest';
import type { ProductListingOffer, ProductVersionAccessDecision } from '../../api/client';
import {
  basisLine,
  denialLine,
  ENTITLEMENT_BOUNDARY,
  ENTITLED_HEADLINE,
  FORK_PROMISES,
  INSTALL_NEXT,
  modelLine,
  PUBLICATION_NOT_PROOF,
  priceLine,
  updateRightsLine,
} from './marketplace-language';

/**
 * V2-017 T12 — the marketplace human-language contract (UX spec §21/§22/§23
 * + the V2-012 authority boundaries, verbatim).
 *
 * The language module owns the presentation wording ONLY — every fact
 * (price, model, decision, basis) arrives from the authority's own records
 * through the transport wire; this module never re-derives, re-validates or
 * invents a marketplace fact. The frozen boundary sentences are asserted
 * verbatim because they ARE the product contract:
 *   - a purchase/entitlement is never presented as execution authorization;
 *   - publication is never presented as verification, authorization, or
 *     proof of safety (the V2-012 trust rule).
 */

const freeOffer: ProductListingOffer = {
  id: 'off-free',
  model: 'free',
  terms: { model: 'free' },
  createdAt: 1789500001000,
};

const oneTimePinned: ProductListingOffer = {
  id: 'off-one-time',
  model: 'one_time_purchase',
  terms: {
    model: 'one_time_purchase',
    amount: '19.00',
    currency: 'USD',
    updatePolicy: 'pinned_only',
  },
  createdAt: 1789500002000,
};

const oneTimeUpdates: ProductListingOffer = {
  id: 'off-one-time-updates',
  model: 'one_time_purchase',
  terms: {
    model: 'one_time_purchase',
    amount: '29.00',
    currency: 'USD',
    updatePolicy: 'compatible_updates',
  },
  createdAt: 1789500003000,
};

const maintenance: ProductListingOffer = {
  id: 'off-maint',
  model: 'maintenance_subscription',
  terms: { model: 'maintenance_subscription', amount: '5.00', currency: 'USD' },
  createdAt: 1789500004000,
};

const euroOneTime: ProductListingOffer = {
  id: 'off-eur',
  model: 'one_time_purchase',
  terms: {
    model: 'one_time_purchase',
    amount: '19.00',
    currency: 'EUR',
    updatePolicy: 'pinned_only',
  },
  createdAt: 1789500005000,
};

describe('priceLine (the §22 price/commercial-model line)', () => {
  it('renders the free model as Free', () => {
    expect(priceLine(freeOffer)).toBe('Free');
  });

  it('renders a USD one-time purchase as a dollar amount', () => {
    expect(priceLine(oneTimePinned)).toBe('$19.00');
  });

  it('renders a maintenance subscription as a monthly amount', () => {
    expect(priceLine(maintenance)).toBe('$5.00/month');
  });

  it('renders non-USD currencies explicitly (never a fabricated symbol)', () => {
    expect(priceLine(euroOneTime)).toBe('19.00 EUR');
  });
});

describe('modelLine (the commercial model words)', () => {
  it('uses the three frozen model words', () => {
    expect(modelLine(freeOffer)).toBe('Free');
    expect(modelLine(oneTimePinned)).toBe('One-time purchase');
    expect(modelLine(maintenance)).toBe('Maintenance subscription');
  });
});

describe('updateRightsLine (what the offer includes)', () => {
  it('a pinned-only one-time purchase pins the exact version', () => {
    expect(updateRightsLine(oneTimePinned)).toBe(
      'Pins this exact version — later updates are separate.',
    );
  });

  it('a compatible-updates one-time purchase includes compatible updates', () => {
    expect(updateRightsLine(oneTimeUpdates)).toBe('Includes compatible updates.');
  });

  it('a maintenance subscription includes updates while active', () => {
    expect(updateRightsLine(maintenance)).toBe(
      'Compatible updates while the subscription is active.',
    );
  });

  it('the free model is the current listed version', () => {
    expect(updateRightsLine(freeOffer)).toBe('The current version as listed.');
  });
});

describe('the version-access decision language (§23 + the frozen boundary)', () => {
  it('the entitled headline is the §23 wording verbatim', () => {
    expect(ENTITLED_HEADLINE).toBe("You're entitled to this workflow.");
  });

  it('each entitled basis gets its own honest line', () => {
    const free: ProductVersionAccessDecision = {
      entitled: true,
      basis: 'free_listing',
      entitlementId: null,
    };
    const oneTime: ProductVersionAccessDecision = {
      entitled: true,
      basis: 'one_time_purchase',
      entitlementId: 'ent-1',
    };
    const subscription: ProductVersionAccessDecision = {
      entitled: true,
      basis: 'maintenance_subscription',
      entitlementId: 'ent-2',
    };
    expect(basisLine(free)).toBe('Access through the free listing.');
    expect(basisLine(oneTime)).toBe('Access through your one-time purchase.');
    expect(basisLine(subscription)).toBe('Access through your maintenance subscription.');
  });

  it('every typed denial gets its own honest line', () => {
    expect(denialLine('no_entitlement')).toBe(
      "Your organization doesn't have access to this version.",
    );
    expect(denialLine('no_free_offering')).toBe('This listing has no free offer.');
    expect(denialLine('entitlement_refunded')).toBe('This purchase was refunded — access ended.');
    expect(denialLine('subscription_canceled')).toBe(
      'Maintenance was canceled — updates are no longer included.',
    );
    expect(denialLine('update_not_included')).toBe(
      "That newer version isn't included in your purchase.",
    );
    expect(denialLine('incompatible_update')).toBe(
      "That newer version isn't compatible with your purchase.",
    );
    expect(denialLine('listing_not_published')).toBe('This listing is no longer published.');
  });

  it('the install-next line names the exact pinned version', () => {
    expect(INSTALL_NEXT(3)).toBe('Next: Install version 3');
  });

  it('the entitlement boundary sentence never reads as execution authorization', () => {
    expect(ENTITLEMENT_BOUNDARY).toBe(
      'Getting this workflow gives your organization access to its content — it is not permission to run. Execution stays subject to your access and approvals.',
    );
  });

  it('publication is never presented as verification or proof', () => {
    expect(PUBLICATION_NOT_PROOF).toBe(
      'Publication is not verification, authorization, or proof of safety.',
    );
  });
});

describe('the Make-my-own (fork) promises (§21, verbatim)', () => {
  it('the four fork disclosure bullets are the §21 copy', () => {
    expect(FORK_PROMISES).toEqual([
      'Have its own versions',
      'Keep the original attribution',
      'Not receive the publisher’s private data',
      'Not receive the publisher’s secrets',
    ]);
  });
});
