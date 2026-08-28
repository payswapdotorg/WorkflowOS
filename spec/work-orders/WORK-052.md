# WORK-052 — Development Governance & Self-Hosting Control Plane

Status: IN FLIGHT (implementation PR against `main`; architect review pending)
Architecture: frozen v1.0 authority model + forward evolution (§34 — Development Governance and Self-Hosting Control Plane)
Dependencies: WORK-038, WORK-039, WORK-040, WORK-041, WORK-045, WORK-051
Authoritative Work Order: GitHub Issue #61 (this document is its repository-resident form)

## Objective

Make the repository — not any chat conversation — the durable source of truth for the
WorkflowOS architecture program, so that a brand-new architect or implementation agent
with zero conversational history can:

```text
1.  determine what architecture version governs;
2.  enumerate the Work Orders that exist;
3.  see which are complete, in flight, or blocked;
4.  identify which Work Items can safely run in parallel;
5.  know which architecture checkpoints apply, at which assurance depth;
6.  recover the durable architectural decisions that constrain the work;
7.  resume an interrupted implementation from repository-resident state.
```

WORK-052 is a GOVERNANCE CONTROL-PLANE slice. It defines the next architecture-version
design package (the Engineering Control Loop, first-class architecture checkpoints,
adaptive assurance profiles, architecture fitness evaluation, governed feedback, and the
self-hosting boundary), the canonical machine-readable repository development state, and
the parallel implementation protocol. It does **not** create a second workflow engine, a
second Work Item authority, a second verification/evidence authority, a second
architecture authority, or any chat-dependent state.

## Governing contracts (frozen v1.0 — unchanged)

- `/architecture` owns Architecture, ArchitectureVersion, ArchitectureDecision, ADRs,
  Architecture Change Requests, and the architecture assertion set. Governing-architecture
  changes require the Architecture Change Request path and a new immutable version.
- `/work-items` owns Work Items, Work Item dependencies, and Work Order state.
- `/workflows` owns the workflow state machine and every lifecycle transition.
- `/verification` owns verification runs, evidence, and criterion evaluation.
- `/reviews` owns Architect Reviews and Review Findings — the semantic authority.
- `/github` owns GitHub integration and is the sole external repository authority.
- `/agents`, `/execution-policy`, `/execution-routing` remain the execution authorities.
- PostgreSQL remains the authoritative runtime application/workflow state; GitHub remains
  authoritative for repository state. **The repository's own development-governance state
  is repository-resident** (the WorkflowOS git tree is its own durable source of truth).

## Authority-boundary mapping for everything WORK-052 introduces

| Artifact | Authority | Notes |
|---|---|---|
| `spec/architecture.md` §34 | architecture spec (append-only forward evolution) | v1.0 sections untouched |
| `spec/architecture-lock.md` forward-evolution invariants | architecture lock (append-only) | frozen v1.0 sections untouched |
| `spec/development-state/governance-model.json` | the machine-readable governance model | declared authority: the architect (changes via Work Order) |
| `spec/development-state/program-state.json` | the machine-readable program state | updated by implementers per protocol, architect-merged |
| `spec/development-state/README.md` | the artifact authority declaration | who may write what |
| `docs/adr/*` | repository-resident Architecture Decision Records for WorkflowOS's own architecture | parallel to (not replacing) the runtime `/architecture` per-project ADR feature |
| `backend/src/development-governance/` | application-layer control-plane capability (NOT a frozen module; the module set stays 17) | reads repository artifacts; holds no mutation ports; issues no SQL |
| `backend/src/architecture-checkpoints/internal/detectors/governance-manifest.detector.ts` | a 7th detector in the existing closed registry | evaluates the governance state through the existing revision-bound snapshot |

## Scope

1. **Architecture-version evolution (design package).** Define the next architecture
   version/design package — appended as §34 to `spec/architecture.md`, as Forward-Evolution
   invariants in `spec/architecture-lock.md`, and as the design document
   `docs/superpowers/specs/2026-08-28-development-governance-design.md` — covering:
   - the Engineering Control Loop: `sense → understand → plan → check → execute → verify →
     review → release → observe → learn`, composed ENTIRELY of existing authorities;
   - architecture checkpoints as first-class governed control points (extending WORK-051);
   - adaptive assurance profiles: `LIGHT`, `STANDARD`, `HIGH_ASSURANCE`, `CRITICAL`;
   - architecture fitness / quality-attribute evaluation (the checkpoint contracts ARE the
     architecture fitness functions);
   - continuous runtime/user/maintenance feedback into governed planning (origin-provenance
     on work-order records; existing WORK-040/WORK-041 machinery produces the signals);
   - repository-resident self-hosting state sufficient to resume after conversation loss.
2. **Canonical repository development state (machine-readable).**
   `spec/development-state/governance-model.json` (the governance model: control loop,
   assurance profiles + deterministic selection rules + requirement matrix, checkpoint
   contract definitions, self-hosting boundary) and `spec/development-state/program-state.json`
   (the program state: governing version, work-order records with statuses/dependencies/
   change surfaces/branch+PR bindings/handoff records/checkpoint outcomes, decisions index,
   resumption protocol state).
3. **Parallel implementation protocol.** A repository-native protocol for concurrent
   stateless implementation agents: one Work Item per implementation branch/PR; explicit
   dependency eligibility from the dependency DAG; shared-authority/migration conflict
   detection over declared change surfaces; no worker alters another Work Item's
   authoritative scope; architectural decisions stay centralized (architect-issued Work
   Orders + ADRs); PR review remains the merge gate. Usable without conversational context.
4. **Architecture checkpoints (governed contracts).** Machine-readable checkpoint contracts
   for at least: authority preservation; dependency direction; tenant isolation;
   identity/idempotency; concurrency and crash safety; external side-effect boundaries;
   exact-revision/provenance integrity; migration/immutability safety; duplicate-authority
   prevention; implementation completeness against the Work Order; and the self-hosting
   boundary. Each contract declares its proof classes — static structural, dynamic
   behavioral/concurrency, and discrimination/mutation — with enforcement references that
   are validated to exist.
5. **Assurance profiles.** Deterministic selection of `LIGHT` / `STANDARD` /
   `HIGH_ASSURANCE` / `CRITICAL` from declared change surfaces. Profiles change REQUIRED
   ASSURANCE DEPTH (which checkpoint contracts apply, which proof classes are required,
   what evidence must be recorded) — never authority semantics. The WORK-051
   impact/checkpoint matrix is untouched; profile requirements must dominate it.
6. **Evidence and decision durability.** Durable ADRs (`docs/adr/`) recording the material
   decisions and their rationale; decisions indexed in the program state; checkpoint
   outcomes recorded per work order; nothing material lives only in chat or PR comments.
7. **Self-hosting boundary.** Explicit machine-readable MAY / MAY-NOT encoding:
   WorkflowOS MAY govern planning, execution, verification, review, and maintenance of its
   own implementation; it MAY NOT silently rewrite its governing architecture, its
   architecture authority, or its foundational rules — those continue through the
   architecture-change/versioning authority. Enforced by loader validation against
   code-pinned core prohibitions, by verbatim static pins on the frozen lock sections, and
   by the `governance-manifest` checkpoint detector.

## Out of scope

- WORK-047 (Agent Intelligence) and every downstream intelligence enhancement
- WORK-048/049/050 (Developer product experience)
- Any change to frozen v1.0 module ownership, workflow semantics, or protected rules
- A second workflow/Work Item/verification/architecture/evidence authority (hard prohibition)
- A provider-specific worker protocol (the protocol is repository/git-native)
- A giant central autonomous agent (the control plane is passive state + deterministic queries)
- New database tables for governance state (the canonical development state is
  repository-resident BY DESIGN; PostgreSQL remains the authority for tenant runtime state)
- An HTTP API surface for the control plane (deferred — see ADR-0001; the self-hosting
  loop is repo/git-based: CLI + service + tests in this increment)
- Automation that updates program-state.json from live PR/CI state (the protocol is
  implementer-maintained in this increment; automation is a separate decision)

## Parallel implementation protocol (repository-native)

1. **One Work Item per branch/PR.** Each Work Order binds exactly one implementation
   branch and at most one active PR (`spec/architecture-lock.md` cardinality).
2. **Dependency eligibility.** A Work Order is implementation-eligible only when every
   declared dependency is `complete` (merged). The control plane computes the frontier.
3. **Surface declarations.** Every work-order record declares its change surfaces —
   modules touched, migration numbers reserved, application-layer directories, spec
   documents, and the shared integration surfaces (composition root, static architecture
   suite). Two `in-flight` Work Orders sharing a declared surface are reported as a
   **conflict**: not parallel-safe without explicit architect coordination (merge-order
   documentation, reserved numbering, or sequencing).
4. **Scope integrity.** A worker edits only its own Work Item's declared surfaces.
   Cross-scope edits require an explicit Work Order amendment.
5. **Centralized architecture decisions.** All architectural decisions enter the
   repository through architect-issued Work Orders (GitHub Issues → `spec/work-orders/`)
   and ADRs; implementers record decisions in ADRs for architect review, never silently.
6. **Merge gate.** PR review by the architect remains the only merge gate. No self-hosted
   worker merges its own PR.

## Acceptance criteria

### W052-AC01 — Repository source of truth (fresh-checkout reconstruction)

A fresh checkout loads and validates `governance-model.json` + `program-state.json` and
answers all seven control questions above without conversational history. Evidence:
integration test against the REAL repository artifacts + the `governance:status` CLI.

### W052-AC02 — Canonical state validity (fail-closed validation)

The loader rejects: schema drift, cyclic dependency DAG, unknown dependency references,
unknown status/assurance vocabulary, weakened self-hosting boundary (missing core
prohibitions), weakened assurance requirement matrix, unknown detector kinds, a `complete`
work order without merge evidence, a `in_flight` work order carrying merge evidence
(merged-but-in-flight), checkpoint outcomes on unstarted (`pending`/`blocked`) items, a
weakened or missing merge-vs-checkpoint completion rule, ONE-SIDED coordination (a
coordination reference between two in-flight work orders not reciprocated), a
coordination record that does not cover the incomplete dependencies it started over,
coordination references to unstarted work orders, and checkpoint contracts whose
enforcement references do not exist in the repository. Evidence: discrimination tests
(each mutation rejected).

### W052-AC03 — Parallel dependency eligibility

Two genuinely independent Work Orders are recognized as concurrently executable; a Work
Order with an unsatisfied dependency is rejected; shared-migration and shared-authority
conflicts are detected. Evidence: integration tests over the real program state +
fixtures.

### W052-AC04 — Deterministic assurance selection

`simple → LIGHT`, `ordinary → STANDARD`, `complex → HIGH_ASSURANCE`, `critical →
CRITICAL` — deterministic from declared change surfaces; the same surfaces always select
the same profile; the selected profile deterministically alters required checkpoint
contracts, proof classes, and evidence requirements; profile requirements dominate the
WORK-051 impact/checkpoint matrix (never weaker). Evidence: integration tests.

### W052-AC05 — Checkpoint contracts with three proof classes

All eleven governed checkpoint contract areas are defined as data with declared proof
classes and validated enforcement references; each contract area has executable proof in
this repository (static invariants, dynamic regressions, and discrimination tests).
Evidence: static suite + integration tests + the enforcement-reference validation.

### W052-AC06 — Self-hosting boundary

The boundary is machine-readable, validated against code-pinned core prohibitions, and
enforced: a weakened boundary is rejected by the loader and by the `governance-manifest`
checkpoint detector; silent rewrites of frozen v1.0 lock sections fail the static suite
(verbatim pins). Evidence: discrimination tests + static pins.

### W052-AC07 — Crash/restart/resume

An interrupted development state (handoff record) persisted in the repository is
recovered by a fresh control-plane instance — full resumption view (work order, proof
contract, handoff steps, branch/PR, recorded outcomes) without chat context. Evidence:
integration test (new instance from the same repository-resident state).

### W052-AC08 — No second authorities

The development-governance capability holds no mutation ports over architecture,
work-items, workflows, verification, or reviews; issues no SQL; adds no DB tables; adds no
workflow states; the module set stays 17. Evidence: static architecture invariants.

### W052-AC09 — Tenant/authority safety

The governance-manifest detector reads only the revision-bound project snapshot
(provider-observed identity recorded; no working-tree fallback; no cross-project reads);
the control plane is tenant-neutral repository state (no per-tenant data). Evidence:
detector integration tests through the checkpoint substrate on real PostgreSQL.

### W052-AC10 — Decision durability

Every material WORK-052 architectural decision is recorded in `docs/adr/` with rationale
and is recoverable from the repository alone. Evidence: ADR files + decisions index.

## Required implementation evidence

- Static architecture invariants (new WORK-052 describe block + deliberate registry pin
  advance 6→7 detectors, documented in ADR-0006).
- Integration tests on real PostgreSQL: state validation, fresh-checkout reconstruction,
  parallel eligibility/conflicts, assurance selection, crash/resume, and the
  governance-manifest detector through the checkpoint substrate (durable evidence rows).
- Discrimination/mutation tests for every protection claimed.
- Typecheck and lint clean; full repository regression suite clean (real PostgreSQL +
  pglite fallback).

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a new workflow state, workflow engine, or second lifecycle authority;
- a second Work Item, verification, evidence, or architecture authority;
- new database tables for governance state or evidence;
- mutating frozen v1.0 architecture sections in place;
- profile-dependent authority semantics (profiles may only change assurance depth);
- a provider-specific worker protocol;
- chat-dependent governance state.

## Definition of Done

- W052 acceptance criteria have objective, executable evidence.
- All required tests pass (static, dynamic, discrimination; real PostgreSQL).
- The PR describes scope, decisions, authority mapping, artifacts, protocol, checkpoint
  model, assurance model, boundary, tests, verification, and explicit deferrals.
- Independent Architect Review approves the implementation PR (the implementer never
  merges).
- WORK-052 is recorded complete in `program-state.json` with merge evidence.
