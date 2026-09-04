import { Link } from 'react-router-dom';

/**
 * ExpertPage — the intentional entry to the developer/engineering workspace
 * (V2-017 Task 1; T13 — the explicit mode crossing).
 *
 * The existing engineering control surface is re-contextualized as an expert
 * workspace, not deleted (work-order rule 8). This page is the progressive
 * disclosure step from the product shell (INSPECT level) to the existing
 * project-scoped controls: workbench, architecture, requirements, work
 * items, benchmarks, and settings. The expert surface remains a consumer of
 * backend authorities — it introduces no second workflow, execution, or
 * evidence authority.
 *
 * T13: the crossing is EXPLICIT — the page names the mode transition
 * ("you're leaving the consumer workflow UX for the advanced workspace"),
 * and the transition target (/projects) labels the expert mode and carries
 * the return path. Never a silent product-mode switch.
 */
export default function ExpertPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Expert workspace</h1>
        <p className="mt-2 text-muted-foreground">
          The engineering and architecture controls remain available as a
          deeper workspace — re-contextualized, not deleted.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-medium">Developer workspace</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Open the project list to reach the workbench, architecture,
          requirements, work items, benchmarks, and the other engineering
          controls.
        </p>
        {/* V2-017 T13 — the explicit mode crossing: never a silent product
            switch. The landing names the transition and carries the return
            path. */}
        <p className="mt-2 text-sm font-medium text-muted-foreground">
          You're leaving the consumer workflow UX for the advanced workspace —
          the project list opens with the engineering controls and a way back.
        </p>
        <Link
          to="/projects"
          className="mt-5 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Open developer workspace
        </Link>
      </div>

      <p className="text-xs text-muted-foreground">
        The expert surface is a consumer of the existing backend authorities —
        it introduces no second workflow, execution, or evidence authority.
      </p>
    </div>
  );
}
