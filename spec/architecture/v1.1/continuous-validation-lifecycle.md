# WorkflowOS v1.1 — Continuous Validation Lifecycle (Operating Modes)

Status: proposed. This document persists the three validation operating
modes (PRE_MERGE, POST_RELEASE, CONTINUOUS) and their EffectPolicy /
assurance-level bindings. It is the design-time authority for the
validation lifecycle; the runtime scheduling engine (when authorized)
lives in the backend under WORK-066.

## 1. The three operating modes

### PRE_MERGE

Environment: preview / isolated environment (a preview deployment of the
PR's branch, an isolated test tenant, a sandbox).

Purpose: catch integration regressions before merge.

EffectPolicy: may permit READ_ONLY, SAFE_MUTATION, ISOLATED_MUTATION.
FORBIDDEN actions are rejected unless an explicitly approved safe
mechanism exists.

Assurance: bound to the change's assurance profile (LIGHT → READ_ONLY
smoke; STANDARD → READ_ONLY + SAFE_MUTATION; HIGH_ASSURANCE → +
ISOLATED_MUTATION + integration journeys; CRITICAL → + the full journey
suite + architect-review record).

Triggers: PR, deployment (to preview), architecture change (ACR-gated
preview), security finding (immediate preview), major dependency change
(the dependency's preview).

### POST_RELEASE

Environment: the real production deployment, immediately after a
release.

Purpose: confirm the new release works in the real deployment.

EffectPolicy: READ_ONLY and SAFE_MUTATION only. ISOLATED_MUTATION
requires an isolated test tenant in production (rare; only for
CRITICAL changes with an approved sandbox). FORBIDDEN actions are
rejected.

Assurance: bound to the release's assurance profile. CRITICAL releases
are canary-bound (WORK-069 progressive release): the POST_RELEASE
validation runs against the canary before full rollout.

Triggers: release.

### CONTINUOUS

Environment: the real production deployment.

Purpose: detect regressions after deployment.

EffectPolicy: READ_ONLY and SAFE_MUTATION only (CRITICAL journeys may
include SAFE_MUTATION in production with an approved test tenant).
FORBIDDEN actions are rejected.

Assurance: bound to the journey's declared assurance level. The
CONTINUOUS mode runs the full journey suite on a schedule (for
CRITICAL-class journeys) or on event triggers (runtime anomaly,
security signal, user-feedback spike).

Triggers: scheduled interval, runtime signal, security signal, user
feedback.

## 2. The EffectPolicy binding per mode and profile

| Mode | LIGHT | STANDARD | HIGH_ASSURANCE | CRITICAL |
|---|---|---|---|---|
| PRE_MERGE | READ_ONLY | READ_ONLY, SAFE_MUTATION | READ_ONLY, SAFE_MUTATION, ISOLATED_MUTATION | READ_ONLY, SAFE_MUTATION, ISOLATED_MUTATION |
| POST_RELEASE | (none) | READ_ONLY | READ_ONLY | READ_ONLY, SAFE_MUTATION |
| CONTINUOUS | (none) | READ_ONLY | READ_ONLY | READ_ONLY, SAFE_MUTATION |

FORBIDDEN is FORBIDDEN in every mode and every profile. Production
destructive operations are never admitted without an explicitly
approved safe mechanism.

## 3. The trigger → mode binding

| Trigger | Mode | Profile |
|---|---|---|
| PR | PRE_MERGE | bound to the PR's assurance profile |
| deployment (to preview) | PRE_MERGE | bound to the deployment's assurance profile |
| release | POST_RELEASE | bound to the release's assurance profile |
| scheduled interval | CONTINUOUS | bound to the journey's declared level |
| runtime signal | CONTINUOUS | bound to the signal's severity |
| architecture change (ACR) | PRE_MERGE | bound to the ACR's assurance profile |
| security finding | PRE_MERGE + POST_RELEASE | bound to the finding's severity |
| major dependency change | PRE_MERGE + POST_RELEASE | bound to the dependency's assurance profile |

The scheduler (WORK-066) consumes triggers from the existing authorities
(`/github`, runtime/audit, `/architecture`, the existing security signal
intake). It does not invent its own triggers.

## 4. The scheduling rules

- A run is admitted only when its declared EffectPolicy is one the
  target Environment is authorized to accept.
- A run is admitted only when its declared TestIdentity is valid for the
  target Environment (a synthetic identity in production; a test-tenant
  identity in an isolated sandbox for ISOLATED_MUTATION).
- A run is admitted only when its declared assurance level is met by
  the run's evidence (static + dynamic + discrimination proofs as
  required).
- A CONTINUOUS run is admitted only by explicit configuration (no
  autonomous unsupervised scheduling).
- A POST_RELEASE run is admitted only after the release is recorded by
  the existing release authority (no premature POST_RELEASE against an
  unreleased change).

## 5. The failure semantics per mode

A validation failure in any mode produces:

- evidence (provenance preserved — the run, journey, step, environment,
  observation);
- an Engineering Signal (WORK-067 — correlated, deduplicated, regression-
  likelihood-assessed);
- a governed Work Item proposal (WORK-068 — through the existing
  `/work-items` authority).

The mode affects the failure's severity and the response:

- a PRE_MERGE failure blocks the merge (the change is not ready);
- a POST_RELEASE failure triggers the progressive-release continue/halt/
  recover decision (WORK-069);
- a CONTINUOUS failure triggers the runtime-observation → signal → Work
  Item flow (the system has regressed since the release).

A failure is NEVER silently discarded, NEVER converted into a false
healthy state, and NEVER directly converted into an ungoverned code
change (the WORK-064 invariant, carried forward).

## 6. The runtime scheduling engine (implemented under WORK-066 — complete)

The runtime scheduling engine that decides WHEN validation runs is
implemented under WORK-066 (Validation Scheduling & Change Triggers),
activated by the architect on 2026-09-01 and COMPLETE — merged as
`0a506b1` via PR #102 on 2026-08-31T16:37:09Z (squash-merged at the
approved head `493ae59`, the tree identical) and finalized §34.8/ADR-0007
by the WORK-066 post-merge finalization: the scheduling/trigger DECISION
layer at `backend/src/validation-scheduling/` that consumes this
document's model — the §3 trigger→mode binding (through WORK-064's
`TRIGGER_MODE_BINDING`), the §2/§4 scheduling rules (the effect-policy
allowance per profile × mode is the SELECTION; the WORK-064 admission
gate remains the authority), and the explicit-configuration-only
CONTINUOUS discipline (no autonomous unsupervised scheduling). The
original v1.1-package statement is preserved as history: "This task does
NOT implement the scheduling engine. It persists the model." — the model
was persisted by the package; WORK-066 implements the decision layer over
it (the activation record is preserved in program-state.json's note).

## 7. The relationship to WORK-069 (Progressive Release & Runtime Validation)

WORK-069 (Progressive Release & Runtime Validation — planned) is the
v1.1 evolution Work Order that binds POST_RELEASE validation to
progressive rollout (canary / partial rollout → synthetic validation →
runtime observation → continue / halt / recover). WORK-066 (this
document's owning Work Order) decides WHEN validation runs; WORK-069
decides how the POST_RELEASE validation is bound to the release
decision. They are separate Work Orders because they own separate
concerns (scheduling vs. release binding).

When WORK-069 lands, the POST_RELEASE mode is extended with the
canary-bound continue/halt/recover loop. Until then, POST_RELEASE is
defined in this document as the immediate-post-release validation
without the progressive-rollout binding.

## 8. The progressive release loop (implemented under WORK-069 — in flight)

The canary-bound continue/halt/recover loop this document's §7 anticipated
is implemented under WORK-069 (Progressive Release & Runtime Validation),
activated by the architect on 2026-08-31 and IN FLIGHT on branch
`feat/WORK-069-progressive-release` (the activation record and the full
binding model are in `spec/work-orders/WORK-069.md`): the feedback binding
layer at `backend/src/progressive-release/` — the application-layer
pattern, NOT an 18th frozen module — that binds this document's POST_RELEASE
mode to the progressive rollout.

The loop, as governed by the Work Order and implemented:

```text
release (the EXISTING /workflows + /github + /runtime authorities — distributed, consumed, never replaced)
    ↓
canary / partial rollout (the existing deployment surface — the stage is DECLARED to the decision layer, never advanced by it)
    ↓
synthetic validation (WORK-064, scheduled by WORK-066 at POST_RELEASE/RELEASE — the decision layer binds the COMPLETED run through findRun)
    ↓
runtime observation (the existing /runtime deployment authority — consumed through the read-only RuntimeObservationReader port)
    ↓
continue / halt / recover (the PURE deterministic policy — a governed derivation, never an autonomous agent decision)
    ↓
    ├─ continue → the existing release authority proceeds with the rollout
    ├─ halt → the failure evidence becomes an Engineering Signal (WORK-067) → WORK-068 → the existing /work-items authority
    └─ recover → the EXISTING rollback authority (consumed through its port; unbound today = the typed fail-closed outcome, never a silent continue)
```

The decision layer's fail-closed ruling (the §5 semantics, enforced):
missing or unusable validation evidence, a missing or ambiguous runtime
observation, a cross-scope binding mismatch, or an inconsistent recorded
rollout state is a TYPED HALT — never a continue, never a synthesized
healthy state. A RECOVER is derived only for the contained-rollback cases
(an effect-policy violation at any stage; a validation failure or an
unhealthy runtime while still contained at the canary); at the exposed
stages (partial/full) the same failures are HALTS (stop the rollout, feed
the governed chain — do not auto-rollback).

The decision identity is deterministic (tenant, project, release, stage,
validation run, runtime-observation event): a duplicate delivery converges
on the recorded decision and re-executes nothing; a different scope is an
independent decision. Every decision record carries the full provenance
(which release, environment, stage, validation run, runtime observation,
policy version, decision, and why) and emits one `/audit` forensic event
(WORK-020).

The consequence durability protocol (the PR #108 architect-review
correction + the 2026-09-01 re-review claim correction): the decision
record is the only idempotency boundary for the governed consequences,
so it is RESERVED (insert-only, through the repository port's `reserve`,
persisted to the composed boundary) BEFORE any governed consequence
executes — the halt/recover consequences (signal emission, the rollback
invocation) run only for the reservation owner, then the
`completeDecision` transition records their real outcomes; a `continue`
reserves atomically final (it carries no governed consequences). Within
the composed boundary, a crash or a concurrent delivery can therefore
never re-execute a non-idempotent consequence for an identity that is
already reserved: the re-delivery that finds a reserved-but-unresolved
(pending) reservation fails closed with the typed
`PR_DECISION_CONSEQUENCES_PENDING` — never a re-execution, never a clean
duplicate. The protocol's strength is the composed adapter's: the
production composition binds the in-memory adapter (`migrations: []` —
the 064/066/067 precedent), whose reservation is PROCESS-LOCAL —
cross-process consequence idempotency is NOT claimed by that
composition; it is the DURABLE-adapter contract of the same port (the
keyed-uniqueness + pending-tombstone semantics proven under real
PostgreSQL, including the process-loss and two-independent-instance
cases) and the future ACR's productionization, which must precede any
drive-surface activation that delivers decisions from more than one
process.

When WORK-059 (Operational and Release Governance) lands, the release
mechanics are delegated to it at the same public ports — WORK-069's
binding model (the decision, the evidence gates, the consequence chain)
is unchanged by that delegation.
