# WORK-049 — Project Health and Maintenance UX

Status: IN FLIGHT — on branch `feat/work-049-project-health-maintenance-ux` (off
main@5c48257 — the merged WORK-048, whose post-merge finalization §34.8/ADR-0007
is carried by this same change). Derived from the architect's authorization; this
document is the governing work order.
Architecture: frozen v1.0 authority model (the health UX is a CONSUMER of existing
authorities, never an authority itself)
Dependencies: WORK-041 (maintenance and project health engine), WORK-048
(Developer Workbench — the engineering workspace this extends). Consumes the
public contracts the Workbench already loads: the maintenance authority
(`/maintenance/health`, `/maintenance/signals` — version-scoped), the
verification authority, the work graph read model (WORK-048), the runtime
authority (`/runtime`, `/runtime/deployments`), the execution records, and the
planner authority.

## Objective

The Workbench is already authoritative for the project engineering workspace.
WORK-049 extends that experience to surface maintenance and health information
using the EXISTING backend authorities. The UX answers, without requiring the
developer to navigate unrelated subsystems:

```text
What is unhealthy?          Why?
How severe is it?           What evidence supports the finding?
What maintenance work exists?  What should happen next?
```

The health view makes emerging maintenance legible at a glance: findings are
derived from authoritative facts, severity comes from the authority's own
values, every finding links to its evidence, maintenance work links to the
authoritative Work Items, and the next step is the existing governed path
(the Work Item page / the workflow), never a frontend-invented action.

## The non-negotiable architectural rule

**The frontend MUST NOT become a health authority.** The health UX is a
read-model presentation over the SAME authoritative responses the Workbench
already loads:

```text
Backend authorities → API/read models → Workbench (WORK-048) → Health view
```

The frontend must NOT create:

- a second maintenance engine;
- a second project-health authority;
- a second technical-debt store;
- a frontend policy engine;
- a frontend prioritization authority;
- a second Work Item store;
- a frontend workflow state machine.

**Maintenance findings are signals/recommendations unless an authoritative Work
Item exists.** Do not silently turn a recommendation into a decision. Where the
maintenance authority's signals carry their own severity/category/advisory
evidence, the health view renders THOSE values — it never computes its own
severity policy over them (grouping/ordering by the authority's own values for
presentation is allowed; inventing new severities is not). Failed health reads
are ERRORS, never "no findings" (the WORK-048 read-state discipline: `success([])`
and `error` are always distinguishable). Missing signals are never fabricated.

## Complexity discipline

Keep the UX lightweight for normal projects. Do not force critical-system
governance onto every project: a project with no findings renders a compact
all-healthy state, not an empty dashboard of governance widgets. Consume
whatever assurance/health information already exists; do NOT invent the future
adaptive-assurance implementation (WORK-054+), the architecture fitness engine
(WORK-057), or continuous maintenance intelligence (WORK-058).

## Governing contracts (the architect's authorization, verbatim intent)

- **API strategy**: consume existing endpoints ONLY — no new backend routes, no
  new tables, no migration (the last migration stays `0057`). The Workbench
  already loads every health-relevant authority:
  `GET /projects/:projectId/maintenance/health?architectureVersionId=` (the
  maintenance authority's own summary: byCategory, bySeverity, and the signal
  records with category/severity/advisoryId/affectedCount/detectorSource +
  planner rationale/whyNow + the completed flag), the WORK-048 work graph
  (unsatisfied dependencies = blocked items), the verification rollup (failed
  runs with the authority's own criteria counts), the runtime authority
  (provider statuses + deployments), the execution rollup (failed executions),
  and the planner authority (recommendations).
- **Read-only**: the health view performs ZERO mutations (no POST/PATCH calls —
  health recommendations cannot mutate state). The maintenance scan/evaluate
  triggers are NOT surfaced from the health view; "what should happen next"
  routes to the authoritative Work Items and the existing governed paths.
- **Findings vs work**: open maintenance findings and COMPLETED maintenance
  work remain visibly distinguishable — a completed maintenance Work Item is
  done work, not an open finding. Authoritative Work Item state (completed or
  not, workflow state) comes from the backend authorities' own records, never
  from frontend bookkeeping.
- **Authorization**: all data flows through the existing server-authorized
  project-scoped reads; cross-project data leakage must be impossible
  (demonstrated by regression — the WORK-048 tenant-isolation pattern).

## Adversarial verification matrix (all required)

1. Tenant isolation (a user cannot read another project's health state).
2. Failed health reads are distinct from genuine empty health (the read-state
   discrimination, per surface).
3. Missing signals are not fabricated (a failed contributing read withholds the
   all-healthy conclusion — "I don't know" never becomes "nothing is unhealthy").
4. Stale UI cannot override fresh backend truth (fresh responses re-derive the
   health view; no cached findings).
5. Health recommendations cannot mutate state (zero mutation calls; the health
   view is read-only by construction).
6. Maintenance findings remain distinguishable from actual completed Work Items
   (open vs completed maintenance work).
7. Authoritative Work Item state comes from backend authorities (the completed
   flag / workflow state are the authority's own values).
8. No new authority is introduced (no second maintenance/health/debt engine, no
   policy or prioritization engine, no second Work Item store, no workflow state
   machine — proven statically).

## Static architecture assertions (WORK-049 describe block)

No new frontend authority of any kind (maintenance, health, technical debt,
policy, prioritization, Work Item, workflow); the health derivation helper is a
PURE presentation function (no fetch, no state, no persistence — facts in,
findings out, deterministic); the Workbench frontend retains ZERO mutation
calls; severity values rendered are the authorities' own; the WORK-049
adversarial regression titles pinned; the work-order pins. Discriminating tests
where practical.

## Required verification

typecheck; lint; frontend unit tests (the health-derivation discriminations +
the WorkbenchPage Health-tab read-state matrix); static architecture checks;
relevant backend integration tests; full regression suite; browser E2E for the
health flows (including browser-level tenant isolation). Failures are
investigated and reproduced, never labeled "pre-existing" without
discrimination.

## Out of scope (explicitly)

WORK-050 (Unified Execution UX), Change Programs, runtime feedback, architecture
fitness, adaptive assurance implementation, continuous maintenance intelligence,
self-hosting automation, any new persistence, migration, or backend endpoint.
