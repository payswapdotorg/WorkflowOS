import { Link } from 'react-router-dom';

/**
 * CreatePage — the universal creation entry (V2-017 Task 1 shell scope).
 *
 * Creation starts from the goal, not from workflow primitives (UX spec §7).
 * The three approved entry modes — Tell / Show / Tell + Show — are presented
 * as the creation vocabulary. The actual flows land with the creation task
 * and reuse the existing authoring authorities: conversation is an input
 * mechanism, never a second durable workflow representation.
 */

const ENTRY_MODES = [
  { mode: 'Tell', description: 'Describe what you want done in your own words.' },
  { mode: 'Show', description: 'Demonstrate the task once while WorkflowOS records provenance.' },
  { mode: 'Tell + Show', description: 'Combine a description with a demonstration.' },
];

export default function CreatePage() {
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

      {/* The approved entry modes; the flows become active in the creation
          task. */}
      <div className="grid gap-3 sm:grid-cols-3" aria-label="Creation entry modes">
        {ENTRY_MODES.map(({ mode, description }) => (
          <div key={mode} className="rounded-xl border border-border bg-card p-5">
            <div className="font-medium">{mode}</div>
            <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          </div>
        ))}
      </div>

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
