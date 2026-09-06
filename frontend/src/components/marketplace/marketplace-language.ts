/**
 * V2-017 T12 — the marketplace presentation language (UX spec §21/§22/§23
 * + the V2-012 authority boundaries).
 *
 * Presentation wording ONLY: every fact (price, model, decision, basis,
 * version pin) arrives from the authority's own records through the
 * transport wire — this module never re-derives, re-validates or invents a
 * marketplace fact. The frozen boundary sentences are the product contract:
 *   - a purchase/entitlement is never presented as execution authorization;
 *   - publication is never presented as verification, authorization, or
 *     proof of safety.
 */
import type { ProductListingOffer } from '../../api/client';

/** §23 verbatim: the entitled headline after a successful purchase. */
export const ENTITLED_HEADLINE = "You're entitled to this workflow.";

/** The frozen entitlement-vs-execution boundary sentence (§23 + V2-012). */
export const ENTITLEMENT_BOUNDARY =
  'Getting this workflow gives your organization access to its content — it is not permission to run. Execution stays subject to your access and approvals.';

/** The frozen publication-is-not-proof sentence (the V2-012 trust rule). */
export const PUBLICATION_NOT_PROOF =
  'Publication is not verification, authorization, or proof of safety.';

/** The §21 fork disclosure bullets, verbatim. */
export const FORK_PROMISES = [
  'Have its own versions',
  'Keep the original attribution',
  'Not receive the publisher’s private data',
  'Not receive the publisher’s secrets',
] as const;

/** §23: the explicit next step names the exact pinned version. */
export function INSTALL_NEXT(versionNumber: number): string {
  return `Next: Install version ${versionNumber}`;
}

/** The §22 price line: Free / $19.00 / $5.00/month (non-USD spelled out). */
export function priceLine(offer: ProductListingOffer): string {
  const { terms } = offer;
  if (terms.model === 'free') return 'Free';
  const symbol = terms.currency === 'USD' ? '$' : '';
  const suffix = terms.currency === 'USD' ? '' : ` ${terms.currency}`;
  if (terms.model === 'maintenance_subscription') {
    return `${symbol}${terms.amount}${suffix}/month`;
  }
  return `${symbol}${terms.amount}${suffix}`;
}

/** The commercial model words (§22). */
export function modelLine(offer: ProductListingOffer): string {
  switch (offer.model) {
    case 'free':
      return 'Free';
    case 'one_time_purchase':
      return 'One-time purchase';
    case 'maintenance_subscription':
      return 'Maintenance subscription';
  }
}

/** What the offer's update rights include (the authority's own terms). */
export function updateRightsLine(offer: ProductListingOffer): string {
  const { terms } = offer;
  if (terms.model === 'free') return 'The current version as listed.';
  if (terms.model === 'maintenance_subscription') {
    return 'Compatible updates while the subscription is active.';
  }
  return terms.updatePolicy === 'compatible_updates'
    ? 'Includes compatible updates.'
    : 'Pins this exact version — later updates are separate.';
}

/** The entitled basis line (why the organization has access). */
export function basisLine(decision: {
  basis: 'free_listing' | 'one_time_purchase' | 'maintenance_subscription';
}): string {
  switch (decision.basis) {
    case 'free_listing':
      return 'Access through the free listing.';
    case 'one_time_purchase':
      return 'Access through your one-time purchase.';
    case 'maintenance_subscription':
      return 'Access through your maintenance subscription.';
  }
}

/** Every typed denial gets its own honest line (never a generic failure). */
export function denialLine(reason: string): string {
  switch (reason) {
    case 'no_entitlement':
      return "Your organization doesn't have access to this version.";
    case 'no_free_offering':
      return 'This listing has no free offer.';
    case 'entitlement_refunded':
      return 'This purchase was refunded — access ended.';
    case 'subscription_canceled':
      return 'Maintenance was canceled — updates are no longer included.';
    case 'update_not_included':
      return "That newer version isn't included in your purchase.";
    case 'incompatible_update':
      return "That newer version isn't compatible with your purchase.";
    case 'listing_not_published':
      return 'This listing is no longer published.';
    default:
      return 'Access facts are unavailable right now.';
  }
}
