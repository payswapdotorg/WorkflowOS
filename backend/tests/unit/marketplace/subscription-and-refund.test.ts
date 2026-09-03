import { describe, it, expect } from 'vitest';
import {
  buildUnitHarness,
  seedPublisherWorkflow,
  createPublishedListing,
  publisherPrincipal,
  publisherMemberPrincipal,
  customerPrincipal,
  outsiderPrincipal,
  oneTimeOffer,
  subscriptionOffer,
  freeOffer,
  CUSTOMER_ORG,
} from './helpers.js';
import { MarketplaceError } from '../../../src/marketplace/index.js';

/**
 * V2-012 — refunds, cancellation and maintenance semantics as EXPLICIT
 * domain contracts:
 *   - a publisher refund settles through the adapter, marks the transaction
 *     refunded and REVOKES the entitlement (future access denied);
 *   - an adapter refund FAILURE is typed and changes NOTHING;
 *   - a customer cancellation stops future maintenance updates while
 *     preserving the pinned version (tested in version-access-rules);
 *   - historical facts are never rewritten (the transaction and entitlement
 *     records are frozen snapshots; only their STATUS transitions).
 */

async function expectMarketplaceError(promise: Promise<unknown>, code: string): Promise<MarketplaceError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(MarketplaceError);
    const typed = err as MarketplaceError;
    expect(typed.code, `expected ${code}, got ${typed.code}: ${typed.message}`).toBe(code);
    return typed;
  }
  throw new Error(`expected a MarketplaceError with code ${code}`);
}

async function purchasedFixture() {
  const harness = buildUnitHarness();
  const seeded = await seedPublisherWorkflow(harness);
  const listingId = await createPublishedListing(harness, seeded, [oneTimeOffer()]);
  const listing = await harness.service.getListing(publisherPrincipal, listingId);
  const accepted = await harness.service.acceptOffer(customerPrincipal, {
    listingId,
    offerId: listing.revision.offers[0]!.id,
    customerOrganizationId: CUSTOMER_ORG,
  });
  return { harness, seeded, listingId, entitlementId: accepted.entitlement.id, transactionId: accepted.transaction!.id };
}

describe('publisher refunds (the explicit refund contract)', () => {
  it('refunds the transaction through the adapter and revokes the entitlement', async () => {
    const { harness, entitlementId, transactionId } = await purchasedFixture();
    const refunded = await harness.service.refundEntitlement(publisherPrincipal, { entitlementId });
    expect(refunded.status).toBe('refunded');
    expect(refunded.endedAt).not.toBeNull();
    const transaction = await harness.service.getTransaction(customerPrincipal, transactionId);
    expect(transaction.status).toBe('refunded');
    expect(transaction.refundedAt).not.toBeNull();
    expect(harness.payments.refundLog()).toHaveLength(1);
  });

  it('a refund is idempotent (re-refund converges, no second adapter call)', async () => {
    const { harness, entitlementId } = await purchasedFixture();
    await harness.service.refundEntitlement(publisherPrincipal, { entitlementId });
    const again = await harness.service.refundEntitlement(publisherMemberPrincipal, { entitlementId });
    expect(again.status).toBe('refunded');
    expect(harness.payments.refundLog()).toHaveLength(1);
  });

  it('ONLY the publisher organization may refund (typed error for anyone else)', async () => {
    const { harness, entitlementId } = await purchasedFixture();
    await expectMarketplaceError(
      harness.service.refundEntitlement(outsiderPrincipal, { entitlementId }),
      'MARKETPLACE_NOT_PUBLISHER',
    );
    // Even the CUSTOMER cannot refund their own purchase through the
    // publisher-side contract.
    await expectMarketplaceError(
      harness.service.refundEntitlement(customerPrincipal, { entitlementId }),
      'MARKETPLACE_NOT_PUBLISHER',
    );
    expect(harness.payments.refundLog()).toHaveLength(0);
  });

  it('an ADAPTER REFUND FAILURE is typed and leaves the entitlement UNCHANGED', async () => {
    const harness = buildUnitHarness({ failingRefundReferences: ['*'] });
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [oneTimeOffer()]);
    const listing = await harness.service.getListing(publisherPrincipal, listingId);
    const accepted = await harness.service.acceptOffer(customerPrincipal, {
      listingId,
      offerId: listing.revision.offers[0]!.id,
      customerOrganizationId: CUSTOMER_ORG,
    });
    await expectMarketplaceError(
      harness.service.refundEntitlement(publisherPrincipal, {
        entitlementId: accepted.entitlement.id,
      }),
      'MARKETPLACE_REFUND_FAILED',
    );
    const stillActive = await harness.service.getEntitlement(
      customerPrincipal,
      accepted.entitlement.id,
    );
    expect(stillActive.status).toBe('active');
    const transaction = await harness.service.getTransaction(customerPrincipal, accepted.transaction!.id);
    expect(transaction.status).toBe('succeeded');
  });
});

describe('customer cancellation (the explicit maintenance-cancellation contract)', () => {
  async function subscriptionFixture() {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [subscriptionOffer()]);
    const listing = await harness.service.getListing(publisherPrincipal, listingId);
    const accepted = await harness.service.acceptOffer(customerPrincipal, {
      listingId,
      offerId: listing.revision.offers[0]!.id,
      customerOrganizationId: CUSTOMER_ORG,
    });
    return { harness, seeded, listingId, entitlementId: accepted.entitlement.id };
  }

  it('the customer cancels: status active → canceled with an endedAt fact', async () => {
    const { harness, entitlementId } = await subscriptionFixture();
    const canceled = await harness.service.cancelSubscription(customerPrincipal, { entitlementId });
    expect(canceled.status).toBe('canceled');
    expect(canceled.endedAt).not.toBeNull();
    // Cancellation is idempotent (converges on the already-canceled state).
    const again = await harness.service.cancelSubscription(customerPrincipal, { entitlementId });
    expect(again.status).toBe('canceled');
    expect(again.endedAt).toBe(canceled.endedAt);
  });

  it('ONLY the customer organization may cancel (typed error for the publisher and outsiders)', async () => {
    const { harness, entitlementId } = await subscriptionFixture();
    await expectMarketplaceError(
      harness.service.cancelSubscription(publisherPrincipal, { entitlementId }),
      'MARKETPLACE_NOT_ORGANIZATION_MEMBER',
    );
    await expectMarketplaceError(
      harness.service.cancelSubscription(outsiderPrincipal, { entitlementId }),
      'MARKETPLACE_NOT_ORGANIZATION_MEMBER',
    );
  });

  it('cancellation applies to SUBSCRIPTIONS only (typed error on a one-time purchase)', async () => {
    const { harness, entitlementId } = await purchasedFixture();
    await expectMarketplaceError(
      harness.service.cancelSubscription(customerPrincipal, { entitlementId }),
      'MARKETPLACE_ENTITLEMENT_STATE_INVALID',
    );
  });

  it('a REFUNDED entitlement can neither be canceled nor re-canceled (typed)', async () => {
    const { harness, entitlementId } = await subscriptionFixture();
    await harness.service.refundEntitlement(publisherPrincipal, { entitlementId });
    await expectMarketplaceError(
      harness.service.cancelSubscription(customerPrincipal, { entitlementId }),
      'MARKETPLACE_ENTITLEMENT_STATE_INVALID',
    );
  });
});

describe('historical facts are never rewritten (explicit transitions only)', () => {
  it('the settlement facts survive cancellation and refund unchanged', async () => {
    // A SUBSCRIPTION entitlement (the only entitlement both transitions
    // legally apply to: cancellation is subscription-only, refund applies
    // to any succeeded settlement).
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [subscriptionOffer()]);
    const listing = await harness.service.getListing(publisherPrincipal, listingId);
    const accepted = await harness.service.acceptOffer(customerPrincipal, {
      listingId,
      offerId: listing.revision.offers[0]!.id,
      customerOrganizationId: CUSTOMER_ORG,
    });
    const entitlementId = accepted.entitlement.id;
    const transactionId = accepted.transaction!.id;
    await harness.service.publishNewVersion(publisherPrincipal, {
      listingId,
      versionId: seeded.version2Id,
    });
    await harness.service.cancelSubscription(customerPrincipal, { entitlementId });
    await harness.service.refundEntitlement(publisherPrincipal, { entitlementId });
    const entitlement = await harness.service.getEntitlement(customerPrincipal, entitlementId);
    // The FROZEN identity facts of the purchase survive every transition.
    expect(entitlement.id).toBe(entitlementId);
    expect(entitlement.pinnedVersionId).toBe(seeded.version1Id);
    expect(entitlement.transactionId).toBe(transactionId);
    expect(entitlement.grantedAt).toBeGreaterThan(0);
    const transaction = await harness.service.getTransaction(customerPrincipal, transactionId);
    expect(transaction.amount).toBe('4.50');
    expect(transaction.adapterReference).not.toBeNull();
    // The listing's revision history is untouched by the commerce lifecycle.
    const history = await harness.service.listListingRevisions(publisherPrincipal, listingId);
    expect(history.map((revision) => revision.pin.versionId)).toEqual([
      seeded.version1Id,
      seeded.version2Id,
    ]);
  });

  it('unknown entitlements and transactions answer uniform typed not-founds', async () => {
    const harness = buildUnitHarness();
    await seedPublisherWorkflow(harness);
    await expectMarketplaceError(
      harness.service.getEntitlement(customerPrincipal, 'mkt_nonexistent'),
      'MARKETPLACE_ENTITLEMENT_NOT_FOUND',
    );
    await expectMarketplaceError(
      harness.service.getTransaction(customerPrincipal, 'mkt_nonexistent'),
      'MARKETPLACE_TRANSACTION_NOT_FOUND',
    );
    await expectMarketplaceError(
      harness.service.cancelSubscription(customerPrincipal, { entitlementId: 'mkt_nonexistent' }),
      'MARKETPLACE_ENTITLEMENT_NOT_FOUND',
    );
    await expectMarketplaceError(
      harness.service.refundEntitlement(publisherPrincipal, { entitlementId: 'mkt_nonexistent' }),
      'MARKETPLACE_ENTITLEMENT_NOT_FOUND',
    );
  });

  it('entitlement reads are visible ONLY to the two parties (customer org, publisher org)', async () => {
    const { harness, entitlementId } = await purchasedFixture();
    const customerRead = await harness.service.getEntitlement(customerPrincipal, entitlementId);
    expect(customerRead.id).toBe(entitlementId);
    const publisherRead = await harness.service.getEntitlement(publisherPrincipal, entitlementId);
    expect(publisherRead.id).toBe(entitlementId);
    await expectMarketplaceError(
      harness.service.getEntitlement(outsiderPrincipal, entitlementId),
      'MARKETPLACE_ENTITLEMENT_NOT_FOUND',
    );
    // A member of a foreign organization is equally denied.
    harness.memberships.assign('unit-other-owner', 'org-other');
    await expectMarketplaceError(
      harness.service.getEntitlement({ userId: 'unit-other-owner' }, entitlementId),
      'MARKETPLACE_ENTITLEMENT_NOT_FOUND',
    );
  });
});

describe('free entitlements carry no settlement (no transaction is ever fabricated)', () => {
  it('a free acceptance records NO transaction and refunds are typed-invalid', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [freeOffer()]);
    const listing = await harness.service.getListing(publisherPrincipal, listingId);
    const accepted = await harness.service.acceptOffer(customerPrincipal, {
      listingId,
      offerId: listing.revision.offers[0]!.id,
      customerOrganizationId: CUSTOMER_ORG,
    });
    expect(accepted.entitlement.transactionId).toBeNull();
    await expectMarketplaceError(
      harness.service.refundEntitlement(publisherPrincipal, {
        entitlementId: accepted.entitlement.id,
      }),
      'MARKETPLACE_ENTITLEMENT_STATE_INVALID',
    );
    expect(harness.payments.refundLog()).toHaveLength(0);
    expect(harness.payments.chargeLog()).toHaveLength(0);
  });
});

describe('membership discipline on the publisher side', () => {
  it('publisher lifecycle operations require publisher-org membership (typed)', async () => {
    const { harness, listingId } = await purchasedFixture();
    await expectMarketplaceError(
      harness.service.publishListing(outsiderPrincipal, { listingId: 'mkt_x' }),
      'MARKETPLACE_LISTING_NOT_FOUND',
    );
    // The outsider cannot even see the listing, so lifecycle ops are
    // uniform not-founds; the MEMBERSHIP gate is proven through the
    // publisher org's own boundary:
    harness.memberships.assign('unit-other-owner', 'org-other');
    const visible = await harness.service.listPublishedListings({ userId: 'unit-other-owner' });
    const found = visible.find((entry) => entry.listing.id === listingId);
    expect(found).toBeDefined();
    await expectMarketplaceError(
      harness.service.retireListing({ userId: 'unit-other-owner' }, { listingId }),
      'MARKETPLACE_NOT_PUBLISHER',
    );
  });
});
