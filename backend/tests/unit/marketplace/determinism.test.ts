import { describe, it, expect } from 'vitest';
import {
  buildUnitHarness,
  seedPublisherWorkflow,
  publisherPrincipal,
  customerPrincipal,
  oneTimeOffer,
  subscriptionOffer,
  freeOffer,
  CUSTOMER_ORG,
} from './helpers.js';

/**
 * V2-012 — determinism: the SAME scenario, executed twice on two FRESH
 * harnesses (fresh store, fresh sequential id source, fresh stepping
 * clock), produces byte-identical transcripts. No randomness, no wall
 * clock, no timers — every identity and timestamp is a deterministic
 * function of the scenario itself.
 */

/** The full marketplace scenario (create → publish → buy → update → cancel/refund → report). */
async function runScenario(): Promise<string> {
  const harness = buildUnitHarness();
  const seeded = await seedPublisherWorkflow(harness);
  const lines: string[] = [];

  const created = await harness.service.createListing(publisherPrincipal, {
    organizationId: 'org-publisher',
    workflowId: seeded.workflowId,
    versionId: seeded.version1Id,
    name: 'Digest Report',
    description: 'the determinism scenario listing',
    offers: [freeOffer(), oneTimeOffer('compatible_updates'), subscriptionOffer()],
  });
  lines.push(`listing ${created.listing.id} ${created.listing.status} rev=${created.revision.id} seq=${created.revision.sequence}`);
  const listingId = created.listing.id;

  const published = await harness.service.publishListing(publisherPrincipal, { listingId });
  lines.push(`published ${published.listing.status}`);

  // One-time purchase.
  const oneTimeOfferId = created.revision.offers.find((offer) => offer.model === 'one_time_purchase')!.id;
  const purchase = await harness.service.acceptOffer(customerPrincipal, {
    listingId,
    offerId: oneTimeOfferId,
    customerOrganizationId: CUSTOMER_ORG,
  });
  lines.push(`purchase ent=${purchase.entitlement.id} tx=${purchase.transaction!.id} status=${purchase.transaction!.status} ref=${purchase.transaction!.adapterReference}`);
  const duplicatePurchase = await harness.service.acceptOffer(customerPrincipal, {
    listingId,
    offerId: oneTimeOfferId,
    customerOrganizationId: CUSTOMER_ORG,
  });
  lines.push(`duplicate created=${duplicatePurchase.created} tx=${duplicatePurchase.transaction === null ? 'none' : duplicatePurchase.transaction.id}`);

  // Subscription purchase.
  const subscriptionOfferId = created.revision.offers.find(
    (offer) => offer.model === 'maintenance_subscription',
  )!.id;
  const subscription = await harness.service.acceptOffer(customerPrincipal, {
    listingId,
    offerId: subscriptionOfferId,
    customerOrganizationId: CUSTOMER_ORG,
  });
  lines.push(`subscription ent=${subscription.entitlement.id} tx=${subscription.transaction!.id}`);

  // The creator maintenance update (revision 2).
  const updated = await harness.service.publishNewVersion(publisherPrincipal, {
    listingId,
    versionId: seeded.version2Id,
  });
  lines.push(`update rev=${updated.revision.id} seq=${updated.revision.sequence} pin=${updated.revision.pin.versionId}`);

  // Access decisions after the update.
  const oneTimeAccess = await harness.service.checkVersionAccess(customerPrincipal, {
    listingId,
    versionId: seeded.version2Id,
    organizationId: CUSTOMER_ORG,
  });
  lines.push(`oneTime v2 access ${JSON.stringify(oneTimeAccess)}`);
  const subscriptionAccess = await harness.service.checkVersionAccess(customerPrincipal, {
    listingId,
    versionId: seeded.version2Id,
    organizationId: CUSTOMER_ORG,
  });
  lines.push(`subscription v2 access ${JSON.stringify(subscriptionAccess)}`);

  // Cancellation + refund.
  const canceled = await harness.service.cancelSubscription(customerPrincipal, {
    entitlementId: subscription.entitlement.id,
  });
  lines.push(`canceled ${canceled.status} at=${canceled.endedAt}`);
  const refunded = await harness.service.refundEntitlement(publisherPrincipal, {
    entitlementId: purchase.entitlement.id,
  });
  lines.push(`refunded ${refunded.status} at=${refunded.endedAt}`);

  // Reports.
  const reported = await harness.service.reportListing(customerPrincipal, {
    listingId,
    reason: 'misleading',
    detail: 'determinism scenario report',
  });
  lines.push(`report ${reported.report.id} ${reported.report.state}`);

  // The full history.
  const history = await harness.service.listListingRevisions(publisherPrincipal, listingId);
  lines.push(`history ${history.map((revision) => `${revision.sequence}:${revision.pin.versionId}`).join(',')}`);
  const trust = history.map((revision) => revision.trust.semanticDigest.slice(0, 12));
  lines.push(`trust ${trust.join(',')}`);

  return lines.join('\n');
}

describe('V2-012 — deterministic domain behavior', () => {
  it('the full scenario produces byte-identical transcripts on two fresh harnesses', async () => {
    const first = await runScenario();
    const second = await runScenario();
    expect(second).toBe(first);
  });

  it('the transcript is STABLE across a re-run in the same file (no hidden state)', async () => {
    const first = await runScenario();
    const second = await runScenario();
    const third = await runScenario();
    expect(first).toBe(second);
    expect(second).toBe(third);
  });
});
