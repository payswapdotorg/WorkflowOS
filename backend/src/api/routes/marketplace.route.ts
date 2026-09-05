/**
 * V2-017 T12 — the marketplace TRANSPORT routes.
 *
 * Transport ONLY (the T9/T11 route family pattern): every marketplace
 * decision — listing lifecycle, immutable revisions pinning exact
 * WorkflowVersions, offers, entitlement, version-access, refunds/
 * cancellation semantics, trust metadata — stays V2-012's frozen
 * `DefaultMarketplaceService`. The §21/§22/§23 consumer surface composes
 * the authority over HTTP (V2-017 rule 9).
 *
 * COMPOSITION (the integration-test recipe, verbatim): the service is
 * composed over the REAL V2-002 repository service as the
 * `MarketplaceVersionReader` port (structurally satisfied — the module can
 * never create, fork, mutate or install a version through it) and the same
 * identity-membership resolver shape the repository service consumes. The
 * payment adapter is the module's OWN deterministic in-memory reference
 * adapter (NO real provider calls — the frozen V2-012 rule; a
 * `payments` override is accepted for tests). The in-memory listing store
 * is transport state (the V2-011 reference-store precedent; durable
 * marketplace persistence is a separately-owned later concern).
 *
 * THE FROZEN BOUNDARY (surfaced, never crossed): an entitlement grants
 * CONTENT/version access only. NO route here grants a capability, a node
 * access, a secret, or execution permission; installation flows through
 * the V2-002 authority's OWN routes (`POST
 * /organizations/:orgId/workflow-repository/installations`), never through
 * this module; the version-access route answers a DECISION, never a grant.
 *
 * ROUTES (all backend-authorized: a resolved human principal via the auth
 * plugin's API-key/session path; every marketplace decision — visibility,
 * membership, ownership, entitlement — is the service's):
 *
 *   GET    /marketplace/listings
 *          — the listings visible to the caller (browse; public + the
 *            restricted listings shared with the caller's organizations)
 *   GET    /marketplace/listings/:listingId
 *          — one listing with its CURRENT revision (visibility-checked;
 *            uniform typed 404 — no existence leak)
 *   GET    /marketplace/listings/:listingId/revisions
 *          — the listing's immutable revision history
 *   POST   /marketplace/listings
 *          — create-or-converge a draft listing (revision 1 pins the EXACT
 *            version; publisher-org ownership is the service's own check)
 *   POST   /marketplace/listings/:listingId/publish
 *          — publish (draft → published; requires the workflow to be
 *            `public` in V2-002 — the service's own check)
 *   POST   /marketplace/listings/:listingId/offers/:offerId/accept
 *          — accept an offer (the purchase flow → the entitlement; payment
 *            failure → typed 402 + NO entitlement, never a silent success)
 *   GET    /organizations/:orgId/marketplace/listings/:listingId/version-access?versionId=…
 *          — the version-access DECISION for one organization (content
 *            access only — never an execution grant)
 *   POST   /marketplace/entitlements/:entitlementId/cancel
 *          — customer cancellation (stops future maintenance; preserves
 *            the historical facts)
 *
 * DELIBERATELY NOT EXPOSED (outside the T12 bounded surface; the authority
 * keeps them): maintenance-update publication (publishNewVersion),
 * retirement, refunds, abuse reporting and publisher-side triage, and any
 * installation/execution command.
 */
import type { FastifyInstance } from 'fastify';
import {
  DefaultMarketplaceService,
  InMemoryMarketplaceStore,
  InMemoryPaymentAdapter,
  MarketplaceError,
  type MarketplaceErrorCode,
  type MarketplaceMembershipResolver,
  type MarketplacePaymentAdapter,
  type MarketplaceService,
  type ListingOffer,
  type ListingRevision,
  type ListingTrustMetadata,
  type MarketplaceEntitlement,
  type MarketplaceListing,
  type MarketplaceTransaction,
} from '../../marketplace/index.js';
import type { WorkflowRepositoryService } from '../../workflow-repository/index.js';
import { requireUser, runAuthed } from '../plugins/auth.plugin.js';

export interface MarketplaceRouteDeps {
  /** The V2-002 repository: the authoritative version/workflow reads (the version-reader port). */
  workflowRepositoryService: WorkflowRepositoryService;
  /** The organization-membership fact source (the identity authority's facts). */
  memberships: MarketplaceMembershipResolver;
  /**
   * Optional payment-adapter override for tests. Default: the module's OWN
   * deterministic in-memory reference adapter (no real provider, ever).
   */
  payments?: MarketplacePaymentAdapter;
  /** Optional deterministic identity source for tests (default: crypto.randomUUID). */
  idFactory?: () => string;
  /** Optional deterministic clock for tests (default: Date.now). */
  clock?: () => number;
}

/** Typed error code → HTTP status (never parse message strings). */
const ERROR_STATUS: Record<MarketplaceErrorCode, number> = {
  MARKETPLACE_LISTING_NOT_FOUND: 404,
  MARKETPLACE_NOT_PUBLISHER: 403,
  MARKETPLACE_NOT_ORGANIZATION_MEMBER: 403,
  MARKETPLACE_WORKFLOW_NOT_OWNED_BY_PUBLISHER: 403,
  // The publish precondition (the workflow must be public in V2-002).
  MARKETPLACE_WORKFLOW_NOT_PUBLIC: 409,
  MARKETPLACE_VERSION_NOT_OF_WORKFLOW: 400,
  MARKETPLACE_VERSION_NOT_NEWER: 409,
  MARKETPLACE_VERSION_CONTENT_NOT_PARSEABLE: 400,
  MARKETPLACE_LISTING_ALREADY_RETIRED: 409,
  MARKETPLACE_LISTING_NOT_PUBLISHED: 409,
  MARKETPLACE_OFFER_NOT_FOUND: 404,
  MARKETPLACE_OFFER_SUPERSEDED: 409,
  MARKETPLACE_OFFER_INVALID: 400,
  MARKETPLACE_ENTITLEMENT_NOT_FOUND: 404,
  MARKETPLACE_TRANSACTION_NOT_FOUND: 404,
  MARKETPLACE_ENTITLEMENT_STATE_INVALID: 409,
  // A failed charge is an honest payment failure that grants NOTHING.
  MARKETPLACE_PAYMENT_FAILED: 402,
  MARKETPLACE_REFUND_FAILED: 502,
  MARKETPLACE_REPORT_NOT_FOUND: 404,
  MARKETPLACE_INPUT_INVALID: 400,
};

/** Typed error code → the stable wire identifier (kebab-case). */
function errorIdentifier(code: MarketplaceErrorCode): string {
  return `marketplace-${code.toLowerCase().replace(/marketplace_/g, '').replace(/_/g, '-')}`;
}

/** A structurally-typed reply (the workflow-runs route precedent). */
type ReplyLike = { code: (n: number) => { send: (b: unknown) => void } };

function sendError(reply: ReplyLike, err: unknown): void {
  if (err instanceof MarketplaceError) {
    reply.code(ERROR_STATUS[err.code] ?? 400).send({
      error: errorIdentifier(err.code),
      code: err.code,
      message: err.message,
    });
    return;
  }
  reply.code(500).send({ error: 'marketplace-internal', message: String(err) });
}

function invalidRequest(reply: ReplyLike, message: string): void {
  reply.code(400).send({
    error: 'marketplace-input-invalid',
    code: 'MARKETPLACE_INPUT_INVALID',
    message,
  });
}

// --- wire serializers (deterministic key order; the authority's own
// --- clock-ms timestamps pass through verbatim — never re-derived) -------

function serializeOffer(offer: ListingOffer): Record<string, unknown> {
  return {
    id: offer.id,
    model: offer.model,
    terms: offer.terms,
    createdAt: offer.createdAt,
  };
}

function serializeTrust(trust: ListingTrustMetadata): Record<string, unknown> {
  return {
    publisherOrganizationId: trust.publisherOrganizationId,
    publisherUserId: trust.publisherUserId,
    workflowId: trust.workflowId,
    versionId: trust.versionId,
    versionNumber: trust.versionNumber,
    contentDigest: trust.contentDigest,
    semanticDigest: trust.semanticDigest,
    requiredCapabilities: trust.requiredCapabilities,
    sensitiveCapabilities: trust.sensitiveCapabilities,
    placements: trust.placements,
    dependencyGraph: trust.dependencyGraph,
    provenance: trust.provenance,
  };
}

function serializeRevision(revision: ListingRevision): Record<string, unknown> {
  return {
    id: revision.id,
    listingId: revision.listingId,
    sequence: revision.sequence,
    pin: revision.pin,
    offers: revision.offers.map(serializeOffer),
    trust: serializeTrust(revision.trust),
    createdAt: revision.createdAt,
  };
}

function serializeListing(listing: MarketplaceListing): Record<string, unknown> {
  return {
    id: listing.id,
    publisherOrganizationId: listing.publisherOrganizationId,
    publisherUserId: listing.publisherUserId,
    workflowId: listing.workflowId,
    name: listing.name,
    description: listing.description,
    status: listing.status,
    distribution: listing.distribution,
    grantedOrganizationIds: listing.grantedOrganizationIds,
    currentRevisionId: listing.currentRevisionId,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
  };
}

function serializeEntitlement(
  entitlement: MarketplaceEntitlement,
): Record<string, unknown> {
  return {
    id: entitlement.id,
    customerOrganizationId: entitlement.customerOrganizationId,
    listingId: entitlement.listingId,
    revisionId: entitlement.revisionId,
    offerId: entitlement.offerId,
    model: entitlement.model,
    status: entitlement.status,
    pinnedVersionId: entitlement.pinnedVersionId,
    transactionId: entitlement.transactionId,
    acceptedByUserId: entitlement.acceptedByUserId,
    grantedAt: entitlement.grantedAt,
    endedAt: entitlement.endedAt,
  };
}

function serializeTransaction(
  transaction: MarketplaceTransaction,
): Record<string, unknown> {
  return {
    id: transaction.id,
    listingId: transaction.listingId,
    revisionId: transaction.revisionId,
    offerId: transaction.offerId,
    customerOrganizationId: transaction.customerOrganizationId,
    amount: transaction.amount,
    currency: transaction.currency,
    status: transaction.status,
    adapterReference: transaction.adapterReference,
    failureCode: transaction.failureCode,
    createdAt: transaction.createdAt,
    refundedAt: transaction.refundedAt,
  };
}

/** Structural presence checks (the service validates canonical shapes). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function marketplaceRoutes(
  app: FastifyInstance,
  deps: MarketplaceRouteDeps,
): Promise<void> {
  // The transport-owned service composition (the T11 route precedent):
  // the frozen V2-012 authority over the REAL V2-002 version reader and
  // the identity membership facts, with the deterministic in-memory
  // reference store + payment adapter as transport state.
  const service: MarketplaceService = new DefaultMarketplaceService({
    store: new InMemoryMarketplaceStore(),
    versionReader: deps.workflowRepositoryService,
    memberships: deps.memberships,
    payments: deps.payments ?? new InMemoryPaymentAdapter(),
    idFactory: deps.idFactory ?? (() => crypto.randomUUID()),
    clock: deps.clock ?? (() => Date.now()),
  });

  // --- browse the listings visible to the caller ------------------------------

  app.get('/marketplace/listings', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      try {
        const listings = await service.listPublishedListings({ userId: user.id });
        return {
          listings: listings.map((entry) => ({
            listing: serializeListing(entry.listing),
            revision: serializeRevision(entry.revision),
          })),
        };
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  // --- one listing with its current revision ------------------------------------

  app.get('/marketplace/listings/:listingId', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { listingId } = req.params as { listingId: string };
      try {
        const entry = await service.getListing({ userId: user.id }, listingId);
        return {
          listing: serializeListing(entry.listing),
          revision: serializeRevision(entry.revision),
        };
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  // --- the listing's immutable revision history ----------------------------------

  app.get('/marketplace/listings/:listingId/revisions', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { listingId } = req.params as { listingId: string };
      try {
        const revisions = await service.listListingRevisions(
          { userId: user.id },
          listingId,
        );
        return { revisions: revisions.map(serializeRevision) };
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  // --- create-or-converge a draft listing (the Share surface) -------------------

  app.post('/marketplace/listings', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const body = req.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body.organizationId !== 'string' ||
        typeof body.workflowId !== 'string' ||
        typeof body.versionId !== 'string' ||
        typeof body.name !== 'string' ||
        !Array.isArray(body.offers)
      ) {
        return invalidRequest(
          reply,
          'organizationId, workflowId, versionId, name and offers are required',
        );
      }
      const description =
        typeof body.description === 'string' ? body.description : null;
      // Structural presence only — the service validates the canonical
      // offer shapes (model + terms) and answers typed 400s.
      const offers = body.offers.filter(
        (offer): offer is Record<string, unknown> => isRecord(offer),
      );
      try {
        const result = await service.createListing({ userId: user.id }, {
          organizationId: body.organizationId,
          workflowId: body.workflowId,
          versionId: body.versionId,
          name: body.name,
          description,
          offers: offers as never,
        });
        return reply.code(result.created ? 201 : 200).send({
          listing: serializeListing(result.listing),
          revision: serializeRevision(result.revision),
          created: result.created,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  // --- publish (draft → published; the public-workflow rule is the service's) ---

  app.post('/marketplace/listings/:listingId/publish', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { listingId } = req.params as { listingId: string };
      try {
        const entry = await service.publishListing({ userId: user.id }, { listingId });
        return {
          listing: serializeListing(entry.listing),
          revision: serializeRevision(entry.revision),
        };
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  // --- accept an offer (the purchase flow → the entitlement) ---------------------

  app.post(
    '/marketplace/listings/:listingId/offers/:offerId/accept',
    async (req, reply) => {
      return runAuthed(req, async () => {
        const user = await requireUser(req, reply);
        const { listingId, offerId } = req.params as {
          listingId: string;
          offerId: string;
        };
        const body = req.body as Record<string, unknown> | null;
        if (!body || typeof body.customerOrganizationId !== 'string') {
          return invalidRequest(reply, 'customerOrganizationId is required');
        }
        try {
          const result = await service.acceptOffer({ userId: user.id }, {
            listingId,
            offerId,
            customerOrganizationId: body.customerOrganizationId,
          });
          return reply.code(result.created ? 201 : 200).send({
            entitlement: serializeEntitlement(result.entitlement),
            transaction: result.transaction
              ? serializeTransaction(result.transaction)
              : null,
            created: result.created,
          });
        } catch (err) {
          return sendError(reply, err);
        }
      });
    },
  );

  // --- the version-access DECISION (content access only — never a grant) --------

  app.get(
    '/organizations/:orgId/marketplace/listings/:listingId/version-access',
    async (req, reply) => {
      return runAuthed(req, async () => {
        const user = await requireUser(req, reply);
        const { orgId, listingId } = req.params as {
          orgId: string;
          listingId: string;
        };
        const query = req.query as Record<string, unknown> | null;
        const versionId = typeof query?.versionId === 'string' ? query.versionId : null;
        if (!versionId) {
          return invalidRequest(reply, 'versionId is required');
        }
        try {
          const decision = await service.checkVersionAccess(
            { userId: user.id },
            { listingId, versionId, organizationId: orgId },
          );
          return { decision };
        } catch (err) {
          return sendError(reply, err);
        }
      });
    },
  );

  // --- customer cancellation (stops future maintenance; preserves history) -------

  app.post('/marketplace/entitlements/:entitlementId/cancel', async (req, reply) => {
    return runAuthed(req, async () => {
      const user = await requireUser(req, reply);
      const { entitlementId } = req.params as { entitlementId: string };
      try {
        const entitlement = await service.cancelSubscription(
          { userId: user.id },
          { entitlementId },
        );
        return { entitlement: serializeEntitlement(entitlement) };
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });
}
