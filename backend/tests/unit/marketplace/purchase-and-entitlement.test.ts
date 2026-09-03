import { describe, it, expect } from 'vitest';
import {
  buildUnitHarness,
  seedPublisherWorkflow,
  createPublishedListing,
  publisherPrincipal,
  customerPrincipal,
  outsiderPrincipal,
  oneTimeOffer,
  freeOffer,
  CUSTOMER_ORG,
  PUBLISHER_ORG,
} from './helpers.js';
import { MarketplaceError } from '../../../src/marketplace/index.js';

/**
 * V2-012 — the purchase flow (creator economics + entitlement):
 * free acceptance, paid acceptance through the payment-adapter boundary,
 * idempotent (create-or-converge) acceptance with NO double charging, and
 * the REQUIRED REGRESSION that a payment-processor failure can NEVER
 * create a false entitlement.
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

describe('free acceptance (no transaction, direct entitlement)', () => {
  it('a free offer acceptance creates an entitlement with NO transaction record', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [freeOffer()]);
    const listing = await harness.service.getListing(publisherPrincipal, listingId);
    const offerId = listing.revision.offers[0]!.id;
    const result = await harness.service.acceptOffer(customerPrincipal, {
      listingId,
      offerId,
      customerOrganizationId: CUSTOMER_ORG,
    });
    expect(result.created).toBe(true);
    expect(result.entitlement.model).toBe('free');
    expect(result.entitlement.status).toBe('active');
    expect(result.entitlement.transactionId).toBeNull();
    expect(result.transaction).toBeNull();
    expect(result.entitlement.pinnedVersionId).toBe(seeded.version1Id);
  });
});

describe('paid acceptance (the payment-adapter boundary)', () => {
  async function paidFixture() {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [oneTimeOffer()]);
    const listing = await harness.service.getListing(publisherPrincipal, listingId);
    return { harness, seeded, listingId, offerId: listing.revision.offers[0]!.id };
  }

  it('a one-time purchase settles through the adapter: transaction succeeded → entitlement active', async () => {
    const { harness, listingId, offerId } = await paidFixture();
    const result = await harness.service.acceptOffer(customerPrincipal, {
      listingId,
      offerId,
      customerOrganizationId: CUSTOMER_ORG,
    });
    expect(result.created).toBe(true);
    expect(result.transaction).not.toBeNull();
    expect(result.transaction!.status).toBe('succeeded');
    expect(result.transaction!.amount).toBe('19.99');
    expect(result.transaction!.currency).toBe('USD');
    expect(result.transaction!.adapterReference).not.toBeNull();
    expect(result.entitlement.model).toBe('one_time_purchase');
    expect(result.entitlement.status).toBe('active');
    expect(result.entitlement.transactionId).toBe(result.transaction!.id);
  });

  it('the transaction carries ONLY normalized facts (no provider state, no customer data)', async () => {
    const { harness, listingId, offerId } = await paidFixture();
    const result = await harness.service.acceptOffer(customerPrincipal, {
      listingId,
      offerId,
      customerOrganizationId: CUSTOMER_ORG,
    });
    const transaction = result.transaction!;
    const keys = Object.keys(transaction).sort();
    expect(keys).toEqual([
      'adapterReference',
      'amount',
      'createdAt',
      'currency',
      'customerOrganizationId',
      'failureCode',
      'id',
      'listingId',
      'offerId',
      'refundedAt',
      'revisionId',
      'status',
    ]);
    // NO provider concepts anywhere in the normalized record.
    expect(JSON.stringify(transaction)).not.toMatch(/stripe|paypal|webhook|card|bank/i);
  });

  it('a duplicate acceptance CONVERGES (idempotent purchase — NO second charge)', async () => {
    const { harness, listingId, offerId } = await paidFixture();
    const first = await harness.service.acceptOffer(customerPrincipal, {
      listingId,
      offerId,
      customerOrganizationId: CUSTOMER_ORG,
    });
    const second = await harness.service.acceptOffer(customerPrincipal, {
      listingId,
      offerId,
      customerOrganizationId: CUSTOMER_ORG,
    });
    expect(second.created).toBe(false);
    expect(second.entitlement.id).toBe(first.entitlement.id);
    expect(second.transaction).toBeNull();
    // The adapter performed EXACTLY ONE charge.
    expect(harness.payments.chargeLog()).toHaveLength(1);
  });

  it('acceptance requires membership of the customer organization (typed)', async () => {
    const { harness, listingId, offerId } = await paidFixture();
    await expectMarketplaceError(
      harness.service.acceptOffer(outsiderPrincipal, {
        listingId,
        offerId,
        customerOrganizationId: CUSTOMER_ORG,
      }),
      'MARKETPLACE_NOT_ORGANIZATION_MEMBER',
    );
    // No charge was attempted.
    expect(harness.payments.chargeLog()).toHaveLength(0);
  });

  it('acceptance requires a PUBLISHED listing (typed)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const created = await harness.service.createListing(publisherPrincipal, {
      organizationId: PUBLISHER_ORG,
      workflowId: seeded.workflowId,
      versionId: seeded.version1Id,
      name: 'Digest Report',
      offers: [oneTimeOffer()],
    });
    const offerId = created.revision.offers[0]!.id;
    // A PUBLISHER member (who can see their own draft listing — the no-
    // existence-leak discipline keeps non-publishers at the uniform
    // not-found) reaches the published-status gate on the acceptance path.
    await expectMarketplaceError(
      harness.service.acceptOffer(publisherPrincipal, {
        listingId: created.listing.id,
        offerId,
        customerOrganizationId: CUSTOMER_ORG,
      }),
      'MARKETPLACE_LISTING_NOT_PUBLISHED',
    );
    expect(harness.payments.chargeLog()).toHaveLength(0);
  });
});

describe('REQUIRED REGRESSION — a payment-processor failure can NEVER create a false entitlement', () => {
  it('a failed charge records a FAILED transaction and throws typed — NO entitlement exists', async () => {
    // The adapter is pre-configured to fail EVERY charge (a processor outage).
    const harness = buildUnitHarness({ failingChargeReferences: ['*'] });
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [oneTimeOffer()]);
    const listing = await harness.service.getListing(publisherPrincipal, listingId);
    const offerId = listing.revision.offers[0]!.id;
    await expectMarketplaceError(
      harness.service.acceptOffer(customerPrincipal, {
        listingId,
        offerId,
        customerOrganizationId: CUSTOMER_ORG,
      }),
      'MARKETPLACE_PAYMENT_FAILED',
    );
    // The failed settlement is DURABLE (observable by the parties)…
    expect(harness.store.listTransactions()).toHaveLength(1);
    expect(harness.store.listTransactions()[0]!.status).toBe('failed');
    // …and NO entitlement was created: version access is DENIED.
    const decision = await harness.service.checkVersionAccess(customerPrincipal, {
      listingId,
      versionId: seeded.version1Id,
      organizationId: CUSTOMER_ORG,
    });
    expect(decision).toEqual({ entitled: false, reason: 'no_entitlement' });
  });

  it('the failed charge leaves a durable failed-transaction record readable by the parties', async () => {
    const harness = buildUnitHarness({ failingChargeReferences: ['*'] });
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [oneTimeOffer()]);
    const listing = await harness.service.getListing(publisherPrincipal, listingId);
    const offerId = listing.revision.offers[0]!.id;
    await expectMarketplaceError(
      harness.service.acceptOffer(customerPrincipal, {
        listingId,
        offerId,
        customerOrganizationId: CUSTOMER_ORG,
      }),
      'MARKETPLACE_PAYMENT_FAILED',
    );
    // The customer reads their failed settlement through the service.
    const failedId = harness.store.listTransactions()[0]!.id;
    const failed = await harness.service.getTransaction(customerPrincipal, failedId);
    expect(failed.status).toBe('failed');
    expect(failed.failureCode).toBe('test-adapter-configured-failure');
    expect(failed.adapterReference).toBeNull();
    // The publisher side can read the SAME normalized fact.
    const publisherView = await harness.service.getTransaction(publisherPrincipal, failedId);
    expect(publisherView.id).toBe(failed.id);
    // A third party cannot read it (typed not-found for non-members).
    await expectMarketplaceError(
      harness.service.getTransaction(outsiderPrincipal, failedId),
      'MARKETPLACE_TRANSACTION_NOT_FOUND',
    );
  });
});
