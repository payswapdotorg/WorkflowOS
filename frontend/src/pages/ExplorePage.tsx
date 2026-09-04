/**
 * ExplorePage — marketplace discovery surface (V2-017 Task 1 shell scope).
 *
 * Explore presents workflows published for installation, inspection, or
 * "make my own" (UX spec §22). Task 1 renders the surface identity only;
 * listings, provenance, and install actions compose over the existing
 * marketplace authorities in the sharing/marketplace task. Entitlement,
 * installation, and execution authorization remain distinct — a purchase is
 * never presented as permission to run.
 */
export default function ExplorePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Explore</h1>
        <p className="mt-2 text-muted-foreground">
          Find workflows published for you to install, inspect, or make your own.
        </p>
      </div>

      <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
        <h2 className="font-medium">Discovery arrives with the marketplace task</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Listings, publisher identity, required access, and install actions
          will be composed over their existing authorities.
        </p>
      </div>
    </div>
  );
}
