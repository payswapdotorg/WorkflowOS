# Development Governance & Self-Hosting Control Plane — Design

**Status:** Proposed evolution for the next WorkflowOS architecture increment (WORK-052,
Issue #61). Companion machine-readable form: `spec/development-state/governance-model.json`.

## 1. Goal

Make the repository — not any chat conversation — the durable source of truth for the
WorkflowOS architecture program: the governing architecture version, the Work Orders and
their dependency DAG, the implementation frontier, the applicable architecture checkpoints
and their assurance depth, the durable architectural decisions, and the resumption state
for interrupted implementations. WorkflowOS must be able to govern its own future
implementation with multiple stateless implementation agents working concurrently, without
sacrificing a single frozen v1.0 authority.

## 2. Problem

The architecture program so far (WORK-001 through WORK-051) is durable in its artifacts —
spec documents, work orders, ADR-equivalent design documents, PRs, and an executable
conformance substrate — but the *program state itself* (what governs now, what is in
flight, what may run in parallel, what checkpoints apply, how to resume) lives partly in
conversational memory. Each implementation session reconstructed it by reading issue
threads and prior chat. That does not scale to multiple concurrent implementers and does
not survive conversation loss.

## 3. Non-goals

- No second workflow engine, Work Item authority, verification/evidence authority, or
  architecture authority.
- No rewriting of frozen v1.0 architecture sections (evolution is append-only through
  forward-evolution sections and new immutable design packages).
- No chat-dependent state; no provider-specific worker protocol; no giant central
  autonomous agent; no mandatory heavy process for trivial changes.
- No new database tables for the governance state — the WorkflowOS repository is its own
  durable source of truth; PostgreSQL remains the authority for tenant runtime state.
- No autonomous approval of architecture changes; the architect remains the review and
  merge authority.

## 4. The Engineering Control Loop (composed of existing authorities)

The next architecture version defines the development control loop as ten stages. Every
stage is ALREADY an existing authority or capability — the loop is connective tissue, not
a new engine:

```text
sense      — /github webhooks + CI ingestion, /audit events, WORK-041 maintenance signals
understand — WORK-038 project baselines + WORK-039 repository intelligence
plan       — architect-issued Work Orders (Issues → spec/work-orders/) + WORK-040 planner
check      — WORK-051 architecture checkpoints + WORK-052 assurance profiles (this design)
execute    — /agents execution fabric + WORK-037 policy + WORK-044 routing (+ WORK-046
             delegation where present)
verify     — /verification evidence + CI through /github
review     — /reviews (the architect's semantic authority)
release    — /workflows merge gating + convergence; deployable runtime
observe    — /audit, maintenance health, benchmark evidence, runtime observability
learn      — durable decisions (ADRs + decisions index) + feedback provenance feeding the
             next plan (closing the loop)
```

The loop's `check` stage is where architecture conformance becomes a first-class governed
control point: checkpoints evaluate an exact implementation revision against the immutable
ArchitectureVersion's assertion set (WORK-051), now with adaptive assurance depth
(WORK-052). The loop's `learn` stage is where material decisions become durable
repository artifacts so no future session depends on conversation memory.

## 5. Canonical repository development state

Two machine-readable artifacts under `spec/development-state/` (authority declared in
`README.md`; schema versioned; validated fail-closed by the control plane):

- **`governance-model.json`** — the governance MODEL (slow-changing, architect-owned):
  schema version; the control-loop stages; the assurance profiles with deterministic
  selection rules and the requirement matrix; the governed checkpoint contracts (the
  architecture fitness functions); the self-hosting boundary (MAY / MAY-NOT); the
  authority map. Changes arrive only through Work Orders.
- **`program-state.json`** — the PROGRAM STATE (maintained per protocol by implementers,
  merged by the architect): the active governing architecture version; one record per
  Work Order — status (`complete` | `in_flight` | `blocked` | `pending`), dependencies,
  declared change surfaces (modules, migrations, app-layer dirs, spec docs, shared
  integration surfaces), branch + PR bindings when in flight, merge evidence when
  complete, assurance classification, proof-contract references and recorded checkpoint
  outcomes, feedback origin, and handoff/resumption records.

The invariants the loader enforces (fail-closed): schema match; closed vocabularies;
acyclic dependency DAG over known Work Orders; monotonic, evidence-backed status under
the EXPLICIT merge-vs-checkpoint completion rule — the architect's merge (`mergedAs`:
pr + mergeCommit) is the ONLY completion event, checkpoint outcomes are
implementer-recorded claims that never substitute the merge, an `in_flight` record
carries a branch and NO merge evidence, and outcomes are recorded only on started
items; coordination records are MUTUAL (one-sided declarations are invalid state) and
COVERING (an in-flight start over incomplete dependencies coordinates with those
dependencies); boundary integrity against code-pinned core prohibitions; assurance
matrix integrity (each profile's requirements dominate the WORK-051 impact/checkpoint
matrix — never weaker); every checkpoint contract's enforcement references exist in
the repository.

## 6. Parallel implementation protocol

The protocol permits multiple independent implementation agents to work concurrently and
is usable with zero conversational context (a fresh agent reads the work order, the
program state, and the ADRs):

1. **One Work Item per branch/PR** (frozen cardinality).
2. **Dependency eligibility**: an item is eligible only when all declared dependencies
   are `complete`. The control plane computes the frontier and rejects ineligible starts.
3. **Surface declarations + conflict detection**: every work-order record declares its
   change surfaces. Two `in_flight` items sharing a surface (same module, overlapping
   migration numbering, the composition root, the static architecture suite, a shared
   spec document) are reported as a conflict — not parallel-safe without explicit
   coordination (documented merge order, reserved numbering, or sequencing). This is
   exactly what happened in practice between WORK-046 and WORK-051 (shared static-suite
   and composition surfaces, resolved by reserved migration numbering).
4. **Scope integrity**: a worker edits only its own surfaces; cross-scope edits require a
   Work Order amendment.
5. **Centralized architecture decisions**: Work Orders and ADRs are the only decision
   entry points; the architect issues/approves them.
6. **PR review is the merge gate**: no self-hosted worker merges its own PR.

## 7. Architecture checkpoints as fitness functions

WORK-051 made architecture conformance executable: immutable ArchitectureVersions carry
assertion sets; deterministic detectors evaluate them at lifecycle gates through the
revision-bound snapshot; evidence persists through `/verification`. WORK-052 defines the
governed **checkpoint contracts** — the architecture fitness functions — as data, one for
each quality attribute the program must preserve:

| Contract | Quality attribute |
|---|---|
| `AUTH-PRESERVATION` | authority preservation |
| `DEPENDENCY-DIRECTION` | dependency direction |
| `TENANT-ISOLATION` | tenant isolation |
| `IDENTITY-IDEMPOTENCY` | identity / idempotency |
| `CONCURRENCY-CRASH-SAFETY` | concurrency and crash safety |
| `EXTERNAL-SIDE-EFFECTS` | external side-effect boundaries |
| `REVISION-PROVENANCE` | exact-revision / provenance integrity |
| `MIGRATION-IMMUTABILITY` | migration / immutability safety |
| `DUPLICATE-AUTHORITY` | forbidden duplicate authorities |
| `IMPLEMENTATION-COMPLETENESS` | completeness against the Work Order |
| `SELF-HOSTING-BOUNDARY` | the self-hosting boundary itself |

Each contract declares its proof classes — **static structural** (architecture-suite
invariants), **dynamic behavioral/concurrency** (integration regressions, including
two-connection proofs), and **discrimination/mutation** (deliberately weakened
protections must be rejected) — with enforcement references validated to exist. Prevention
is preferred over detection wherever the architecture already makes unsafe states
structurally unrepresentable (DB triggers, closed registries, capability types).

The `governance-manifest` detector (a 7th detector in the WORK-051 closed registry)
evaluates the development-governance state itself through the existing revision-bound
snapshot: a repository whose governance manifest is missing, unreadable, cyclic,
boundary-weakened, or evidence-inconsistent is `inconclusive`/`fail` — fail closed. This
is WorkflowOS checking its own control plane at any revision.

## 8. Adaptive assurance profiles

Four deterministic profiles select ASSURANCE DEPTH — never authority semantics:

```text
LIGHT            simple change    (documentation / local single-module behavior)
STANDARD         ordinary change  (module internals / data model within one module)
HIGH_ASSURANCE   complex change   (public contracts / concurrency / external boundaries)
CRITICAL         critical change  (authority boundaries / security / tenant / schema)
```

Selection is a deterministic function of the declared change surfaces (rule table in
`governance-model.json`): any authority-boundary, security/tenant, or schema surface ⇒
`CRITICAL`; else any public-contract, concurrency/crash, or external-side-effect surface ⇒
`HIGH_ASSURANCE`; else any module-internals or multi-module surface ⇒ `STANDARD`; else
`LIGHT`. The unset/unknown case fails closed (`HIGH_ASSURANCE` floor: the impact-derived
default stays `high`).

Each profile fixes the required checkpoint contracts, proof classes, and evidence
requirements. The requirement matrix DOMINATES the WORK-051 impact/checkpoint matrix
(a profile's required checkpoint kinds always include everything the item's impact level
applies) — assurance can only add depth, never subtract. Trivial changes stay `LIGHT`;
heavy process is not mandatory for them.

## 9. Evidence and decision durability

Material architectural decisions become durable repository artifacts:

- **ADRs** (`docs/adr/`) — the repository-resident decision record authority for
  WorkflowOS's own architecture (explicitly parallel to, and not replacing, the runtime
  `/architecture` per-project ADR feature).
- **Design packages** (`docs/superpowers/specs/…`) — the next-version design documents.
- **Work Orders** (`spec/work-orders/…`) — the authorization + acceptance contracts.
- **Checkpoint outcomes** (in `program-state.json`) — per-work-order conformance evidence
  with proof references.
- **Decisions index** (in `program-state.json`) — durable pointer to every ADR/design
  decision, so a fresh architect recovers the rationale trail.

PR comments and chat remain ephemeral coordination, never the durable record.

## 10. Self-hosting boundary

WorkflowOS MAY govern, through its own machinery:

- planning its own implementation (Work Orders, planner);
- executing changes (the execution fabric);
- verification (evidence, CI ingestion);
- review (the architect's semantic authority through `/reviews`);
- maintenance (WORK-041 signals → governed Work Items).

WorkflowOS MAY NOT:

- silently rewrite its governing architecture (frozen v1.0 + lock) — changes continue
  through the architecture-change/versioning authority (Work Order + ACR semantics + new
  immutable version);
- silently rewrite its own architecture authority or foundational rules;
- let a self-hosted worker merge its own PR (PR review by the architect is the merge gate);
- weaken the frozen security/tenant/concurrency/idempotency invariants.

Enforcement is layered: the boundary is machine-readable in `governance-model.json`;
the loader validates it against code-pinned core prohibitions (a weakened boundary file
is rejected); the static architecture suite pins the frozen lock sections verbatim (a
silent rewrite fails CI); and the `governance-manifest` detector fails closed at
checkpoints when the boundary is absent or weakened at the evaluated revision.

## 11. Success criteria

The design is successful when:

- a fresh clone answers all seven control questions (governing version, Work Orders,
  complete/in-flight/blocked, parallel eligibility, applicable checkpoints, constraining
  decisions, resumption) from the repository alone;
- two independent implementers can work concurrently on dependency-independent,
  surface-disjoint Work Orders without conversational coordination;
- a deliberate weakening of any protected property is rejected by executable proof;
- an interrupted implementation resumes from repository-resident state;
- every frozen v1.0 authority remains the sole authority for its domain.

## 12. Compatibility with the frozen architecture

This is an append-only next-version design package: §34 of `spec/architecture.md` and the
Forward-Evolution invariants in `spec/architecture-lock.md` record it without modifying
any frozen v1.0 rule. The module set stays 17; the lifecycle stays the 15-state machine;
evidence stays in `/verification`; assertions stay in `/architecture`; transitions stay in
`/workflows`; semantic judgment stays in `/reviews`; external truth stays in `/github`.
Any future change to a frozen rule still requires the Architecture Change Request path
and a new immutable architecture version.
