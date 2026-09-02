# IG-002 — WorkflowIR ↔ Capability/Placement Integration Gate — Dogfooding Evidence

**Work Order:** IG-002 — WorkflowIR ↔ Capability/Placement Integration
**Classification of capability:** integration-gate verification of two merged execution-facing contracts (V2-003 WorkflowIR authoring/validation/semantic digest × V2-004 node/capability registration + matching); not a human UI surface
**Validation type:** real-protocol integration experiment (work-order dogfooding requirement, literal frozen clause: "Take one real workflow that can run on two supported host classes and verify equivalent workflow meaning with host-specific capability resolution")
**Status:** EVIDENCE PERSISTED — experiment run through the real integrated paths; gate remains pending-architect-merge (agents never mark COMPLETE)

## Work Order ID

IG-002 — WorkflowIR ↔ Capability/Placement Integration Gate, wave W3, branch `feat/ig-002-ir-capability-placement-gate`, base `def45e79db60d9b509263d2c166733ede9dc1b3d` (merged main: V2-002/V2-003/V2-004/V2-006/V2-007/V2-014/V2-005 all frozen on this base).

## Workflow / version under test

Two real WorkflowIR documents authored through the merged V2-003 module:

1. **The triage workflow** (`buildTriageDocument()` — the shared V2-003 battery fixture): 6 nodes / 5 control edges, validated by the real `validateWorkflowIrDocument`, semantic digest `571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37`. Its per-node requirement projections (canonical capability names + placement ids, via the gate's test-local adapter — V2-004 consumes requirements as data by design) exercise `github.repository.read`/`cloud_allowed`, `workflow.execute`/`any_supported_node`, `messaging.send`/`cloud_preferred`, `filesystem.write`/`device_local`+`localOnly`, and a human `review_gate`/`device_local`+`localOnly` node.
2. **The dogfooding-core workflow**: `buildMinimalDocument()` + one `workflow.observe` observer node (`deterministic_api`, placement `any_supported_node`) — the capability genuinely advertised by BOTH registered host classes, so the whole workflow runs on two supported host classes.

## Surface / host

Two node identities of **different platform classes**, both registering through the REAL V2-004 protocol path (key enrollment → nonce challenge → HMAC-SHA256 challenge-response → registration → session → trust attributes):

- **Web host (device class):** node id `node_d1cd87188e243581`, platform class `web`, location class `device`, protocol version 1, capabilities `workflow.observe`, `browser.navigate`, `browser.click`, `supportsHumanApproval: true`, health `healthy`, trust tier `trusted`.
- **Cloud host (cloud class):** node id `node_742447f47f5ca742`, platform class `cloud`, location class `cloud`, protocol version 1, capabilities `workflow.execute`, `workflow.observe`, `github.repository.read`, `supportsHumanApproval: false`, health `healthy`, trust tier `trusted`.
- **Unsupported-platform fleets:** a cloud-only fleet (the same cloud host, NO device-class node deployed) and the full fleet under a `minProtocolVersion: 2` requirement.
- **Matcher:** the real `matchNodes` of `DefaultNodeCapabilityService` — capability matching, placement/locality/privacy constraints, protocol gating, trust — with dimension-tagged reasons.

## Exact task

1. Author + validate the real triage workflow through V2-003; derive every per-node requirement projection (no fabricated node ids).
2. Register both host classes through the real V2-004 registration protocol.
3. Run the dogfooding core: resolve the same real workflow on BOTH host classes; verify the WorkflowIR semantic digest is identical across host resolutions (platform-neutral IR) and both hosts evaluate ELIGIBLE (capability + placement).
4. Verify host-specific capability resolution with equivalent meaning: the same step under `device_preferred` + explicit `cloud_allowed` fallback resolves web rank 0 / cloud rank 1 — placement substitution explicit, never silent.
5. Verify TRUE unsupported-platform rejection (distinct from cross-dimensional impossibility): (a) cloud-only fleet + device-local step → 0 eligible, placement-dimension rejection; (b) full fleet + protocol requirement above every deployed node's protocol version → 0 eligible, `PROTOCOL_VERSION_UNSUPPORTED` fail-closed.
6. Classify the browser.navigate+cloud_required case as what it is: a cross-dimensional capability×placement impossibility (each node fails a different dimension), NOT a platform rejection.
7. Execute as a standalone real process and persist the transcript verbatim below.

## Starting state

Fresh in-process node/capability directory (`DefaultNodeCapabilityService` with in-memory key/record stores). Deterministic environment: injected protocol clock base `1733568000000` (2024-12-07T10:40:00Z), sequential nonce source, fixed key seeds (`sha256('ig-002-dogfooding-cloud-host')`, `sha256('ig-002-dogfooding-web-host')`) → stable node ids, heartbeat lease TTL 60 000 ms. No network, no wall-clock dependence in protocol logic, no randomness.

## Expected outcome

- The real workflow validates and its semantic digest is IDENTICAL whichever host resolves it (the IR carries no platform semantics).
- Both host classes evaluate ELIGIBLE for the shared `workflow.observe` capability; host-specific placement resolution is explicit (ranks + satisfied placement reported).
- Unsupported platforms are rejected honestly: dimension-tagged reasons, 0 eligible nodes, never silent substitution/emulation.
- The protocol gate fails closed: no node silently downgrades to satisfy a newer protocol requirement.
- Overall: **equivalent workflow meaning on two supported host classes with host-specific capability resolution.**

## Observed outcome (verbatim run transcript)

Run: `cd /home/z/worktrees/IG-002/backend && bunx tsx tests/integration/integration-gates/run-ig-002-dogfooding.ts` — exit code 0, 2026-09-02T06:16:44Z (wall clock start 1788329804369 ms; wall duration 6 ms; wall-clock lines are run-instance bookkeeping, not protocol state — the protocol clock is injected).

```text
IG-002 WorkflowIR ↔ node-capability/placement — dogfooding run
work order: IG-002 (integration gate: V2-003 WorkflowIR × V2-004 node/capability protocol)
gate test: backend/tests/integration/integration-gates/ig-002-workflowir-capability-placement.integration.test.ts
branch base (merged main): def45e79db60d9b509263d2c166733ede9dc1b3d
injected protocol clock base: 1733568000000
nonce source: sequential (per service instance)
heartbeat lease TTL (ms): 60000
key seeds: sha256('ig-002-dogfooding-cloud-host'), sha256('ig-002-dogfooding-web-host')
wall clock start (ms): 1788329804369

authored workflow (real V2-003 authoring + validation):
  fixture                                buildTriageDocument() (backend/tests/unit/workflow-ir/helpers.ts)
  validateWorkflowIrDocument             ok=true
  semantic digest                        571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37
  nodes / edges                          6 / 5
per-node requirement projections (test-local IR→requirement adapter; V2-004 consumes requirements as data):
  fetch_issue                            capabilities=[github.repository.read] placement=cloud_allowed
  draft_summary                          capabilities=[github.repository.read] placement=cloud_allowed
  review_gate                            capabilities=[] placement=device_local privacy.localOnly=true
  notify_channel                         capabilities=[messaging.send] placement=cloud_preferred
  sync_backlog                           capabilities=[workflow.execute] placement=any_supported_node
  log_rejection                          capabilities=[filesystem.write] placement=device_local privacy.localOnly=true

host registration (real V2-004 protocol: enrollNodeKey → requestRegistrationChallenge → computeRegistrationResponse → completeRegistration → setNodeTrustAttributes):
  web host (device class)                node_d1cd87188e243581 platform=web location=device protocol=1
    capabilities                         workflow.observe, browser.navigate, browser.click
    supportsHumanApproval                true
  cloud host (cloud class)               node_742447f47f5ca742 platform=cloud location=cloud protocol=1
    capabilities                         workflow.execute, workflow.observe, github.repository.read
    supportsHumanApproval                false

dogfooding core — one real workflow on two supported host classes:
  workflow under test                    buildMinimalDocument() + workflow.observe observer node, placement any_supported_node
  WorkflowIR semantic digest             4a1ea87fd34088c6d535eba8a015cb826e8bba207c44227c351fd22a7c5d34eb (platform-neutral)
  digest stable across host resolutions  true
shared resolution (workflow.observe, any_supported_node):
  web host                               ELIGIBLE capability=true placement=true rank=0
  cloud host                             ELIGIBLE capability=true placement=true rank=0
host-specific resolution (device_preferred + explicit cloud_allowed fallback, requirement data not IR):
  web host                               ELIGIBLE capability=true placement=true rank=0 satisfied=device_preferred
  cloud host                             ELIGIBLE capability=true placement=true rank=1 satisfied=cloud_allowed

unsupported-platform rejections (explicit, dimension-tagged, never silent):
- cloud-only fleet + device_local browser step (no device-class node deployed):
  deployed platform set                  node_742447f47f5ca742 platform=cloud location=cloud (no device-class node)
  eligible nodes                         0
  cloud evaluation                       INELIGIBLE placement=false
  reasons                                capability:CAPABILITY_NOT_ADVERTISED; placement:PLACEMENT_LOCALITY_VIOLATION; placement:PRIVACY_LOCAL_ONLY_VIOLATION
  verdict                                UNSUPPORTED PLATFORM (no deployed device-class node): REJECTED HONESTLY
- cloud-only fleet + device_preferred browser step (no fallback admitted):
  eligible nodes                         0
  cloud evaluation                       INELIGIBLE placement=false
  reasons                                capability:CAPABILITY_NOT_ADVERTISED; placement:PLACEMENT_CLASS_MISMATCH
  verdict                                UNSUPPORTED PLATFORM (no deployed device-class node): REJECTED HONESTLY
- full fleet + minProtocolVersion 2 requirement (nodes registered at protocol version 1):
  eligible nodes                         0
  cloud evaluation                       INELIGIBLE protocol=false (capability=true placement=true)
    reasons                              protocol:PROTOCOL_VERSION_UNSUPPORTED
  web evaluation                         INELIGIBLE protocol=false (capability=true placement=true)
    reasons                              protocol:PROTOCOL_VERSION_UNSUPPORTED
  verdict                                UNSUPPORTED PLATFORM (protocol version): REJECTED HONESTLY
- full fleet + browser.navigate with cloud_required (each node fails a DIFFERENT dimension):
  eligible nodes                         0
  web reasons                            placement:PLACEMENT_CLASS_MISMATCH
  cloud reasons                          capability:CAPABILITY_NOT_ADVERTISED
  verdict                                CLASSIFIED: cross-dimensional impossibility (NOT platform rejection)

checks:
  ✓ authored triage workflow validates through the real V2-003 validator
  ✓ per-node requirement projections derived for every authored node (no fabricated ids)
  ✓ two host classes of different platform classes registered through the real V2-004 protocol
  ✓ WorkflowIR semantic digest identical across both host resolutions (platform-neutral IR)
  ✓ runner workflow validates (real V2-003 validator)
  ✓ both host classes eligible for the shared workflow.observe step (capability + placement)
  ✓ host-specific resolution: web host rank 0, cloud host rank 1 (explicit fallback, equivalent meaning)
  ✓ cloud-only fleet registers exactly one cloud-class node (no device-class node deployed)
  ✓ unsupported platform (no deployed device-class node, device_local): 0 eligible, placement-dimension rejection
  ✓ unsupported platform (no deployed device-class node, device_preferred): 0 eligible, PLACEMENT_CLASS_MISMATCH
  ✓ unsupported platform (protocol version): 0 eligible, every evaluation PROTOCOL_VERSION_UNSUPPORTED (fail-closed)
  ✓ cross-dimensional impossibility on the full fleet: 0 eligible, each node fails a different dimension (NOT platform rejection)
assertions: 12/12 passed

RESULT: equivalent workflow meaning on two supported host classes with host-specific capability resolution — PASS
wall duration (ms): 6
```

Summary of observed outcomes:

- **Equivalent workflow meaning on two host classes:** the WorkflowIR semantic digest (`4a1ea87f…`) was identical across both host resolutions (the IR never changed per host — platform-neutral), and the shared `workflow.observe` capability resolved ELIGIBLE on both the web and cloud host classes (capability + placement + protocol + trust all true).
- **Host-specific capability resolution, explicit:** under `device_preferred` with the explicit `cloud_allowed` fallback, the web host took rank 0 (`satisfied=device_preferred`) and the cloud host rank 1 (`satisfied=cloud_allowed`) — the substitution is reported, never silent.
- **True unsupported-platform rejection (its own proof item):** (a) no deployed device-class node → 0 eligible with placement-dimension reasons (`PLACEMENT_LOCALITY_VIOLATION`/`PRIVACY_LOCAL_ONLY_VIOLATION` for the hard `device_local` spelling, `PLACEMENT_CLASS_MISMATCH` for the non-hard `device_preferred` spelling); (b) protocol requirement above the deployed protocol version → 0 eligible, every evaluation `PROTOCOL_VERSION_UNSUPPORTED` while capability and placement remained satisfied — fail-closed, no silent protocol downgrade.
- **Correct boundary classification:** the browser.navigate+cloud_required case (both host classes deployed, each node failing a different dimension) is reported as a cross-dimensional impossibility, distinct from platform rejection — the architect's adversarial-review concern is addressed by explicit classification, not approximation.

## Duration / cost

Protocol run wall duration: 6 ms (single process; includes both full-fleet registrations, the cloud-only fleet registration, and 6 match resolutions). Total experiment loop including process startup: ~1.2 s (tsx boot). Protocol time is driven by the injected deterministic clock, so the protocol timeline is reproducible exactly.

## Node-auth boundary reasoning (registration channel, not execution attestation)

- The challenge-response is **registration-channel authentication** (HMAC-SHA256 over `workflowos/node-registration/v1` canonical-JSON payloads; single-use expiring nonces; timing-safe comparison) — it authenticates node identity and MACs the exact advertisement. It is not a signature, not an ExecutionStatement/Digest/Attestation, not a claim about any side effect, and carries no verification authority (constitution §21; registry authority rules).
- This gate deliberately introduces **no second authority**: the IR→requirement projection is test-local data adaptation (V2-004 consumes requirement data and must not absorb WorkflowIR semantics); capability possession stays distinct from authorization (asserted structurally — no `authorized`/`authorizationEligible` field exists on any evaluation).

## Evidence references

- Node identities: `node_d1cd87188e243581` (web/device class), `node_742447f47f5ca742` (cloud class) — deterministic SHA-256 node-key fingerprints over fixed seeds.
- Runner: `backend/tests/integration/integration-gates/run-ig-002-dogfooding.ts` (standalone real-process run; transcript above captured 2026-09-02T06:16:44Z, exit code 0).
- Gate test: `backend/tests/integration/integration-gates/ig-002-workflowir-capability-placement.integration.test.ts` (7 tests: 5 strengthened originals + 2 dedicated unsupported-platform-rejection proofs).
- Implementation commits on `feat/ig-002-ir-capability-placement-gate`: `40ccefc` (type-import + dimension-honest reason-code fixes — the PR-local TS defects), `b21f861` (true unsupported-platform rejection proofs + honest re-classification of the cross-dimensional case), `4fba33c` (dogfooding runner). Evidence commit: this file.
- Scoped verification at evidence time: gate test 7/7 green; `bun run typecheck` clean (the 4 CI TS errors gone); runner exit 0 (12/12 checks).
- Full-suite result at the final head: see the worklog record for this task (only the two PRE-EXISTING inherited development-governance files fail — the stale WORK-069 expectation owned by governance PR #139; out of gate scope per architect direction).

## Classification

**PASS** — equivalent workflow meaning verified on two supported host classes with host-specific capability resolution; unsupported platforms rejected honestly with dimension-tagged reasons (platform-class-not-deployed and protocol-version-unsupported as their own proof items); the capability×placement cross-dimensional case classified at the correct boundary; no platform SDK semantics entered the WorkflowIR; no second authorization/evidence authority introduced.

## Limitations recorded honestly (observations, not failures)

1. **In-process host identities.** V2-004 owns the node/capability protocol layer, not a network transport; the two hosts are two distinct authenticated node identities exercising the full real protocol logic through the real service in one process (same limitation recorded by the V2-004 dogfooding evidence, whose cross-process verification was deferred to this gate; a real multi-process transport remains future-surface work owned elsewhere).
2. **Projection adapter is test-local by design.** The frozen scope forbids making V2-004 absorb WorkflowIR semantics; the adapter is the composition seam the gate itself owns (test code), and the projection stays pure data mapping of canonical registry names/placement ids.
3. **Repository round-trip is IG-001's proof.** This gate exercises authoring/validation/digest + matching, not persistence; the repository ↔ IR round-trip (including the two-installed-versions clause) is persisted by the IG-001 gate evidence.

## Resulting action

- IG-002 remains **implemented / pending-architect-merge** (never marked COMPLETE by an agent). This evidence satisfies the Work Order's literal dogfooding clause and the required "unsupported-platform rejection" proof as its own item.
- No contract failure found; no corrective Work Order needed from this experiment. The PR-local TypeScript defects and the ambiguous unsupported-case classification were corrected within the gate's own scope (`40ccefc`, `b21f861`) before this evidence was captured.
