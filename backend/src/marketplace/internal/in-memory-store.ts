/**
 * V2-012 — the reference marketplace store + deterministic source factories.
 *
 * The store port (types.ts) keeps marketplace persistence pluggable: durable
 * storage is a later, separately-owned concern; this in-memory store is the
 * reference composition used by tests and the dogfooding harness (the exact
 * V2-006/V2-010/V2-011 precedent). The factories mirror the house
 * deterministic-source discipline (sequential ids, stepping clock — zero
 * wall clock, zero randomness).
 *
 * Convergence keys (create-or-converge, mirroring V2-002's discipline):
 *   - listing:          (publisherOrganizationId, workflowId)
 *   - revision:         (listingId, versionId)
 *   - entitlement:      (customerOrganizationId, offerId)
 *   - report:           (reporterUserId, listingId, reason)
 */
import type {
  ListingRevision,
  MarketplaceAbuseReport,
  MarketplaceEntitlement,
  MarketplaceListing,
  MarketplaceReportReason,
  MarketplaceStore,
  MarketplaceTransaction,
} from '../types.js';

/** An isolated in-memory marketplace store (insertion order everywhere). */
export class InMemoryMarketplaceStore implements MarketplaceStore {
  private readonly listings = new Map<string, MarketplaceListing>();
  private readonly revisions = new Map<string, ListingRevision>();
  private readonly entitlements = new Map<string, MarketplaceEntitlement>();
  private readonly transactions = new Map<string, MarketplaceTransaction>();
  private readonly reports = new Map<string, MarketplaceAbuseReport>();

  // --- listings -------------------------------------------------------------

  putListing(listing: MarketplaceListing): void {
    this.listings.set(listing.id, listing);
  }

  getListing(listingId: string): MarketplaceListing | undefined {
    return this.listings.get(listingId);
  }

  findListingByWorkflow(
    publisherOrganizationId: string,
    workflowId: string,
  ): MarketplaceListing | undefined {
    for (const listing of this.listings.values()) {
      if (
        listing.publisherOrganizationId === publisherOrganizationId &&
        listing.workflowId === workflowId
      ) {
        return listing;
      }
    }
    return undefined;
  }

  listListings(): readonly MarketplaceListing[] {
    return [...this.listings.values()];
  }

  // --- revisions ------------------------------------------------------------

  putRevision(revision: ListingRevision): void {
    this.revisions.set(revision.id, revision);
  }

  getRevision(revisionId: string): ListingRevision | undefined {
    return this.revisions.get(revisionId);
  }

  findRevisionByVersion(listingId: string, versionId: string): ListingRevision | undefined {
    for (const revision of this.revisions.values()) {
      if (revision.listingId === listingId && revision.pin.versionId === versionId) {
        return revision;
      }
    }
    return undefined;
  }

  listRevisions(listingId: string): readonly ListingRevision[] {
    return [...this.revisions.values()]
      .filter((revision) => revision.listingId === listingId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  // --- entitlements ----------------------------------------------------------

  putEntitlement(entitlement: MarketplaceEntitlement): void {
    this.entitlements.set(entitlement.id, entitlement);
  }

  getEntitlement(entitlementId: string): MarketplaceEntitlement | undefined {
    return this.entitlements.get(entitlementId);
  }

  findEntitlementByOffer(
    customerOrganizationId: string,
    offerId: string,
  ): MarketplaceEntitlement | undefined {
    for (const entitlement of this.entitlements.values()) {
      if (
        entitlement.customerOrganizationId === customerOrganizationId &&
        entitlement.offerId === offerId
      ) {
        return entitlement;
      }
    }
    return undefined;
  }

  listEntitlementsForListing(
    customerOrganizationId: string,
    listingId: string,
  ): readonly MarketplaceEntitlement[] {
    return [...this.entitlements.values()].filter(
      (entitlement) =>
        entitlement.customerOrganizationId === customerOrganizationId &&
        entitlement.listingId === listingId,
    );
  }

  // --- transactions -----------------------------------------------------------

  putTransaction(transaction: MarketplaceTransaction): void {
    this.transactions.set(transaction.id, transaction);
  }

  getTransaction(transactionId: string): MarketplaceTransaction | undefined {
    return this.transactions.get(transactionId);
  }

  listTransactionsForOrganization(
    customerOrganizationId: string,
    listingId: string,
  ): readonly MarketplaceTransaction[] {
    return [...this.transactions.values()].filter(
      (transaction) =>
        transaction.customerOrganizationId === customerOrganizationId &&
        transaction.listingId === listingId,
    );
  }

  /** Test observability only (NOT part of the store port). */
  listTransactions(): readonly MarketplaceTransaction[] {
    return [...this.transactions.values()];
  }

  // --- abuse reports -----------------------------------------------------------

  putReport(report: MarketplaceAbuseReport): void {
    this.reports.set(report.id, report);
  }

  getReport(reportId: string): MarketplaceAbuseReport | undefined {
    return this.reports.get(reportId);
  }

  findReportByReporter(
    reporterUserId: string,
    listingId: string,
    reason: MarketplaceReportReason,
  ): MarketplaceAbuseReport | undefined {
    for (const report of this.reports.values()) {
      if (
        report.reporterUserId === reporterUserId &&
        report.listingId === listingId &&
        report.reason === reason
      ) {
        return report;
      }
    }
    return undefined;
  }

  listReportsForListing(listingId: string): readonly MarketplaceAbuseReport[] {
    return [...this.reports.values()].filter((report) => report.listingId === listingId);
  }
}

/** A deterministic sequential id factory: `${prefix}_1`, `${prefix}_2`, … */
export function createSequentialIdFactory(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}_${(counter += 1)}`;
}

/**
 * A deterministic stepping clock: first call returns `startMs`, each further
 * call advances by `stepMs` (test/dogfooding determinism — never a wall
 * clock).
 */
export function createSteppingClock(startMs: number, stepMs: number): () => number {
  let ticks = 0;
  return () => startMs + ticks++ * stepMs;
}
