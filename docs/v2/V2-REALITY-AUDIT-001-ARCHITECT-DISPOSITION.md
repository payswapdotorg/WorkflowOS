# V2-REALITY-AUDIT-001 — Architect Disposition

**Status:** R4 RECONCILED — repair slices authorized; repeat audit required before deployment

This is the canonical Architect reconciliation record for the worker report merged from PR #16 at `0cb335a259c03bb617aa7f4538cf3b4645f3ca9d`.

## Reconciliation rules

The Architect does not accept a proposed repair merely because a browser journey failed. Each finding is reconciled against the implemented V2 operational authority and current source.

Primary preference:

`existing capability wiring → adapter/composition → missing public route/command → governed architecture change`

No finding below authorizes a new workflow/execution/evidence/verification/authorization authority.

## Disposition table

| Finding | Worker classification | Architect disposition | Canonical repair | Notes |
|---|---|---|---|---|
| F-001 | MISSING_ADAPTER_OR_COMPOSITION | **ACCEPT** | **REALITY-REPAIR-001** — deployment composition | Critical. Extend the real deployment composition to construct/pass the existing V2 product route dependencies. No service or authority redesign. |
| F-002 | MISSING_ADAPTER_OR_COMPOSITION | **ACCEPT** | **REALITY-REPAIR-002** — first-run organization onboarding | Critical. Consume existing `POST /organizations`; eliminate silent no-op when no org is selected. Explicit onboarding is preferred over implicit server auto-provision. |
| F-003 | WIRED_TO_WRONG_COMMAND_OR_READ | **ACCEPT** | **REALITY-REPAIR-003** — caller-org detail reads | Critical. Resolve org-scoped run/install/deployment facts against the caller's org, never the publisher's owner org. |
| F-004a | UX_DEFECT | **ACCEPT** | **REALITY-REPAIR-004** — creation copy correction | High. Remove the false implication that a workflow authoring surface already exists. Preserve the honest fail-closed boundary. |
| F-004b | TRUE_ARCHITECTURE_GAP / UX gap | **SPLIT / DEFER AI AUTHORITY** | **REALITY-REPAIR-004a** — bounded expert IR authoring; future governed ACR for capture→IR | The existing V2-002 create/createVersion commands and V2-003 IR contract are sufficient for a composition-only expert authoring surface. Do not invent an NL→IR backend authority now. The AI capture→IR path requires a future governed V2 architecture change if pursued. |
| F-005 | UX_DEFECT | **ACCEPT** | **REALITY-REPAIR-005** — Home approvals/updates composition | High. Reuse existing run/version/install reads and derivations. No aggregate authority. |
| F-006 | EXPECTED_UNAVAILABLE_SURFACE | **ACCEPT AS-IS** | None | Device issues remain honestly unavailable. A public device-status read is explicitly deferred and cannot be invented as part of these repairs. |
| F-007 | UX_DEFECT | **ACCEPT** | **REALITY-REPAIR-006** — installed workflow naming | Minor. Consume the existing public workflow read for installed-card names. |
| F-008 | MISSING_ADAPTER_OR_COMPOSITION | **ACCEPT** | **REALITY-REPAIR-007** — run lifecycle controls | Critical. Add user-facing Approve/Resume plus safe Pause/Cancel controls by composing existing V2-005 command routes/envelopes. No new approval authority. |
| F-009 | UX_DEFECT | **ACCEPT** | **REALITY-REPAIR-008** — teaching feedback reference | Minor copy defect; bounded UI correction. |
| F-010 | UX_DEFECT | **ACCEPT** | **REALITY-REPAIR-009** — human-readable version diff | Minor presentation defect; preserve the authoritative comparison payload and honest non-equivalence. |

## Additional Architect decisions

### Authoring

The current Create flow is correctly fail-closed because no implemented capture→WorkflowIR generation capability exists. The false sentence promising later executable authoring is not acceptable and must be corrected.

Near-term authoring is authorized only as a **composition-only expert IR authoring surface** over the existing V2-002 create/createVersion commands and V2-003 WorkflowIR validation. This must not create a second workflow model, compiler, execution engine, or AI authority.

Natural-language capture→WorkflowIR generation is **deferred**. Any future implementation that introduces a generation authority, model policy, provider boundary, or new semantic ownership must arrive through the governed V2 architecture-change mechanism.

### Device status

Home "Device issues" remains unavailable because the audit found no public org-scoped device/node-status read. This is an explicit product deferral, not an implementation defect.

### Assessment interaction

The exact-token assessment behavior is recorded as an observation, not a blocking finding. No standalone repair is authorized by this disposition unless a later bounded UX review demonstrates a concrete product or trust defect.

## Repair sequencing

The critical repair sequence is intentionally serialized because each slice changes the confidence of the subsequent browser journey:

```text
REALITY-REPAIR-001  deployment composition
          ↓
REALITY-REPAIR-002  organization onboarding
          ↓
REALITY-REPAIR-003  caller-org detail reads
          ↓
REALITY-REPAIR-007  run lifecycle controls
          ↓
REALITY-REPAIR-004/004a + 005/006/008/009  bounded UX repairs
          ↓
R6 full repeat reality audit
          ↓
R7 deployment readiness
```

The bounded UX repairs may be implemented separately or as clearly disjoint slices, but no implementation branch may absorb unrelated architecture changes.

## Release-blocking findings

The following remain **open and release-blocking until verified fixed on the real deployment topology and full browser journey**:

- F-001 — deployment composition gap
- F-002 — no organization onboarding
- F-003 — marketplace installed-workflow detail uses publisher org reads
- F-008 — user-facing run lifecycle/approval controls absent

F-004a is high priority but is not itself a deployment blocker. F-004b remains deferred beyond the bounded expert authoring composition unless separately expanded by governed architecture change.

## Acceptance standard for repair slices

Every authorized repair must:

1. start from the then-current `main` head;
2. consume only merged/frozen existing authorities and public contracts;
3. remain within its declared change surface;
4. include deterministic tests plus real browser proof where applicable;
5. be reviewed and merged by the Architect at the exact tested head;
6. be followed by the R6 repeat audit over the real deployment entry, not only test harness compositions.

## Deployment gate

The V2 deployment roadmap remains downstream of the accepted R4 disposition **and** successful R6 repeat audit. No deployment slice may be used to conceal or bypass a product/operational composition defect.
