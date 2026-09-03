import { describe, it, expect } from 'vitest';
import {
  buildUnitHarness,
  seedPublisherWorkflow,
  publisherPrincipal,
  publisherMemberPrincipal,
  outsiderPrincipal,
  versionContentOf,
  authorDigestDocument,
  PUBLISHER_ORG,
  type SeededPublisher,
} from './helpers.js';
import { MarketplaceError } from '../../../src/marketplace/index.js';

/**
 * V2-012 — the listing lifecycle: draft → published → retired, the immutable
 * revision sequence, the creator maintenance update as an EXPLICIT new
 * revision (never an in-place mutation), and create-or-converge discipline.
 */

async function isMarketplaceError(err: unknown, code: string): Promise<boolean> {
  return err instanceof MarketplaceError && err.code === code;
}

async function expectMarketplaceError(
  promise: Promise<unknown>,
  code: string,
): Promise<MarketplaceError> {
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

describe('listing creation (draft, revision 1 pins the exact version)', () => {
  it('creates a DRAFT listing whose revision 1 pins the exact V2-002 version identity', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const result = await harness.service.createListing(publisherPrincipal, {
      organizationId: PUBLISHER_ORG,
      workflowId: seeded.workflowId,
      versionId: seeded.version1Id,
      name: 'Digest Report',
      description: 'test listing',
      offers: [{ model: 'free', terms: { model: 'free' } }],
    });
    expect(result.created).toBe(true);
    expect(result.listing.status).toBe('draft');
    expect(result.listing.workflowId).toBe(seeded.workflowId);
    expect(result.listing.currentRevisionId).toBe(result.revision.id);
    expect(result.revision.sequence).toBe(1);
    expect(result.revision.pin.versionId).toBe(seeded.version1Id);
    expect(result.revision.pin.workflowId).toBe(seeded.workflowId);
    expect(result.revision.pin.versionNumber).toBe(1);
    // The pin's digest is the authority's OWN content digest (never recomputed).
    expect(result.revision.pin.contentDigest).toBe(`digest-${seeded.workflowId}-${seeded.version1Id}`);
  });

  it('converges on an existing listing for the same publisher workflow (create-or-converge)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const input = {
      organizationId: PUBLISHER_ORG,
      workflowId: seeded.workflowId,
      versionId: seeded.version1Id,
      name: 'Digest Report',
      offers: [{ model: 'free' as const, terms: { model: 'free' as const } }],
    };
    const first = await harness.service.createListing(publisherPrincipal, input);
    const second = await harness.service.createListing(publisherMemberPrincipal, input);
    expect(second.created).toBe(false);
    expect(second.listing.id).toBe(first.listing.id);
    expect(second.revision.id).toBe(first.revision.id);
  });

  it('rejects a listing for a workflow owned by ANOTHER organization (typed)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    await expectMarketplaceError(
      harness.service.createListing(publisherPrincipal, {
        organizationId: 'org-foreign',
        workflowId: seeded.workflowId,
        versionId: seeded.version1Id,
        name: 'Foreign listing',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      }),
      'MARKETPLACE_WORKFLOW_NOT_OWNED_BY_PUBLISHER',
    );
  });

  it('rejects a listing for an invisible workflow through the authority (uniform typed propagation)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    // The outsider cannot SEE the workflow at all: the reader (the V2-002
    // authority's read boundary) denies BEFORE any listing exists. (The
    // fixture re-seeds the workflow PRIVATE so the authority genuinely
    // denies the outsider — a public workflow would be visible to any
    // authenticated principal.)
    harness.reader.seedWorkflow({
      id: seeded.workflowId,
      organizationId: PUBLISHER_ORG,
      ownerUserId: 'unit-publisher-owner',
      slug: 'digest-report',
      visibility: 'private',
    });
    await expect(
      harness.service.createListing(outsiderPrincipal, {
        organizationId: PUBLISHER_ORG,
        workflowId: seeded.workflowId,
        versionId: seeded.version1Id,
        name: 'Outsider listing',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND' });
  });

  it('rejects a listing pinning a version of ANOTHER workflow (typed)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    harness.reader.seedWorkflow({
      id: 'wfw_unit_other',
      organizationId: PUBLISHER_ORG,
      ownerUserId: 'unit-publisher-owner',
      slug: 'other-workflow',
      visibility: 'public',
    });
    harness.reader.seedVersion({
      id: 'wfv_unit_other_1',
      workflowId: 'wfw_unit_other',
      versionNumber: 1,
      content: versionContentOf(authorDigestDocument()),
    });
    await expectMarketplaceError(
      harness.service.createListing(publisherPrincipal, {
        organizationId: PUBLISHER_ORG,
        workflowId: seeded.workflowId,
        versionId: 'wfv_unit_other_1',
        name: 'Mismatched listing',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      }),
      'MARKETPLACE_VERSION_NOT_OF_WORKFLOW',
    );
  });

  it('rejects a non-member publisher principal (typed)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    await expectMarketplaceError(
      harness.service.createListing(outsiderPrincipal, {
        organizationId: PUBLISHER_ORG,
        workflowId: seeded.workflowId,
        versionId: seeded.version1Id,
        name: 'Outsider listing',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      }),
      'MARKETPLACE_NOT_ORGANIZATION_MEMBER',
    );
  });
});

describe('publication (draft → published)', () => {
  it('publishes a draft listing (the workflow must be PUBLIC in the V2-002 authority)', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const created = await harness.service.createListing(publisherPrincipal, {
      organizationId: PUBLISHER_ORG,
      workflowId: seeded.workflowId,
      versionId: seeded.version1Id,
      name: 'Digest Report',
      offers: [{ model: 'free', terms: { model: 'free' } }],
    });
    const listingId = created.listing.id;
    const published = await harness.service.publishListing(publisherPrincipal, { listingId });
    expect(published.listing.status).toBe('published');
    expect(published.revision.id).toBe(created.revision.id);
  });

  it('is idempotent: publishing an already-published listing converges', async () => {
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
    const again = await harness.service.publishListing(publisherMemberPrincipal, {
      listingId: created.listing.id,
    });
    expect(again.listing.status).toBe('published');
    expect(again.listing.updatedAt).toBe((await harness.service.getListing(publisherPrincipal, created.listing.id)).listing.updatedAt);
  });

  it('REFUSES publication while the workflow is not public (repository visibility is the authority)', async () => {
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
    const created = await harness.service.createListing(publisherPrincipal, {
      organizationId: PUBLISHER_ORG,
      workflowId: 'wfw_unit_private',
      versionId: 'wfv_unit_private_1',
      name: 'Private listing',
      offers: [{ model: 'free', terms: { model: 'free' } }],
    });
    await expectMarketplaceError(
      harness.service.publishListing(publisherPrincipal, { listingId: created.listing.id }),
      'MARKETPLACE_WORKFLOW_NOT_PUBLIC',
    );
    // Still a draft — publication never happened.
    const still = await harness.service.getListing(publisherPrincipal, created.listing.id);
    expect(still.listing.status).toBe('draft');
  });

  it('retire is terminal and preserves every record (unpublish stops distribution only)', async () => {
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
    const retired = await harness.service.retireListing(publisherPrincipal, {
      listingId: created.listing.id,
    });
    expect(retired.listing.status).toBe('retired');
    await expectMarketplaceError(
      harness.service.publishListing(publisherPrincipal, { listingId: created.listing.id }),
      'MARKETPLACE_LISTING_ALREADY_RETIRED',
    );
    // The publisher still reads the retired listing with its full history.
    const history = await harness.service.listListingRevisions(publisherPrincipal, created.listing.id);
    expect(history).toHaveLength(1);
  });
});

describe('the creator maintenance update (an EXPLICIT new revision, never an in-place mutation)', () => {
  async function setupPublished(harness: ReturnType<typeof buildUnitHarness>): Promise<SeededPublisher & { listingId: string }> {
    const seeded = await seedPublisherWorkflow(harness);
    const created = await harness.service.createListing(publisherPrincipal, {
      organizationId: PUBLISHER_ORG,
      workflowId: seeded.workflowId,
      versionId: seeded.version1Id,
      name: 'Digest Report',
      offers: [{ model: 'free', terms: { model: 'free' } }],
    });
    await harness.service.publishListing(publisherPrincipal, { listingId: created.listing.id });
    return { ...seeded, listingId: created.listing.id };
  }

  it('publishes the new version as revision 2 and NEVER mutates revision 1', async () => {
    const harness = buildUnitHarness();
    const ctx = await setupPublished(harness);
    const before = await harness.service.listListingRevisions(publisherPrincipal, ctx.listingId);
    const revision1 = before[0]!;
    const result = await harness.service.publishNewVersion(publisherPrincipal, {
      listingId: ctx.listingId,
      versionId: ctx.version2Id,
    });
    expect(result.created).toBe(true);
    expect(result.revision.sequence).toBe(2);
    expect(result.revision.pin.versionId).toBe(ctx.version2Id);
    expect(result.revision.pin.versionNumber).toBe(2);
    expect(result.listing.currentRevisionId).toBe(result.revision.id);
    // Revision 1 is UNTOUCHED (byte-stable, still listed as history).
    const after = await harness.service.listListingRevisions(publisherPrincipal, ctx.listingId);
    expect(after).toHaveLength(2);
    expect(after[0]!.id).toBe(revision1.id);
    expect(after[0]!.pin.versionId).toBe(revision1.pin.versionId);
    expect(after[0]!.trust.semanticDigest).toBe(revision1.trust.semanticDigest);
    expect(after[0]!.createdAt).toBe(revision1.createdAt);
    expect(after[0]!.offers.map((o) => o.id)).toEqual(revision1.offers.map((o) => o.id));
  });

  it('carries the previous revision\'s pricing forward as NEW immutable offer records', async () => {
    const harness = buildUnitHarness();
    const seeded = await seedPublisherWorkflow(harness);
    const created = await harness.service.createListing(publisherPrincipal, {
      organizationId: PUBLISHER_ORG,
      workflowId: seeded.workflowId,
      versionId: seeded.version1Id,
      name: 'Digest Report',
      offers: [
        { model: 'one_time_purchase', terms: { model: 'one_time_purchase', amount: '19.99', currency: 'USD', updatePolicy: 'pinned_only' } },
      ],
    });
    await harness.service.publishListing(publisherPrincipal, { listingId: created.listing.id });
    const result = await harness.service.publishNewVersion(publisherPrincipal, {
      listingId: created.listing.id,
      versionId: seeded.version2Id,
    });
    // Same terms, DIFFERENT immutable offer records (the old offer ids stay valid).
    expect(result.revision.offers).toHaveLength(1);
    expect(result.revision.offers[0]!.model).toBe('one_time_purchase');
    expect(result.revision.offers[0]!.terms).toEqual(created.revision.offers[0]!.terms);
    expect(result.revision.offers[0]!.id).not.toBe(created.revision.offers[0]!.id);
  });

  it('rejects a maintenance update pinning a version that is NOT newer (typed)', async () => {
    const harness = buildUnitHarness();
    const ctx = await setupPublished(harness);
    await expectMarketplaceError(
      harness.service.publishNewVersion(publisherPrincipal, {
        listingId: ctx.listingId,
        versionId: ctx.version1Id,
      }),
      'MARKETPLACE_VERSION_NOT_NEWER',
    );
  });

  it('converges when the SAME version is published again (create-or-converge on listing+version)', async () => {
    const harness = buildUnitHarness();
    const ctx = await setupPublished(harness);
    const first = await harness.service.publishNewVersion(publisherPrincipal, {
      listingId: ctx.listingId,
      versionId: ctx.version2Id,
    });
    const second = await harness.service.publishNewVersion(publisherMemberPrincipal, {
      listingId: ctx.listingId,
      versionId: ctx.version2Id,
    });
    expect(second.created).toBe(false);
    expect(second.revision.id).toBe(first.revision.id);
    const history = await harness.service.listListingRevisions(publisherPrincipal, ctx.listingId);
    expect(history).toHaveLength(2);
  });

  it('the revision records are DEEP-FROZEN (an in-place mutation is structurally impossible)', async () => {
    const harness = buildUnitHarness();
    const ctx = await setupPublished(harness);
    await harness.service.publishNewVersion(publisherPrincipal, {
      listingId: ctx.listingId,
      versionId: ctx.version2Id,
    });
    const history = await harness.service.listListingRevisions(publisherPrincipal, ctx.listingId);
    for (const revision of history) {
      expect(Object.isFrozen(revision)).toBe(true);
      expect(Object.isFrozen(revision.pin)).toBe(true);
      expect(Object.isFrozen(revision.trust)).toBe(true);
      expect(Object.isFrozen(revision.offers)).toBe(true);
      for (const offer of revision.offers) {
        expect(Object.isFrozen(offer)).toBe(true);
      }
      expect(() => {
        (revision as { pin: { versionId: string } }).pin.versionId = 'mutated';
      }).toThrow();
    }
  });

  it('accepts an explicit new offer set on the new revision (pricing change = new revision)', async () => {
    const harness = buildUnitHarness();
    const ctx = await setupPublished(harness);
    const result = await harness.service.publishNewVersion(publisherPrincipal, {
      listingId: ctx.listingId,
      versionId: ctx.version2Id,
      offers: [
        { model: 'one_time_purchase', terms: { model: 'one_time_purchase', amount: '29.99', currency: 'EUR', updatePolicy: 'compatible_updates' } },
      ],
    });
    expect(result.revision.offers).toHaveLength(1);
    expect(result.revision.offers[0]!.terms).toEqual({
      model: 'one_time_purchase',
      amount: '29.99',
      currency: 'EUR',
      updatePolicy: 'compatible_updates',
    });
  });

  it('rejects an unknown listing uniformly (typed not-found)', async () => {
    const harness = buildUnitHarness();
    await seedPublisherWorkflow(harness);
    await expectMarketplaceError(
      harness.service.publishNewVersion(publisherPrincipal, {
        listingId: 'mkt_nonexistent',
        versionId: 'wfv_unit_publisher_1',
      }),
      'MARKETPLACE_LISTING_NOT_FOUND',
    );
    expect(await isMarketplaceError(new Error('x'), 'x')).toBe(false);
  });
});
