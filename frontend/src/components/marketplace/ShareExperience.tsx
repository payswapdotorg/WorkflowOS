import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  marketplace,
  workflowRepository,
  type ProductWorkflow,
  type ProductWorkflowVersion,
} from '../../api/client';
import {
  ENTITLEMENT_BOUNDARY,
  FORK_PROMISES,
} from './marketplace-language';

/**
 * V2-017 T12 — the Share experience (Issue #7 dispatch; UX spec §21/§22
 * over the existing V2-002 + V2-012 authorities).
 *
 * Share composes EXISTING authorities only:
 *   - the V2-002 visibility facts + the EXISTING owner visibility command
 *     (a private workflow must become public before it can be listed — the
 *     V2-012 publish precondition, surfaced honestly);
 *   - the V2-012 listing creation + publication through its transport
 *     routes: creation pins the EXACT head version (immutable-version
 *     semantics — no floating listing) and converges on the publisher
 *     workflow (a duplicate share is "already listed", never a second
 *     listing);
 *   - the §21 fork disclosure ("Make my own" happens on the listing
 *     detail — the promises are disclosed here too).
 *
 * HONESTY RULES:
 *   - the entitlement boundary sentence renders with the published state
 *     (a listing is access, never execution authorization);
 *   - a publish failure renders as an honest error — never a fabricated
 *     published state;
 *   - without a head version, the pin is disclosed as unavailable (no
 *     floating listing).
 */

interface ShareExperienceProps {
  workflow: ProductWorkflow;
  /** The workflow's head version (the EXACT pin a listing would create). */
  headVersion: ProductWorkflowVersion | null;
  /** Re-run the page's authoritative reads after a visibility change. */
  onRefresh: () => void;
}

type PublishedState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'published'; listingId: string; alreadyListed: boolean }
  | { kind: 'error' };

/** Normalizes a typed price to a decimal string ("19" → "19.00"). */
function normalizeAmount(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  return `${whole}.${(fraction + '00').slice(0, 2)}`;
}

export default function ShareExperience({
  workflow,
  headVersion,
  onRefresh,
}: ShareExperienceProps) {
  // The local visibility override: the V2-002 PATCH response is
  // authoritative, and the parent re-reads; the override keeps this
  // surface honest while the parent refresh lands.
  const [localVisibility, setLocalVisibility] = useState<string | null>(null);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [visibilityError, setVisibilityError] = useState(false);

  const [listingName, setListingName] = useState(workflow.name);
  const [listingDescription, setListingDescription] = useState(
    workflow.description ?? '',
  );
  const [freeSelected, setFreeSelected] = useState(false);
  const [oneTimeAmount, setOneTimeAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [updatePolicy, setUpdatePolicy] = useState<'pinned_only' | 'compatible_updates'>(
    'pinned_only',
  );
  const [maintenanceAmount, setMaintenanceAmount] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [publishedState, setPublishedState] = useState<PublishedState>({ kind: 'idle' });

  const visibility = localVisibility ?? workflow.visibility;

  const visibilityLine = useMemo(() => {
    if (visibility === 'private') return 'Private — only you';
    if (visibility === 'organization') return 'Shared with your organization';
    return 'Public — any signed-in user';
  }, [visibility]);

  /** Make the workflow public through the EXISTING V2-002 owner command. */
  const makePublic = async () => {
    setVisibilityBusy(true);
    setVisibilityError(false);
    try {
      const updated = await workflowRepository.update(workflow.id, {
        visibility: 'public',
      });
      setLocalVisibility(updated.visibility);
      onRefresh();
    } catch {
      setVisibilityError(true);
    } finally {
      setVisibilityBusy(false);
    }
  };

  /** Publish the listing: create (converge) + publish, over V2-012. */
  const publish = async () => {
    if (!headVersion) return;
    setFormError(null);

    // Compose the offers from the publisher's choices (at least one).
    const offers: {
      model: 'free' | 'one_time_purchase' | 'maintenance_subscription';
      terms: Record<string, unknown>;
    }[] = [];
    if (freeSelected) {
      offers.push({ model: 'free', terms: { model: 'free' } });
    }
    const oneTime = normalizeAmount(oneTimeAmount);
    if (oneTimeAmount.trim() !== '') {
      if (!oneTime) {
        setFormError('Enter the one-time price as an amount, like 19 or 19.50.');
        return;
      }
      offers.push({
        model: 'one_time_purchase',
        terms: {
          model: 'one_time_purchase',
          amount: oneTime,
          currency,
          updatePolicy,
        },
      });
    }
    const maintenance = normalizeAmount(maintenanceAmount);
    if (maintenanceAmount.trim() !== '') {
      if (!maintenance) {
        setFormError('Enter the maintenance price as an amount, like 5 or 5.50.');
        return;
      }
      offers.push({
        model: 'maintenance_subscription',
        terms: { model: 'maintenance_subscription', amount: maintenance, currency },
      });
    }
    if (offers.length === 0) {
      setFormError('Choose at least one way for people to get it — free or priced.');
      return;
    }

    setPublishedState({ kind: 'busy' });
    try {
      const created = await marketplace.createListing({
        organizationId: workflow.organizationId,
        workflowId: workflow.id,
        versionId: headVersion.id,
        name: listingName.trim() || workflow.name,
        description: listingDescription.trim() || null,
        offers: offers as never,
      });
      await marketplace.publishListing(created.listing.id);
      setPublishedState({
        kind: 'published',
        listingId: created.listing.id,
        alreadyListed: !created.created,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setFormError(
          'Publishing needs the workflow to be public — make it public first.',
        );
        setPublishedState({ kind: 'idle' });
        return;
      }
      setPublishedState({ kind: 'error' });
    }
  };

  return (
    <section
      aria-label="Share"
      className="rounded-xl border border-border bg-card p-5"
    >
      <h2 className="font-medium">Share</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Let others use this workflow — install it from Explore, or make their
        own copy.
      </p>

      {/* Who can use or edit it today (V2-002 visibility facts). */}
      <p className="mt-3 text-sm">{visibilityLine}</p>

      {visibility === 'private' && (
        <div className="mt-3 rounded-lg border border-border p-4">
          <p className="text-sm text-muted-foreground">
            Publishing to Explore requires this workflow to be public.
          </p>
          <button
            type="button"
            disabled={visibilityBusy}
            onClick={makePublic}
            className="mt-3 rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            {visibilityBusy ? 'Making public…' : 'Make it public'}
          </button>
          {visibilityError && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              Couldn't make the workflow public — you may not own it, or the
              command failed. Try again.
            </p>
          )}
        </div>
      )}

      {/* What a copy does and does not inherit (§21, verbatim). */}
      <div className="mt-4">
        <p className="text-sm text-muted-foreground">When someone makes it their own, their copy will:</p>
        <ul aria-label="What a copy inherits" className="mt-2 list-none space-y-1 text-sm">
          {FORK_PROMISES.map((promise) => (
            <li key={promise} className="flex items-start gap-2">
              <span aria-hidden className="mt-0.5">✓</span>
              <span>{promise}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* The publish surface (public workflows with a head version). */}
      {visibility !== 'private' && !headVersion && (
        <p className="mt-4 text-sm text-muted-foreground">
          Version facts unavailable — the listing needs an exact version to
          pin, and the head version isn’t readable right now.
        </p>
      )}

      {visibility !== 'private' && headVersion && publishedState.kind !== 'published' && (
        <div className="mt-4 space-y-3 rounded-lg border border-border p-4">
          <p className="text-sm font-medium">Publish to Explore</p>
          <p className="text-xs text-muted-foreground">
            The listing pins version {headVersion.versionNumber} exactly — a
            later update is a new listing revision, never a silent change.
          </p>
          <div>
            <label htmlFor="share-listing-name" className="block text-sm text-muted-foreground">
              Listing name
            </label>
            <input
              id="share-listing-name"
              value={listingName}
              onChange={(event) => setListingName(event.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="share-listing-description" className="block text-sm text-muted-foreground">
              Description
            </label>
            <textarea
              id="share-listing-description"
              value={listingDescription}
              onChange={(event) => setListingDescription(event.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>

          {/* Pricing: the three frozen commercial models. */}
          <fieldset className="space-y-3">
            <legend className="text-sm text-muted-foreground">How people get it</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={freeSelected}
                onChange={(event) => setFreeSelected(event.target.checked)}
              />
              Free
            </label>
            <div>
              <label
                htmlFor="share-one-time-price"
                className="block text-sm text-muted-foreground"
              >
                One-time price (optional)
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="share-one-time-price"
                  value={oneTimeAmount}
                  onChange={(event) => setOneTimeAmount(event.target.value)}
                  placeholder="19"
                  inputMode="decimal"
                  className="w-24 rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
                <label htmlFor="share-currency" className="sr-only">
                  Currency
                </label>
                <select
                  id="share-currency"
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value)}
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
                <label htmlFor="share-update-policy" className="sr-only">
                  Included versions
                </label>
                <select
                  id="share-update-policy"
                  value={updatePolicy}
                  onChange={(event) =>
                    setUpdatePolicy(event.target.value as 'pinned_only' | 'compatible_updates')
                  }
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="pinned_only">Pins this version</option>
                  <option value="compatible_updates">Includes compatible updates</option>
                </select>
              </div>
            </div>
            <div>
              <label
                htmlFor="share-maintenance-price"
                className="block text-sm text-muted-foreground"
              >
                Maintenance price per month (optional)
              </label>
              <input
                id="share-maintenance-price"
                value={maintenanceAmount}
                onChange={(event) => setMaintenanceAmount(event.target.value)}
                placeholder="5"
                inputMode="decimal"
                className="mt-1 w-24 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
          </fieldset>

          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}

          <button
            type="button"
            disabled={publishedState.kind === 'busy'}
            onClick={publish}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            {publishedState.kind === 'busy' ? 'Publishing…' : 'Publish to Explore'}
          </button>
          {publishedState.kind === 'error' && (
            <p role="alert" className="text-sm text-destructive">
              Couldn't publish — the marketplace command failed. Try again.
            </p>
          )}
        </div>
      )}

      {/* The published state: the listing link + the boundary sentence. */}
      {publishedState.kind === 'published' && (
        <div className="mt-4 space-y-2 rounded-lg border border-border bg-accent/30 p-4">
          <p className="text-sm font-medium">
            {publishedState.alreadyListed
              ? 'This workflow is already listed.'
              : 'Published to Explore.'}
          </p>
          <Link
            to={`/explore/${publishedState.listingId}`}
            className="inline-block text-sm underline-offset-4 hover:underline"
          >
            View on Explore
          </Link>
          <p className="text-xs text-muted-foreground">
            Anyone signed in can get it from Explore.
          </p>
          <p className="text-xs text-muted-foreground">{ENTITLEMENT_BOUNDARY}</p>
        </div>
      )}
    </section>
  );
}
