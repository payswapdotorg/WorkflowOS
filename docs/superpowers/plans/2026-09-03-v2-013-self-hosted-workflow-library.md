# V2-013 — Self-Hosted Workflow Library: implementation plan

**Base:** `d97a92f8ba243a47e2ac173d0b189dd79814aeca` (canonical `main` after the architect merge of V2-015 PR #158).
**Branch:** `feat/v2-013-self-hosted-workflow-library` (rooted EXACTLY at the base; no sibling consumption, no rebase).
**Frozen contract:** `spec/architecture/v2/work-orders/V2-013.md` (+ `V2-CTRL-002-roadmap-lock.md`, `V2-CTRL-003-protocol-registry.md`, the governance constitution artifacts, `spec/development-state/governance-model.json`).

## Goal

Deliver V2-013 on main: a first-party WorkflowOS development-workflow library — the six development procedures (implementation, review, testing, release, maintenance, dogfooding) as ordinary WorkflowIR documents, their repository/version manifests, self-hosting installation for development environments through the SAME V2-002 installation authority third-party workflows use, the safe self-hosting permission boundary (governance-preserved, fail-closed), safe execution packaging that consumes V2-015 proof predicates where a first-party step requires a `VerifiedExecutionFact`, typed failed-workflow recovery, and deterministic evidence reconstruction. Plus the frozen dogfooding: WorkflowOS itself installs and executes one development workflow end-to-end with the repository recording the evidence, and the proof predicate satisfied by a valid, fresh, authorized execution attestation (never an assertion or replay).

## Module shape (the V2-012/V2-015 family precedent)

`backend/src/self-hosted-library/` — a PURE application-layer domain module: `index.ts` (public barrel), `types.ts` (public contracts), `internal/*` (private). NO routes, NO migrations, NO new dependencies, no wall clock / randomness / network in the module source (all injected/deterministic).

### Consumed authorities (public barrels ONLY; pinned by the boundary battery)

- **V2-003 workflow-ir** — the ONLY workflow-semantics authority: artifacts are authored THROUGH `createWorkflowIrBuilder`; digests through `computeWorkflowVersionSemanticDigest`; validation through `validateWorkflowIrDocument`/`parseWorkflowIrDocument`. Never re-implemented.
- **V2-002 workflow-repository** — the ONLY workflow/version/install authority: installation composes through a NARROW structural port (`Pick<WorkflowRepositoryService, 'createWorkflow' | 'createVersion' | 'installVersion' | 'getInstallation'>` — the MarketplaceVersionReader precedent extended to the install surface V2-013 owns). First-party and third-party workflows install through the SAME authority.
- **V2-005 workflow-runs** — the Run/evidence authority: TYPE-ONLY consumption of `WorkflowRunHistory`/run-state shapes for evidence reconstruction. No runs created here.
- **V2-015 execution-proof-graph** — the proof-composition authority: proof-required steps consume `evaluateProofAdmission` (V2-015 public barrel) with `PredecessorEvidence` + trust policy; failures carried VERBATIM. Attestation types via V2-015's re-exports.
- **development-governance (WORK-052 / architecture-checkpoints)** — the governance authority: the boundary evaluator consumes `CORE_SELF_HOSTING_PROHIBITIONS` (code-pinned) and the `SelfHostingBoundary` type READ-ONLY; the packaging fails closed when a supplied boundary model is absent/weakened.
- **NOT imported:** marketplace (V2-012 — independent sibling), computer-agent (V2-008 — packaging produces typed preconditions, never executes), execution-attestation directly (through V2-015's re-exports), orchestration/work item modules (no second Work Item authority).

### Registry conformance

V2-013 introduces NO new protocol-visible identifiers: every artifact capability is an EXISTING canonical registry name; every event/concept name is reused. Module-internal vocabularies (procedure kinds, packaging failure codes) follow the V2-015 module-internal precedent (not registry objects). A discrimination test pins that no non-canonical capability name appears in any artifact.

## Public surface (types.ts)

- §0 vocabulary: `FIRST_PARTY_PROCEDURE_KINDS` = implementation / review / testing / release / maintenance / dogfooding (frozen, exactly the six the work order names).
- §1 artifacts: `FirstPartyWorkflowArtifact` { kind, slug, name, description, document: WorkflowIrDocument, executionPolicy: FirstPartyExecutionPolicy { proofRequiredSteps: readonly stepId[] } }.
- §2 boundary: `SelfHostingBoundaryPolicyInput` (the governance model's selfHostingBoundary, read-only data); `FIRST_PARTY_ALLOWED_CAPABILITIES` (frozen allowlist of canonical registry capabilities first-party dev workflows may declare); `GOVERNANCE_PROTECTED_SURFACES` (frozen repository path prefixes that are governance-authoritative); `evaluateSelfHostingBoundary` typed verdict.
- §3 installation: `FirstPartyInstallPort` (structural over V2-002); `installFirstPartyWorkflows` → `FirstPartyInstallOutcome` per kind (manifest + created/converged flags).
- §4 manifest: `FirstPartyWorkflowManifest` { kind, workflowId, versionId, versionNumber, contentDigest, semanticDigest, installationId } — the repository/version manifest V2-013 owns; deterministic derivation.
- §5 packaging: `packageFirstPartyExecution` → `SelfHostingExecutionPackage` (allowed: pinned version facts + boundary verdict + admitted proof predicates + boundary fingerprint) | typed `SelfHostingPackagingFailure` (`SELF_HOSTING_PACKAGING_FAILURE_CODES`); proof-predicate failures carry the V2-015 admission failure verbatim.
- §6 recovery: `planFailedWorkflowRecovery` → typed plan { retry_same_pin | advance_version | blocked } (a failed run is NEVER resurrected in place; the pin NEVER moves silently).
- §7 evidence: `reconstructSelfHostingEvidence` → deterministic `SelfHostingEvidenceRecord` composed from manifests + installation details + run history.

## Task breakdown (red→green per task; batteries run twice before each commit)

1. **Boundary battery first (RED), module skeleton (GREEN)** — `tests/architecture/self-hosted-library-battery.test.ts`: canonical layout, public-barrel-only imports, no V2-012/V2-008 imports, no run-lifecycle/verification/work-item concepts, no wall clock/random/network, no new protocol-visible identifiers, registry-canonical capabilities only.
2. **First-party artifacts + manifest derivation** — `internal/first-party-artifacts.ts` (six deterministic WorkflowIR documents via the V2-003 builder; canonical capabilities; proof-required steps declared) + unit battery `artifacts.test.ts` (valid per V2-003 parse/validate, deterministic digests, distinct kinds, canonical capability names only, proof-required steps exist in the IR).
3. **Self-hosting permission boundary** — `internal/boundary.ts` + `boundary.test.ts`: valid artifacts allowed; single-dimension mutations (merge-capability claim, governance-protected-surface write binding, non-canonical capability, weakened boundary model, missing boundary) each denied with its OWN typed code (discrimination).
4. **Installer + version pinning** — `internal/installer.ts` + `installation.test.ts` over an in-memory fake port: deterministic manifests, create-or-converge idempotence, pin recording; pin drift detected at packaging.
5. **Execution packaging + proof-consumption** — `internal/packaging.ts` + `packaging.test.ts` with REAL Ed25519 attestations: admitted package on valid fresh facts (V2-014 verify → V2-015 admission through the V2-013 wrapper); replayed nonce / failed verification / wrapper-fact substitution / stale → typed denial, V2-015 codes verbatim, NO package minted.
6. **Failed-workflow recovery** — `internal/recovery.ts` + `recovery.test.ts`: failed run → retry_same_pin (a NEW run against the same pin); advance_version ONLY as an explicit manifest transition; governance-blocked typed; never in-place resurrection.
7. **Evidence reconstruction** — `internal/evidence.ts` + `evidence.test.ts`: reconstruction from run history + manifests converges (independent reconstruction == recorded manifest), deterministic.
8. **Integration battery on the REAL stack** — `tests/integration/self-hosted-library/self-hosting.integration.test.ts`: real Fastify app (app.inject) + real V2-002 routes; first-party install through the same authority as a third-party workflow (protocol equivalence), version pin immutability under a new version, governance preservation from the REAL `spec/development-state/governance-model.json`, weakened-boundary fail-closed, recovery on a REAL failed run (real V2-005 service), evidence reconstruction from real run history.
9. **Dogfooding** — `tests/integration/self-hosted-library/run-v2-013-dogfooding.ts` (the V2-015 runner's real-stack composition): install ONE development workflow through the REAL V2-002 routes; execute it end-to-end through the REAL V2-005 run service (real run pinned to workflow+version+installation, real step/evidence records); the proof-required step's predicate satisfied by a REAL Ed25519 attestation verified by an INDEPENDENT verifier process and admitted through V2-015 admission (valid/fresh/authorized); a REPLAYED attestation rejected typed; evidence recorded in `spec/architecture/v2/dogfooding-evidence/V2-013-self-hosted-workflow-library.md` with corrective observations.
10. **Final verification** — full backend battery, typecheck (zero new errors), scoped lint, push, PR, evidence posting. NOT MERGED — the architect merge is the completion event.

## Required-regression mapping (frozen work order → batteries)

| Regression | Battery |
| --- | --- |
| self-hosting permission boundary | boundary.test.ts (unit) + integration governance-preservation |
| workflow version pinning | installation.test.ts + integration pin-immutability |
| failed-workflow recovery | recovery.test.ts + integration recovery on a real failed run |
| governance preservation | boundary.test.ts (core-prohibition fail-closed) + integration (real governance-model.json) |
| evidence reconstruction | evidence.test.ts + integration reconstruction from real run history |
| no bypass of authoritative development state | boundary.test.ts (protected-surface mutation) + boundary battery import pins |
| first-party/third-party protocol equivalence | integration (same real authority, same pin semantics) |
| rejection of invalid/replayed execution-proof predicates | packaging.test.ts + dogfooding (real replay rejection) |
