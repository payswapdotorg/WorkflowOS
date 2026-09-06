import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  marketplace,
  organizations,
  workflowRepository,
  type ProductListing,
  type ProductListingRevision,
  type ProductVersionAccessDecision,
} from '../../api/client';
import OrganizationOnboarding from '../onboarding/OrganizationOnboarding';
import {
  basisLine,
  denialLine,
  ENTITLEMENT_BOUNDARY,
  ENTITLED_HEADLINE,
  FORK_PROMISES,
  INSTALL_NEXT,
  modelLine,
  PUBLICATION_NOT_PROOF,
  priceLine,
  updateRightsLine,
} from './marketplace-language';

/**
 * V2-017 T12 — the marketplace listing detail (Issue #7 dispatch; UX spec
 * §21/§22/§23 over the existing V2-012 + V2-002 authorities).
 *
 * The listing detail composes EXISTING authorities only:
 *   - the V2-012 listing read (current revision: the exact version pin,
 *     the offers, the frozen trust metadata) through its transport routes;
 *   - the V2-012 version-access DECISION per organization (entitlement is
 *     CONTENT access — the frozen boundary sentence renders with it);
 *   - the V2-012 offer acceptance (the purchase flow): a payment failure
 *     is an honest failure that grants nothing;
 *   - the EXISTING V2-002 install command — Install pins the EXACT listed
 *     version, through the repository's own route, never a marketplace
 *     mutation;
 *   - the EXISTING V2-002 fork command ("Make my own") with the §21
 *     disclosure: own versions, kept attribution, no private data, no
 *     secrets.
 *
 * HONESTY RULES:
 *   - loading / error / data states are explicit (a failed read is never a
 *     successful empty);
 *   - no publisher org/user identifier ever renders;
 *   - required capabilities are DISCLOSURE ("Needs access to") with the
 *     sensitive ones flagged — never grants;
 *   - publication is never presented as verification (the trust sentence).
 */

type ListingState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; listing: ProductListing; revision: ProductListingRevision };

type AccessState =
  | { kind: 'checking' }
  | { kind: 'unavailable' }
  | { kind: 'decision'; decision: ProductVersionAccessDecision };

/** Slug-derivation for the fork command (V2-002's slug vocabulary). */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default function MarketplaceListingDetail() {
  const { listingId } = useParams<{ listingId: string }>();
  const [listingState, setListingState] = useState<ListingState>({ kind: 'loading' });
  const [orgs, setOrgs] = useState<{ id: string; name: string }[] | null>(null);
  const [orgsFailed, setOrgsFailed] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [accessState, setAccessState] = useState<AccessState>({ kind: 'checking' });
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [acceptingOfferId, setAcceptingOfferId] = useState<string | null>(null);
  const [installState, setInstallState] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'error' } | { kind: 'done'; versionNumber: number }
  >({ kind: 'idle' });
  const [forkOpen, setForkOpen] = useState(false);
  const [forkName, setForkName] = useState('');
  const [forkBusy, setForkBusy] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);
  const [forkedWorkflowId, setForkedWorkflowId] = useState<string | null>(null);

  const [listingNonce, setListingNonce] = useState(0);
  const [accessNonce, setAccessNonce] = useState(0);

  // --- the listing read ------------------------------------------------------

  useEffect(() => {
    if (!listingId) return;
    let cancelled = false;
    setListingState({ kind: 'loading' });
    marketplace
      .getListing(listingId)
      .then(({ listing, revision }) => {
        if (!cancelled) setListingState({ kind: 'data', listing, revision });
      })
      .catch(() => {
        if (!cancelled) setListingState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [listingId, listingNonce]);

  // --- the organizations read (the entitlement/install/fork target) ----------

  useEffect(() => {
    let cancelled = false;
    organizations
      .listForUser()
      .then((found) => {
        if (cancelled) return;
        const mapped = found.map((o) => ({ id: o.id, name: o.name }));
        setOrgs(mapped);
        setSelectedOrgId((current) => current ?? mapped[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setOrgsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // REALITY-REPAIR-002 (F-002): when the organizations read succeeds and the
  // caller has ZERO organizations, the actionable onboarding replaces the
  // silent dead end (the perpetual "Checking your access…" with no
  // organization for the decision to resolve against). The created
  // organization — from the authoritative 201 response of the EXISTING
  // POST /organizations authority — immediately becomes the selection, so
  // the per-org access decision runs for it and the offer-accept / install /
  // fork flows become reachable: the marketplace path no longer silently
  // no-ops for a fresh signup.
  const onOrganizationCreated = useCallback(
    (created: { id: string; name: string }) => {
      setOrgs((current) =>
        current && current.some((o) => o.id === created.id)
          ? current
          : [...(current ?? []), { id: created.id, name: created.name }],
      );
      setSelectedOrgId(created.id);
      setInstallState({ kind: 'idle' });
      setForkedWorkflowId(null);
    },
    [],
  );
  const zeroOrgs = orgs !== null && orgs.length === 0;

  const revision =
    listingState.kind === 'data' ? listingState.revision : null;
  const pin = revision?.pin ?? null;

  // --- the version-access decision (per selected organization) ---------------

  const loadAccess = useCallback(() => {
    if (!listingId || !pin || !selectedOrgId) return;
    let cancelled = false;
    setAccessState({ kind: 'checking' });
    marketplace
      .checkVersionAccess(selectedOrgId, listingId, pin.versionId)
      .then((decision) => {
        if (!cancelled) setAccessState({ kind: 'decision', decision });
      })
      .catch(() => {
        if (!cancelled) setAccessState({ kind: 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, [listingId, pin, selectedOrgId]);

  useEffect(() => {
    loadAccess();
  }, [loadAccess, accessNonce]);

  const ownPublisherLine = useMemo(() => {
    if (listingState.kind !== 'data' || !orgs) return 'Listed by another organization';
    const own = orgs.find((o) => o.id === listingState.listing.publisherOrganizationId);
    return own ? `Listed by your organization ${own.name}` : 'Listed by another organization';
  }, [listingState, orgs]);

  // --- the purchase flow (offer acceptance) -----------------------------------

  const acceptOffer = useCallback(
    async (offerId: string) => {
      if (!listingId || !selectedOrgId) return;
      setAcceptingOfferId(offerId);
      setAcceptError(null);
      try {
        await marketplace.acceptOffer(listingId, offerId, selectedOrgId);
        // Re-read the authoritative decision after the purchase.
        setAccessNonce((n) => n + 1);
      } catch (err) {
        if (err instanceof ApiError && err.status === 402) {
          setAcceptError('Payment failed — no access was granted.');
        } else {
          setAcceptError("Couldn't get the workflow — try again.");
        }
      } finally {
        setAcceptingOfferId(null);
      }
    },
    [listingId, selectedOrgId],
  );

  // --- the install flow (the EXISTING V2-002 command, the EXACT pin) ----------

  const install = useCallback(async () => {
    if (!pin || !selectedOrgId) return;
    setInstallState({ kind: 'busy' });
    try {
      await workflowRepository.installVersion(selectedOrgId, pin.workflowId, pin.versionId);
      setInstallState({ kind: 'done', versionNumber: pin.versionNumber });
    } catch {
      setInstallState({ kind: 'error' });
    }
  }, [pin, selectedOrgId]);

  // --- the fork flow ("Make my own" — the EXISTING V2-002 command) -------------

  const fork = useCallback(async () => {
    if (!pin || !selectedOrgId || !forkName.trim()) return;
    setForkBusy(true);
    setForkError(null);
    try {
      const result = await workflowRepository.fork(selectedOrgId, {
        sourceWorkflowId: pin.workflowId,
        sourceVersionId: pin.versionId,
        slug: slugify(forkName) || `copy-of-${pin.workflowId}`,
        name: forkName.trim(),
      });
      setForkedWorkflowId(result.workflow.id);
    } catch {
      setForkError("Couldn't create your copy — try again.");
    } finally {
      setForkBusy(false);
    }
  }, [pin, selectedOrgId, forkName]);

  const decision =
    accessState.kind === 'decision' ? accessState.decision : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <nav aria-label="Back to Explore" className="text-sm">
        <Link
          to="/explore"
          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          ← Explore
        </Link>
      </nav>

      {listingState.kind === 'loading' && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading the listing…
        </p>
      )}

      {listingState.kind === 'error' && (
        <div role="alert" className="rounded-xl border border-border bg-card p-6 text-center">
          <h1 className="font-medium">The listing is unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The marketplace read failed — this is not an empty result.
          </p>
          <button
            type="button"
            onClick={() => setListingNonce((n) => n + 1)}
            className="mt-4 rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            Try again
          </button>
        </div>
      )}

      {listingState.kind === 'data' && revision && (
        <>
          <header>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {listingState.listing.name}
            </h1>
            {listingState.listing.description && (
              <p className="mt-2 text-muted-foreground">
                {listingState.listing.description}
              </p>
            )}
            <p className="mt-1 text-sm text-muted-foreground">{ownPublisherLine}</p>
          </header>

          {/* The §22 listing summary grid. */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* Offers (the commercial terms + the §23 boundary sentence). */}
            <section
              aria-label="Offers"
              className="rounded-xl border border-border bg-card p-5 md:col-span-2"
            >
              <h2 className="font-medium">Get this workflow</h2>
              <ul className="mt-3 space-y-3">
                {revision.offers.map((offer) => (
                  <li
                    key={offer.id}
                    className="flex flex-wrap items-baseline justify-between gap-3 rounded-lg border border-border p-3"
                  >
                    <div>
                      <p className="font-medium">
                        {priceLine(offer)}
                        {modelLine(offer) !== priceLine(offer) && (
                          <span className="ml-2 text-sm font-normal text-muted-foreground">
                            {modelLine(offer)}
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {updateRightsLine(offer)}
                      </p>
                    </div>
                    {decision?.entitled ? (
                      <span className="text-sm text-muted-foreground">Included</span>
                    ) : (
                      <button
                        type="button"
                        disabled={acceptingOfferId === offer.id}
                        onClick={() => acceptOffer(offer.id)}
                        className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
                      >
                        {acceptingOfferId === offer.id ? 'Getting…' : 'Get workflow'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {/* The frozen boundary: a purchase is never execution authorization. */}
              <p className="mt-4 text-xs text-muted-foreground">{ENTITLEMENT_BOUNDARY}</p>
              {acceptError && (
                <p role="alert" className="mt-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  {acceptError}
                </p>
              )}
            </section>

            {/* Needs access to (DISCLOSURE, never grants). */}
            <section
              aria-label="Needs access to"
              className="rounded-xl border border-border bg-card p-5"
            >
              <h2 className="font-medium">Needs access to</h2>
              {revision.trust.requiredCapabilities.length > 0 ? (
                <ul className="mt-3 space-y-1 text-sm">
                  {revision.trust.requiredCapabilities.map((capability) => (
                    <li key={capability}>
                      <span>{capability}</span>
                      {revision.trust.sensitiveCapabilities.includes(capability) && (
                        <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                          sensitive
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  No access needs are declared.
                </p>
              )}
              {revision.trust.sensitiveCapabilities.length > 0 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {revision.trust.sensitiveCapabilities.join(', ')} is sensitive — your
                  approval stays required even after you get this workflow.
                </p>
              )}
            </section>

            {/* Works with (the placement facts). */}
            <section aria-label="Works with" className="rounded-xl border border-border bg-card p-5">
              <h2 className="font-medium">Works with</h2>
              {revision.trust.placements.length > 0 ? (
                <ul className="mt-3 space-y-1 text-sm">
                  {revision.trust.placements.map((placement) => (
                    <li key={placement}>{placement}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  No placement needs are declared.
                </p>
              )}
            </section>
          </div>

          {/* Version + trust (publication is never proof). */}
          <section aria-label="Version and trust" className="rounded-xl border border-border bg-card p-5">
            <h2 className="font-medium">Version {revision.pin.versionNumber}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The listing pins this exact version — immutable, with its own digest.
            </p>
            <p className="mt-3 text-xs text-muted-foreground">{PUBLICATION_NOT_PROOF}</p>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-muted-foreground">
                Advanced verification facts
              </summary>
              <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
                <div className="flex gap-2">
                  <dt className="shrink-0">Content digest</dt>
                  <dd className="break-all">{revision.trust.contentDigest}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0">Semantic digest</dt>
                  <dd className="break-all">{revision.trust.semanticDigest}</dd>
                </div>
                {revision.trust.provenance.forkedFromWorkflowId && (
                  <div className="flex gap-2">
                    <dt className="shrink-0">Forked lineage</dt>
                    <dd>Kept from the original workflow (attribution preserved)</dd>
                  </div>
                )}
              </dl>
            </details>
          </section>

          {/* Your access (the §23 entitlement → install flow). */}
          <section
            aria-label="Your access"
            className="rounded-xl border border-border bg-card p-5"
          >
            <h2 className="font-medium">Your access</h2>
            {/* The organization context (entitlement is per organization). */}
            {orgsFailed && (
              <p className="mt-2 text-sm text-muted-foreground">
                Your organizations are unavailable right now.
              </p>
            )}
            {/* REALITY-REPAIR-002 (F-002): the zero-org actionable state — the
                fresh-signup onboarding (existing POST /organizations
                authority) instead of the silent dead end. */}
            {zeroOrgs && (
              <div className="mt-3">
                <OrganizationOnboarding onCreated={onOrganizationCreated} />
              </div>
            )}
            {orgs && orgs.length > 1 && (
              <div className="mt-3">
                <label
                  htmlFor="listing-org-select"
                  className="block text-sm text-muted-foreground"
                >
                  For organization
                </label>
                <select
                  id="listing-org-select"
                  value={selectedOrgId ?? ''}
                  onChange={(event) => {
                    setSelectedOrgId(event.target.value);
                    setInstallState({ kind: 'idle' });
                    setForkedWorkflowId(null);
                  }}
                  className="mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  {orgs.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="mt-3">
              {/* With ZERO organizations the per-org decision can never
                  resolve — the onboarding above is the actionable state, so
                  the perpetual "checking" line is suppressed (F-002). */}
              {accessState.kind === 'checking' && !zeroOrgs && (
                <p role="status" className="text-sm text-muted-foreground">
                  Checking your access…
                </p>
              )}
              {accessState.kind === 'unavailable' && (
                <div>
                  <p className="text-sm text-muted-foreground">
                    Access facts unavailable — the decision read failed.
                  </p>
                  <button
                    type="button"
                    onClick={() => setAccessNonce((n) => n + 1)}
                    className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
                  >
                    Try again
                  </button>
                </div>
              )}
              {decision && !decision.entitled && (
                <p className="text-sm">{denialLine(decision.reason)}</p>
              )}
              {decision?.entitled && (
                <div className="space-y-2">
                  <p className="font-medium">{ENTITLED_HEADLINE}</p>
                  <p className="text-sm text-muted-foreground">{basisLine(decision)}</p>
                  {installState.kind === 'done' ? (
                    <div className="rounded-lg border border-border bg-accent/30 p-3">
                      <p className="text-sm font-medium">
                        Installed — pinned to version {installState.versionNumber}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Running it stays a separate decision — nothing executes until you
                        start it and your access and approvals allow it.
                      </p>
                      <Link
                        to={`/workflows/${revision.pin.workflowId}`}
                        className="mt-2 inline-block text-sm underline-offset-4 hover:underline"
                      >
                        Open in your Workflows library
                      </Link>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">
                        {INSTALL_NEXT(revision.pin.versionNumber)}
                      </p>
                      <button
                        type="button"
                        disabled={installState.kind === 'busy'}
                        onClick={install}
                        className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
                      >
                        {installState.kind === 'busy' ? 'Installing…' : 'Install'}
                      </button>
                      {installState.kind === 'error' && (
                        <p role="alert" className="text-sm text-destructive">
                          Install failed — try again.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Make my own (the §21 fork flow over the EXISTING V2-002 command). */}
          <section aria-label="Make my own" className="rounded-xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-medium">Make my own</h2>
              <button
                type="button"
                onClick={() => setForkOpen((v) => !v)}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
              >
                {forkOpen ? 'Close' : 'Make it my own'}
              </button>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Create your own copy of this workflow — the §21 disclosure applies.
            </p>
            {forkOpen && (
              <div className="mt-3 space-y-3">
                <ul aria-label="What a copy inherits" className="list-none space-y-1 text-sm">
                  {FORK_PROMISES.map((promise) => (
                    <li key={promise} className="flex items-start gap-2">
                      <span aria-hidden className="mt-0.5">✓</span>
                      <span>{promise}</span>
                    </li>
                  ))}
                </ul>
                {forkedWorkflowId ? (
                  <Link
                    to={`/workflows/${forkedWorkflowId}`}
                    className="inline-block rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
                  >
                    Open your copy
                  </Link>
                ) : (
                  <div className="space-y-2">
                    <label
                      htmlFor="fork-copy-name"
                      className="block text-sm text-muted-foreground"
                    >
                      Name your copy
                    </label>
                    <input
                      id="fork-copy-name"
                      value={forkName}
                      onChange={(event) => setForkName(event.target.value)}
                      placeholder="My social report"
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    />
                    <button
                      type="button"
                      disabled={forkBusy || !forkName.trim()}
                      onClick={fork}
                      className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
                    >
                      {forkBusy ? 'Creating…' : 'Create copy'}
                    </button>
                    {forkError && (
                      <p role="alert" className="text-sm text-destructive">
                        {forkError}
                      </p>
                    )}
                    {!selectedOrgId && (
                      <p className="text-sm text-muted-foreground">
                        Your organization is needed to create the copy.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
