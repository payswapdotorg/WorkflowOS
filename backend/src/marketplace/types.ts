/**
 * V2-012 — Collaboration + Marketplace + Economics: the public contracts.
 *
 * The domain lives at `src/marketplace/` (application-layer pure domain
 * module — the V2-006/V2-010/V2-011 family precedent: NO migration, NO route
 * file, NO PostgreSQL store; the reference store + payment adapter are
 * in-memory and deterministic, durable persistence being a separately-owned
 * later concern). It owns EXACTLY the Work Order V2-012 scope
 * (spec/architecture/v2/work-orders/V2-012.md +
 * spec/architecture/v2/workflow-marketplace-economics.md +
 * spec/architecture/v2/workflow-teaching-and-marketplace.md):
 *
 *   - the marketplace LISTING lifecycle (draft → published → retired) with
 *     immutable LISTING REVISIONS, each pinning ONE exact WorkflowVersion
 *     (identity facts resolved read-only through the version-reader port —
 *     the real V2-002 repository service in composition) and carrying its
 *     own immutable OFFERS;
 *   - creator economics: one-time pricing and maintenance-subscription
 *     offers (the three frozen commercial models), acceptance through the
 *     payment-adapter port (a deterministic in-memory test adapter — NO real
 *     provider calls, NO provider semantics in this module), and normalized
 *     TRANSACTION facts only;
 *   - ENTITLEMENT and version-access rules: an entitlement grants CONTENT /
 *     VERSION access only (the frozen boundary — never capability
 *     authorization, node access, secrets, or execution permission);
 *   - refunds / cancellation / maintenance semantics as explicit domain
 *     contracts (publisher refunds revoke future access; customer
 *     cancellation stops future maintenance updates; both preserve the
 *     pinned historical version and never rewrite anything);
 *   - creator MAINTENANCE UPDATES as explicit new listing revisions pinning
 *     explicit new WorkflowVersions (created through the V2-002 authority by
 *     the publisher — never an in-place mutation of any published version);
 *   - abuse REPORTING and marketplace trust metadata (a frozen, derived view
 *     over the pinned version's real WorkflowIR: required capabilities,
 *     sensitive-capability classification consumed from V2-008, placements,
 *     dependency graph, fork provenance, digests — never authorization or
 *     execution proof).
 *
 * BOUNDARY CONTRACT (V2-012 vs the merged frozen modules — consume-only):
 *
 *   - Workflow/WorkflowVersion identity + installation pinning authority is
 *     V2-002's: this module NEVER creates, mutates, forks or installs
 *     versions. It reads version/workflow facts through the narrow
 *     MarketplaceVersionReader port (structurally satisfied by the real
 *     V2-002 repository service in composition — the port's denials are the
 *     authority's own uniform not-founds and pass through untouched);
 *   - WorkflowIR semantics + the SEMANTIC digest are V2-003's (the parser,
 *     digest and version-update negotiation are consumed through the merged
 *     barrel — the maintenance-update compatibility rule IS V2-003's
 *     negotiation decision, never re-implemented here);
 *   - the sensitive-capability classification is V2-008's (consumed
 *     read-only for the trust view — never a grant, never execution policy);
 *   - run/evidence semantics are V2-005's: NO run concept, NO execution
 *     concept, NO capability grant exists anywhere in this module's API
 *     surface (entitlement answers "may this customer access this content /
 *     version?" — NEVER "may this workflow execute this capability?");
 *   - payment processors are EXTERNAL ADAPTERS behind the
 *     MarketplacePaymentAdapter port: provider-specific identifiers,
 *     webhooks, cards and processor state never appear in WorkflowIR, Run,
 *     execution or authorization contracts — the workflow domain deals only
 *     in the normalized entitlement/transaction facts declared here;
 *   - NO secrets: no credential, token, cookie, or secret material is
 *     stored or transported by this module (constitution §16); publishers
 *     receive no customer execution data (publisher boundary);
 *   - repository collaboration facts (visibility, membership, fork
 *     provenance, version history) are V2-002's — this module LAYERS the
 *     commercial distribution boundary on top (listing visibility +
 *     restricted distribution + the public-workflow publish requirement)
 *     and SURFACES the collaboration facts in its trust metadata.
 */
// ============================================================================
// §0  Frozen vocabularies (the marketplace-economics design doc, verbatim)
// ============================================================================

/** The frozen commercial models (workflow-marketplace-economics.md). */
export const MARKETPLACE_COMMERCIAL_MODELS = [
  'free',
  'one_time_purchase',
  'maintenance_subscription',
] as const;
export type MarketplaceCommercialModel = (typeof MARKETPLACE_COMMERCIAL_MODELS)[number];

/** The listing lifecycle: draft (private) → published → retired (terminal). */
export const MARKETPLACE_LISTING_STATUSES = ['draft', 'published', 'retired'] as const;
export type MarketplaceListingStatus = (typeof MARKETPLACE_LISTING_STATUSES)[number];

/**
 * Listing distribution scope (a MARKETPLACE concept — distinct from the
 * V2-CTRL-003 repository visibility triple, which stays V2-002's):
 *   - `public`     — browseable by every authenticated principal;
 *   - `restricted` — browseable only by the publisher organization and the
 *                    explicitly granted customer organizations ("shared").
 */
export const MARKETPLACE_LISTING_DISTRIBUTIONS = ['public', 'restricted'] as const;
export type MarketplaceListingDistribution = (typeof MARKETPLACE_LISTING_DISTRIBUTIONS)[number];

/** The entitlement lifecycle. */
export const MARKETPLACE_ENTITLEMENT_STATUSES = ['active', 'canceled', 'refunded'] as const;
export type MarketplaceEntitlementStatus = (typeof MARKETPLACE_ENTITLEMENT_STATUSES)[number];

/** The normalized transaction lifecycle (adapter facts, never provider state). */
export const MARKETPLACE_TRANSACTION_STATUSES = ['succeeded', 'failed', 'refunded'] as const;
export type MarketplaceTransactionStatus = (typeof MARKETPLACE_TRANSACTION_STATUSES)[number];

/** The frozen abuse-report reasons. */
export const MARKETPLACE_REPORT_REASONS = [
  'malicious',
  'misleading',
  'privacy',
  'copyright',
  'other',
] as const;
export type MarketplaceReportReason = (typeof MARKETPLACE_REPORT_REASONS)[number];

/** The abuse-report review states (publisher-side triage). */
export const MARKETPLACE_REPORT_STATES = ['open', 'reviewed', 'dismissed'] as const;
export type MarketplaceReportState = (typeof MARKETPLACE_REPORT_STATES)[number];

// ============================================================================
// §1  The acting principal + the consumed authority ports
// ============================================================================

/** The acting principal (structurally the repositories' principal). */
export interface MarketplacePrincipal {
  readonly userId: string;
}

/**
 * Workflow facts read through the V2-002 authority (visibility-checked by
 * THAT authority — denials are its uniform typed not-founds). Structurally
 * satisfied by the merged WorkflowRepositoryService's Workflow records.
 */
export interface MarketplaceWorkflowFacts {
  readonly id: string;
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly slug: string;
  /** The canonical V2-CTRL-003 registry triple (V2-002's vocabulary). */
  readonly visibility: 'private' | 'organization' | 'public';
  /** FORK PROVENANCE (V2-002's preserved facts, surfaced in trust metadata). */
  readonly forkedFromWorkflowId: string | null;
  readonly forkedFromVersionId: string | null;
  readonly headVersionId: string | null;
}

/**
 * Version facts read through the V2-002 authority. `content` is the OPAQUE
 * version document (parsed read-only for the trust view and the V2-003
 * compatibility negotiation — never interpreted, never re-defined here).
 * `contentDigest` is V2-002's CONTENT digest (NOT the semantic digest).
 */
export interface MarketplaceVersionFacts {
  readonly id: string;
  readonly workflowId: string;
  readonly versionNumber: number;
  readonly contentDigest: string;
  readonly protocol: { readonly irSchemaVersion: string };
  readonly content: Readonly<Record<string, unknown>>;
}

/**
 * The narrow read-only port over the V2-002 repository authority. The real
 * WorkflowRepositoryService satisfies this STRUCTURALLY in composition (it
 * exposes strictly more); through this port the marketplace can never
 * create, fork, mutate or install anything — it can only READ, and every
 * read is the authority's own visibility-checked read.
 */
export interface MarketplaceVersionReader {
  getWorkflow(principal: MarketplacePrincipal, workflowId: string): Promise<MarketplaceWorkflowFacts>;
  getVersion(
    principal: MarketplacePrincipal,
    workflowId: string,
    versionId: string,
  ): Promise<MarketplaceVersionFacts>;
}

/**
 * The organization-membership fact source (the identity authority's facts,
 * consumed through a port — never re-implemented; structurally satisfied by
 * the same resolver shape the repository service consumes).
 */
export interface MarketplaceMembershipResolver {
  isMember(userId: string, organizationId: string): Promise<boolean>;
}

// ============================================================================
// §2  The payment adapter port (provider isolation — the frozen rule)
// ============================================================================

/** A normalized charge request: marketplace facts ONLY (no provider objects). */
export interface PaymentChargeRequest {
  /** The marketplace transaction this charge settles. */
  readonly transactionId: string;
  readonly listingId: string;
  readonly offerId: string;
  readonly customerOrganizationId: string;
  /** Decimal-string amount + ISO 4217 alpha-3 currency (verbatim offer terms). */
  readonly amount: string;
  readonly currency: string;
}

/** The normalized charge outcome (adapter-scoped reference, never provider state). */
export type PaymentChargeResult =
  | { readonly ok: true; readonly adapterReference: string }
  | { readonly ok: false; readonly failureCode: string };

/** The normalized refund outcome for a previously succeeded charge. */
export interface PaymentRefundResult {
  readonly ok: boolean;
  readonly failureCode: string | null;
}

/**
 * The payment-adapter boundary. Payment processors are EXTERNAL adapters
 * behind this port (the deterministic in-memory test adapter is the
 * reference implementation); NO real provider is ever called, and NO
 * provider-specific semantics (identifiers, webhooks, cards, processor
 * state) ever cross this boundary into the workflow domain.
 */
export interface MarketplacePaymentAdapter {
  charge(request: PaymentChargeRequest): Promise<PaymentChargeResult>;
  refund(adapterReference: string): Promise<PaymentRefundResult>;
}

// ============================================================================
// §3  Offers + trust metadata (immutable, per listing revision)
// ============================================================================

/** Whether a one-time purchase includes later compatible updates. */
export type OneTimeUpdatePolicy = 'pinned_only' | 'compatible_updates';

/** The frozen free offer terms. */
export interface FreeOfferTerms {
  readonly model: 'free';
}

/** The frozen one-time purchase terms (explicit update rights only). */
export interface OneTimePurchaseOfferTerms {
  readonly model: 'one_time_purchase';
  /** Decimal string (e.g. "19.99"). */
  readonly amount: string;
  /** ISO 4217 alpha-3 currency code. */
  readonly currency: string;
  readonly updatePolicy: OneTimeUpdatePolicy;
}

/** The frozen maintenance-subscription terms (compatible updates while active). */
export interface MaintenanceSubscriptionOfferTerms {
  readonly model: 'maintenance_subscription';
  readonly amount: string;
  readonly currency: string;
}

export type MarketplaceOfferTerms =
  | FreeOfferTerms
  | OneTimePurchaseOfferTerms
  | MaintenanceSubscriptionOfferTerms;

/** One immutable offer of one listing revision. */
export interface ListingOffer {
  readonly id: string;
  readonly model: MarketplaceCommercialModel;
  readonly terms: MarketplaceOfferTerms;
  readonly createdAt: number;
}

/** A subworkflow dependency reference in the pinned version (opaque). */
export interface ListingDependencyNode {
  readonly nodeId: string;
  readonly dependencyRef: string;
}

/** The repository collaboration facts surfaced by the trust view. */
export interface ListingProvenanceFacts {
  readonly forkedFromWorkflowId: string | null;
  readonly forkedFromVersionId: string | null;
}

/**
 * The frozen, derived trust metadata of ONE listing revision — computed at
 * revision creation from the pinned version's REAL WorkflowIR document
 * (V2-003 parser + semantic digest) and the V2-008 sensitive-capability
 * classification. Publication, sales volume, ranking, reviews or badges are
 * NEVER part of this view and can NEVER be interpreted as authorization or
 * execution proof (the marketplace-economics trust-presentation rule).
 */
export interface ListingTrustMetadata {
  readonly publisherOrganizationId: string;
  readonly publisherUserId: string;
  readonly workflowId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  /** V2-002's CONTENT digest of the pinned version. */
  readonly contentDigest: string;
  /** V2-003's SEMANTIC digest of the pinned version (computed via the merged barrel). */
  readonly semanticDigest: string;
  /** Sorted unique declared capability requirements (disclosure, NOT grants). */
  readonly requiredCapabilities: readonly string[];
  /** The required capabilities V2-008 classifies as sensitive (disclosure). */
  readonly sensitiveCapabilities: readonly string[];
  /** Sorted unique declared placements. */
  readonly placements: readonly string[];
  /** The pinned version's subworkflow dependency references (opaque). */
  readonly dependencyGraph: readonly ListingDependencyNode[];
  /** Fork provenance preserved by V2-002, surfaced here. */
  readonly provenance: ListingProvenanceFacts;
}

/** The exact version identity a listing revision pins (V2-002 facts as data). */
export interface ListedVersionPin {
  readonly workflowId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly contentDigest: string;
  readonly protocol: { readonly irSchemaVersion: string };
}

/**
 * ONE immutable listing revision: pins ONE exact WorkflowVersion, carries
 * its own immutable offers and its frozen trust metadata. A creator
 * maintenance update creates a NEW revision (a new explicit version pin) —
 * a revision is NEVER mutated in place.
 */
export interface ListingRevision {
  readonly id: string;
  readonly listingId: string;
  /** 1-based, monotonically increasing with each published version. */
  readonly sequence: number;
  readonly pin: ListedVersionPin;
  readonly offers: readonly ListingOffer[];
  readonly trust: ListingTrustMetadata;
  readonly createdAt: number;
}

// ============================================================================
// §4  Durable records (listing, entitlement, transaction, abuse report)
// ============================================================================

/**
 * A marketplace listing: the commercial distribution surface of ONE
 * publisher workflow. Draft listings are PRIVATE (publisher organization
 * only); publication requires the workflow to be `public` in the V2-002
 * authority (cross-tenant installation is the repository's own rule).
 */
export interface MarketplaceListing {
  readonly id: string;
  /** The publisher TENANT (the workflow's owning organization). */
  readonly publisherOrganizationId: string;
  /** The creator (recorded provenance; management is org-scoped). */
  readonly publisherUserId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: MarketplaceListingStatus;
  readonly distribution: MarketplaceListingDistribution;
  /** Organizations the listing is shared with (restricted distribution only). */
  readonly grantedOrganizationIds: readonly string[];
  /** The current revision (revision 1 exists from creation; advances only by NEW revisions). */
  readonly currentRevisionId: string;
  /** Injected-clock ms (never a wall clock). */
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * A customer's entitlement: the right to ACCESS content/versions under an
 * accepted offer. It is NOT an installation (V2-002's), NOT a deployment
 * (V2-009's), and NEVER an authorization grant beyond content access.
 */
export interface MarketplaceEntitlement {
  readonly id: string;
  readonly customerOrganizationId: string;
  readonly listingId: string;
  readonly revisionId: string;
  readonly offerId: string;
  readonly model: MarketplaceCommercialModel;
  readonly status: MarketplaceEntitlementStatus;
  /** The EXACT version pinned at acceptance (the purchased artifact). */
  readonly pinnedVersionId: string;
  /** Null for the free model (no transaction). */
  readonly transactionId: string | null;
  readonly acceptedByUserId: string;
  readonly grantedAt: number;
  readonly endedAt: number | null;
}

/**
 * A normalized marketplace transaction: marketplace facts + the adapter's
 * own reference ONLY. A FAILED charge is recorded (status `failed`) with
 * its typed failure code — a payment-processor failure can NEVER create a
 * false entitlement (the frozen regression).
 */
export interface MarketplaceTransaction {
  readonly id: string;
  readonly listingId: string;
  readonly revisionId: string;
  readonly offerId: string;
  readonly customerOrganizationId: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: MarketplaceTransactionStatus;
  /** The adapter's receipt reference (adapter-scoped; never provider state). */
  readonly adapterReference: string | null;
  readonly failureCode: string | null;
  readonly createdAt: number;
  readonly refundedAt: number | null;
}

/** One abuse report against a listing (trust metadata, never authorization). */
export interface MarketplaceAbuseReport {
  readonly id: string;
  readonly listingId: string;
  readonly reporterUserId: string;
  readonly reason: MarketplaceReportReason;
  readonly detail: string | null;
  readonly state: MarketplaceReportState;
  readonly createdAt: number;
  readonly reviewedAt: number | null;
}

// ============================================================================
// §5  The version-access decision (content access ONLY — the frozen boundary)
// ============================================================================

export type MarketplaceVersionAccessBasis =
  | 'free_listing'
  | 'one_time_purchase'
  | 'maintenance_subscription';

/** Why content/version access was DENIED (deterministic, typed). */
export type MarketplaceVersionAccessDenialReason =
  | 'listing_not_published'
  | 'no_free_offering'
  | 'no_entitlement'
  | 'entitlement_refunded'
  | 'subscription_canceled'
  | 'update_not_included'
  | 'incompatible_update';

/**
 * The content/version access decision. `entitled: true` grants CONTENT
 * access to the exact version ONLY — it is structurally incapable of
 * granting capability authorization, node access, secrets, or execution
 * permission (no such field exists on this type).
 */
export type MarketplaceVersionAccessDecision =
  | {
      readonly entitled: true;
      readonly basis: MarketplaceVersionAccessBasis;
      readonly entitlementId: string | null;
    }
  | {
      readonly entitled: false;
      readonly reason: MarketplaceVersionAccessDenialReason;
    };

// ============================================================================
// §6  Inputs / results (create-or-converge everywhere: duplicates converge)
// ============================================================================

/** One offer declaration for a new listing revision. */
export interface CreateOfferInput {
  readonly model: MarketplaceCommercialModel;
  readonly terms: MarketplaceOfferTerms;
}

export interface CreateListingInput {
  /** The publisher TENANT (must be the workflow's owning organization). */
  readonly organizationId: string;
  readonly workflowId: string;
  /** The exact immutable version revision 1 pins (resolved through the reader). */
  readonly versionId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly offers: readonly CreateOfferInput[];
  /** Defaults to `public`. */
  readonly distribution?: MarketplaceListingDistribution;
  /** Required for (and only used with) `restricted` distribution. */
  readonly grantedOrganizationIds?: readonly string[];
}

export interface PublishListingInput {
  readonly listingId: string;
}

export interface RetireListingInput {
  readonly listingId: string;
}

export interface PublishNewVersionInput {
  readonly listingId: string;
  /** The publisher's NEW immutable version (created through V2-002 first). */
  readonly versionId: string;
  /**
   * The new revision's offers. Omitted = carry the current revision's terms
   * forward verbatim (new immutable offer records — pricing continuity for
   * a maintenance update).
   */
  readonly offers?: readonly CreateOfferInput[];
}

export interface AcceptOfferInput {
  readonly listingId: string;
  readonly offerId: string;
  /** The customer TENANT accepting. */
  readonly customerOrganizationId: string;
}

export interface CheckVersionAccessInput {
  readonly listingId: string;
  readonly versionId: string;
  /** The customer TENANT whose access is checked. */
  readonly organizationId: string;
}

export interface CancelSubscriptionInput {
  readonly entitlementId: string;
}

export interface RefundEntitlementInput {
  readonly entitlementId: string;
}

export interface ReportListingInput {
  readonly listingId: string;
  readonly reason: MarketplaceReportReason;
  readonly detail?: string | null;
}

export interface ReviewReportInput {
  readonly reportId: string;
  readonly disposition: 'reviewed' | 'dismissed';
}

export interface CreateListingResult {
  readonly listing: MarketplaceListing;
  readonly revision: ListingRevision;
  /** false = converged on an existing listing for the same publisher workflow. */
  readonly created: boolean;
}

export interface ListingRevisionResult {
  readonly listing: MarketplaceListing;
  readonly revision: ListingRevision;
  /** false = converged on an existing revision pinning the same version. */
  readonly created: boolean;
}

/** The listing with its CURRENT revision resolved. */
export interface ListingWithRevision {
  readonly listing: MarketplaceListing;
  readonly revision: ListingRevision;
}

export interface AcceptOfferResult {
  readonly entitlement: MarketplaceEntitlement;
  /** The settlement transaction (null for the free model / converged accepts). */
  readonly transaction: MarketplaceTransaction | null;
  /** false = converged on the existing entitlement (idempotent — no double charge). */
  readonly created: boolean;
}

export interface ReportListingResult {
  readonly report: MarketplaceAbuseReport;
  /** false = converged on the reporter's existing report for the listing. */
  readonly created: boolean;
}

// ============================================================================
// §7  The store port (persistence pluggable; in-memory reference store)
// ============================================================================

/**
 * The marketplace store port. Durable marketplace persistence is a
 * separately-owned later concern (the V2-006/V2-010/V2-011 family
 * precedent); the in-memory reference store is the composition used by the
 * tests and the dogfooding harness. All records handed to the store are
 * DEEP-FROZEN (immutable by construction).
 */
export interface MarketplaceStore {
  putListing(listing: MarketplaceListing): void;
  getListing(listingId: string): MarketplaceListing | undefined;
  /** The create-or-converge key: ONE listing per publisher workflow. */
  findListingByWorkflow(
    publisherOrganizationId: string,
    workflowId: string,
  ): MarketplaceListing | undefined;
  listListings(): readonly MarketplaceListing[];

  putRevision(revision: ListingRevision): void;
  getRevision(revisionId: string): ListingRevision | undefined;
  /** The create-or-converge key: ONE revision per (listing, version). */
  findRevisionByVersion(listingId: string, versionId: string): ListingRevision | undefined;
  listRevisions(listingId: string): readonly ListingRevision[];

  putEntitlement(entitlement: MarketplaceEntitlement): void;
  getEntitlement(entitlementId: string): MarketplaceEntitlement | undefined;
  /** The create-or-converge key: ONE entitlement per (customer org, offer). */
  findEntitlementByOffer(
    customerOrganizationId: string,
    offerId: string,
  ): MarketplaceEntitlement | undefined;
  listEntitlementsForListing(
    customerOrganizationId: string,
    listingId: string,
  ): readonly MarketplaceEntitlement[];

  putTransaction(transaction: MarketplaceTransaction): void;
  getTransaction(transactionId: string): MarketplaceTransaction | undefined;
  /** The settlement attempts of one customer organization for one listing. */
  listTransactionsForOrganization(
    customerOrganizationId: string,
    listingId: string,
  ): readonly MarketplaceTransaction[];

  putReport(report: MarketplaceAbuseReport): void;
  getReport(reportId: string): MarketplaceAbuseReport | undefined;
  /** The create-or-converge key: ONE report per (reporter, listing, reason). */
  findReportByReporter(
    reporterUserId: string,
    listingId: string,
    reason: MarketplaceReportReason,
  ): MarketplaceAbuseReport | undefined;
  listReportsForListing(listingId: string): readonly MarketplaceAbuseReport[];
}

// ============================================================================
// §8  The service contract
// ============================================================================

export interface MarketplaceServiceDeps {
  readonly store: MarketplaceStore;
  readonly versionReader: MarketplaceVersionReader;
  readonly memberships: MarketplaceMembershipResolver;
  readonly payments: MarketplacePaymentAdapter;
  /** Deterministic id source (sequential factory — never random). */
  readonly idFactory: () => string;
  /** Deterministic injected clock (ms — never a wall clock). */
  readonly clock: () => number;
}

/**
 * The marketplace service: the one authority for listing/offer/entitlement/
 * transaction/report domain state. Every mutating operation is
 * create-or-converge (duplicates converge on the existing durable identity).
 *
 * Version/workflow facts are ALWAYS resolved through the V2-002 authority
 * (the version-reader port); the service NEVER creates, forks, mutates or
 * installs versions, and NEVER exposes any run, capability-grant or secret
 * concept (the entitlement boundary is structural).
 */
export interface MarketplaceService {
  /** Create a draft listing (revision 1 pins the exact version) — converges on (publisher, workflow). */
  createListing(
    principal: MarketplacePrincipal,
    input: CreateListingInput,
  ): Promise<CreateListingResult>;

  /** Publish (draft → published). Requires the workflow to be `public` in V2-002. Idempotent. */
  publishListing(
    principal: MarketplacePrincipal,
    input: PublishListingInput,
  ): Promise<ListingWithRevision>;

  /** Retire (published → retired, terminal): distribution stops; entitlements are untouched. */
  retireListing(
    principal: MarketplacePrincipal,
    input: RetireListingInput,
  ): Promise<ListingWithRevision>;

  /**
   * The creator maintenance update: pin the publisher's NEW version as a NEW
   * immutable revision (never an in-place mutation). Converges on
   * (listing, version); the new version must be newer than the current pin.
   */
  publishNewVersion(
    principal: MarketplacePrincipal,
    input: PublishNewVersionInput,
  ): Promise<ListingRevisionResult>;

  /** Read one listing with its current revision (visibility-checked; uniform typed not-found). */
  getListing(principal: MarketplacePrincipal, listingId: string): Promise<ListingWithRevision>;

  /** The distributed listings visible to the principal (browse). */
  listPublishedListings(principal: MarketplacePrincipal): Promise<readonly ListingWithRevision[]>;

  /** The listing's immutable revision history (the marketplace version-history view). */
  listListingRevisions(
    principal: MarketplacePrincipal,
    listingId: string,
  ): Promise<readonly ListingRevision[]>;

  /**
   * Accept an offer (the purchase flow): membership + listing + current-revision
   * offer checks, the adapter charge for paid models (failure → typed error,
   * a FAILED transaction record, NO entitlement), then the entitlement.
   * Converges on (customer org, offer) — a duplicate accept NEVER re-charges.
   */
  acceptOffer(principal: MarketplacePrincipal, input: AcceptOfferInput): Promise<AcceptOfferResult>;

  /**
   * The entitlement enforcement: may this organization access this content /
   * version? A DECISION, never a capability/execution grant.
   */
  checkVersionAccess(
    principal: MarketplacePrincipal,
    input: CheckVersionAccessInput,
  ): Promise<MarketplaceVersionAccessDecision>;

  /** Customer cancellation: stops future maintenance updates; preserves the pinned version access. */
  cancelSubscription(
    principal: MarketplacePrincipal,
    input: CancelSubscriptionInput,
  ): Promise<MarketplaceEntitlement>;

  /** Publisher refund: revokes the entitlement; the historical version/run facts are never rewritten. */
  refundEntitlement(
    principal: MarketplacePrincipal,
    input: RefundEntitlementInput,
  ): Promise<MarketplaceEntitlement>;

  /** Read one entitlement (customer-org or publisher-org members only). */
  getEntitlement(
    principal: MarketplacePrincipal,
    entitlementId: string,
  ): Promise<MarketplaceEntitlement>;

  /** Read one transaction (customer-org or publisher-org members only). */
  getTransaction(
    principal: MarketplacePrincipal,
    transactionId: string,
  ): Promise<MarketplaceTransaction>;

  /** Report a visible listing for abuse (trust metadata; never authorization). Converges on (reporter, listing). */
  reportListing(
    principal: MarketplacePrincipal,
    input: ReportListingInput,
  ): Promise<ReportListingResult>;

  /** List a listing's abuse reports (publisher-org members only). */
  listReports(
    principal: MarketplacePrincipal,
    listingId: string,
  ): Promise<readonly MarketplaceAbuseReport[]>;

  /** Triage an abuse report (publisher-org members only; idempotent). */
  reviewReport(
    principal: MarketplacePrincipal,
    input: ReviewReportInput,
  ): Promise<MarketplaceAbuseReport>;
}

// ============================================================================
// §9  Typed errors (stable machine-readable codes — never parse message strings)
// ============================================================================

export const MARKETPLACE_ERROR_CODES = [
  /** Uniform not-found for invisible/denied listings (NO existence leak). */
  'MARKETPLACE_LISTING_NOT_FOUND',
  'MARKETPLACE_NOT_PUBLISHER',
  'MARKETPLACE_NOT_ORGANIZATION_MEMBER',
  'MARKETPLACE_WORKFLOW_NOT_OWNED_BY_PUBLISHER',
  'MARKETPLACE_WORKFLOW_NOT_PUBLIC',
  'MARKETPLACE_VERSION_NOT_OF_WORKFLOW',
  'MARKETPLACE_VERSION_NOT_NEWER',
  'MARKETPLACE_VERSION_CONTENT_NOT_PARSEABLE',
  'MARKETPLACE_LISTING_ALREADY_RETIRED',
  'MARKETPLACE_LISTING_NOT_PUBLISHED',
  'MARKETPLACE_OFFER_NOT_FOUND',
  'MARKETPLACE_OFFER_SUPERSEDED',
  'MARKETPLACE_OFFER_INVALID',
  'MARKETPLACE_ENTITLEMENT_NOT_FOUND',
  'MARKETPLACE_TRANSACTION_NOT_FOUND',
  'MARKETPLACE_ENTITLEMENT_STATE_INVALID',
  'MARKETPLACE_PAYMENT_FAILED',
  'MARKETPLACE_REFUND_FAILED',
  'MARKETPLACE_REPORT_NOT_FOUND',
  'MARKETPLACE_INPUT_INVALID',
] as const;

export type MarketplaceErrorCode = (typeof MARKETPLACE_ERROR_CODES)[number];

/** The typed marketplace error (discriminated by `code`). */
export class MarketplaceError extends Error {
  readonly code: MarketplaceErrorCode;

  constructor(code: MarketplaceErrorCode, message: string) {
    super(`marketplace: ${message}`);
    this.name = 'MarketplaceError';
    this.code = code;
  }
}
