# V2-003 Dogfooding Evidence — Workflow IR Round-Trip

**Work Order ID:** V2-003 — Workflow IR
**Workflow under test:** "Triage an inbound GitHub issue" (authored WorkflowIR document, IR schema version 1, canonical object type `workflowos/workflow-ir/v1`)
**WorkflowVersion under test:** the version whose semantic content is this IR; WorkflowVersion identity/pinning itself is V2-002 (not yet merged — see Limitations)
**Surface/host:** `backend/src/workflow-ir/` public module surface, exercised in-process on this development host (worktree `work/V2-003`) — builder, validator, canonical serializer, parser, semantic/digest API and negotiator. No DB, no routes, no network (pure domain module by design).
**Experiment date:** recorded at W1 implementation time (repo dates); implementation head at experiment time: `faa92b9` (green implementation commit), red battery commits `5464b64` → `d51e427`.

## Exact task (dogfooding-protocol requirement for V2-003)

Author ONE real, non-trivial workflow → validate → serialize → deserialize → re-validate → compare semantic equality and digest stability → demonstrate cross-client equivalence through a second independent builder path → exercise version negotiation. Per the task instructions, "execute/inspect" at this boundary means inspecting meaning through the IR's own semantic/validator API; actual execution arrives with V2-005+ (explicit observation below, never hidden).

## The workflow

A real triage workflow for an inbound GitHub issue — not a toy:

| Node | Execution class | Semantics |
|---|---|---|
| `fetch_issue` | `deterministic_api` | observation step — `github.repository.read`, completion evidence `observation`, placement `cloud_allowed`, failure policy `fail_workflow` |
| `draft_summary` | `agentic_computer_use` | agent drafts triage summary + severity, placement `cloud_allowed`, retry budget 2 |
| `review_gate` | `human` | pause-safe approval gate — declared outcomes `approved`/`rejected`, boolean `approved` output, completion evidence `human_confirmation`, placement `device_local` |
| `notify_channel` | `deterministic_api` | `messaging.send` with secret-referenced credentials (`secret_ref: team-notifications@secrets` on a `secret`-typed port), placement `cloud_preferred`, completion evidence `verification` |
| `sync_backlog` | `subworkflow` | explicit immutable dependency `wf-backlog-sync` @ `wfv_0192837465afdeadbeef-candidate-1`, requires `workflow.execute`, retry budget 3 |
| `log_rejection` | `deterministic_api` | `filesystem.write` rejection log, placement `device_local`, `ignore_and_continue` failure policy |

Plus: workflow inputs `issueUrl` (required) / `channel` (optional), workflow outputs `summary` / `messageId`, 5 control edges (including the two human outcome edges), default placement `any_supported_node`, provenance `authored`, presentation metadata (title, labels, layout).

## Starting state

Red regression battery committed first (all 11 test files failing on missing module), then implementation committed green (`faa92b9`): 197 tests / 11 files passing, `bun run typecheck` clean, scoped eslint clean. No repository persistence, no execution runtime — as specified for this Work Order.

## Expected outcome

- authored workflow validates at authoring time;
- canonical serialization is deterministic and carries only the opaque secret reference;
- deserialize → re-validate → semantically identical, digest stable;
- a second independent construction path produces identical canonical bytes;
- an honest compatible v2 negotiates to `upgrade`; a dishonest declaration is rejected.

## Observed outcome (real run — script output, not reconstructed)

Run through the module's public API (`bunx tsx` in-process, zero network/DB):

```text
[1-author] nodes=6 edges=5 start=fetch_issue
[1-author] execution classes: fetch_issue:deterministic_api, draft_summary:agentic_computer_use,
           review_gate:human, notify_channel:deterministic_api, sync_backlog:subworkflow,
           log_rejection:deterministic_api
[2-validate] ok=true
[3-serialize] bytes=4695 containsSecretRef=true
[4-parse] ok=true / revalidate ok=true
[5-round-trip] semanticallyEqual=true
[5-round-trip] digest before=571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37
[5-round-trip] digest after =571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37
[5-round-trip] digest stable=true algorithm=sha-256 domain=workflowos/workflow-ir/v1
[5-round-trip] serialize(parsed) === serialize(authored): true
[6-cross-client] builder bytes === literal bytes: true
[6-cross-client] builder digest === literal digest: true
[7-alt-order-client] alt bytes === literal bytes: true
[8-negotiation] decision={"decision":"upgrade","reason":"additive-compatible-surface"}
[8-negotiation] candidate digest differs from v1: true
[9-presentation-excluded] digest unchanged under presentation-only change: true
```

**WorkflowVersion semantic digest produced:** `571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37` (sha-256, domain `workflowos/workflow-ir/v1`, presentation excluded, computed over the canonical semantic preimage `{domain, irSchemaVersion, compatibility, ir}`).

Additional checks in the same run path (pinned by the committed battery): the serialized bytes contain the opaque secret handle `team-notifications@secrets` and never the secret-material canary; the approval gate round-trips with both declared outcomes covered; capability requirements round-trip as canonical registry names; a dishonest v2 (declares `equivalent` while adding a required input) is rejected (`compatibility-declaration-inconsistent`).

## Evidence references

- Regression battery (committed RED first): `5464b649dceca437ef4fe4b8a89a0475117c2211` (all 11 files fail on import — verified again during the refined-red commit by moving `src/workflow-ir/` away), refined red battery `d51e427…` (still red).
- Green implementation: `faa92b9…` — `backend/src/workflow-ir/**` (10 source files: barrel, types, 8 internal modules). The module-resident specification `backend/src/workflow-ir/SCHEMA.md` and this evidence file follow in the immediately subsequent docs commit on the same branch.
- Repeatable experiment harness: `backend/tests/integration/workflow-ir/dogfooding-round-trip.integration.test.ts` (11 steps, mirrors this run) and `backend/tests/integration/workflow-ir/cross-client-equivalence.integration.test.ts` (cross-client byte equivalence).
- Full-suite verification at the final head: recorded in the W1 wave worklog (`bunx vitest run` + `bun run typecheck`).

## Duration / cost

In-process compute for the full experiment: < 1 s (single `bunx tsx` run; suite runtime for all 11 workflow-ir test files: ~2.4 s). No external resources consumed; secret reference is an opaque fixture handle, no real credentials involved (protocol safety rule satisfied).

## Classification

**PASS** — the round-trip preserves executable meaning losslessly; the semantic digest is deterministic and presentation-independent; cross-client equivalence holds byte-for-byte; negotiation decisions are deterministic and honesty-checked.

### Honest limitations (explicit observations, not failures)

1. **Execution arrives with V2-005+.** "Execute/inspect" at this boundary means inspecting meaning through the IR's own semantic/validator API (semantic equality, digest stability, control-semantics queries). No WorkflowRun was created, because run lifecycle/evidence is V2-005 (sequential wave W2B, contract-gated on V2-014) and repository pinning is V2-002 (parallel sibling, not consumable pre-merge). This is the specified boundary of the Work Order, recorded per the anti-repeat rule so V2-005 consumes this result.
2. **No real WorkflowVersion id / installation pinning** was exercised (V2-002 owns it; parallel-no-rebase forbids consuming the sibling branch). The digest produced is the version's *semantic* digest, exactly what V2-002 will persist.

## Findings (persisted, not silently folded)

1. **Governed registry extension required (registry-conformance rule 5):** the IR canonical object type `workflowos/workflow-ir/v1` is a genuinely new protocol-visible-shaped identifier (the registry has no WorkflowIR object type; its object types are the three execution-attestation ones owned by V2-014). It is kept schema-internal and IR-scoped, with discrimination tests pinning distinctness from every registry attestation object type and tests pinning the embedded vocabulary against the registry file. It MUST be added to `V2-CTRL-003` through a governed architecture change before it becomes protocol-visible. No aliases of existing registry identifiers were introduced.
2. **Spec promotion deferred to the architect:** the dedicated IR specification lives module-resident at `backend/src/workflow-ir/SCHEMA.md` (the Work Order's "dedicated IR tests/specification"). Writing into the shared `spec/` tree is an architect decision and was deliberately not performed.
3. No contract contradictions were encountered; no stop condition triggered.

## Resulting action

V2-003 is implementation-complete with persisted verification and dogfooding evidence; Work Order state remains for the architect's merge decision (no COMPLETE marking — merge evidence is out of agent scope). Downstream consumers: V2-002 (repository persists this document + digest), V2-004 (capability matching against `capabilityRequirements`), IG-001/IG-002 (composition gates after sibling merges), V2-005 (execution of this IR).
