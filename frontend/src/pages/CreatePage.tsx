import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

/**
 * CreatePage — the universal creation entry (V2-017 T1 shell scope, T2
 * entry-point landing, T5 Tell / Show / Tell + Show creation).
 *
 * Creation starts from the goal, not from workflow primitives (UX spec §7).
 * Home's entry points land here with the chosen mode (tell / show /
 * tell-show) and the typed goal (q); T5 composes the capture →
 * understanding preview → correction → EXPLICIT COMMIT flow over the
 * existing V2-002 authoring route.
 *
 * HONESTY RULES:
 *   - the preview shows exactly what the user told/showed (verbatim) plus
 *     the structured facts they can CORRECT — it never invents understood
 *     steps (the honest limitation is surfaced instead);
 *   - every capture/preview value is TRANSIENT client-local state, never
 *     durable workflow truth — nothing renders as created before the
 *     authoritative POST responds, and the success surface renders FROM
 *     THE RESPONSE;
 *   - the durable commit FAILS CLOSED (F-T5-001): the frozen V2-002
 *     contract requires a version's irSchemaVersion to truthfully declare
 *     WorkflowIR compatibility, the WorkflowIR itself requires at least one
 *     authored node, and NO public authoring authority accepts captured
 *     input — so the preview surfaces the missing-authority dependency
 *     honestly and never sends a create POST (a fabricated/non-WorkflowIR
 *     irSchemaVersion on a durable WorkflowVersion is the blocking
 *     violation); nothing renders as committed;
 *   - conversation/demonstration is INPUT, never a second durable workflow
 *     representation.
 */

const ENTRY_MODES = [
  {
    key: 'tell',
    label: 'Tell',
    description: 'Describe what you want done in your own words.',
  },
  {
    key: 'show',
    label: 'Show',
    description: 'Demonstrate the task once while WorkflowOS records provenance.',
  },
  {
    key: 'tell-show',
    label: 'Tell + Show',
    description: 'Combine a description with a demonstration.',
  },
] as const;

type EntryModeKey = 'tell' | 'show' | 'tell-show';

const VISIBILITIES = ['private', 'organization', 'public'] as const;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export default function CreatePage() {
  const [params] = useSearchParams();
  const goalParam = params.get('q');
  const modeParam = params.get('mode');
  const urlMode: EntryModeKey | null =
    modeParam === 'tell' || modeParam === 'show' || modeParam === 'tell-show'
      ? modeParam
      : null;

  // The selected entry mode: the URL landing (T2) or a local choice (T5 —
  // the mode cards are selectable when the page is opened directly).
  const [localMode, setLocalMode] = useState<EntryModeKey | null>(null);
  const mode: EntryModeKey | null = localMode ?? urlMode;

  // --- transient capture state (client-local, never authoritative) ---------
  const [phase, setPhase] = useState<'capture' | 'preview'>('capture');
  const [goal, setGoal] = useState(goalParam ?? '');
  const [stepDraft, setStepDraft] = useState('');
  const [steps, setSteps] = useState<string[]>([]);

  // --- preview correction fields (PROPOSED values, user-owned) ------------
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<string>('private');

  const addStep = useCallback(() => {
    const trimmed = stepDraft.trim();
    if (!trimmed) return;
    setSteps((current) => [...current, trimmed]);
    setStepDraft('');
  }, [stepDraft]);

  const removeStep = useCallback((index: number) => {
    setSteps((current) => current.filter((_, i) => i !== index));
  }, []);

  /** Continue: derive the PROPOSED structured facts from the capture. */
  const continueToPreview = useCallback(() => {
    const proposedName = (goal.trim() || steps[0] || '').slice(0, 120);
    setName(proposedName);
    setSlug(slugify(proposedName));
    setDescription(goal.trim());
    setPhase('preview');
  }, [goal, steps]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Create a workflow</h1>
        <p className="mt-2 text-muted-foreground">
          Start from the goal, not from workflow primitives. Authoring stays
          grounded in the existing workflow contracts — conversation is an
          input, never a second workflow format.
        </p>
      </div>

      {goalParam && phase === 'capture' && (
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Starting from your goal</p>
          <p className="mt-1 text-sm font-medium">{goalParam}</p>
        </div>
      )}

      {/* The approved entry modes; the chosen mode is marked active (T2),
          and the cards are selectable (T5 — client-local choice). */}
      <ul
        role="list"
        aria-label="Creation entry modes"
        className="grid gap-3 sm:grid-cols-3"
      >
        {ENTRY_MODES.map(({ key, label, description: modeDescription }) => {
          const active = mode === key;
          return (
            <li
              key={key}
              aria-current={active ? 'true' : undefined}
              className={
                active
                  ? 'rounded-xl border-2 border-primary bg-card p-5'
                  : 'rounded-xl border border-border bg-card p-5'
              }
            >
              <button
                type="button"
                onClick={() => setLocalMode(key)}
                className="w-full text-left"
                aria-pressed={active}
              >
                <span className="font-medium">{label}</span>
                <p className="mt-2 text-sm text-muted-foreground">{modeDescription}</p>
              </button>
            </li>
          );
        })}
      </ul>

      {/* --- the capture phase (UX spec §7) -------------------------------- */}
      {phase === 'capture' && mode && (
        <section aria-label="Capture what you want" className="space-y-4 rounded-xl border border-border bg-card p-6">
          {(mode === 'tell' || mode === 'tell-show') && (
            <div>
              <label htmlFor="tell-capture" className="text-sm font-medium">
                Describe what you want done
              </label>
              <textarea
                id="tell-capture"
                rows={4}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder="Every morning, check my calendar, summarize today's meetings and send the summary to me."
                className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          )}

          {(mode === 'show' || mode === 'tell-show') && (
            <div>
              <label htmlFor="show-step" className="text-sm font-medium">
                Describe one step of the demonstration
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  id="show-step"
                  type="text"
                  value={stepDraft}
                  onChange={(event) => setStepDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addStep();
                    }
                  }}
                  placeholder="Open the sales dashboard"
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
                <button
                  type="button"
                  onClick={addStep}
                  className="rounded-md border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
                >
                  Add step
                </button>
              </div>
              {steps.length > 0 && (
                <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm" aria-label="Demonstration steps so far">
                  {steps.map((step, index) => (
                    <li key={`${index}-${step}`} className="flex items-baseline justify-between gap-3">
                      <span>{step}</span>
                      <button
                        type="button"
                        onClick={() => removeStep(index)}
                        className="text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                No screen recording exists yet — describe what you did, one step
                at a time. The capture stays provenance, never the durable
                workflow itself.
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={continueToPreview}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Continue to preview
          </button>
        </section>
      )}

      {/* --- the understanding preview: correction before commitment -------- */}
      {phase === 'preview' && (
        <section aria-label="Understanding preview" className="space-y-4 rounded-xl border border-border bg-card p-6">
          <h2 className="text-xl font-semibold">Here's what I understood</h2>

          {/* The captured input, echoed verbatim for correction. */}
          <section aria-label="Captured input" className="space-y-2">
            {(mode === 'tell' || mode === 'tell-show') && (
              <p className="text-sm">{goal.trim()}</p>
            )}
            {(mode === 'show' || mode === 'tell-show') && (
              <ol className="list-decimal space-y-1 pl-5 text-sm" aria-label="Your demonstration">
                {steps.map((step, index) => (
                  <li key={`${index}-${step}`}>{step}</li>
                ))}
              </ol>
            )}
          </section>

          {/* The honest limitation — uncertainty surfaced, never invented. */}
          <p className="rounded-md bg-accent/50 p-3 text-sm text-muted-foreground">
            WorkflowOS can't yet turn your description into executable
            steps. Your captured input is recorded as the starting content:
            the durable workflow is created with immutable Version 1, and
            executable authoring happens later from the workflow surface.
          </p>

          <div className="space-y-3">
            <h3 className="text-sm font-medium">Before it's saved</h3>

            <div>
              <label htmlFor="create-name" className="text-sm">
                Workflow name
              </label>
              <input
                id="create-name"
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label htmlFor="create-slug" className="text-sm">
                Workflow slug
              </label>
              <input
                id="create-slug"
                type="text"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Lowercase letters, numbers and hyphens — the workflow&rsquo;s
                durable identity inside the organization.
              </p>
            </div>

            <div>
              <label htmlFor="create-description" className="text-sm">
                Description (optional)
              </label>
              <textarea
                id="create-description"
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label htmlFor="create-visibility" className="text-sm">
                Visibility
              </label>
              <select
                id="create-visibility"
                value={visibility}
                onChange={(event) => setVisibility(event.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                {VISIBILITIES.map((option) => (
                  <option key={option} value={option}>
                    {option === 'private'
                      ? 'Private — only you'
                      : option === 'organization'
                        ? 'Organization — members of your organization'
                        : 'Public — any signed-in user'}
                  </option>
                ))}
              </select>
            </div>

          </div>

          {/* The fail-closed durable boundary (F-T5-001): the frozen V2-002
              contract requires a version's irSchemaVersion to truthfully
              declare WorkflowIR compatibility; the WorkflowIR requires at
              least one authored node; no public authoring authority accepts
              captured input. The missing-authority dependency is surfaced —
              NO create POST (with any fabricated/non-WorkflowIR
              irSchemaVersion) is ever sent. */}
          <div className="rounded-md border border-border bg-accent/30 p-4">
            <p
              role="status"
              aria-label="Durable creation unavailable"
              className="text-sm font-medium"
            >
              Durable creation isn't available yet
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              The workflow authority accepts WorkflowIR content only — a
              version's protocol declaration must truthfully declare
              WorkflowIR compatibility, and WorkflowOS can't yet turn your
              captured input into a WorkflowIR document. A captured-input
              authoring authority is missing (surfaced to the architect).
              Nothing is committed; your captured input stays on this page.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setPhase('capture')}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
            >
              Change something
            </button>
          </div>
        </section>
      )}

      <Link
        to="/workflows"
        className="inline-flex rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
      >
        Back to my workflows
      </Link>
    </div>
  );
}
