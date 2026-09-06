import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  marketplace,
  organizations,
  type ProductListingWithRevision,
} from '../api/client';
import {
  priceLine,
  modelLine,
  PUBLICATION_NOT_PROOF,
} from '../components/marketplace/marketplace-language';

/**
 * ExplorePage — the marketplace discovery surface (V2-017 Task 12; UX
 * spec §22).
 *
 * Explore presents the listings visible to the caller through the V2-012
 * browse read (public distribution, plus the restricted listings shared
 * with the caller's organizations). Each card summarizes what the workflow
 * does, the price/commercial model and the current version — and links to
 * the listing detail where required access, trust facts, purchase and
 * install live. Entitlement, installation and execution authorization
 * remain distinct — a purchase is never presented as permission to run.
 *
 * HONESTY RULES (the same contract as the library):
 *   - loading / error-with-retry / successful-empty / data states are
 *     explicit; a failed read is NEVER a successful empty state;
 *   - no internal identifier (org id, user id, offer id) ever renders;
 *   - publication is never presented as verification (the trust sentence).
 */
type BrowseState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; listings: ProductListingWithRevision[] };

/** The honest publisher line: the org name when it is one of the caller's
 * own organizations (the name the caller's read provides), otherwise the
 * honest another-organization line — never an identifier. */
function publisherLine(
  publisherOrganizationId: string,
  orgs: { id: string; name: string }[],
): string {
  const own = orgs.find((org) => org.id === publisherOrganizationId);
  return own ? `Listed by your organization ${own.name}` : 'Listed by another organization';
}

export default function ExplorePage() {
  const [state, setState] = useState<BrowseState>({ kind: 'loading' });
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    marketplace
      .listListings()
      .then((listings) => {
        if (!cancelled) setState({ kind: 'data', listings });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    // The publisher-name source (best-effort): a failed orgs read never
    // fails the listings browse — the publisher line stays honest.
    organizations
      .listForUser()
      .then((found) => {
        if (!cancelled) setOrgs(found.map((o) => ({ id: o.id, name: o.name })));
      })
      .catch(() => {
        /* the honest fallback line renders without names */
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Explore</h1>
        <p className="mt-2 text-muted-foreground">
          Find workflows published for you to install, inspect, or make your own.
        </p>
      </header>

      {state.kind === 'loading' && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading listings…
        </p>
      )}

      {state.kind === 'error' && (
        <div
          role="alert"
          className="rounded-xl border border-border bg-card p-6 text-center"
        >
          <h2 className="font-medium">Listings are unavailable</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The marketplace read failed — this is not an empty result.
          </p>
          <button
            type="button"
            onClick={retry}
            className="mt-4 rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            Try again
          </button>
        </div>
      )}

      {state.kind === 'data' && state.listings.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <h2 className="font-medium">Nothing is published for you yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Published workflows will appear here for you to get and install.
          </p>
        </div>
      )}

      {state.kind === 'data' && state.listings.length > 0 && (
        <>
          <ul aria-label="Marketplace listings" className="grid gap-4 sm:grid-cols-2">
            {state.listings.map(({ listing, revision }) => (
              <li key={listing.id}>
                <Link
                  to={`/explore/${listing.id}`}
                  className="block h-full rounded-xl border border-border bg-card p-5 transition-colors hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <h2 className="font-medium">{listing.name}</h2>
                  {listing.description && (
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {listing.description}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {publisherLine(listing.publisherOrganizationId, orgs)}
                  </p>
                  <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    {revision.offers.map((offer) => (
                      <span
                        key={offer.id}
                        className="text-sm font-medium"
                      >
                        {priceLine(offer)}
                        {modelLine(offer) !== priceLine(offer) && (
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            {modelLine(offer)}
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Version {revision.pin.versionNumber}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{PUBLICATION_NOT_PROOF}</p>
        </>
      )}
    </div>
  );
}
