/**
 * WorkflowsPage — the human-facing workflow library (V2-017 Task 1 shell
 * scope).
 *
 * Workflows are the user's primary durable mental model (UX spec §5). Task 1
 * renders the library structure (the section vocabulary from the approved
 * design); the authoritative workflow reads — purpose, state, last run,
 * schedule, environment, attention — land with the library task. Nothing
 * here fabricates workflow data, and no failed read renders as an empty
 * success.
 */

const LIBRARY_VIEWS = ['My Workflows', 'Installed', 'Shared with me', 'Drafts', 'Archived'];

export default function WorkflowsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Workflows</h1>
        <p className="mt-2 text-muted-foreground">
          Your installed, shared, draft, and archived workflows live here.
        </p>
      </div>

      {/* The approved library sections. The views become interactive when
          the library task wires the authoritative reads. */}
      <div className="flex flex-wrap gap-2" aria-label="Library sections">
        {LIBRARY_VIEWS.map((view) => (
          <span
            key={view}
            className="rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground"
          >
            {view}
          </span>
        ))}
      </div>

      <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
        <h2 className="font-medium">The library presentation arrives next</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Workflow records will come from authoritative backend reads in the
          library task — until then this surface shows no data rather than
          guessed data.
        </p>
      </div>
    </div>
  );
}
