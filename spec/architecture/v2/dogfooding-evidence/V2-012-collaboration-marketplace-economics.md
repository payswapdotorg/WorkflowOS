# V2-012 — Collaboration + Marketplace + Economics — Dogfooding Evidence

**Work Order:** V2-012 — Collaboration + Marketplace + Economics
**Classification of capability:** feature implementation (marketplace/economics domain module composed OVER the merged V2-002 repository authority); not a human UI surface
**Validation type:** real-stack feature-boundary dogfooding experiment (work-order dogfooding requirement, literal frozen clause: "Use a safe test workflow to fork, modify, publish, install and complete a test transaction; verify creator entitlement and version history")
**Status:** EVIDENCE PERSISTED — experiment run through the real integrated paths; work order remains pending-architect-merge (agents never mark COMPLETE)

## Work Order ID

V2-012 — Collaboration + Marketplace + Economics, wave W5, branch `feat/v2-012-collaboration-marketplace-economics`, base `927f23dea74bd2d9206fb55e8cb084088650d97c` (current main after the IG-004 gate merge). Dependencies: V2-002, V2-005, V2-006, V2-011 — all merged on this base. Scope: repository collaboration/visibility extensions, publishing/install distribution, entitlement, creator economics, maintenance subscriptions, marketplace-specific trust metadata — implemented as the new `backend/src/marketplace` module consuming the merged public barrels only (zero modifications to any existing file; zero new migrations; zero new routes — the repository authority's existing routes carry every version-identity step).

## Workflow / version under test

ONE safe test workflow — the **repository ticket digest report** (the merged V2-003 builder; `github.repository.read` / `messaging.send` disclosure, a REAL `secret_ref` binding on the send step for the secret-isolation proof). Version lifecycle exercised on the REAL V2-002 repository:

- **upstream v1** — authored by the original tenant through the real route, made PUBLIC (the collaboration surface).
- **fork v1** — the second tenant's fork through the REAL V2-002 fork route (fork provenance `forkedFromWorkflowId`/`forkedFromVersionId` preserved; a NEW immutable version identity carrying the source content, content digest `1f0189d77…1fbc`).
- **fork v2 (the derivative)** — the forker's explicit NEW immutable version (number 2, distinct content digest `15d012661…561c`, V2-003 semantic digest `161dc0db6…3283`) created through the real createVersion route; the fork made public; PUBLISHED as the listing revision 1.
- **fork v3 (the maintenance update)** — an explicit NEW revision (sequence 2) pinning a NEW real version; revision 1 UNCHANGED — never an in-place mutation.

## Surface / host

The REAL stack, one process, inject-driven HTTP over the REAL Fastify app:

- **Persistence:** real PGlite with ALL 62 migrations.
- **Identity:** the real identity stack — API-key operator per tenant (author, forker, customer), provisioned through the real credential provisioner.
- **Routes:** the REAL V2-002 workflow-repository routes (create workflow → visibility → fork → createVersion → cross-tenant install), every repository step over `app.inject()`.
- **Marketplace composition:** the new `DefaultMarketplaceService` composed OVER the real repository authority — the `MarketplaceVersionReader` port satisfied structurally by the REAL `DefaultWorkflowRepositoryService` (the exact service behind the routes); the marketplace's own in-memory listing/entitlement/transaction store; the module's deterministic in-memory payment adapter (NO real provider calls — the frozen V2-012 rule: payment-provider semantics stay behind the adapter; nothing provider-specific reaches WorkflowIR, Run, execution, or authorization contracts).

## Exact task

1. AUTHOR the safe test workflow through the real route; make the repository workflow public.
2. FORK the public v1 through the REAL V2-002 fork route; verify fork provenance.
3. MODIFY: the forker's explicit NEW immutable version v2 on the fork through the real createVersion route; make the fork public.
4. PUBLISH the derivative (one-time purchase offer, `pinned_only` updates); verify the listing revision pins the EXACT real version identity and the trust view surfaces fork provenance + real capability disclosure.
5. TRANSACTION: a customer browses the published listing and accepts the one-time offer; the deterministic adapter settles the charge; duplicate acceptance converges with EXACTLY ONE charge; the entitlement pins fork v2.
6. INSTALL the purchased version through the REAL cross-tenant install route (the installation PINS the purchased version, status enabled).
7. MAINTENANCE UPDATE: the creator publishes an explicit new revision pinning a NEW real version (fork v3); verify revision 1 is unchanged, the customer's installation still pins the purchased fork v2, and the purchased version is byte-identical (paid-version pinning).
8. CREATOR ENTITLEMENT + VERSION HISTORY: the customer's entitlement grants CONTENT access to the purchased fork v2 (basis `one_time_purchase`) and NOTHING else (the `pinned_only` update attempt is denied typed `update_not_included`); the creator reads the same succeeded transaction; the fork's repository versions [1, 2, 3] and the listing revisions [v2, v3] agree — 3 distinct content digests, full provenance chain.
9. Verify execution-authority separation (the whole commerce loop created ZERO runs; the access decision exposes exactly `{entitled, basis, entitlementId}`) and secret isolation (the fixture's real `secret_ref` binding never appears in any marketplace record).
10. Execute as a standalone real process, TWICE on fresh stacks, and persist the transcript verbatim below.

## Starting state

Fresh PGlite + fresh identity stack per run. Deterministic environment: injected clocks, sequential id factories, fixed fixture content. No network, no wall-clock dependence in domain logic, no randomness, no real payment provider (the deterministic adapter's receipt sequence is fixed: `pay_1`, 19.99 USD, succeeded). The only wall-clock facts are the run-instance timestamps/durations below. Run-scoped repository ids (uuid-shaped `wfw_`/`wfwv_`/`wfin_`) differ per run by design of the authority's id factory; the structured facts (content digests, semantic digests, adapter receipts, sequences, typed outcomes) are identical across runs.

## Expected outcome

- Repository/version authority remains V2-002 end-to-end: fork provenance, explicit new versions, publication pins, installs — all through the real authority; the marketplace never introduces a second WorkflowVersion identity or persistence authority.
- Fork → modify → publish → install → transaction completes with the entitlement pinning the exact purchased version; duplicate acceptance converges with exactly one charge.
- Maintenance updates are explicit new revisions; published versions are never mutated in place; paid-version pinning holds (the customer's installation and purchased bytes unchanged).
- Entitlement grants content/version access ONLY: zero runs created by the commerce loop; the upgrade attempt outside the purchased basis is denied typed; secrets never leak into marketplace records.
- Overall: **workflows behave as repository-like collaborative artifacts that can be shared, forked, published, installed and monetized — with creator economics settled deterministically behind the adapter boundary.**

## Observed outcome (verbatim run transcript)

Run: `cd /home/z/worktrees/V2-012/backend && bunx tsx tests/integration/integration-gates/run-v2-012-dogfooding.ts` — exit code 0, final capture 2026-09-02T22:24:54Z (wall duration 6.7 s for BOTH fresh-stack runs; third consecutive all-PASS execution). Captured transcript sha-256: `d395047468f4c150392ad9abede4c8fe24b65eadeacfd877edb0fd8b27866f94` (raw capture; the only cross-run variance is the run-scoped uuid-shaped repository ids — a diff of two raw captures is exactly the id-bearing lines, 16 lines, all structured facts identical).

```text
--- RUN 2 — 1. AUTHOR the safe test workflow (real V2-002 route) ---
[PASS] 1.authored :: the safe test workflow authored v1 (content digest 1f0189d77…1fbc) and made PUBLIC through the real repository routes

--- RUN 2 — 2. FORK the public v1 (real V2-002 fork route) ---
[PASS] 2.fork-provenance :: FORK provenance preserved by V2-002: forkedFrom(wfw_…@wfwv_…) — the fork's own v1 is a NEW immutable version identity carrying the source content (digest 1f0189d77…1fbc)

--- RUN 2 — 3. MODIFY: the forker's explicit new version (real createVersion route) ---
[PASS] 3.modified :: the derivative's explicit new version v2 (number 2, distinct content digest 15d012661…561c) created through the real route; the fork made PUBLIC

--- RUN 2 — 4. PUBLISH the derivative (listing + publication) ---
[PASS] 4.published :: the listing published with revision 1 pinning the REAL fork v2 identity (content 15d012661…561c, semantic 161dc0db6…3283), provenance wfw_…, disclosure [github.repository.read, messaging.send] (sensitive: messaging.send)

--- RUN 2 — 5. TRANSACTION: the customer purchases (deterministic adapter) ---
[PASS] 5.transaction :: the test transaction completed through the deterministic adapter (pay_1, 19.99 USD, succeeded); the entitlement pins fork v2; the duplicate acceptance CONVERGED with EXACTLY ONE charge

--- RUN 2 — 6. INSTALL the purchased version (real V2-002 install route) ---
[PASS] 6.installed :: the customer installed the purchased fork v2 through the REAL cross-tenant install route — the installation PINS wfwv_… (enabled)

--- RUN 2 — 7. MAINTENANCE update (a NEW revision pinning a NEW real version) ---
[PASS] 7.maintenance-new-revision :: the creator maintenance update is an EXPLICIT new revision (sequence 2 pinning fork v3 wfwv_…); revision 1 is UNCHANGED (same pin + same trust view) — never an in-place mutation
[PASS] 7.paid-version-pinning :: PAID-VERSION PINNING: the customer's installation still pins fork v2 and the purchased version is byte-identical after the maintenance update

--- RUN 2 — 8. CREATOR ENTITLEMENT + VERSION HISTORY (content access ONLY) ---
[PASS] 8.creator-entitlement :: CREATOR ENTITLEMENT verified: the customer's entitlement grants CONTENT access to the purchased fork v2 (basis one_time_purchase) and NOTHING else (the pinned_only update is denied update_not_included); the creator reads the same succeeded transaction
[PASS] 8.version-history :: VERSION HISTORY verified: the fork's repository versions [1, 2, 3] and the listing revisions [v2, v3] agree — 3 distinct content digests, full provenance chain
[PASS] 8.execution-authority-separation :: EXECUTION-AUTHORITY SEPARATION: the whole commerce loop created ZERO runs (entitlement grants content access ONLY) and the access decision exposes exactly {entitled, basis, entitlementId}
[PASS] 8.secret-isolation :: SECRET ISOLATION: the fixture's real secret_ref binding never appears in any marketplace record (listing revisions, entitlement, transaction, decision)

# RUN 2 summary: all checks PASS

(RUN 1 transcript: byte-identical to RUN 2 above after normalizing run-scoped
 bookkeeping — uuid-shaped ids, the derived wfw_/wfwv_/wfin_ repository ids, the
 run labels. Both runs share the same deterministic marketplace ids, the same
 content/semantic digests and the same adapter receipt sequence.)

determinism: transcripts IDENTICAL after normalization

DOGFOODING RESULT: PASS (deterministic across two fresh runs)
```

Summary of observed outcomes:

- **One repository authority end-to-end:** every version-identity step (author, public visibility, fork with provenance, explicit new versions, cross-tenant install, byte-identical re-read) flowed through the REAL V2-002 routes/service; the marketplace module composed over the `MarketplaceVersionReader` port satisfied by the real repository service — no second WorkflowVersion identity or persistence authority was introduced (zero new migrations, zero new routes).
- **The frozen dogfooding clause, literally:** the safe test workflow was forked, modified (explicit new version), published (revision pins the exact real identity), installed (real cross-tenant route, installation pins the purchased version) and the test transaction completed deterministically (pay_1, 19.99 USD, succeeded; duplicate acceptance converged with exactly one charge).
- **Creator entitlement and version history verified:** the customer's entitlement grants content access on basis `one_time_purchase` and nothing else — the out-of-basis update attempt denied typed `update_not_included`; the creator reads the same succeeded transaction; repository versions [1,2,3] and listing revisions [v2,v3] agree with 3 distinct content digests and the full provenance chain.
- **Maintenance = explicit new revision, never mutation:** the maintenance update published revision 2 pinning fork v3; revision 1 was unchanged; the customer's installation still pinned the purchased fork v2 and the purchased bytes were byte-identical (paid-version pinning).
- **Execution-authority separation + secret isolation:** the whole commerce loop created ZERO runs (entitlement grants content/version access only); the access decision surface is exactly `{entitled, basis, entitlementId}`; the real `secret_ref` binding never appeared in any marketplace record.
- **Provider semantics contained:** the only payment surface is the module's deterministic in-memory adapter; no provider-specific semantics appear in WorkflowIR, Run, execution, or authorization contracts (the unit battery's module-boundary test enforces the import boundary).

## Duration / cost

Wall duration 6.7 s for the whole double-run experiment (two fresh PGlite stacks + three real tenants' identity stacks + the full commerce loop). Domain time is driven by injected deterministic clocks, so the protocol timeline is reproducible exactly.

## Evidence references

- Runner: `backend/tests/integration/integration-gates/run-v2-012-dogfooding.ts` (standalone real-process run; final capture 2026-09-02T22:24:54Z, exit code 0, wall 6.7 s, raw-capture sha-256 `d395047468f4c150392ad9abede4c8fe24b65eadeacfd877edb0fd8b27866f94`; a second external capture produced identical structured facts — the raw diff is exactly the 16 id-bearing lines of run-scoped repository ids).
- Integration test: `backend/tests/integration/marketplace/marketplace.core.integration.test.ts` (2 tests on the real stack: the full market path — fork → modify → publish → install → transaction with creator economics and version history — and the private-visibility isolation negative through the real authority: a private workflow denies cross-tenant listing creation with the authority's uniform not-found; publication of a non-public workflow refuses typed).
- Unit battery: `backend/tests/unit/marketplace/` (11 files / 96 tests covering every Must-deliver area and every required regression: private visibility isolation, fork provenance, concurrent version publication, entitlement enforcement, subscription cancellation, paid-version pinning, creator maintenance updates, execution-authority separation, secret isolation, abuse/reporting + trust metadata, offers/pricing, refunds, version-access rules, determinism, module boundary).
- Module: `backend/src/marketplace/` (public barrel `index.ts` + `types.ts` + `internal/` services: marketplace-service, in-memory-store, in-memory-payment-adapter, listing-trust, compatibility, immutable).
- Frozen work order: `spec/architecture/v2/work-orders/V2-012.md` + Issue #149 (branch base `927f23dea74bd2d9206fb55e8cb084088650d97c`).
- Deterministic identities shared by both runs: upstream/fork-v1 content digest `1f0189d77…1fbc`; fork-v2 content digest `15d012661…561c` and V2-003 semantic digest `161dc0db6…3283`; adapter receipt `pay_1` (19.99 USD, succeeded); repository version sequence [1, 2, 3]; listing revision sequence [v2, v3].
- Scoped verification at evidence time (all re-run at the final head, receipts in the PR): unit battery 96/96 green (run TWICE — deterministic); integration test 2/2 green (run TWICE); the other gates IG-001/IG-002/IG-004 13/13 green (zero modifications to them); architecture suite 895/895 (static pins intact: migration count 62, route count 37 — this work order adds ZERO migrations and ZERO routes); `bun run typecheck` — zero new errors (the 2 `workflow-deployments.route.ts` errors are the inherited, pristine-base-verified baseline, disclosed in the PR); scoped eslint on all new files — 0 errors, 0 warnings; full local vitest suite in disjoint chunks: **4244 passed / 3 failed / 65 skipped** (baseline 4146/3/65 + 98 new passing tests; the 3 failures are the WORK-069 governance trio — governance-state W052-AC01 + parallel-eligibility W052-AC03 ×2 — verified identical when re-run in isolation at this head; zero governance files in this diff).
- Full-suite chunk details (re-runnable from `backend/`): unit + architecture + continuous-validation 2447 passed; integration a–e 1010 passed / 3 failed / 36 skipped (the inherited trio); integration f–o 202 passed / 10 skipped (includes the marketplace integration 2/2 and the integration-gates 13/13); integration p–w 585 passed / 19 skipped.

## Classification

**PASS** — the marketplace/economics domain delivered per the frozen work order over the real V2-002 authority: repository permissions/visibility, fork provenance and version history, publish/install lifecycle, one-time pricing and maintenance subscriptions, entitlement and version-access rules, refunds/cancellation/maintenance as explicit domain contracts, abuse/reporting and trust metadata — with entitlement granting content/version access ONLY (never capability authorization, node access, secrets, or execution permission), payment-provider semantics fully contained behind the module's deterministic adapter, and immutable version identity preserved (maintenance = explicit new version transition, never in-place mutation).

## Limitations recorded honestly (observations, not failures)

1. **In-process HTTP.** All route calls are `app.inject()` over the REAL Fastify app in one process (the family precedent); a real network transport is not exercised.
2. **PGlite/CI divergence.** The local real stack is PGlite; CI runs the same suite against PGlite (the production boundary is `pg`) — the same single persistence boundary, different driver build (recorded by every V2 family evidence).
3. **The marketplace store is the module's in-memory reference composition.** Durable listing/entitlement/transaction persistence is a separately-owned later concern; every version-identity fact (the authority this work order composes over) flows through the REAL V2-002 repository service/routes in both the integration test and the dogfooding runner.
4. **The payment adapter is deterministic in-memory by design.** The frozen rule forbids provider SDKs in domain contracts; a real provider integration would live behind the same adapter port (out of this work order's scope).
5. **Marketplace routes are not added.** The work order's "publish/install distribution" is delivered at the service boundary composed over the real repository routes (the family's established module-first pattern; the route inventory stays at 37 — zero pin updates required). If the architect wants marketplace HTTP routes as a follow-up, that is a separate work order.
6. **Collaboration review-approval flows are modeled at the service level** (listing publication/withdrawal, revision lifecycle, abuse reporting, trust metadata) rather than through new repository-permission routes; repository permissions/visibility are consumed from the merged V2-002 authority as-is.

## Resulting action

- V2-012 remains **implemented / pending-architect-merge** (never marked COMPLETE by an agent). This evidence satisfies the Work Order's literal dogfooding clause and the required regressions on the real stack.
- No contract failure found against the V2-002/V2-005/V2-006/V2-011 merged surfaces; no corrective Work Order needed from this experiment. The architect's merge is the completion event.
