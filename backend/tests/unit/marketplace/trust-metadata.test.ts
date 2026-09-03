import { describe, it, expect } from 'vitest';
import {
  buildUnitHarness,
  seedPublisherWorkflow,
  publisherPrincipal,
  versionContentOf,
  authorDigestDocument,
  authorEquivalentUpdateDocument,
  PUBLISHER_ORG,
} from './helpers.js';
import {
  computeWorkflowVersionSemanticDigest,
  parseWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import { sensitiveCapabilities } from '../../../src/computer-agent/index.js';
import { MarketplaceError } from '../../../src/marketplace/index.js';

/**
 * V2-012 — marketplace trust metadata: the frozen derived view over the
 * pinned version's REAL WorkflowIR document (V2-003 parser + semantic
 * digest + capability/placement/dependency facts) and the V2-008 sensitive
 * classification, with fork provenance surfaced from the V2-002 facts.
 * Publication/volume/reviews/badges never enter the view and can never be
 * interpreted as authorization or execution proof.
 */

/** The V2-003 semantic digest of a real fixture document's stored content. */
function semanticDigestOf(content: Record<string, unknown>): string {
  const parsed = parseWorkflowIrDocument(JSON.stringify(content));
  if (!parsed.ok) {
    throw new Error('fixture content must be a parseable WorkflowIR document');
  }
  return computeWorkflowVersionSemanticDigest(parsed.document).digest;
}

async function createDraftListing(harness: ReturnType<typeof buildUnitHarness>) {
  const seeded = await seedPublisherWorkflow(harness);
  const created = await harness.service.createListing(publisherPrincipal, {
    organizationId: PUBLISHER_ORG,
    workflowId: seeded.workflowId,
    versionId: seeded.version1Id,
    name: 'Digest Report',
    offers: [{ model: 'free', terms: { model: 'free' } }],
  });
  return { seeded, created };
}

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

describe('the derived trust view (real V2-003 + V2-008 consumption)', () => {
  it('carries the exact version identity + BOTH digests (V2-002 content, V2-003 semantic)', async () => {
    const harness = buildUnitHarness();
    const { created } = await createDraftListing(harness);
    const trust = created.revision.trust;
    expect(trust.semanticDigest).toBe(semanticDigestOf(versionContentOf(authorDigestDocument())));
    expect(trust.contentDigest).toBe(created.revision.pin.contentDigest);
    expect(trust.versionId).toBe(created.revision.pin.versionId);
    expect(trust.versionNumber).toBe(1);
    expect(trust.workflowId).toBe(created.listing.workflowId);
    expect(trust.publisherOrganizationId).toBe(PUBLISHER_ORG);
    expect(trust.publisherUserId).toBe('unit-publisher-owner');
  });

  it('lists the sorted unique required capabilities and flags the V2-008 SENSITIVE ones', async () => {
    const harness = buildUnitHarness();
    const { created } = await createDraftListing(harness);
    const trust = created.revision.trust;
    expect(trust.requiredCapabilities).toEqual(['github.repository.read', 'messaging.send']);
    // messaging.send IS in V2-008's sensitive set (consumed read-only).
    expect(sensitiveCapabilities()).toContain('messaging.send');
    expect(trust.sensitiveCapabilities).toEqual(['messaging.send']);
    // Ordinary and sensitive are DISJOINT partitions of the required set.
    const ordinary = trust.requiredCapabilities.filter(
      (capability) => !trust.sensitiveCapabilities.includes(capability),
    );
    expect(ordinary).toEqual(['github.repository.read']);
  });

  it('lists the sorted unique placements', async () => {
    const harness = buildUnitHarness();
    const { created } = await createDraftListing(harness);
    expect(created.revision.trust.placements).toEqual(['cloud_allowed', 'cloud_preferred']);
  });

  it('carries the subworkflow dependency references (opaque, no interpretation)', async () => {
    const harness = buildUnitHarness();
    const { created } = await createDraftListing(harness);
    // The digest fixture declares NO subworkflow dependencies: honest empty.
    expect(created.revision.trust.dependencyGraph).toEqual([]);
  });

  it('surfaces the FORK PROVENANCE preserved by V2-002 (collaboration facts)', async () => {
    const harness = buildUnitHarness();
    // A FORKED workflow: the customer forked the publisher's public v1
    // (the collaboration flow) — V2-002 preserves the provenance facts.
    harness.reader.seedWorkflow({
      id: 'wfw_unit_fork',
      organizationId: 'org-customer',
      ownerUserId: 'unit-customer-owner',
      slug: 'digest-fork',
      visibility: 'private',
      forkedFromWorkflowId: 'wfw_unit_publisher',
      forkedFromVersionId: 'wfv_unit_publisher_1',
    });
    harness.reader.seedVersion({
      id: 'wfv_unit_fork_1',
      workflowId: 'wfw_unit_fork',
      versionNumber: 1,
      content: versionContentOf(authorDigestDocument()),
    });
    const created = await harness.service.createListing(
      { userId: 'unit-customer-owner' },
      {
        organizationId: 'org-customer',
        workflowId: 'wfw_unit_fork',
        versionId: 'wfv_unit_fork_1',
        name: 'Forked digest',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      },
    );
    expect(created.revision.trust.provenance).toEqual({
      forkedFromWorkflowId: 'wfw_unit_publisher',
      forkedFromVersionId: 'wfv_unit_publisher_1',
    });
    expect(created.listing.workflowId).toBe('wfw_unit_fork');
  });

  it('the trust derivation is DETERMINISTIC (two fresh compositions yield the identical view)', async () => {
    const harness2 = buildUnitHarness();
    const second = await createDraftListing(harness2);
    const harness3 = buildUnitHarness();
    const third = await createDraftListing(harness3);
    expect(second.created.revision.trust).toEqual(third.created.revision.trust);
  });
});

describe('fail-closed content handling (the marketplace only distributes WorkflowIR)', () => {
  it('REFUSES to list a version whose content is not a parseable WorkflowIR document (typed)', async () => {
    const harness = buildUnitHarness();
    const { seeded } = await createDraftListing(harness);
    harness.reader.seedVersion({
      id: 'wfv_unit_opaque',
      workflowId: seeded.workflowId,
      versionNumber: 5,
      content: { not: 'a workflow ir document' },
    });
    await expectMarketplaceError(
      harness.service.createListing(publisherPrincipal, {
        organizationId: PUBLISHER_ORG,
        workflowId: seeded.workflowId,
        versionId: 'wfv_unit_opaque',
        name: 'Opaque listing',
        offers: [{ model: 'free', terms: { model: 'free' } }],
      }),
      'MARKETPLACE_VERSION_CONTENT_NOT_PARSEABLE',
    );
  });

  it('REFUSES a maintenance update whose new version is not parseable (typed)', async () => {
    const harness = buildUnitHarness();
    const { created } = await createDraftListing(harness);
    await harness.service.publishListing(publisherPrincipal, { listingId: created.listing.id });
    harness.reader.seedVersion({
      id: 'wfv_unit_opaque2',
      workflowId: 'wfw_unit_publisher',
      versionNumber: 6,
      content: { also: 'not an ir document' },
    });
    await expectMarketplaceError(
      harness.service.publishNewVersion(publisherPrincipal, {
        listingId: created.listing.id,
        versionId: 'wfv_unit_opaque2',
      }),
      'MARKETPLACE_VERSION_CONTENT_NOT_PARSEABLE',
    );
  });
});

describe('trust ≠ authorization (the marketplace-economics rule)', () => {
  it('the trust view exposes NO volume, ranking, review or badge field', async () => {
    const harness = buildUnitHarness();
    const { created } = await createDraftListing(harness);
    const keys = Object.keys(created.revision.trust).sort();
    // (Default lexicographic sort: 'semanticDigest' sorts BEFORE
    // 'sensitiveCapabilities'.)
    expect(keys).toEqual([
      'contentDigest',
      'dependencyGraph',
      'placements',
      'provenance',
      'publisherOrganizationId',
      'publisherUserId',
      'requiredCapabilities',
      'semanticDigest',
      'sensitiveCapabilities',
      'versionId',
      'versionNumber',
      'workflowId',
    ]);
    expect(JSON.stringify(created.revision.trust)).not.toMatch(
      /rank|rating|badge|salesVolume|downloads|stars/i,
    );
  });

  it('a NEW revision\'s trust view is derived fresh over the NEW version (distinct digests)', async () => {
    const harness = buildUnitHarness();
    const { seeded, created } = await createDraftListing(harness);
    await harness.service.publishListing(publisherPrincipal, { listingId: created.listing.id });
    const updated = await harness.service.publishNewVersion(publisherPrincipal, {
      listingId: created.listing.id,
      versionId: seeded.version2Id,
    });
    const v1Trust = created.revision.trust;
    const v2Trust = updated.revision.trust;
    expect(v2Trust.versionId).toBe(seeded.version2Id);
    // The semantic digests DIFFER (the maintenance change is real content).
    const digestV1 = semanticDigestOf(versionContentOf(authorDigestDocument()));
    const digestV2 = semanticDigestOf(versionContentOf(authorEquivalentUpdateDocument()));
    expect(digestV1).not.toBe(digestV2);
    expect(v1Trust.semanticDigest).toBe(digestV1);
    expect(v2Trust.semanticDigest).toBe(digestV2);
    // The content digests differ too (V2-002's own identity inputs).
    expect(v1Trust.contentDigest).not.toBe(v2Trust.contentDigest);
  });
});
