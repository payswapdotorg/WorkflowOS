# WORK-044 — Adaptive Execution Router

Status: READY
Architecture: frozen v1.0 authority model + forward adaptive-execution architecture (§33.3/§33.4)
Dependencies: WORK-032, WORK-033, WORK-043

## Objective
Implement the adaptive execution router that recommends or automatically selects among eligible native/API and external candidates using benchmark outcomes, quality, reliability, cost, latency, human-intervention requirements, and user/project preferences.

The router is a selection layer only. It consumes the authoritative WORK-043 eligibility verdict and MUST NOT reinterpret, weaken, or bypass hard constraints.

## Scope
1. Rank only candidates already accepted by WORK-043.
2. Use benchmark/evidence quality, reliability, cost, latency, human-intervention requirements, and project/user preferences as explicit ranking inputs.
3. Provide deterministic ordering and tie-breaking.
4. Support recommendation and automatic-selection intents without owning workflow state.
5. Return inspectable routing explanations.
6. Preserve native/external parity with no intrinsic mode bias.

## Out of scope
- New eligibility constraints (WORK-043)
- New benchmark methodology (WORK-032)
- New provider adapters
- WORK-045..047 multi-agent intelligence
- WORK-050 unified execution UX
- Workflow transitions, authorization, verification, GitHub merge/review authority
- Credentials
- Capability degradation/equalization

## Acceptance Criteria
### W044-AC01
Public routing ranks only WORK-043-eligible candidates.
### W044-AC02
An ineligible high-quality candidate can never beat an eligible candidate.
### W044-AC03
Identical eligible inputs produce identical ordering and selection.
### W044-AC04
Ranking dimensions and their precedence are explicit.
### W044-AC05
Native and external execution have no hard-coded ranking bias.
### W044-AC06
Provider capabilities are never truncated or downgraded to equalize outcomes.
### W044-AC07
Preferences can reorder eligible candidates but cannot bypass eligibility.
### W044-AC08
Recommendation is side-effect free; automatic selection does not mutate workflow authority.
### W044-AC09
Routing output explains winner, relevant alternatives, eligibility, and principal ranking factors.
### W044-AC10
Insufficient/inconsistent evidence fails deterministically and never falls back to an ineligible candidate.
### W044-AC11
Router consumes WORK-043; no second eligibility evaluator exists.
### W044-AC12
Router does not own workflow, authorization, verification, GitHub, or credential authority.
### W044-AC13
Ranking evidence remains tenant/project scoped.
### W044-AC14
Tie-breaking is deterministic and independent of nondeterministic iteration/order.

## Required verification
Unit ranking tests; static architecture tests proving WORK-043 dependency; PostgreSQL tenant/project isolation and evidence tests; blocked-high-quality regressions; recommendation/automatic-selection tests; typecheck; lint; architecture suite; full regression suite.

## Stop conditions
Raise an Architecture Change Request rather than continuing if implementation requires changing WORK-043 semantics, adding provider-specific hard-coded preference, weakening native/external parity, introducing a second eligibility/authorization engine, inventing a benchmark ledger, or changing the frozen architecture.

## Definition of Done
All criteria have objective evidence; architecture invariants and CI are green; the PR is within WORK-044 scope; independent Architect Review approves; the PR merges; WORK-044 is marked VERIFIED before WORK-045 becomes eligible.
