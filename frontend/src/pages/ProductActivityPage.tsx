/**
 * ProductActivityPage — the universal activity timeline (V2-017 Task 1 shell
 * scope).
 *
 * Activity is the universal timeline for executions, approvals, updates,
 * device events, and relevant workflow changes (UX spec §16). Task 1 renders
 * the surface identity only; the timeline and its filters land with the
 * activity task. Completed work, failures, and unavailable reads stay
 * visually distinct — a failed read is never presented as "nothing
 * happened".
 */
export default function ProductActivityPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-2 text-muted-foreground">
          See runs, approvals, updates, and device events as they become
          available.
        </p>
      </div>

      <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
        <h2 className="font-medium">The timeline arrives with the activity task</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Activity records will distinguish completed work, failures, and
          unavailable reads instead of treating them as empty data.
        </p>
      </div>
    </div>
  );
}
