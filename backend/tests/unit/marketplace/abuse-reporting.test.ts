import { describe, it, expect } from 'vitest';
import {
  buildUnitHarness,
  seedPublisherWorkflow,
  createPublishedListing,
  publisherPrincipal,
  customerPrincipal,
  outsiderPrincipal,
  freeOffer,
  CUSTOMER_ORG,
} from './helpers.js';
import { MarketplaceError, MARKETPLACE_REPORT_REASONS } from '../../../src/marketplace/index.js';

/**
 * V2-012 — abuse reporting and review: typed report reasons, publisher-side
 * triage, create-or-converge per (reporter, listing), and the hard rule
 * that reports are TRUST METADATA — never authorization, never removal of
 * distribution on their own.
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

async function publishedFixture() {
  const harness = buildUnitHarness();
  const seeded = await seedPublisherWorkflow(harness);
  const listingId = await createPublishedListing(harness, seeded, [freeOffer()]);
  return { harness, seeded, listingId };
}

describe('reporting a distributed listing', () => {
  it('any principal who can SEE the listing may report it (typed reasons)', async () => {
    const { harness, listingId } = await publishedFixture();
    for (const reason of MARKETPLACE_REPORT_REASONS) {
      const result = await harness.service.reportListing(customerPrincipal, {
        listingId,
        reason,
        detail: `report for ${reason}`,
      });
      expect(result.report.reason).toBe(reason);
      expect(result.report.state).toBe('open');
      expect(result.report.reporterUserId).toBe('unit-customer-owner');
    }
    // The reporter's duplicate reports CONVERGE (one report per reporter/listing).
    const duplicate = await harness.service.reportListing(customerPrincipal, {
      listingId,
      reason: 'malicious',
    });
    expect(duplicate.created).toBe(false);
    const reports = await harness.service.listReports(publisherPrincipal, listingId);
    expect(reports).toHaveLength(MARKETPLACE_REPORT_REASONS.length);
  });

  it('a DIFFERENT reporter gets their own report record', async () => {
    const { harness, listingId } = await publishedFixture();
    const first = await harness.service.reportListing(customerPrincipal, {
      listingId,
      reason: 'misleading',
    });
    const second = await harness.service.reportListing(outsiderPrincipal, {
      listingId,
      reason: 'misleading',
    });
    expect(second.created).toBe(true);
    expect(second.report.id).not.toBe(first.report.id);
    const reports = await harness.service.listReports(publisherPrincipal, listingId);
    expect(reports.map((report) => report.reporterUserId).sort()).toEqual([
      'unit-customer-owner',
      'unit-outsider',
    ]);
  });

  it('an INVISIBLE listing answers the uniform not-found (no existence leak)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    // A DRAFT listing is invisible to the customer.
    const created = await harness.service.createListing(publisherPrincipal, {
      organizationId: 'org-publisher',
      workflowId: seeded.workflowId,
      versionId: seeded.version1Id,
      name: 'Digest Report',
      offers: [freeOffer()],
    });
    await expectMarketplaceError(
      harness.service.reportListing(customerPrincipal, {
        listingId: created.listing.id,
        reason: 'malicious',
      }),
      'MARKETPLACE_LISTING_NOT_FOUND',
    );
  });

  it('an invalid reason is rejected typed', async () => {
    const { harness, listingId } = await publishedFixture();
    await expectMarketplaceError(
      harness.service.reportListing(customerPrincipal, {
        listingId,
        reason: 'spam' as never,
      }),
      'MARKETPLACE_INPUT_INVALID',
    );
  });
});

describe('publisher-side triage (review/dismiss)', () => {
  it('the publisher reviews and dismisses reports (idempotent transitions)', async () => {
    const { harness, listingId } = await publishedFixture();
    const reported = await harness.service.reportListing(customerPrincipal, {
      listingId,
      reason: 'misleading',
      detail: 'the listing overstates the workflow',
    });
    const reviewed = await harness.service.reviewReport(publisherPrincipal, {
      reportId: reported.report.id,
      disposition: 'reviewed',
    });
    expect(reviewed.state).toBe('reviewed');
    expect(reviewed.reviewedAt).not.toBeNull();
    // Idempotent re-review converges (no timestamp churn).
    const again = await harness.service.reviewReport(publisherPrincipal, {
      reportId: reported.report.id,
      disposition: 'dismissed',
    });
    expect(again.state).toBe('reviewed');
    expect(again.reviewedAt).toBe(reviewed.reviewedAt);

    const other = await harness.service.reportListing(outsiderPrincipal, {
      listingId,
      reason: 'privacy',
    });
    const dismissed = await harness.service.reviewReport(publisherPrincipal, {
      reportId: other.report.id,
      disposition: 'dismissed',
    });
    expect(dismissed.state).toBe('dismissed');
    expect(dismissed.reviewedAt).not.toBeNull();
  });

  it('ONLY publisher-org members may read and triage reports (typed)', async () => {
    const { harness, listingId } = await publishedFixture();
    await harness.service.reportListing(customerPrincipal, { listingId, reason: 'malicious' });
    await expectMarketplaceError(
      harness.service.listReports(customerPrincipal, listingId),
      'MARKETPLACE_NOT_PUBLISHER',
    );
    const reports = await harness.service.listReports(publisherPrincipal, listingId);
    await expectMarketplaceError(
      harness.service.reviewReport(customerPrincipal, {
        reportId: reports[0]!.id,
        disposition: 'dismissed',
      }),
      'MARKETPLACE_NOT_PUBLISHER',
    );
  });

  it('an unknown report answers a uniform typed not-found', async () => {
    const { harness } = await publishedFixture();
    await expectMarketplaceError(
      harness.service.reviewReport(publisherPrincipal, {
        reportId: 'mkt_nonexistent',
        disposition: 'dismissed',
      }),
      'MARKETPLACE_REPORT_NOT_FOUND',
    );
  });
});

describe('reports are trust metadata ONLY (never enforcement)', () => {
  it('reports NEVER change listing visibility, access decisions or the revision history', async () => {
    const { harness, seeded, listingId } = await publishedFixture();
    const before = await harness.service.getListing(publisherPrincipal, listingId);
    for (const reporter of ['reporter-a', 'reporter-b', 'reporter-c', 'reporter-d', 'reporter-e']) {
      await harness.service.reportListing({ userId: reporter }, { listingId, reason: 'malicious' });
    }
    const after = await harness.service.getListing(publisherPrincipal, listingId);
    expect(after.listing.status).toBe(before.listing.status);
    expect(after.listing.currentRevisionId).toBe(before.listing.currentRevisionId);
    // The customer's free access is UNCHANGED by five abuse reports.
    const decision = await harness.service.checkVersionAccess(customerPrincipal, {
      listingId,
      versionId: seeded.version1Id,
      organizationId: CUSTOMER_ORG,
    });
    expect(decision).toEqual({ entitled: true, basis: 'free_listing', entitlementId: null });
    // The listing remains browsable and reportable.
    const browsed = await harness.service.listPublishedListings(customerPrincipal);
    expect(browsed.map((entry) => entry.listing.id)).toContain(listingId);
  });

  it('the report record carries NO customer execution data (publisher boundary)', async () => {
    const { harness, listingId } = await publishedFixture();
    const reported = await harness.service.reportListing(customerPrincipal, {
      listingId,
      reason: 'privacy',
      detail: 'the workflow reads private repositories',
    });
    const keys = Object.keys(reported.report).sort();
    expect(keys).toEqual([
      'createdAt',
      'detail',
      'id',
      'listingId',
      'reason',
      'reporterUserId',
      'reviewedAt',
      'state',
    ]);
    expect(JSON.stringify(reported.report)).not.toMatch(/run|invocation|evidence|execution|secret|node|capability/i);
  });
});
