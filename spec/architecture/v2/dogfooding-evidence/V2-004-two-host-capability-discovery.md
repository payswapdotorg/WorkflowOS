# V2-004 Two-Host Capability Discovery — Dogfooding Evidence

**Work Order:** V2-004 — Node + Capability Protocol
**Classification of capability:** execution-facing protocol capability (node/capability directory; not a human UI surface)
**Validation type:** real-protocol two-host capability-discovery experiment (work-order dogfooding requirement: "Discover capabilities from two real supported host classes and run the same workflow semantics through both where the required capabilities exist")
**Status:** EVIDENCE PERSISTED — experiment run through the real protocol path; Work Order remains pending-architect-merge (agents never mark COMPLETE)

## Work Order ID

V2-004 — Node + Capability Protocol, wave W1, branch `work/V2-004`, base `dff907d16728c7124fab5176b21622d927178b3d`.

## Workflow / version under test

V2-002 (repository/versioning) and V2-003 (WorkflowIR) are parallel W1 siblings and, per the wave's no-rebase rule, are **not** consumed. The workflow semantics under test are therefore the **representative workflow-step requirement sets** that the V2-004 module treats as protocol data (`NodeRequirementSet`: canonical capability requirements + placement + privacy constraints), exactly the surface V2-004 owns:

| Requirement id | Required capabilities | Placement | Privacy |
|---|---|---|---|
| `V2-004-DOG-REQ-1-observe-run` | `workflow.observe` | `any_supported_node` | — |
| `V2-004-DOG-REQ-2-placement-preference` | `workflow.observe` | `device_preferred` (fallback `cloud_allowed`) | — |
| `V2-004-DOG-REQ-3-open-github-pr` | `github.pull_request.create`, `github.repository.read` | `cloud_required` | — |
| `V2-004-DOG-REQ-4-local-browser-step` | `browser.navigate` | `device_local` | `localOnly: true` |
| `V2-004-DOG-REQ-5-local-only-privacy` | `workflow.observe` | `cloud_allowed` | `localOnly: true` |

These are declared in `backend/tests/integration/node-capability/dogfooding-two-hosts.harness.ts` (`DOGFOODING_REQUIREMENTS`).

## Surface / host

Two node identities of **different platform classes**, both registering through the REAL protocol path (key enrollment → nonce challenge → HMAC-SHA256 challenge-response → registration → session → trust attributes → heartbeats → matching):

- **Host A (device/browser class):** node id `node_795e8b12eaef3e45`, key fingerprint `node_795e8b12eaef3e45`, platform class `web`, location class `device`, protocol version 1, declared capabilities `browser.navigate`, `browser.click`, `browser.type`, `browser.observe`, `notifications.observe`, `workflow.observe` (the genuinely cloud-shared capability), `supportsHumanApproval: true`, health `healthy`, trust tier set to `trusted` by the directory.
- **Host B (cloud class):** node id `node_76411bc6944a64cd`, key fingerprint `node_76411bc6944a64cd`, platform class `cloud`, location class `cloud`, protocol version 1, declared capabilities `workflow.execute`, `workflow.pause`, `workflow.resume`, `workflow.cancel`, `workflow.observe`, `github.repository.read`, `github.pull_request.create`, `github.pull_request.merge`, `supportsHumanApproval: false`, health `healthy`, trust tier `trusted`.
- **Authentication mechanism (registration channel only):** HMAC-SHA256 challenge-response over domain-separated canonical-JSON payloads (`workflowos/node-registration/v1`; fingerprints over `workflowos/node-key/v1`; session tokens over `workflowos/node-session/v1`), single-use expiring nonces, timing-safe comparison. 2 challenges exchanged, 2 sessions issued.

## Exact task

1. Register both hosts through the authenticated registration protocol (out-of-band key enrollment of fixed seed material → challenge → node-side MAC computation via `computeRegistrationResponse` → directory verification → session issuance).
2. Set node trust attributes and demonstrate liveness: registered → stale (lease expiry via the injected clock) → heartbeat-recovered (fresh heartbeats with valid session tokens).
3. Resolve the SAME five-requirement set through BOTH hosts via the real matcher (`matchNodes`), asserting: equivalence where capabilities exist on both hosts; explicit, dimension-tagged ineligibility where they do not (honest difference reporting, constitution §13).
4. Execute as a standalone real process (`bunx tsx tests/integration/node-capability/run-two-host-dogfooding.ts`) and persist the transcript verbatim below.

## Starting state

Fresh in-process node+capability directory (`DefaultNodeCapabilityService` with in-memory key/record stores). Deterministic environment: injected protocol clock base `1733568000000` (2024-12-07T10:40:00Z), sequential nonce source, fixed key seeds (`v2-004-dogfood-cloud-host-key`, `v2-004-dogfood-browser-host-key`) → stable node ids, heartbeat lease TTL 60 000 ms. No network, no wall-clock dependence in protocol logic, no randomness.

## Expected outcome

- The shared capability `workflow.observe` resolves **equivalently** on both host classes (REQ-1, REQ-2, REQ-5).
- Placement preference resolves deterministically: web host rank 0 (`device_preferred`), cloud host rank 1 (`cloud_allowed` fallback).
- Capabilities absent on one host produce explicit `CAPABILITY_NOT_ADVERTISED` ineligibility — never emulation, substitution, or silent fallback (constitution §5).
- Locality (`device_local`) and privacy (`localOnly`) violations on the cloud host produce explicit `PLACEMENT_LOCALITY_VIOLATION` / `PRIVACY_LOCAL_ONLY_VIOLATION` (constitution §12/§16/§19).
- Stale nodes are excluded; a fresh heartbeat re-includes them.
- Overall: **all shared capabilities resolve equivalently on both host classes.**

## Observed outcome (verbatim run transcript)

Run: `cd /home/z/worktrees/V2-004/backend && bunx tsx tests/integration/node-capability/run-two-host-dogfooding.ts` — exit code 0, 2026-09-01T14:04:49Z (wall clock start 1788271489916 ms; wall duration 2 ms; wall-clock lines are run-instance bookkeeping, not protocol state — the protocol clock is injected).

```text
V2-004 two-host capability discovery — dogfooding run
work order: V2-004 (node+capability protocol v1)
injected protocol clock base: 1733568000000
wall clock start (ms): 1788271489916
wall duration (ms): 2

authentication (registration channel only):
  mechanism                          hmac-sha256-challenge-response
  MAC domain                         workflowos/node-registration/v1
  challenges exchanged               2
  sessions issued                    2

host A (device/browser class):
  node id                            node_795e8b12eaef3e45
  key fingerprint                    node_795e8b12eaef3e45
  platform class                     web
  location class                     device
  capabilities                       browser.navigate, browser.click, browser.type, browser.observe, notifications.observe, workflow.observe

host B (cloud class):
  node id                            node_76411bc6944a64cd
  key fingerprint                    node_76411bc6944a64cd
  platform class                     cloud
  location class                     cloud
  capabilities                       workflow.execute, workflow.pause, workflow.resume, workflow.cancel, workflow.observe, github.repository.read, github.pull_request.create, github.pull_request.merge

liveness phases (heartbeat/lease):
  registered                         node_76411bc6944a64cd, node_795e8b12eaef3e45
  stale                              <no eligible nodes>
  heartbeat-recovered                node_76411bc6944a64cd, node_795e8b12eaef3e45

requirement resolutions (same requirement set through both hosts):
- V2-004-DOG-REQ-1-observe-run
  required capabilities              workflow.observe
  placement                          any_supported_node
  node web                           ELIGIBLE (capability=true, placement=true, rank=0)
    reasons                          none
  node cloud                         ELIGIBLE (capability=true, placement=true, rank=0)
    reasons                          none
- V2-004-DOG-REQ-2-placement-preference
  required capabilities              workflow.observe
  placement                          device_preferred (fallback: cloud_allowed)
  node web                           ELIGIBLE (capability=true, placement=true, rank=0)
    reasons                          none
  node cloud                         ELIGIBLE (capability=true, placement=true, rank=1)
    reasons                          none
- V2-004-DOG-REQ-3-open-github-pr
  required capabilities              github.pull_request.create, github.repository.read
  placement                          cloud_required
  node web                           INELIGIBLE (capability=false, placement=false, rank=n/a)
    reasons                          capability:CAPABILITY_NOT_ADVERTISED; capability:CAPABILITY_NOT_ADVERTISED; placement:PLACEMENT_CLASS_MISMATCH
  node cloud                         ELIGIBLE (capability=true, placement=true, rank=0)
    reasons                          none
- V2-004-DOG-REQ-4-local-browser-step
  required capabilities              browser.navigate
  placement                          device_local
  node web                           ELIGIBLE (capability=true, placement=true, rank=0)
    reasons                          none
  node cloud                         INELIGIBLE (capability=false, placement=false, rank=n/a)
    reasons                          capability:CAPABILITY_NOT_ADVERTISED; placement:PLACEMENT_LOCALITY_VIOLATION; placement:PRIVACY_LOCAL_ONLY_VIOLATION
- V2-004-DOG-REQ-5-local-only-privacy
  required capabilities              workflow.observe
  placement                          cloud_allowed
  node web                           ELIGIBLE (capability=true, placement=true, rank=0)
    reasons                          none
  node cloud                         INELIGIBLE (capability=true, placement=false, rank=n/a)
    reasons                          placement:PRIVACY_LOCAL_ONLY_VIOLATION

cross-host equivalence checks (capabilities genuinely on both hosts):
  V2-004-DOG-REQ-1-observe-run / workflow.observe EQUIVALENT
  V2-004-DOG-REQ-2-placement-preference / workflow.observe EQUIVALENT
  V2-004-DOG-REQ-5-local-only-privacy / workflow.observe EQUIVALENT

honest ineligibility differences (explicit, never silent):
  V2-004-DOG-REQ-3-open-github-pr    node_795e8b12eaef3e45 → CAPABILITY_NOT_ADVERTISED
    detail                           required capability "github.pull_request.create" is not advertised by node node_795e8b12eaef3e45 (no substitution, emulation, or fallback)
  V2-004-DOG-REQ-3-open-github-pr    node_795e8b12eaef3e45 → CAPABILITY_NOT_ADVERTISED
    detail                           required capability "github.repository.read" is not advertised by node node_795e8b12eaef3e45 (no substitution, emulation, or fallback)
  V2-004-DOG-REQ-3-open-github-pr    node_795e8b12eaef3e45 → PLACEMENT_CLASS_MISMATCH
    detail                           node node_795e8b12eaef3e45 is a device node (web) and does not satisfy placement chain cloud_required
  V2-004-DOG-REQ-4-local-browser-step node_76411bc6944a64cd → CAPABILITY_NOT_ADVERTISED
    detail                           required capability "browser.navigate" is not advertised by node node_76411bc6944a64cd (no substitution, emulation, or fallback)
  V2-004-DOG-REQ-4-local-browser-step node_76411bc6944a64cd → PLACEMENT_LOCALITY_VIOLATION
    detail                           device_local is a locality correctness constraint and node node_76411bc6944a64cd is a cloud node (cloud)
  V2-004-DOG-REQ-4-local-browser-step node_76411bc6944a64cd → PRIVACY_LOCAL_ONLY_VIOLATION
    detail                           requirement forbids data leaving the device (localOnly) and node node_76411bc6944a64cd is a cloud node
  V2-004-DOG-REQ-5-local-only-privacy node_76411bc6944a64cd → PRIVACY_LOCAL_ONLY_VIOLATION
    detail                           requirement forbids data leaving the device (localOnly) and node node_76411bc6944a64cd is a cloud node

RESULT: all shared capabilities resolved equivalently on both host classes
```

Summary of observed outcomes:

- **Equivalence:** the shared capability `workflow.observe` resolved EQUIVALENT on both host classes in REQ-1, REQ-2 and REQ-5 (3/3 checks). REQ-2 ordering was deterministic: web host rank 0 / cloud host rank 1 via the explicit `cloud_allowed` fallback.
- **Honest ineligibility (explicit, dimension-tagged):** REQ-3 web host — 2× `CAPABILITY_NOT_ADVERTISED` + `PLACEMENT_CLASS_MISMATCH`; REQ-4 cloud host — `CAPABILITY_NOT_ADVERTISED` + `PLACEMENT_LOCALITY_VIOLATION` + `PRIVACY_LOCAL_ONLY_VIOLATION`; REQ-5 cloud host — capability present but `PRIVACY_LOCAL_ONLY_VIOLATION` (capability possession ≠ eligibility, registry authority rule `capability-advertisement-is-not-authorization`).
- **Liveness:** both hosts eligible after registration → zero eligible while stale (lease expired at injected clock +60 001 ms) → both re-eligible after fresh authenticated heartbeats.
- **No leakage:** requirement sets reference only canonical registry names and placement ids; no platform SDK names entered any protocol surface (registry-conformant validation rejects non-canonical aliases at registration time).

## Duration / cost

Protocol run wall duration: 2 ms (single process; includes both registrations, 3 liveness probes, 5 two-host match resolutions). Total experiment loop including process startup: ~0.5 s (tsx boot). Protocol time is driven by the injected deterministic clock, so the protocol timeline is reproducible exactly.

## Node-auth boundary reasoning (registration channel, not execution attestation)

- The challenge-response is **registration-channel authentication**: it proves possession of node-scoped key material at registration time and MACs the exact canonical-JSON registration payload (platform class, protocol version, capability advertisement, attributes) so the advertisement cannot be altered in transit. Session tokens likewise authenticate the node's session channel (re-registration invalidates earlier tokens).
- It is HMAC-SHA256 message authentication verified by the directory — the only party that needs to verify it. It is **not** a signature, **not** an ExecutionStatement/Digest/Attestation, **not** a claim about any side effect, and it carries **no verification authority**. It never becomes execution truth: node authentication is one dimension (node identity) kept strictly separate from workload identity, capability possession, authorization, placement, policy, and assurance (constitution §21; registry authority rules).
- The V2-014 attestation object types (`workflowos/execution-statement/v1`, `workflowos/execution-attestation/v1`, `workflowos/execution-proof-graph/v1`) are structurally absent from `backend/src/node-capability/**`; MAC input domains are node-scoped (`workflowos/node-key/v1`, `workflowos/node-registration/v1`, `workflowos/node-session/v1`) so a registration MAC can never be replayed as any other protocol fact. Absence is pinned by `tests/unit/node-capability/module-boundary.test.ts`.

## Evidence references

- Node identities: `node_795e8b12eaef3e45` (web/device class), `node_76411bc6944a64cd` (cloud class); key fingerprints identical to node ids (deterministic SHA-256 over `workflowos/node-key/v1` + fixed seed material).
- Runner: `backend/tests/integration/node-capability/run-two-host-dogfooding.ts` (standalone real-process run; transcript above captured 2026-09-01T14:04:49Z).
- Harness: `backend/tests/integration/node-capability/dogfooding-two-hosts.harness.ts` (real protocol paths: `enrollNodeKey` → `requestRegistrationChallenge` → `computeRegistrationResponse` → `completeRegistration` → `setNodeTrustAttributes` → `heartbeat` → `matchNodes`).
- Contract pinning: `backend/tests/integration/node-capability/two-host-discovery.integration.test.ts` (7 tests, incl. the determinism check that a second run produces the identical protocol report modulo wall-clock bookkeeping).
- Implementation commits on `work/V2-004`: `8e4e2d4` (deterministic red suite), `764f23a` (implementation). Evidence commit: `docs(node-capability): persist V2-004 two-host dogfooding evidence` (this file).
- Scoped test state at evidence time: 94 passed / 10 files (`bunx vitest run tests/unit/node-capability tests/integration/node-capability`).

## Classification

**PASS** — all shared capabilities resolved equivalently on both real host classes; every absent capability, locality, privacy, and liveness condition produced an explicit dimension-tagged ineligible result; no silent substitution, emulation, or platform-specific semantic leakage occurred.

## Limitations recorded honestly (observations, not failures)

1. **In-process host identities.** V2-004 owns the node/capability protocol layer, not a network transport (the W1 ownership map assigns routes only to V2-002; V2-004 has none). The two hosts are therefore two distinct authenticated node identities exercising the full real protocol logic through the real service in one process. Cross-process/transport verification is deferred to IG-002 shared integration per wave rules.
2. **Requirement sets as data, not WorkflowIR.** Sibling V2-003's WorkflowIR is not consumable at this base (no-rebase). The experiment uses the representative requirement-set form the protocol actually receives, which is exactly V2-004's owned surface; IG-002 re-verifies matching against real WorkflowIR semantics after the wave lands.

## Resulting action

- V2-004 remains **implemented / pending-architect-merge** (never marked COMPLETE by an agent). This evidence satisfies the Work Order's dogfooding requirement and the anti-repeat rule for the next consumer: V2-005 (Run/evidence) must consume this two-host result when routing runs to nodes.
- No contract failure found; no corrective Work Order needed from this experiment. Observations 1–2 above are non-blocking and already tracked by the wave's integration gates.
