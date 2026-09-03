import { describe, it, expect } from 'vitest';
import {
  buildUnitHarness,
  seedPublisherWorkflow,
  createPublishedListing,
  publisherPrincipal,
  customerPrincipal,
  oneTimeOffer,
  freeOffer,
  subscriptionOffer,
  CUSTOMER_ORG,
  OTHER_ORG,
} from './helpers.js';

/**
 * V2-012 — REQUIRED REGRESSION: entitlement enforcement and the version-
 * access rules. An entitlement for version A NEVER silently authorizes
 * version B: updates are gated by the offer's EXPLICIT update policy and by
 * V2-003's compatibility negotiation (the real merged decision function
 * over the two REAL WorkflowIR documents). Free access applies only to the
 * current revision's pinned version. The decision carries ONLY content-
 * access facts (no capability/execution/secrets fields exist on it).
 */

function access(
  harness: ReturnType<typeof buildUnitHarness>,
  listingId: string,
  versionId: string,
  organizationId = CUSTOMER_ORG,
) {
  return harness.service.checkVersionAccess(customerPrincipal, {
    listingId,
    versionId,
    organizationId,
  });
}

describe('free listing access (the current pinned version only)', () => {
  it('an unentitled principal accesses the CURRENT version of a free listing (basis free_listing)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [freeOffer()]);
    const decision = await access(harness, listingId, seeded.version1Id);
    expect(decision).toEqual({ entitled: true, basis: 'free_listing', entitlementId: null });
  });

  it('a listing with NO free offer denies the unentitled (reason no_free_offering)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [oneTimeOffer()]);
    const decision = await access(harness, listingId, seeded.version1Id);
    expect(decision).toEqual({ entitled: false, reason: 'no_free_offering' });
  });

  it('an organization with no relationship at all is denied (reason no_entitlement)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [oneTimeOffer()]);
    const decision = await access(harness, listingId, seeded.version1Id, OTHER_ORG);
    expect(decision).toEqual({ entitled: false, reason: 'no_entitlement' });
  });
});

describe('one-time purchase access (the purchased version is pinned forever)', () => {
  async function purchasedFixture(updatePolicy: 'pinned_only' | 'compatible_updates') {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [oneTimeOffer(updatePolicy)]);
    const listing = await harness.service.getListing(publisherPrincipal, listingId);
    const offerId = listing.revision.offers[0]!.id;
    await harness.service.acceptOffer(customerPrincipal, {
      listingId,
      offerId,
      customerOrganizationId: CUSTOMER_ORG,
    });
    // The creator publishes the maintenance update (revision 2, version 2).
    await harness.service.publishNewVersion(publisherPrincipal, {
      listingId,
      versionId: seeded.version2Id,
    });
    return { harness, seeded, listingId, offerId };
  }

  it('the purchased version stays accessible (basis one_time_purchase, the exact entitlement)', async () => {
    const { harness, seeded, listingId } = await purchasedFixture('pinned_only');
    const decision = await access(harness, listingId, seeded.version1Id);
    expect(decision.entitled).toBe(true);
    if (decision.entitled) {
      expect(decision.basis).toBe('one_time_purchase');
      expect(decision.entitlementId).not.toBeNull();
    }
  });

  it('REQUIRED REGRESSION: entitlement for version A does NOT authorize version B (pinned_only)', async () => {
    const { harness, seeded, listingId } = await purchasedFixture('pinned_only');
    const decision = await access(harness, listingId, seeded.version2Id);
    expect(decision).toEqual({ entitled: false, reason: 'update_not_included' });
  });

  it('compatible_updates policy: a COMPATIBLE version B is authorized (V2-003 negotiation accept)', async () => {
    const { harness, seeded, listingId } = await purchasedFixture('compatible_updates');
    const decision = await access(harness, listingId, seeded.version2Id);
    expect(decision.entitled).toBe(true);
    if (decision.entitled) {
      expect(decision.basis).toBe('one_time_purchase');
    }
  });

  it('compatible_updates policy: a BREAKING version B is refused (V2-003 negotiation reject)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [oneTimeOffer('compatible_updates')]);
    const listing = await harness.service.getListing(publisherPrincipal, listingId);
    await harness.service.acceptOffer(customerPrincipal, {
      listingId,
      offerId: listing.revision.offers[0]!.id,
      customerOrganizationId: CUSTOMER_ORG,
    });
    // The breaking update becomes revision 2 (a distinct version pin).
    await harness.service.publishNewVersion(publisherPrincipal, {
      listingId,
      versionId: seeded.version2BreakingId,
    });
    const decision = await access(harness, listingId, seeded.version2BreakingId);
    expect(decision).toEqual({ entitled: false, reason: 'incompatible_update' });
    // The purchased version A is STILL accessible (the pin was never touched).
    const stillA = await access(harness, listingId, seeded.version1Id);
    expect(stillA.entitled).toBe(true);
  });

  it('a REFUNDED one-time purchase denies every version (the right is revoked)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [oneTimeOffer()]);
    const listing = await harness.service.getListing(publisherPrincipal, listingId);
    const accepted = await harness.service.acceptOffer(customerPrincipal, {
      listingId,
      offerId: listing.revision.offers[0]!.id,
      customerOrganizationId: CUSTOMER_ORG,
    });
    await harness.service.refundEntitlement(publisherPrincipal, {
      entitlementId: accepted.entitlement.id,
    });
    const decision = await access(harness, listingId, seeded.version1Id);
    expect(decision).toEqual({ entitled: false, reason: 'entitlement_refunded' });
  });
});

describe('maintenance-subscription access (compatible updates while active)', () => {
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
    await harness.service.publishNewVersion(publisherPrincipal, {
      listingId,
      versionId: seeded.version2Id,
    });
    return { harness, seeded, listingId, entitlementId: accepted.entitlement.id };
  }

  it('an ACTIVE subscription authorizes the compatible maintenance update (basis maintenance_subscription)', async () => {
    const { harness, seeded, listingId } = await subscriptionFixture();
    const decision = await access(harness, listingId, seeded.version2Id);
    expect(decision.entitled).toBe(true);
    if (decision.entitled) {
      expect(decision.basis).toBe('maintenance_subscription');
    }
  });

  it('the subscribed BASELINE version stays accessible', async () => {
    const { harness, seeded, listingId } = await subscriptionFixture();
    const decision = await access(harness, listingId, seeded.version1Id);
    expect(decision.entitled).toBe(true);
  });

  it('REQUIRED REGRESSION: a CANCELED subscription stops the eligible update but preserves the pinned version', async () => {
    const { harness, seeded, listingId, entitlementId } = await subscriptionFixture();
    await harness.service.cancelSubscription(customerPrincipal, { entitlementId });
    const updateDecision = await access(harness, listingId, seeded.version2Id);
    expect(updateDecision).toEqual({ entitled: false, reason: 'subscription_canceled' });
    const pinnedDecision = await access(harness, listingId, seeded.version1Id);
    expect(pinnedDecision.entitled).toBe(true);
  });
});

describe('the decision shape (execution-authority separation is structural)', () => {
  it('the access decision exposes NO capability, node, secret or execution field', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [freeOffer()]);
    const decision = await access(harness, listingId, seeded.version1Id);
    const granted = decision as Record<string, unknown>;
    expect(Object.keys(granted).sort()).toEqual(['basis', 'entitled', 'entitlementId']);
    expect(JSON.stringify(decision)).not.toMatch(
      /capabilit|node|secret|execution|run\b|grant|authorize|policy|token|credential/i,
    );
  });

  it('reports and sales volume NEVER influence the access decision (trust ≠ authorization)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [freeOffer()]);
    const before = await access(harness, listingId, seeded.version1Id);
    // A wave of abuse reports arrives (public trust metadata).
    for (const reporter of ['r1', 'r2', 'r3']) {
      await harness.service.reportListing({ userId: reporter }, {
        listingId,
        reason: 'misleading',
      });
    }
    const after = await access(harness, listingId, seeded.version1Id);
    expect(after).toEqual(before);
  });
});
