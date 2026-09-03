import { describe, it, expect } from 'vitest';
import {
  buildUnitHarness,
  seedPublisherWorkflow,
  publisherPrincipal,
  PUBLISHER_ORG,
} from './helpers.js';
import { MarketplaceError, MARKETPLACE_COMMERCIAL_MODELS } from '../../../src/marketplace/index.js';

/**
 * V2-012 — offers and creator pricing: the three frozen commercial models,
 * deterministic validation of pricing terms, immutability of offer records
 * per listing revision, and no second pricing vocabulary.
 */

async function expectMarketplaceError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(MarketplaceError);
    expect((err as MarketplaceError).code, `expected ${code}, got ${(err as MarketplaceError).code}`).toBe(code);
    return;
  }
  throw new Error(`expected a MarketplaceError with code ${code}`);
}

async function createListingWith(offers: readonly unknown[]) {
  const harness = buildUnitHarness();
  const seeded = await seedPublisherWorkflow(harness);
  const promise = harness.service.createListing(publisherPrincipal, {
    organizationId: PUBLISHER_ORG,
    workflowId: seeded.workflowId,
    versionId: seeded.version1Id,
    name: 'Digest Report',
    offers: offers as never,
  });
  return { harness, seeded, promise };
}

describe('the frozen commercial-model vocabulary', () => {
  it('is exactly free | one_time_purchase | maintenance_subscription', () => {
    expect([...MARKETPLACE_COMMERCIAL_MODELS]).toEqual([
      'free',
      'one_time_purchase',
      'maintenance_subscription',
    ]);
  });

  it('an offer record persists its model and terms verbatim (immutable pricing facts)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const created = await harness.service.createListing(publisherPrincipal, {
      organizationId: PUBLISHER_ORG,
      workflowId: seeded.workflowId,
      versionId: seeded.version1Id,
      name: 'Digest Report',
      offers: [
        { model: 'free', terms: { model: 'free' } },
        {
          model: 'one_time_purchase',
          terms: { model: 'one_time_purchase', amount: '19.99', currency: 'USD', updatePolicy: 'pinned_only' },
        },
        {
          model: 'maintenance_subscription',
          terms: { model: 'maintenance_subscription', amount: '4.50', currency: 'USD' },
        },
      ],
    });
    expect(created.revision.offers.map((offer) => offer.model)).toEqual([
      'free',
      'one_time_purchase',
      'maintenance_subscription',
    ]);
    const oneTime = created.revision.offers[1]!;
    expect(oneTime.terms).toEqual({
      model: 'one_time_purchase',
      amount: '19.99',
      currency: 'USD',
      updatePolicy: 'pinned_only',
    });
    expect(Object.isFrozen(oneTime)).toBe(true);
    expect(Object.isFrozen(oneTime.terms)).toBe(true);
  });
});

describe('pricing validation (deterministic, fail-closed)', () => {
  it('rejects an invalid amount (typed)', async () => {
    const { promise } = await createListingWith([
      {
        model: 'one_time_purchase',
        terms: { model: 'one_time_purchase', amount: '19.999', currency: 'USD', updatePolicy: 'pinned_only' },
      },
    ]);
    await expectMarketplaceError(promise, 'MARKETPLACE_OFFER_INVALID');
  });

  it('rejects a non-decimal amount (typed)', async () => {
    const { promise } = await createListingWith([
      {
        model: 'one_time_purchase',
        terms: { model: 'one_time_purchase', amount: 'free', currency: 'USD', updatePolicy: 'pinned_only' },
      },
    ]);
    await expectMarketplaceError(promise, 'MARKETPLACE_OFFER_INVALID');
  });

  it('rejects an invalid currency (typed)', async () => {
    const { promise } = await createListingWith([
      {
        model: 'one_time_purchase',
        terms: { model: 'one_time_purchase', amount: '19.99', currency: 'usd', updatePolicy: 'pinned_only' },
      },
    ]);
    await expectMarketplaceError(promise, 'MARKETPLACE_OFFER_INVALID');
  });

  it('rejects an unknown commercial model (typed)', async () => {
    const { promise } = await createListingWith([
      { model: 'pay_per_run', terms: { model: 'pay_per_run' } },
    ]);
    await expectMarketplaceError(promise, 'MARKETPLACE_OFFER_INVALID');
  });

  it('rejects terms that disagree with the declared model (typed)', async () => {
    const { promise } = await createListingWith([
      {
        model: 'free',
        terms: { model: 'one_time_purchase', amount: '19.99', currency: 'USD', updatePolicy: 'pinned_only' },
      },
    ]);
    await expectMarketplaceError(promise, 'MARKETPLACE_OFFER_INVALID');
  });

  it('rejects a free listing with no name (structural validation, typed)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    await expectMarketplaceError(
      harness.service.createListing(publisherPrincipal, {
        organizationId: PUBLISHER_ORG,
        workflowId: seeded.workflowId,
        versionId: seeded.version1Id,
        name: '',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      }),
      'MARKETPLACE_INPUT_INVALID',
    );
  });

  it('rejects restricted distribution with no granted organizations (typed)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    await expectMarketplaceError(
      harness.service.createListing(publisherPrincipal, {
        organizationId: PUBLISHER_ORG,
        workflowId: seeded.workflowId,
        versionId: seeded.version1Id,
        name: 'Digest Report',
        offers: [{ model: 'free', terms: { model: 'free' } }],
        distribution: 'restricted',
        grantedOrganizationIds: [],
      }),
      'MARKETPLACE_INPUT_INVALID',
    );
  });
});

describe('offer lookup discipline', () => {
  it('an unknown offer is rejected typed; a SUPERSEDED (old-revision) offer is rejected typed', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const created = await harness.service.createListing(publisherPrincipal, {
      organizationId: PUBLISHER_ORG,
      workflowId: seeded.workflowId,
      versionId: seeded.version1Id,
      name: 'Digest Report',
      offers: [
        { model: 'free', terms: { model: 'free' } },
        {
          model: 'one_time_purchase',
          terms: { model: 'one_time_purchase', amount: '19.99', currency: 'USD', updatePolicy: 'pinned_only' },
        },
      ],
    });
    const listingId = created.listing.id;
    await harness.service.publishListing(publisherPrincipal, { listingId });
    const oldOfferId = created.revision.offers[1]!.id;
    // Maintenance update → revision 2 carries a NEW one-time offer.
    const updated = await harness.service.publishNewVersion(publisherPrincipal, {
      listingId,
      versionId: seeded.version2Id,
      offers: [
        {
          model: 'one_time_purchase',
          terms: { model: 'one_time_purchase', amount: '19.99', currency: 'USD', updatePolicy: 'pinned_only' },
        },
      ],
    });
    const newOfferId = updated.revision.offers[0]!.id;
    expect(oldOfferId).not.toBe(newOfferId);
    // The OLD revision's offer is superseded (its version is no longer current).
    await expectMarketplaceError(
      harness.service.acceptOffer(
        { userId: 'unit-customer-owner' },
        { listingId, offerId: oldOfferId, customerOrganizationId: 'org-customer' },
      ),
      'MARKETPLACE_OFFER_SUPERSEDED',
    );
    // A wholly unknown offer id is a plain typed not-found.
    await expectMarketplaceError(
      harness.service.acceptOffer(
        { userId: 'unit-customer-owner' },
        { listingId, offerId: 'mkt_nonexistent', customerOrganizationId: 'org-customer' },
      ),
      'MARKETPLACE_OFFER_NOT_FOUND',
    );
  });
});
