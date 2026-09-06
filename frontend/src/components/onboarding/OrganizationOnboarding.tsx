import { useState } from 'react';
import { organizations } from '../../api/client';

/**
 * REALITY-REPAIR-002 — the first-run organization onboarding card (F-002).
 *
 * Governing Work Order: spec/architecture/v2/work-orders/REALITY-REPAIR-002.md
 * (parent gate V2-REALITY-AUDIT-001, Architect disposition F-002 ACCEPT).
 *
 * The audit's release blocker: a fresh signup reached the product shell with
 * ZERO organizations while every org-scoped product action silently no-oped
 * — the UI never created or selected the organization those actions are
 * scoped to. This card is the smallest valid repair: an EXPLICIT user-facing
 * creation step consuming the EXISTING `POST /organizations` authority
 * (authenticated humans; the creator becomes its `owner`). Server-side
 * auto-provisioning was deliberately NOT chosen — it would have introduced
 * new ownership/naming semantics into the backend; explicit creation
 * introduces none.
 *
 * Boundary discipline:
 *   - the card does NOT read the organization collection — the mounting
 *     surface owns the zero-org condition (no second read, no client-side
 *     authority over which organizations exist);
 *   - it never fabricates an organization: `onCreated` receives the
 *     authoritative 201 response record verbatim;
 *   - honest failure only — a failed create renders a visible error with the
 *     form still retryable, never a silent no-op (the defect being repaired);
 *   - `POST /organizations` is the ONLY command it composes.
 */
export interface CreatedOrganization {
  id: string;
  name: string;
}

export default function OrganizationOnboarding({
  onCreated,
}: {
  /** The mounting surface's callback: receives the AUTHORITATIVE created
   *  record (from the 201 response) and re-scopes its own reads/selection. */
  onCreated: (organization: CreatedOrganization) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { organization } = await organizations.create(trimmed);
      // The authoritative record — handed onward verbatim; the parent then
      // refetches/establishes its selection from the real response facts.
      onCreated({ id: organization.id, name: organization.name });
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? `Couldn’t create your organization — ${err.message}. Try again.`
          : 'Couldn’t create your organization — try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Organization onboarding"
      className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8"
    >
      <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
        Set up your organization
      </h2>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        The workflows you install and buy belong to an organization — create
        your first one to get started. You’ll be its owner.
      </p>
      <form onSubmit={submit} className="mt-4 flex max-w-xl flex-col gap-2 sm:flex-row">
        <label htmlFor="organization-name" className="sr-only">
          Organization name
        </label>
        <input
          id="organization-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Your organization’s name"
          disabled={busy}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || !trimmed}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create organization'}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
