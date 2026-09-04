import { Link, useSearchParams } from 'react-router-dom';

/**
 * CreatePage — the universal creation entry (V2-017 T1 shell scope, T2
 * entry-point landing).
 *
 * Creation starts from the goal, not from workflow primitives (UX spec §7).
 * Home's entry points navigate here with the chosen mode (tell / show /
 * tell-show) and the typed goal (q): the matching entry mode is marked
 * active and the goal is shown as the starting context. The actual flows
 * land with the creation task and reuse the existing authoring
 * authorities: conversation is an input mechanism, never a second durable
 * workflow representation.
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

export default function CreatePage() {
  const [params] = useSearchParams();
  const modeParam = params.get('mode');
  const goal = params.get('q');
  const activeMode: EntryModeKey | null =
    modeParam === 'tell' || modeParam === 'show' || modeParam === 'tell-show'
      ? modeParam
      : null;

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

      {goal && (
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Starting from your goal</p>
          <p className="mt-1 text-sm font-medium">{goal}</p>
        </div>
      )}

      {/* The approved entry modes; the flows become active in the creation
          task. The mode chosen on Home is marked active. */}
      <ul
        role="list"
        aria-label="Creation entry modes"
        className="grid gap-3 sm:grid-cols-3"
      >
        {ENTRY_MODES.map(({ key, label, description }) => {
          const active = activeMode === key;
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
              <div className="font-medium">{label}</div>
              <p className="mt-2 text-sm text-muted-foreground">{description}</p>
            </li>
          );
        })}
      </ul>

      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-medium">Understanding before commitment</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The creation flow will show its understanding and allow correction
          before any durable workflow change is committed.
        </p>
      </div>

      <Link
        to="/workflows"
        className="inline-flex rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
      >
        Back to my workflows
      </Link>
    </div>
  );
}
