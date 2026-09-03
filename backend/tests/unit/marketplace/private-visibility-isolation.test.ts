import { describe, it, expect } from 'vitest';
import {
  buildUnitHarness,
  seedPublisherWorkflow,
  publisherPrincipal,
  customerPrincipal,
  outsiderPrincipal,
  versionContentOf,
  authorDigestDocument,
  PUBLISHER_ORG,
  CUSTOMER_ORG,
  OTHER_ORG,
} from './helpers.js';
import { MarketplaceError } from '../../../src/marketplace/index.js';

/**
 * V2-012 — REQUIRED REGRESSION: private visibility isolation.
 *
 * A draft ("private") listing cannot leak to any unauthorized tenant: every
 * read answers the SAME uniform typed not-found as a missing listing (no
 * existence leak), for the listing itself, its revisions, offer acceptance,
 * version access checks and abuse reporting alike. Restricted ("shared")
 * listings leak to neither ungranted nor granted-but-unknown tenants.
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

describe('draft (private) listing isolation — uniform not-found, NO existence leak', () => {
  async function draftFixture() {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const created = await harness.service.createListing(publisherPrincipal, {
      organizationId: PUBLISHER_ORG,
      workflowId: seeded.workflowId,
      versionId: seeded.version1Id,
      name: 'Digest Report',
      offers: [{ model: 'free', terms: { model: 'free' } }],
    });
    return { harness, seeded, listingId: created.listing.id, offerId: created.revision.offers[0]!.id };
  }

  it('a non-publisher principal gets the SAME uniform not-found as for a missing listing', async () => {
    const { harness, listingId, offerId, seeded } = await draftFixture();
    // The draft listing answers EXACTLY like a nonexistent listing.
    await expectMarketplaceError(
      harness.service.getListing(customerPrincipal, listingId),
      'MARKETPLACE_LISTING_NOT_FOUND',
    );
    await expectMarketplaceError(
      harness.service.getListing(customerPrincipal, 'mkt_nonexistent'),
      'MARKETPLACE_LISTING_NOT_FOUND',
    );
    await expectMarketplaceError(
      harness.service.listListingRevisions(outsiderPrincipal, listingId),
      'MARKETPLACE_LISTING_NOT_FOUND',
    );
    await expectMarketplaceError(
      harness.service.acceptOffer(customerPrincipal, {
        listingId,
        offerId,
        customerOrganizationId: CUSTOMER_ORG,
      }),
      'MARKETPLACE_LISTING_NOT_FOUND',
    );
    await expectMarketplaceError(
      harness.service.checkVersionAccess(customerPrincipal, {
        listingId,
        versionId: seeded.version1Id,
        organizationId: CUSTOMER_ORG,
      }),
      'MARKETPLACE_LISTING_NOT_FOUND',
    );
    await expectMarketplaceError(
      harness.service.reportListing(outsiderPrincipal, { listingId, reason: 'malicious' }),
      'MARKETPLACE_LISTING_NOT_FOUND',
    );
    // …and the draft NEVER appears in the public browse surface.
    const browsed = await harness.service.listPublishedListings(customerPrincipal);
    expect(browsed.map((entry) => entry.listing.id)).not.toContain(listingId);
  });

  it('publisher-org members CAN read the draft (org-scoped collaboration)', async () => {
    const { harness, listingId } = await draftFixture();
    const read = await harness.service.getListing(
      { userId: 'unit-publisher-member' },
      listingId,
    );
    expect(read.listing.status).toBe('draft');
  });
});

describe('restricted (shared) listing isolation — granted organizations only', () => {
  async function restrictedFixture() {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const created = await harness.service.createListing(publisherPrincipal, {
      organizationId: PUBLISHER_ORG,
      workflowId: seeded.workflowId,
      versionId: seeded.version1Id,
      name: 'Digest Report (shared)',
      offers: [{ model: 'free', terms: { model: 'free' } }],
      distribution: 'restricted',
      grantedOrganizationIds: [CUSTOMER_ORG],
    });
    await harness.service.publishListing(publisherPrincipal, { listingId: created.listing.id });
    return { harness, seeded, listingId: created.listing.id };
  }

  it('the granted organization sees the shared listing', async () => {
    const { harness, listingId } = await restrictedFixture();
    const read = await harness.service.getListing(customerPrincipal, listingId);
    expect(read.listing.distribution).toBe('restricted');
    const browsed = await harness.service.listPublishedListings(customerPrincipal);
    expect(browsed.map((entry) => entry.listing.id)).toContain(listingId);
  });

  it('an UNGRANTED organization gets the uniform not-found (no existence leak)', async () => {
    const { harness, listingId } = await restrictedFixture();
    harness.memberships.assign('unit-other-owner', OTHER_ORG);
    await expectMarketplaceError(
      harness.service.getListing({ userId: 'unit-other-owner' }, listingId),
      'MARKETPLACE_LISTING_NOT_FOUND',
    );
    const browsed = await harness.service.listPublishedListings({ userId: 'unit-other-owner' });
    expect(browsed.map((entry) => entry.listing.id)).not.toContain(listingId);
  });

  it('the publisher organization always sees its own shared listing', async () => {
    const { harness, listingId } = await restrictedFixture();
    const read = await harness.service.getListing(publisherPrincipal, listingId);
    expect(read.listing.status).toBe('published');
  });
});

describe('private WORKFLOW isolation flows through the authority (V2-002 read boundary)', () => {
  it('a private workflow is invisible to other tenants through EVERY marketplace path', async () => {
    const harness = buildUnitHarness();
    await seedPublisherWorkflow(harness);
    harness.reader.seedWorkflow({
      id: 'wfw_unit_private',
      organizationId: PUBLISHER_ORG,
      ownerUserId: 'unit-publisher-owner',
      slug: 'private-workflow',
      visibility: 'private',
    });
    harness.reader.seedVersion({
      id: 'wfv_unit_private_1',
      workflowId: 'wfw_unit_private',
      versionNumber: 1,
      content: versionContentOf(authorDigestDocument()),
    });
    // Even the listing CREATION path denies (the reader is the authority).
    await expect(
      harness.service.createListing(customerPrincipal, {
        organizationId: PUBLISHER_ORG,
        workflowId: 'wfw_unit_private',
        versionId: 'wfv_unit_private_1',
        name: 'Leak attempt',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND' });
    await expect(
      harness.reader.getVersion(customerPrincipal, 'wfw_unit_private', 'wfv_unit_private_1'),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND' });
  });
});

describe('retired listing isolation (distribution stopped)', () => {
  it('a retired listing is invisible to non-publishers (uniform not-found)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const created = await harness.service.createListing(publisherPrincipal, {
      organizationId: PUBLISHER_ORG,
      workflowId: seeded.workflowId,
      versionId: seeded.version1Id,
      name: 'Digest Report',
      offers: [{ model: 'free', terms: { model: 'free' } }],
    });
    await harness.service.publishListing(publisherPrincipal, { listingId: created.listing.id });
    await harness.service.retireListing(publisherPrincipal, { listingId: created.listing.id });
    await expectMarketplaceError(
      harness.service.getListing(customerPrincipal, created.listing.id),
      'MARKETPLACE_LISTING_NOT_FOUND',
    );
    const browsed = await harness.service.listPublishedListings(customerPrincipal);
    expect(browsed.map((entry) => entry.listing.id)).not.toContain(created.listing.id);
    // The publisher still reads it (with the full revision history intact).
    const read = await harness.service.getListing(publisherPrincipal, created.listing.id);
    expect(read.listing.status).toBe('retired');
  });
});
