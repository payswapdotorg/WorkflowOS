# WorkflowOS v1.1 — Adaptive Assurance Evolution (Validation-Aware Dimension)

Status: proposed. This document EXTENDS the existing v1.0 adaptive
assurance model (already established in
`spec/governance/assurance-profiles.json` and code-pinned in
`backend/src/architecture-checkpoints/internal/governance-validation.ts`
as `CODE_PINNED_PROFILE_MINIMUMS`). It does NOT rewrite the v1.0 model.
It adds the validation-aware dimension the continuous product validation
sub-evolution (WORK-064..070) requires.

## 1. The existing v1.0 assurance model (preserved, not rewritten)

The v1.0 model already establishes:

- four profiles: LIGHT, STANDARD, HIGH_ASSURANCE, CRITICAL;
- selection by deterministic first-match over declared change-surface
  flags (most severe first);
- code-pinned minimums (each profile's required checkpoint kinds, proof
  classes, and architect-review-record flag);
- dominance over the WORK-051 impact/checkpoint matrix (assurance adds
  depth, never subtracts);
- the invariant: assurance may add evidence requirements but never
  relaxes frozen architecture or security semantics.

The v1.1 evolution preserves ALL of this. The same four profiles remain.
The same authorities remain in force. Only the assurance depth changes.

## 2. The invariant (carried forward)

> Same authority model, different assurance depth.

The v1.1 validation sub-evolution does NOT add a fifth profile. It does
NOT change the selection rule. It does NOT weaken the dominance rule. It
adds a validation-aware DIMENSION that selects the validation operating
mode (PRE_MERGE / POST_RELEASE / CONTINUOUS) and the journey depth
appropriate to the assurance level.

## 3. The validation-aware dimension (the v1.1 extension)

When WORK-064 (Continuous Product Validation) and WORK-066 (Validation
Scheduling & Change Triggers) are implemented, the validation scheduler
will select which ValidationJourneys to admit for a given trigger based
on the assurance level the trigger warrants. The mapping is:

### LIGHT

```text
simple change
→ lightweight checkpoint
→ tests
→ merge
→ PRE_MERGE READ_ONLY smoke journeys (the affected surface only)
```

### STANDARD

```text
normal feature change
→ work_order + pr_conformance checkpoints
→ static + dynamic proofs
→ PRE_MERGE READ_ONLY + SAFE_MUTATION journeys (the affected journeys)
→ POST_RELEASE READ_ONLY journeys (the affected journeys, immediately
  after release)
```

### HIGH_ASSURANCE

```text
public-contract, concurrency, external-side-effect change
→ readiness + work_order + pr_conformance + verification_entry
→ static + dynamic + discrimination proofs
→ PRE_MERGE READ_ONLY + SAFE_MUTATION + ISOLATED_MUTATION journeys
  (the affected journeys plus integration journeys, with discrimination
  evidence)
→ POST_RELEASE READ_ONLY journeys (immediately after release)
→ CONTINUOUS READ_ONLY journeys (on schedule, the affected journeys)
```

### CRITICAL

```text
authority, security/tenant, schema, mission-critical, materially
irreversible change
→ readiness + work_order + pr_conformance + verification_entry +
  architect_review
→ static + dynamic + discrimination proofs
→ architecture tradeoff analysis (security, performance, dependency
  analysis)
→ independent verification
→ staged release (canary / partial rollout)
→ PRE_MERGE READ_ONLY + SAFE_MUTATION + ISOLATED_MUTATION journeys
  (the full journey suite, with discrimination evidence and
  architect-review record)
→ POST_RELEASE READ_ONLY + SAFE_MUTATION journeys (immediately after
  release; canary-bound)
→ CONTINUOUS READ_ONLY + SAFE_MUTATION journeys (on schedule, the full
  journey suite)
→ runtime validation bound to progressive rollout (WORK-069)
```

## 4. The EffectPolicy binding per profile

The validation-aware dimension binds the EffectPolicy to the assurance
level:

| Profile | PRE_MERGE | POST_RELEASE | CONTINUOUS |
|---|---|---|---|
| LIGHT | READ_ONLY | (none) | (none) |
| STANDARD | READ_ONLY, SAFE_MUTATION | READ_ONLY | READ_ONLY |
| HIGH_ASSURANCE | READ_ONLY, SAFE_MUTATION, ISOLATED_MUTATION | READ_ONLY | READ_ONLY |
| CRITICAL | READ_ONLY, SAFE_MUTATION, ISOLATED_MUTATION | READ_ONLY, SAFE_MUTATION | READ_ONLY, SAFE_MUTATION |

FORBIDDEN is FORBIDDEN in every profile and every mode: production
destructive operations are never admitted without an explicitly approved
safe mechanism.

## 5. The dominance rule (preserved)

The v1.0 dominance rule is preserved: assurance adds depth, never
subtracts. The validation-aware dimension adds journey depth and
mode breadth; it never relaxes the EffectPolicy or the safety
invariants. Concretely:

- a CRITICAL change cannot skip the PRE_MERGE journey suite by claiming
  a lower profile (the selection is deterministic first-match, most
  severe first);
- a FORBIDDEN action cannot be admitted in any profile by claiming a
  higher profile (FORBIDDEN is absolute);
- a SAFE_MUTATION journey cannot run against an environment authorized
  only for READ_ONLY (the environment-policy binding is enforced).

## 6. The runtime profile engine (implemented under WORK-066 — complete)

The runtime profile engine that selects journeys and binds the
effect-policy allowance per assurance level is implemented under WORK-066
(Validation Scheduling & Change Triggers), activated by the architect on
2026-09-01 and COMPLETE — merged as `0a506b1` via PR #102 on 2026-08-31
and finalized §34.8/ADR-0007 by the WORK-066 post-merge finalization: the
FIXED profile × mode → journey selection declared in this
document (§4's table is the selection matrix — the WORK-064 admission gate
remains the authority) ships as the deterministic fixed mapping the
WORK-066 Work Order itself declared ("the scheduler uses a fixed mapping
(trigger → assurance level → journey set) declared in this Work Order").
When WORK-058 lands, the selection delegates to its deterministic
function (§7). The original v1.1-package statement is preserved as
history: "This task does NOT implement the runtime profile engine. It
persists the model."

## 7. The relationship to WORK-058 (Adaptive Assurance Engine)

WORK-058 (Adaptive Assurance Engine — planned) is the v1.1 evolution
Work Order that implements the runtime engine for the v1.0 assurance
model. WORK-066 (Validation Scheduling & Change Triggers — complete,
merged `0a506b1` via PR #102) is
the v1.1 evolution Work Order that implements the runtime engine for
the validation-aware dimension in this document.

When WORK-058 lands, the assurance selection (profile → required
proofs/checkpoints) delegates to it. WORK-066 has LANDED (complete — the
validation selection (profile → journey set + EffectPolicy binding) is
now the runtime fixed mapping at `backend/src/validation-scheduling/`);
the assurance selection (profile → required proofs/checkpoints) remains
design-time proposed state in this document until WORK-058 lands.

WORK-058 and WORK-066 are SEPARATE Work Orders because they own
SEPARATE concerns (assurance depth vs. validation depth). They are
both subordinate to the same authority model and the same dominance
rule.
