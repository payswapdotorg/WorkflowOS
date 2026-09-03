# IG-005 — Marketplace ↔ Self-Hosting Integration: dogfooding evidence

**Runner:** `backend/tests/integration/integration-gates/run-ig-005-dogfooding.ts` (executed from `backend/` with `bunx tsx`)
**Date:** 2026-09-03 (the frozen IG-005 dogfooding clause execution)
**Base:** `9d803b98849b978b694e045814a03346aab40866` (canonical main after the post-W6 reconciliation merge, PR #162)

## The executed clause

> Use a safe test workflow to fork, publish, install and execute it, then install and execute one first-party WorkflowOS development workflow through the same protocol.

The safe test workflow was the V2-012 fixture family (the repository ticket digest: a real V2-003 document with deterministic + agentic + secret-binding steps). The first-party workflow chosen for the same-protocol execution was the MAINTENANCE procedure (the only first-party artifact whose steps require no proof-predicate packaging — its four steps, including the HUMAN architect-triage gate, all execute through the ordinary run command surface).

## Machine-checkable results (both fresh-stack runs)

[PASS] governance-model-valid: the canonical governance-model.json loads and validates clean (the fail-closed governance state)

## run-1 — 1. THE THIRD-PARTY PROTOCOL (fork → publish → install)

[PASS] fork-provenance-recorded: the REAL fork records the upstream (workflow, version) and carries the source content as a NEW immutable version identity
[PASS] listing-published-pinned: the marketplace listing is PUBLISHED with revision 1 pinning the exact fork v2 (provenance riding verbatim)
[PASS] purchase-entitled-pinned: the customer's purchase settles exactly one charge and the entitlement pins the purchased version (content access only)
[PASS] installed-version-pinned: the published workflow is installed VERSION-PINNED through the real installation path (the exact purchased version identity)

## run-1 — 2. THE ENTITLEMENT BOUNDARY (entitlement is not an execution credential)

[PASS] commerce-creates-zero-runs: the FULL commerce flow (listing, publication, purchase, entitlement, installation) created ZERO runs — entitlement grants content access only
[PASS] entitlement-credential-refused: the ACTIVE entitlement id presented as an installation credential is refused TYPED (RUN_INSTALLATION_MISMATCH) — the marketplace identity is not an execution credential

## run-1 — 3. THE MAINTENANCE UPDATE (explicit transitions, pin held)

[PASS] maintenance-explicit-transition: the maintenance update is an EXPLICIT version transition (new immutable v3 + new revision pinning it; version history 1,2,3)
[PASS] maintenance-pin-held: the installed pin NEVER moved through the maintenance update (still the exact purchased v2 identity)

## run-1 — 4. EXECUTE THE THIRD-PARTY WORKFLOW (the real run, pinned)

[PASS] third-party-run-pinned: the REAL run pins the installed workflow EXACTLY (workflow, version, installation) and carries the authority's semantic digest
[PASS] third-party-run-completed: the third-party workflow executed END-TO-END through the real run command surface (3 declared steps, 3 capability invocations, honest evidence records, completed)

## run-1 — 5. THE FIRST-PARTY PROTOCOL (the same installation + execution authorities)

[PASS] first-party-boundary-admitted: the REAL governance boundary admits all six first-party artifacts (self-hosting does not bypass development governance)
[PASS] first-party-installed: the six first-party workflows installed through the SAME real authority (the maintenance manifest pins wfw_f9af3977eb2e27d55912a37c32cc9eb4@wfwv_187a6b4eefcddf7e814d217b9e0a85b6)
[PASS] first-party-same-install-protocol: the SAME universal installVersion call serves the first-party workflow and CONVERGES on the port-installed installation identity (one installation authority)
[PASS] first-party-run-pinned: the first-party run pins the manifest EXACTLY (workflow, version, installation) with the manifest's semantic digest — the same pin semantics as the third-party run
[PASS] first-party-run-completed: the first-party development workflow executed END-TO-END through the SAME run command surface (4 steps incl. the human architect-triage gate, completed)

## run-1 — 6. PROTOCOL EQUIVALENCE + EVIDENCE (the convergence)

[PASS] protocol-equivalence-pins: BOTH installations expose the SAME pin facts (workflow, version, versionNumber, contentDigest) through the SAME authority read surface — first-party and third-party are one protocol
[PASS] evidence-reconstruction-converges: the evidence reconstruction over the REAL run history converges with the first-party manifest (pin matches; the completed run attributed to the exact pinned installation; zero unpinned runs)

## Corrective observations (recorded per the dogfooding protocol)

1. **The universal installation protocol is observably ONE.** The third-party fork (a cross-tenant marketplace install of a purchased version) and the first-party library (the self-hosting development environment) both resolve to the SAME authority surface: the SAME `installVersion` call, the SAME pinned-version read-back shape, and the SAME convergence semantics (a duplicate install converges on the existing installation identity — `created: false`). The gate found no protocol fork between marketplace distribution and self-hosting.
2. **The entitlement boundary is structural, not procedural.** The full commerce flow (listing → publication → purchase → installation) created zero runs, and the active entitlement id presented to the run authority as an installation credential was refused with the authority's own typed code (RUN_INSTALLATION_MISMATCH). Execution authorization lives entirely in the run authority's chain (membership + pinned-version resolution + installation pin match); the marketplace's version-access decision shape (entitled/basis/entitlementId) carries no execution concept at all.
3. **Maintenance transitions are explicit on both sides.** The marketplace maintenance update created a new immutable version (v3) and a new pinning revision (sequence 2) while the customer's installation stayed pinned to the purchased v2 — and the first-party library's governed transition (publish + install through the real authorities, with the recovery advance requiring the installed read-back) is the same discipline. No in-place mutation of any pin, revision or version was observed anywhere in the experiment.
4. **The human gate is honest.** The first-party MAINTENANCE procedure's architect_triage step executed as a HUMAN step (no capability invocation — the approval is the human act, recorded as step outcome, exactly as the governance model prescribes). The dogfood recorded it honestly rather than simulating an agentic step in its place.
5. **Fork provenance is durable distribution metadata.** The fork's upstream facts rode the listing trust view verbatim through publication and the maintenance revision, and the fork's v1 still carried the source content digest byte-identically — provenance survives publication exactly as the work order requires.

## Determinism

The experiment ran twice on fresh stacks (fresh PGlite with ALL migrations, fresh identities). The structured facts were identical across both runs; the normalized transcripts (eliding only generated identities — the V2-002/V2-005 uuid-shaped ids, the digests, the run labels) were byte-identical.

## Honest scope statement

The dogfood drove the repository surfaces at the service level (the exact service behind the real routes; the integration battery drives the identical surface through the real HTTP routes via `app.inject`). It did NOT drive a real payment provider (the frozen V2-012 rule: the deterministic in-memory TEST adapter is the reference implementation) and did NOT drive the V2-008 ComputerAgentRuntime host-execution path (the capability invocations were recorded through the run authority's command surface — the worker's real recording path).
