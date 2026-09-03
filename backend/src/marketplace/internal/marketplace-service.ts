/**
 * V2-012 — the default marketplace service (the one domain authority for
 * listing/offer/entitlement/transaction/report state).
 *
 * Every mutating operation is create-or-converge. Version/workflow facts
 * are ALWAYS resolved through the MarketplaceVersionReader port (the real
 * V2-002 repository service in composition — its typed denials are the
 * authority's own uniform not-founds and pass through, with only the
 * version-of-workflow denial mapped to this module's typed code). The
 * service NEVER creates, forks, mutates or installs versions, and NEVER
 * exposes any run, capability-grant, node-access, secret or execution
 * concept: entitlement grants content/version access ONLY.
 *
 * Determinism: all identities come from the injected sequential id factory,
 * all timestamps from the injected clock; the only concurrency guard is a
 * deterministic in-flight map keyed by the accept-offer convergence key
 * (concurrent duplicate acceptances share ONE settlement and converge).
 */
import { deepFreeze } from './immutable.js';
import { deriveListingTrust } from './listing-trust.js';
import { isCompatibleUpdate, parseVersionDocument } from './compatibility.js';
import {
  MARKETPLACE_COMMERCIAL_MODELS,
  MARKETPLACE_REPORT_REASONS,
  MarketplaceError,
} from '../types.js';
import type {
  AcceptOfferInput,
  AcceptOfferResult,
  CreateListingInput,
  CreateListingResult,
  CreateOfferInput,
  ListingOffer,
  ListingRevision,
  ListingRevisionResult,
  ListingWithRevision,
  MarketplaceAbuseReport,
  MarketplaceEntitlement,
  MarketplaceListing,
  MarketplacePrincipal,
  MarketplaceService,
  MarketplaceServiceDeps,
  MarketplaceTransaction,
  MarketplaceVersionAccessDecision,
  MarketplaceVersionAccessDenialReason,
  MarketplaceVersionFacts,
  MarketplaceWorkflowFacts,
  PublishListingInput,
  PublishNewVersionInput,
  ReportListingInput,
  ReportListingResult,
  ReviewReportInput,
  RetireListingInput,
  CancelSubscriptionInput,
  CheckVersionAccessInput,
  RefundEntitlementInput,
} from '../types.js';

const AMOUNT_PATTERN = /^\d{1,9}(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Fixed denial-reason priority (deterministic multi-entitlement reduction). */
const DENIAL_PRIORITY: readonly MarketplaceVersionAccessDenialReason[] = [
  'entitlement_refunded',
  'subscription_canceled',
  'incompatible_update',
  'update_not_included',
];

export class DefaultMarketplaceService implements MarketplaceService {
  private readonly store: MarketplaceServiceDeps['store'];
  private readonly reader: MarketplaceServiceDeps['versionReader'];
  private readonly memberships: MarketplaceServiceDeps['memberships'];
  private readonly payments: MarketplaceServiceDeps['payments'];
  private readonly ids: () => string;
  private readonly clock: () => number;
  /** Deterministic in-flight guard for concurrent duplicate acceptances. */
  private readonly acceptInFlight = new Map<string, Promise<AcceptOfferResult>>();
  /**
   * Deterministic per-key serialization of listing mutations: concurrent
   * callers register in arrival order and execute strictly one after another
   * (the create-or-converge checks inside each body then converge the
   * duplicates). This is the ONLY concurrency mechanism (no locks, no
   * timers, no randomness).
   */
  private readonly listingOps = new Map<string, Promise<unknown>>();

  constructor(deps: MarketplaceServiceDeps) {
    this.store = deps.store;
    this.reader = deps.versionReader;
    this.memberships = deps.memberships;
    this.payments = deps.payments;
    this.ids = deps.idFactory;
    this.clock = deps.clock;
  }

  // ==========================================================================
  // Listing lifecycle
  // ==========================================================================

  async createListing(
    principal: MarketplacePrincipal,
    input: CreateListingInput,
  ): Promise<CreateListingResult> {
    // Serialize per (publisher organization, workflow): two concurrent
    // create-listing calls for the same workflow converge on ONE listing
    // (the second body finds the first's durable record).
    return this.serialize(`${input.organizationId}:${input.workflowId}`, () =>
      this.createListingBody(principal, input),
    );
  }

  private async createListingBody(
    principal: MarketplacePrincipal,
    input: CreateListingInput,
  ): Promise<CreateListingResult> {
    if (!input.name || typeof input.name !== 'string') {
      throw new MarketplaceError('MARKETPLACE_INPUT_INVALID', 'a listing name is required');
    }
    const distribution = input.distribution ?? 'public';
    const granted = input.grantedOrganizationIds ?? [];
    if (distribution === 'restricted' && granted.length === 0) {
      throw new MarketplaceError(
        'MARKETPLACE_INPUT_INVALID',
        'restricted distribution requires at least one granted organization',
      );
    }
    for (const offer of input.offers) {
      this.validateOffer(offer);
    }

    // Resolve the EXACT version facts through the V2-002 authority FIRST:
    // its read boundary is the authority (an invisible workflow denies
    // through the authority's own uniform typed not-found, propagated
    // untouched), and the version-of-workflow denial maps to this module's
    // typed code.
    const version = await this.readVersion(principal, input.workflowId, input.versionId);
    const workflow = await this.reader.getWorkflow(principal, input.workflowId);
    if (workflow.organizationId !== input.organizationId) {
      throw new MarketplaceError(
        'MARKETPLACE_WORKFLOW_NOT_OWNED_BY_PUBLISHER',
        'the listed workflow belongs to another organization',
      );
    }
    if (!(await this.memberships.isMember(principal.userId, input.organizationId))) {
      throw new MarketplaceError(
        'MARKETPLACE_NOT_ORGANIZATION_MEMBER',
        'the principal is not a member of the publisher organization',
      );
    }

    // Validation BEFORE convergence: the pinned version must yield a trust
    // view (the marketplace only distributes parseable WorkflowIR content) —
    // a converged create with an unlistable version refuses typed rather
    // than silently converging.
    const revision = this.buildRevision({
      listingId: this.ids(),
      sequence: 1,
      version,
      workflow,
      publisherOrganizationId: input.organizationId,
      publisherUserId: principal.userId,
      offers: input.offers,
    });

    // Converge on (publisher organization, workflow).
    const existing = this.store.findListingByWorkflow(input.organizationId, input.workflowId);
    if (existing) {
      const existingRevision = this.store.getRevision(existing.currentRevisionId);
      if (!existingRevision) {
        throw new MarketplaceError('MARKETPLACE_LISTING_NOT_FOUND', 'listing revision missing');
      }
      return { listing: existing, revision: existingRevision, created: false };
    }
    const listing = deepFreeze<MarketplaceListing>({
      id: revision.listingId,
      publisherOrganizationId: input.organizationId,
      publisherUserId: principal.userId,
      workflowId: input.workflowId,
      name: input.name,
      description: input.description ?? null,
      status: 'draft',
      distribution,
      grantedOrganizationIds: [...granted],
      currentRevisionId: revision.id,
      createdAt: revision.createdAt,
      updatedAt: revision.createdAt,
    });
    this.store.putListing(listing);
    this.store.putRevision(revision);
    return { listing, revision, created: true };
  }

  async publishListing(
    principal: MarketplacePrincipal,
    input: PublishListingInput,
  ): Promise<ListingWithRevision> {
    const { listing } = await this.requirePublisher(principal, input.listingId);
    if (listing.status === 'retired') {
      throw new MarketplaceError(
        'MARKETPLACE_LISTING_ALREADY_RETIRED',
        'a retired listing cannot be re-published',
      );
    }
    if (listing.status === 'published') {
      return this.withCurrentRevision(listing);
    }
    // Cross-tenant distribution requires the workflow to be PUBLIC in the
    // V2-002 authority (the repository's own visibility is the authority).
    const workflow = await this.reader.getWorkflow(principal, listing.workflowId);
    if (workflow.visibility !== 'public') {
      throw new MarketplaceError(
        'MARKETPLACE_WORKFLOW_NOT_PUBLIC',
        'publishing requires the workflow to be public in the repository authority',
      );
    }
    const updated = deepFreeze<MarketplaceListing>({
      ...listing,
      status: 'published',
      updatedAt: this.clock(),
    });
    this.store.putListing(updated);
    return this.withCurrentRevision(updated);
  }

  async retireListing(
    principal: MarketplacePrincipal,
    input: RetireListingInput,
  ): Promise<ListingWithRevision> {
    const { listing } = await this.requirePublisher(principal, input.listingId);
    if (listing.status === 'retired') {
      return this.withCurrentRevision(listing);
    }
    const updated = deepFreeze<MarketplaceListing>({
      ...listing,
      status: 'retired',
      updatedAt: this.clock(),
    });
    this.store.putListing(updated);
    return this.withCurrentRevision(updated);
  }

  async publishNewVersion(
    principal: MarketplacePrincipal,
    input: PublishNewVersionInput,
  ): Promise<ListingRevisionResult> {
    // Serialize per listing: concurrent same-version publications converge
    // on ONE revision (the second body finds the first's durable record);
    // concurrent different-version publications land in arrival order with
    // strictly increasing sequences and a deterministic newest-version head.
    return this.serialize(`rev:${input.listingId}`, () =>
      this.publishNewVersionBody(principal, input),
    );
  }

  private async publishNewVersionBody(
    principal: MarketplacePrincipal,
    input: PublishNewVersionInput,
  ): Promise<ListingRevisionResult> {
    const { listing } = await this.requirePublisher(principal, input.listingId);
    if (listing.status !== 'published') {
      throw new MarketplaceError(
        'MARKETPLACE_LISTING_NOT_PUBLISHED',
        'maintenance updates apply to published listings',
      );
    }
    if (input.offers) {
      for (const offer of input.offers) {
        this.validateOffer(offer);
      }
    }

    // Converge on a prior MAINTENANCE publication of the same version: a
    // duplicate submission of the SAME maintenance update never creates a
    // second revision. The BORN revision (sequence 1 — the listing's initial
    // pin, not a maintenance publication) is deliberately excluded here: it
    // converges below into the not-newer violation instead.
    const existing = this.store.findRevisionByVersion(listing.id, input.versionId);
    if (existing && existing.sequence > 1) {
      return { listing, revision: existing, created: false };
    }

    const current = this.store.getRevision(listing.currentRevisionId);
    if (!current) {
      throw new MarketplaceError('MARKETPLACE_LISTING_NOT_FOUND', 'listing revision missing');
    }

    // The NEW version is resolved through the V2-002 authority (the version
    // was created there by the publisher — NEVER here).
    const version = await this.readVersion(principal, listing.workflowId, input.versionId);
    if (version.versionNumber <= current.pin.versionNumber) {
      throw new MarketplaceError(
        'MARKETPLACE_VERSION_NOT_NEWER',
        'a maintenance update must pin a newer version than the current revision',
      );
    }
    const workflow = await this.reader.getWorkflow(principal, listing.workflowId);

    // Pricing continuity: an omitted offer set carries the current revision's
    // terms forward as NEW immutable offer records.
    const offerInputs: readonly CreateOfferInput[] = input.offers ?? current.offers.map(
      (offer) => ({ model: offer.model, terms: offer.terms }),
    );

    const revision = this.buildRevision({
      listingId: listing.id,
      sequence: current.sequence + 1,
      version,
      workflow,
      publisherOrganizationId: listing.publisherOrganizationId,
      publisherUserId: listing.publisherUserId,
      offers: offerInputs,
    });
    const updated = deepFreeze<MarketplaceListing>({
      ...listing,
      currentRevisionId: revision.id,
      updatedAt: revision.createdAt,
    });
    this.store.putRevision(revision);
    this.store.putListing(updated);
    return { listing: updated, revision, created: true };
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  async getListing(
    principal: MarketplacePrincipal,
    listingId: string,
  ): Promise<ListingWithRevision> {
    return this.withCurrentRevision(await this.visibleListing(principal, listingId));
  }

  async listPublishedListings(
    principal: MarketplacePrincipal,
  ): Promise<readonly ListingWithRevision[]> {
    const results: ListingWithRevision[] = [];
    for (const listing of this.store.listListings()) {
      if (await this.canSee(principal, listing)) {
        results.push(await this.withCurrentRevision(listing));
      }
    }
    return results;
  }

  async listListingRevisions(
    principal: MarketplacePrincipal,
    listingId: string,
  ): Promise<readonly ListingRevision[]> {
    await this.visibleListing(principal, listingId);
    return this.store.listRevisions(listingId);
  }

  // ==========================================================================
  // The purchase flow (creator economics)
  // ==========================================================================

  async acceptOffer(
    principal: MarketplacePrincipal,
    input: AcceptOfferInput,
  ): Promise<AcceptOfferResult> {
    const key = `${input.customerOrganizationId}:${input.offerId}`;
    const inFlight = this.acceptInFlight.get(key);
    if (inFlight) {
      // A concurrent duplicate acceptance converges on the FIRST settlement
      // (deterministic: the duplicate sees created=false, no second charge).
      const settled = await inFlight;
      return { entitlement: settled.entitlement, transaction: null, created: false };
    }
    const operation = this.settleOffer(principal, input).finally(() => {
      this.acceptInFlight.delete(key);
    });
    this.acceptInFlight.set(key, operation);
    return operation;
  }

  private async settleOffer(
    principal: MarketplacePrincipal,
    input: AcceptOfferInput,
  ): Promise<AcceptOfferResult> {
    const { listing, revision } = await this.visibleOfferListing(
      principal,
      input.listingId,
    );
    if (listing.status !== 'published') {
      throw new MarketplaceError(
        'MARKETPLACE_LISTING_NOT_PUBLISHED',
        'offers can only be accepted on published listings',
      );
    }
    if (!(await this.memberships.isMember(principal.userId, input.customerOrganizationId))) {
      throw new MarketplaceError(
        'MARKETPLACE_NOT_ORGANIZATION_MEMBER',
        'the principal is not a member of the customer organization',
      );
    }

    // The offer must be the CURRENT revision's offer (old-revision offers are
    // superseded: their version is no longer the distributed one).
    const offer = revision.offers.find((candidate) => candidate.id === input.offerId);
    if (!offer) {
      const superseded = this.store
        .listRevisions(listing.id)
        .some((candidate) =>
          candidate.offers.some((candidateOffer) => candidateOffer.id === input.offerId),
        );
      if (superseded) {
        throw new MarketplaceError(
          'MARKETPLACE_OFFER_SUPERSEDED',
          'the offer belongs to a superseded listing revision',
        );
      }
      throw new MarketplaceError('MARKETPLACE_OFFER_NOT_FOUND', 'unknown offer');
    }

    // Converge on (customer organization, offer): a duplicate acceptance
    // NEVER re-charges.
    const existing = this.store.findEntitlementByOffer(
      input.customerOrganizationId,
      input.offerId,
    );
    if (existing) {
      return { entitlement: existing, transaction: null, created: false };
    }

    const transactionId = this.ids();
    let transaction: MarketplaceTransaction | null = null;
    if (offer.model !== 'free') {
      if (offer.terms.model === 'free') {
        // Defense in depth: the terms must match the declared model (the
        // offer validation enforces this at declaration time).
        throw new MarketplaceError(
          'MARKETPLACE_OFFER_INVALID',
          'the offer terms must match the declared commercial model',
        );
      }
      const { amount, currency } = offer.terms;
      const outcome = await this.payments.charge({
        transactionId,
        listingId: listing.id,
        offerId: offer.id,
        customerOrganizationId: input.customerOrganizationId,
        amount,
        currency,
      });
      // The settlement is durable either way; a FAILED charge creates NO
      // entitlement (a payment-processor failure can never create a false one).
      transaction = deepFreeze<MarketplaceTransaction>({
        id: transactionId,
        listingId: listing.id,
        revisionId: revision.id,
        offerId: offer.id,
        customerOrganizationId: input.customerOrganizationId,
        amount,
        currency,
        status: outcome.ok ? 'succeeded' : 'failed',
        adapterReference: outcome.ok ? outcome.adapterReference : null,
        failureCode: outcome.ok ? null : outcome.failureCode,
        createdAt: this.clock(),
        refundedAt: null,
      });
      this.store.putTransaction(transaction);
      if (!outcome.ok) {
        throw new MarketplaceError(
          'MARKETPLACE_PAYMENT_FAILED',
          `the payment adapter declined the charge (${outcome.failureCode})`,
        );
      }
    }

    const entitlement = deepFreeze<MarketplaceEntitlement>({
      id: this.ids(),
      customerOrganizationId: input.customerOrganizationId,
      listingId: listing.id,
      revisionId: revision.id,
      offerId: offer.id,
      model: offer.model,
      status: 'active',
      pinnedVersionId: revision.pin.versionId,
      transactionId: transaction ? transaction.id : null,
      acceptedByUserId: principal.userId,
      grantedAt: this.clock(),
      endedAt: null,
    });
    this.store.putEntitlement(entitlement);
    return { entitlement, transaction, created: true };
  }

  // ==========================================================================
  // Entitlement enforcement (content access ONLY)
  // ==========================================================================

  async checkVersionAccess(
    principal: MarketplacePrincipal,
    input: CheckVersionAccessInput,
  ): Promise<MarketplaceVersionAccessDecision> {
    const { listing, revision } = await this.visibleOfferListing(principal, input.listingId);
    // The answer is a DENIAL for an unrelated organization (never a throw —
    // the decision surface is total, and an unmembered principal learns
    // nothing beyond no_entitlement).
    if (!(await this.memberships.isMember(principal.userId, input.organizationId))) {
      return { entitled: false, reason: 'no_entitlement' };
    }
    if (listing.status !== 'published') {
      return { entitled: false, reason: 'listing_not_published' };
    }

    // The entitlements of the checked organization (insertion order).
    const entitlements = this.store.listEntitlementsForListing(
      input.organizationId,
      listing.id,
    );
    let bestDenial: MarketplaceVersionAccessDenialReason | undefined;

    for (const entitlement of entitlements) {
      const decision = await this.evaluateEntitlement(
        principal,
        entitlement,
        input.versionId,
        listing.workflowId,
      );
      if (decision.entitled) {
        return decision;
      }
      const priority = DENIAL_PRIORITY.indexOf(decision.reason);
      if (
        bestDenial === undefined ||
        priority < DENIAL_PRIORITY.indexOf(bestDenial)
      ) {
        bestDenial = decision.reason;
      }
    }

    // The free path: the CURRENT revision's pinned version under a free offer.
    if (
      input.versionId === revision.pin.versionId &&
      revision.offers.some((offer) => offer.model === 'free')
    ) {
      return { entitled: true, basis: 'free_listing', entitlementId: null };
    }

    if (bestDenial !== undefined) {
      return { entitled: false, reason: bestDenial };
    }
    // A prior settlement attempt (e.g. a FAILED charge) that produced no
    // entitlement answers no_entitlement: the organization tried to acquire
    // the right and does not have it.
    if (this.store.listTransactionsForOrganization(input.organizationId, listing.id).length > 0) {
      return { entitled: false, reason: 'no_entitlement' };
    }
    return {
      entitled: false,
      reason: input.versionId === revision.pin.versionId ? 'no_free_offering' : 'no_entitlement',
    };
  }

  private async evaluateEntitlement(
    principal: MarketplacePrincipal,
    entitlement: MarketplaceEntitlement,
    versionId: string,
    workflowId: string,
  ): Promise<MarketplaceVersionAccessDecision> {
    // The purchased/pinned artifact itself.
    if (versionId === entitlement.pinnedVersionId) {
      if (entitlement.status === 'refunded') {
        return { entitled: false, reason: 'entitlement_refunded' };
      }
      return {
        entitled: true,
        basis: entitlement.model === 'maintenance_subscription' ? 'maintenance_subscription' : entitlement.model === 'one_time_purchase' ? 'one_time_purchase' : 'free_listing',
        entitlementId: entitlement.id,
      };
    }

    // Update access (a DIFFERENT version than the pinned one).
    if (entitlement.status === 'refunded') {
      return { entitled: false, reason: 'entitlement_refunded' };
    }
    if (
      entitlement.model === 'maintenance_subscription' &&
      entitlement.status === 'canceled'
    ) {
      return { entitled: false, reason: 'subscription_canceled' };
    }

    // Fetch the offer's update policy through the accepting revision.
    const revision = this.store.getRevision(entitlement.revisionId);
    const offer = revision?.offers.find((candidate) => candidate.id === entitlement.offerId);
    if (entitlement.model === 'one_time_purchase') {
      const policy = offer?.terms.model === 'one_time_purchase' ? offer.terms.updatePolicy : 'pinned_only';
      if (policy !== 'compatible_updates') {
        return { entitled: false, reason: 'update_not_included' };
      }
    }

    // Compatibility rules (V2-003's negotiation over the two REAL documents).
    const candidate = await this.readVersionQuietly(principal, workflowId, versionId);
    const pinned = await this.readVersionQuietly(principal, workflowId, entitlement.pinnedVersionId);
    if (!candidate || !pinned) {
      return { entitled: false, reason: 'incompatible_update' };
    }
    if (candidate.versionNumber <= pinned.versionNumber) {
      // Not an update at all (an older or sibling version): never authorized
      // through this entitlement.
      return { entitled: false, reason: 'update_not_included' };
    }
    const baselineDocument = parseVersionDocument(pinned);
    const candidateDocument = parseVersionDocument(candidate);
    if (!baselineDocument || !candidateDocument) {
      return { entitled: false, reason: 'incompatible_update' };
    }
    if (!isCompatibleUpdate(baselineDocument, candidateDocument)) {
      return { entitled: false, reason: 'incompatible_update' };
    }
    return {
      entitled: true,
      basis: entitlement.model === 'maintenance_subscription' ? 'maintenance_subscription' : 'one_time_purchase',
      entitlementId: entitlement.id,
    };
  }

  // ==========================================================================
  // Cancellation + refunds (explicit domain contracts)
  // ==========================================================================

  async cancelSubscription(
    principal: MarketplacePrincipal,
    input: CancelSubscriptionInput,
  ): Promise<MarketplaceEntitlement> {
    const entitlement = this.requireEntitlement(input.entitlementId);
    if (
      !(await this.memberships.isMember(principal.userId, entitlement.customerOrganizationId))
    ) {
      throw new MarketplaceError(
        'MARKETPLACE_NOT_ORGANIZATION_MEMBER',
        'only the customer organization may cancel its subscription',
      );
    }
    if (entitlement.model !== 'maintenance_subscription') {
      throw new MarketplaceError(
        'MARKETPLACE_ENTITLEMENT_STATE_INVALID',
        'cancellation applies to maintenance subscriptions only',
      );
    }
    if (entitlement.status === 'refunded') {
      throw new MarketplaceError(
        'MARKETPLACE_ENTITLEMENT_STATE_INVALID',
        'a refunded entitlement cannot be canceled',
      );
    }
    if (entitlement.status === 'canceled') {
      return entitlement;
    }
    const canceled = deepFreeze<MarketplaceEntitlement>({
      ...entitlement,
      status: 'canceled',
      endedAt: this.clock(),
    });
    this.store.putEntitlement(canceled);
    return canceled;
  }

  async refundEntitlement(
    principal: MarketplacePrincipal,
    input: RefundEntitlementInput,
  ): Promise<MarketplaceEntitlement> {
    const entitlement = this.requireEntitlement(input.entitlementId);
    const listing = this.store.getListing(entitlement.listingId);
    if (!listing) {
      throw new MarketplaceError('MARKETPLACE_LISTING_NOT_FOUND', 'unknown listing');
    }
    if (!(await this.memberships.isMember(principal.userId, listing.publisherOrganizationId))) {
      throw new MarketplaceError(
        'MARKETPLACE_NOT_PUBLISHER',
        'only the publisher organization may refund a purchase',
      );
    }
    if (entitlement.status === 'refunded') {
      return entitlement;
    }
    if (!entitlement.transactionId) {
      throw new MarketplaceError(
        'MARKETPLACE_ENTITLEMENT_STATE_INVALID',
        'a free entitlement has no settlement to refund',
      );
    }
    const transaction = this.store.getTransaction(entitlement.transactionId);
    if (!transaction || transaction.status !== 'succeeded') {
      throw new MarketplaceError(
        'MARKETPLACE_ENTITLEMENT_STATE_INVALID',
        'only a succeeded settlement can be refunded',
      );
    }
    const refund = await this.payments.refund(transaction.adapterReference!);
    if (!refund.ok) {
      throw new MarketplaceError(
        'MARKETPLACE_REFUND_FAILED',
        `the payment adapter declined the refund (${refund.failureCode})`,
      );
    }
    const refundedTransaction = deepFreeze<MarketplaceTransaction>({
      ...transaction,
      status: 'refunded',
      refundedAt: this.clock(),
    });
    this.store.putTransaction(refundedTransaction);
    const refunded = deepFreeze<MarketplaceEntitlement>({
      ...entitlement,
      status: 'refunded',
      endedAt: this.clock(),
    });
    this.store.putEntitlement(refunded);
    return refunded;
  }

  async getEntitlement(
    principal: MarketplacePrincipal,
    entitlementId: string,
  ): Promise<MarketplaceEntitlement> {
    const entitlement = this.requireEntitlement(entitlementId);
    const listing = this.store.getListing(entitlement.listingId);
    if (!listing) {
      throw new MarketplaceError('MARKETPLACE_ENTITLEMENT_NOT_FOUND', 'unknown entitlement');
    }
    const entitled = await this.memberships.isMember(
      principal.userId,
      entitlement.customerOrganizationId,
    );
    const publisher = await this.memberships.isMember(
      principal.userId,
      listing.publisherOrganizationId,
    );
    if (!entitled && !publisher) {
      throw new MarketplaceError(
        'MARKETPLACE_ENTITLEMENT_NOT_FOUND',
        'the entitlement is visible only to its parties',
      );
    }
    return entitlement;
  }

  async getTransaction(
    principal: MarketplacePrincipal,
    transactionId: string,
  ): Promise<MarketplaceTransaction> {
    const transaction = this.store.getTransaction(transactionId);
    if (!transaction) {
      throw new MarketplaceError('MARKETPLACE_TRANSACTION_NOT_FOUND', 'unknown transaction');
    }
    const listing = this.store.getListing(transaction.listingId);
    if (!listing) {
      throw new MarketplaceError('MARKETPLACE_TRANSACTION_NOT_FOUND', 'unknown transaction');
    }
    const customer = await this.memberships.isMember(
      principal.userId,
      transaction.customerOrganizationId,
    );
    const publisher = await this.memberships.isMember(
      principal.userId,
      listing.publisherOrganizationId,
    );
    if (!customer && !publisher) {
      throw new MarketplaceError(
        'MARKETPLACE_TRANSACTION_NOT_FOUND',
        'the transaction is visible only to its parties',
      );
    }
    return transaction;
  }

  // ==========================================================================
  // Abuse reporting + trust review
  // ==========================================================================

  async reportListing(
    principal: MarketplacePrincipal,
    input: ReportListingInput,
  ): Promise<ReportListingResult> {
    if (!MARKETPLACE_REPORT_REASONS.includes(input.reason)) {
      throw new MarketplaceError('MARKETPLACE_INPUT_INVALID', 'unknown report reason');
    }
    await this.visibleListing(principal, input.listingId);
    const existing = this.store.findReportByReporter(
      principal.userId,
      input.listingId,
      input.reason,
    );
    if (existing) {
      return { report: existing, created: false };
    }
    const report = deepFreeze<MarketplaceAbuseReport>({
      id: this.ids(),
      listingId: input.listingId,
      reporterUserId: principal.userId,
      reason: input.reason,
      detail: input.detail ?? null,
      state: 'open',
      createdAt: this.clock(),
      reviewedAt: null,
    });
    this.store.putReport(report);
    return { report, created: true };
  }

  async listReports(
    principal: MarketplacePrincipal,
    listingId: string,
  ): Promise<readonly MarketplaceAbuseReport[]> {
    const { listing } = await this.requirePublisher(principal, listingId);
    return this.store.listReportsForListing(listing.id);
  }

  async reviewReport(
    principal: MarketplacePrincipal,
    input: ReviewReportInput,
  ): Promise<MarketplaceAbuseReport> {
    const report = this.store.getReport(input.reportId);
    if (!report) {
      throw new MarketplaceError('MARKETPLACE_REPORT_NOT_FOUND', 'unknown report');
    }
    const listing = this.store.getListing(report.listingId);
    if (!listing) {
      throw new MarketplaceError('MARKETPLACE_REPORT_NOT_FOUND', 'unknown report');
    }
    if (!(await this.memberships.isMember(principal.userId, listing.publisherOrganizationId))) {
      throw new MarketplaceError(
        'MARKETPLACE_NOT_PUBLISHER',
        'only the publisher organization may triage reports',
      );
    }
    if (report.state !== 'open') {
      // Idempotent: an already-triaged report never changes state again.
      return report;
    }
    const reviewed = deepFreeze<MarketplaceAbuseReport>({
      ...report,
      state: input.disposition === 'dismissed' ? 'dismissed' : 'reviewed',
      reviewedAt: this.clock(),
    });
    this.store.putReport(reviewed);
    return reviewed;
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /**
   * Serialize operations under one key in ARRIVAL ORDER (deterministic):
   * each subsequent operation starts only after the previous one settles
   * (successfully or not — a failed operation never blocks the queue).
   */
  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.listingOps.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.listingOps.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  private validateOffer(offer: CreateOfferInput): void {
    if (!MARKETPLACE_COMMERCIAL_MODELS.includes(offer.model)) {
      throw new MarketplaceError('MARKETPLACE_OFFER_INVALID', 'unknown commercial model');
    }
    const terms = offer.terms as { model?: string; amount?: string; currency?: string; updatePolicy?: string };
    if (terms.model !== offer.model) {
      throw new MarketplaceError(
        'MARKETPLACE_OFFER_INVALID',
        'the offer terms must match the declared commercial model',
      );
    }
    if (offer.model !== 'free') {
      if (typeof terms.amount !== 'string' || !AMOUNT_PATTERN.test(terms.amount)) {
        throw new MarketplaceError(
          'MARKETPLACE_OFFER_INVALID',
          'a decimal amount string (e.g. "19.99") is required',
        );
      }
      if (typeof terms.currency !== 'string' || !CURRENCY_PATTERN.test(terms.currency)) {
        throw new MarketplaceError(
          'MARKETPLACE_OFFER_INVALID',
          'an ISO 4217 alpha-3 currency code is required',
        );
      }
    }
    if (offer.model === 'one_time_purchase') {
      if (terms.updatePolicy !== 'pinned_only' && terms.updatePolicy !== 'compatible_updates') {
        throw new MarketplaceError(
          'MARKETPLACE_OFFER_INVALID',
          'a one-time purchase must declare its explicit update policy',
        );
      }
    }
  }

  private buildRevision(input: {
    listingId: string;
    sequence: number;
    version: MarketplaceVersionFacts;
    workflow: MarketplaceWorkflowFacts;
    publisherOrganizationId: string;
    publisherUserId: string;
    offers: readonly CreateOfferInput[];
  }): ListingRevision {
    const createdAt = this.clock();
    const trust = deepFreeze(
      deriveListingTrust({
        version: input.version,
        workflow: input.workflow,
        publisherOrganizationId: input.publisherOrganizationId,
        publisherUserId: input.publisherUserId,
      }),
    );
    const offers = deepFreeze<ListingOffer[]>(
      input.offers.map((offer) => ({
        id: this.ids(),
        model: offer.model,
        terms: offer.terms,
        createdAt,
      })),
    );
    return deepFreeze<ListingRevision>({
      id: this.ids(),
      listingId: input.listingId,
      sequence: input.sequence,
      pin: deepFreeze({
        workflowId: input.version.workflowId,
        versionId: input.version.id,
        versionNumber: input.version.versionNumber,
        contentDigest: input.version.contentDigest,
        protocol: deepFreeze({ irSchemaVersion: input.version.protocol.irSchemaVersion }),
      }),
      offers,
      trust,
      createdAt,
    });
  }

  /** Read the exact version through the authority, mapping its version-mismatch denial. */
  private async readVersion(
    principal: MarketplacePrincipal,
    workflowId: string,
    versionId: string,
  ): Promise<MarketplaceVersionFacts> {
    try {
      return await this.reader.getVersion(principal, workflowId, versionId);
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        (err as { code?: string }).code === 'WORKFLOW_VERSION_NOT_FOUND'
      ) {
        throw new MarketplaceError(
          'MARKETPLACE_VERSION_NOT_OF_WORKFLOW',
          `version ${versionId} does not belong to workflow ${workflowId}`,
        );
      }
      throw err;
    }
  }

  /** A quiet version read (undefined on any denial — fail-closed decisions). */
  private async readVersionQuietly(
    principal: MarketplacePrincipal,
    workflowId: string,
    versionId: string,
  ): Promise<MarketplaceVersionFacts | undefined> {
    try {
      return await this.reader.getVersion(principal, workflowId, versionId);
    } catch {
      return undefined;
    }
  }

  /** The listing visible to the principal, or the uniform typed not-found. */
  private async visibleListing(
    principal: MarketplacePrincipal,
    listingId: string,
  ): Promise<MarketplaceListing> {
    const listing = this.store.getListing(listingId);
    if (!listing || !(await this.canSee(principal, listing))) {
      throw new MarketplaceError('MARKETPLACE_LISTING_NOT_FOUND', 'unknown listing');
    }
    return listing;
  }

  private async visibleOfferListing(
    principal: MarketplacePrincipal,
    listingId: string,
  ): Promise<ListingWithRevision> {
    return this.withCurrentRevision(await this.visibleListing(principal, listingId));
  }

  /** The listing requiring PUBLISHER-side authority (visible + publisher member). */
  private async requirePublisher(
    principal: MarketplacePrincipal,
    listingId: string,
  ): Promise<ListingWithRevision> {
    const listing = this.store.getListing(listingId);
    if (!listing || !(await this.canSee(principal, listing))) {
      throw new MarketplaceError('MARKETPLACE_LISTING_NOT_FOUND', 'unknown listing');
    }
    if (!(await this.memberships.isMember(principal.userId, listing.publisherOrganizationId))) {
      throw new MarketplaceError(
        'MARKETPLACE_NOT_PUBLISHER',
        'the principal is not a member of the publisher organization',
      );
    }
    return this.withCurrentRevision(listing);
  }

  /** The listing-visibility rule (private/restricted/retired never leak). */
  private async canSee(
    principal: MarketplacePrincipal,
    listing: MarketplaceListing,
  ): Promise<boolean> {
    if (await this.memberships.isMember(principal.userId, listing.publisherOrganizationId)) {
      return true;
    }
    if (listing.status !== 'published') {
      return false;
    }
    if (listing.distribution === 'public') {
      return true;
    }
    for (const granted of listing.grantedOrganizationIds) {
      if (await this.memberships.isMember(principal.userId, granted)) {
        return true;
      }
    }
    return false;
  }

  private withCurrentRevision(listing: MarketplaceListing): ListingWithRevision {
    const revision = this.store.getRevision(listing.currentRevisionId);
    if (!revision) {
      throw new MarketplaceError('MARKETPLACE_LISTING_NOT_FOUND', 'listing revision missing');
    }
    return { listing, revision };
  }

  private requireEntitlement(entitlementId: string): MarketplaceEntitlement {
    const entitlement = this.store.getEntitlement(entitlementId);
    if (!entitlement) {
      throw new MarketplaceError('MARKETPLACE_ENTITLEMENT_NOT_FOUND', 'unknown entitlement');
    }
    return entitlement;
  }
}
