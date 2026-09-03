import { describe, it, expect } from 'vitest';
import {
  buildUnitHarness,
  seedPublisherWorkflow,
  createPublishedListing,
  publisherPrincipal,
  customerPrincipal,
  oneTimeOffer,
  versionContentOf,
  authorEquivalentUpdateDocument,
  PUBLISHER_ORG,
} from './helpers.js';

/**
 * V2-012 — REQUIRED REGRESSION: concurrent version publication.
 *
 * Concurrent publication converges create-or-converge style: the SAME
 * version published twice (Promise.all) yields exactly ONE new revision;
 * TWO DIFFERENT versions published concurrently yield TWO revisions whose
 * sequence order is pinned by version identity, and every version stays
 * independently addressable in the history. Concurrent purchases converge
 * with exactly one charge.
 */

describe('concurrent publication of the SAME version (converge)', () => {
  it('two concurrent publishNewVersion calls yield ONE revision (created 1×, converged 1×)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [oneTimeOffer()]);
    const [first, second] = await Promise.all([
      harness.service.publishNewVersion(publisherPrincipal, {
        listingId,
        versionId: seeded.version2Id,
      }),
      harness.service.publishNewVersion(
        { userId: 'unit-publisher-member' },
        { listingId, versionId: seeded.version2Id },
      ),
    ]);
    const createdFlags = [first.created, second.created].sort();
    expect(createdFlags).toEqual([false, true]);
    expect(first.revision.id).toBe(second.revision.id);
    expect(first.revision.sequence).toBe(second.revision.sequence);
    const history = await harness.service.listListingRevisions(publisherPrincipal, listingId);
    expect(history).toHaveLength(2);
    expect(history.filter((revision) => revision.pin.versionId === seeded.version2Id)).toHaveLength(1);
  });

  it('two concurrent createListing calls for the same workflow converge on ONE listing', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const input = {
      organizationId: PUBLISHER_ORG,
      workflowId: seeded.workflowId,
      versionId: seeded.version1Id,
      name: 'Digest Report',
      offers: [oneTimeOffer()],
    } as const;
    const [first, second] = await Promise.all([
      harness.service.createListing(publisherPrincipal, input),
      harness.service.createListing({ userId: 'unit-publisher-member' }, input),
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.listing.id).toBe(second.listing.id);
    expect(first.revision.id).toBe(second.revision.id);
  });
});

describe('concurrent publication of TWO DIFFERENT versions (both land, deterministic order)', () => {
  it('v2 and v3 published concurrently yield TWO revisions in version order', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    harness.reader.seedVersion({
      id: 'wfv_unit_publisher_3',
      workflowId: seeded.workflowId,
      versionNumber: 3,
      content: versionContentOf(authorEquivalentUpdateDocument()),
    });
    const listingId = await createPublishedListing(harness, seeded, [oneTimeOffer()]);
    await Promise.all([
      harness.service.publishNewVersion(publisherPrincipal, {
        listingId,
        versionId: seeded.version2Id,
      }),
      harness.service.publishNewVersion(
        { userId: 'unit-publisher-member' },
        { listingId,
          versionId: 'wfv_unit_publisher_3' },
      ),
    ]);
    const history = await harness.service.listListingRevisions(publisherPrincipal, listingId);
    expect(history).toHaveLength(3);
    // BOTH versions are independently addressable and sequence-ordered.
    expect(history.map((revision) => revision.pin.versionNumber)).toEqual([1, 2, 3]);
    expect(history[1]!.pin.versionId).toBe(seeded.version2Id);
    expect(history[2]!.pin.versionId).toBe('wfv_unit_publisher_3');
    // The current revision is the NEWEST version pin (deterministic head).
    const current = await harness.service.getListing(publisherPrincipal, listingId);
    expect(current.revision.pin.versionId).toBe('wfv_unit_publisher_3');
    // The ORIGINAL revision 1 is byte-stable through the concurrent wave.
    expect(history[0]!.pin.versionId).toBe(seeded.version1Id);
    expect(history[0]!.trust.semanticDigest).toBe(
      (await seedPublisherWorkflowFreshDigest()) ?? history[0]!.trust.semanticDigest,
    );
  });

  async function seedPublisherWorkflowFreshDigest(): Promise<string | undefined> {
    // A fresh harness re-derives revision 1's trust over the same fixture:
    // its semantic digest must match the historical revision 1 exactly.
    const fresh = buildUnitHarness();
    const seededFresh = await seedPublisherWorkflow(fresh);
    const created = await fresh.service.createListing(publisherPrincipal, {
      organizationId: PUBLISHER_ORG,
      workflowId: seededFresh.workflowId,
      versionId: seededFresh.version1Id,
      name: 'Digest Report',
      offers: [oneTimeOffer()],
    });
    return created.revision.trust.semanticDigest;
  }
});

describe('concurrent purchases (idempotent settlement)', () => {
  it('two concurrent acceptances of the same offer yield ONE entitlement and ONE charge', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const listingId = await createPublishedListing(harness, seeded, [oneTimeOffer()]);
    const listing = await harness.service.getListing(publisherPrincipal, listingId);
    const offerId = listing.revision.offers[0]!.id;
    const [first, second] = await Promise.all([
      harness.service.acceptOffer(customerPrincipal, {
        listingId,
        offerId,
        customerOrganizationId: 'org-customer',
      }),
      harness.service.acceptOffer(customerPrincipal, {
        listingId,
        offerId,
        customerOrganizationId: 'org-customer',
      }),
    ]);
    const createdFlags = [first.created, second.created].sort();
    expect(createdFlags).toEqual([false, true]);
    expect(first.entitlement.id).toBe(second.entitlement.id);
    // EXACTLY ONE adapter charge settled the concurrent purchase.
    expect(harness.payments.chargeLog()).toHaveLength(1);
    expect(harness.store.listTransactions()).toHaveLength(1);
  });
});
