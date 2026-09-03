/**
 * V2-012 — Collaboration + Marketplace + Economics public barrel.
 *
 * The domain lives at `src/marketplace/` (application-layer pure domain
 * module — the V2-006/V2-010/V2-011 family precedent). It owns the
 * marketplace listing lifecycle with immutable revisions pinning exact
 * WorkflowVersions, creator economics (one-time pricing + maintenance
 * subscriptions behind the payment-adapter boundary), entitlement and
 * version-access rules (content access ONLY), refunds/cancellation/
 * maintenance semantics as explicit domain contracts, abuse reporting and
 * marketplace trust metadata.
 *
 * Boundaries (V2-012):
 *   - NO Workflow/WorkflowVersion/installation authority (V2-002 — version
 *     and workflow facts are consumed read-only through the
 *     MarketplaceVersionReader port, structurally satisfied by the real
 *     repository service in composition; installation flows through the
 *     authority's own service/routes, never through this module);
 *   - NO WorkflowIR semantics redefinition (V2-003 — the parser, semantic
 *     digest and version-update negotiation are consumed through the merged
 *     barrel; the maintenance-update compatibility rule IS V2-003's
 *     negotiation decision);
 *   - NO execution authority (V2-005): no run, capability-grant, node-access
 *     or secret concept exists in this module — entitlement grants content /
 *     version access ONLY (the frozen V2-012 integration boundary);
 *   - NO payment-provider semantics: processors are external adapters behind
 *     the MarketplacePaymentAdapter port (the deterministic in-memory test
 *     adapter is the reference implementation — no real provider calls);
 *   - NO computer-agent execution (V2-008 — only the sensitive-capability
 *     classification is consumed read-only for the trust view);
 *   - NO teaching (V2-006/V2-010), optimization (V2-011), scheduling/events
 *     (V2-009) or self-hosting composition (IG-005 — later gate).
 *
 * GREEN-STAGE BARREL: the full public surface (types + the service + the
 * reference store/payment adapter + the deterministic source factories).
 */

// The service (the one domain authority for listing/offer/entitlement/
// transaction/report state; version/workflow facts flow ONLY through the
// MarketplaceVersionReader port — the real V2-002 repository service in
// composition).
export { DefaultMarketplaceService } from './internal/marketplace-service.js';

// The reference store + deterministic source factories (the V2-006/V2-010/
// V2-011 family precedent; durable marketplace persistence is a
// separately-owned later concern).
export {
  InMemoryMarketplaceStore,
  createSequentialIdFactory,
  createSteppingClock,
} from './internal/in-memory-store.js';

// The deterministic in-memory TEST payment adapter (the reference
// implementation of the adapter boundary — NO real provider calls, NO
// provider semantics anywhere in this module).
export {
  InMemoryPaymentAdapter,
  IN_MEMORY_PAYMENT_FAILURE_CODES,
} from './internal/in-memory-payment-adapter.js';
export type {
  InMemoryPaymentAdapterOptions,
  ObservedCharge,
} from './internal/in-memory-payment-adapter.js';

export {
  // §0 frozen vocabularies
  MARKETPLACE_COMMERCIAL_MODELS,
  MARKETPLACE_LISTING_STATUSES,
  MARKETPLACE_LISTING_DISTRIBUTIONS,
  MARKETPLACE_ENTITLEMENT_STATUSES,
  MARKETPLACE_TRANSACTION_STATUSES,
  MARKETPLACE_REPORT_REASONS,
  MARKETPLACE_REPORT_STATES,
  // §9 typed error surface
  MARKETPLACE_ERROR_CODES,
  MarketplaceError,
} from './types.js';
export type {
  MarketplaceCommercialModel,
  MarketplaceListingStatus,
  MarketplaceListingDistribution,
  MarketplaceEntitlementStatus,
  MarketplaceTransactionStatus,
  MarketplaceReportReason,
  MarketplaceReportState,
  // §1 principal + consumed authority ports
  MarketplacePrincipal,
  MarketplaceWorkflowFacts,
  MarketplaceVersionFacts,
  MarketplaceVersionReader,
  MarketplaceMembershipResolver,
  // §2 payment adapter boundary
  PaymentChargeRequest,
  PaymentChargeResult,
  PaymentRefundResult,
  MarketplacePaymentAdapter,
  // §3 offers + trust metadata
  OneTimeUpdatePolicy,
  FreeOfferTerms,
  OneTimePurchaseOfferTerms,
  MaintenanceSubscriptionOfferTerms,
  MarketplaceOfferTerms,
  ListingOffer,
  ListingDependencyNode,
  ListingProvenanceFacts,
  ListingTrustMetadata,
  ListedVersionPin,
  ListingRevision,
  // §4 durable records
  MarketplaceListing,
  MarketplaceEntitlement,
  MarketplaceTransaction,
  MarketplaceAbuseReport,
  // §5 the version-access decision
  MarketplaceVersionAccessBasis,
  MarketplaceVersionAccessDenialReason,
  MarketplaceVersionAccessDecision,
  // §6 inputs / results
  CreateOfferInput,
  CreateListingInput,
  PublishListingInput,
  RetireListingInput,
  PublishNewVersionInput,
  AcceptOfferInput,
  CheckVersionAccessInput,
  CancelSubscriptionInput,
  RefundEntitlementInput,
  ReportListingInput,
  ReviewReportInput,
  CreateListingResult,
  ListingRevisionResult,
  ListingWithRevision,
  AcceptOfferResult,
  ReportListingResult,
  // §7 the store port
  MarketplaceStore,
  // §8 the service contract
  MarketplaceServiceDeps,
  MarketplaceService,
  // §9 typed errors
  MarketplaceErrorCode,
} from './types.js';
