import { Link } from 'react-router-dom';

/**
 * HomePage — the universal product Home (V2-017 Task 1 shell scope).
 *
 * Home answers "What can I do right now?" (UX spec §4). Task 1 renders the
 * human-facing entry structure; the authoritative reads (recent workflows,
 * attention, approvals, version updates, device issues) land with the
 * workflow-first Home task. No data is fabricated here, and no failed read
 * is ever presented as a successful empty state.
 */
export default function HomePage() {
  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-10">
        <p className="text-sm font-medium text-muted-foreground">
          Make · Do · Learn · Share · Improve
        </p>
        <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          What do you want to get done?
        </h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Start with something you need to accomplish. WorkflowOS keeps the
          workflow, its versions, and its authoritative state behind the scenes.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            to="/create"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Create a workflow
          </Link>
          <Link
            to="/workflows"
            className="rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            See my workflows
          </Link>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3" aria-label="Where to go next">
        <Link
          to="/workflows"
          className="rounded-xl border border-border bg-card p-5 transition-colors hover:bg-accent/40"
        >
          <h2 className="font-medium">Workflows</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Pick up something you already use.
          </p>
        </Link>
        <Link
          to="/activity"
          className="rounded-xl border border-border bg-card p-5 transition-colors hover:bg-accent/40"
        >
          <h2 className="font-medium">What needs attention?</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Review recent runs, approvals, and updates.
          </p>
        </Link>
        <Link
          to="/explore"
          className="rounded-xl border border-border bg-card p-5 transition-colors hover:bg-accent/40"
        >
          <h2 className="font-medium">Explore</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Discover workflows you can install or make your own.
          </p>
        </Link>
      </section>
    </div>
  );
}
