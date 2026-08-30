# WORK-064 Repository Mapping — the existing authority boundaries

> Task 1 of `docs/superpowers/plans/2026-08-30-work-064-continuous-product-validation.md`.
> The repository is authoritative. This note records the EXACT existing symbols
> WORK-064 consumes, and why nothing here duplicates an authority. Base commit:
> `4018f42` (main, "docs: add WORK-064 implementation plan").

## The module pattern WORK-064 follows

`src/modules/` is the FROZEN v1.0 module set (17 modules —
`FROZEN_MODULE_NAMES` in `src/platform/module-contract.ts`, pinned by
PLAT-AC-01/AC-02 static checks). Every post-v1.0 application-layer capability
lives in a TOP-LEVEL `src/<domain>/` directory and CONSUMES the frozen modules
through their public barrels — the established precedents:
`src/execution-policy/` (WORK-033), `src/delegation/` (WORK-046),
`src/orchestration/` (WORK-062), `src/agent-roles/` (WORK-045),
`src/development-governance/` (WORK-052), etc. Each has the shape:
`index.ts` (public barrel) + `types.ts` (public contracts) +
`internal/*` (private implementation).

**WORK-064 lands at `src/continuous-validation/` in exactly this shape.** It is
NOT an 18th frozen module; it consumes frozen modules via `@modules/*` barrels
and platform types via `@platform/*`, imported by relative path from `src/`
(the orchestration precedent — no new tsconfig alias needed).

## Authority 1 — identity (consumed, never duplicated)

- **The existing identity authority result type**: `AuthenticatedPrincipal`
  (`src/modules/auth/internal/auth.types.ts`, re-exported from
  `src/modules/auth/index.ts`) — `{ externalId, label, provider }`. This is the
  `ExistingIdentityAuthorityResult` of the plan's Task 4: the output of the ONE
  authentication boundary (`AuthProvider.authenticate`).
- **The existing machine-identity mechanism**: API keys —
  `ApiKeyCredentialProvisioner.provision` (`/auth` internal
  `authorization-service.ts`), digests in `wfos_api_key_credentials`
  (migration 0001). `ApiKeyAuthProvider` authenticates raw keys and yields
  `provider: 'apikey'` principals. This is the ONLY existing non-interactive
  (machine) credential mechanism; WORK-063's runtime scoped-service-account
  layer is future architect-gated work (the Work Order merged SPEC-ONLY — no
  runtime identity code exists; grep proves no `service account`/
  `principalClass` runtime concept exists yet).
- **WORK-064 consumes**: `bindTestIdentity` receives an ALREADY-AUTHENTICATED
  `AuthenticatedPrincipal` plus the synthetic classification
  (class/capabilities/tenant/reason). It VALIDATES and BINDS; it never issues
  tokens, never creates users, never persists principals, never authenticates.
  Discrimination: only principals from a closed set of machine-credential
  providers (today: `apikey` — the existing mechanism; the set is a named
  constant that WORK-063's future runtime extends) may bind as synthetic test
  identities; human-interactive principals are rejected as TestIdentity. There
  is NO demo-key mechanism anywhere in runtime code (grep for demo-key finds
  nothing — the "Workbench demo-key bootstrap" is the retired frontend dev
  pattern, not a runtime mechanism); the domain encodes no permanent
  demo-key identity path.
- **The existing server-side authorization chain** (consumed where
  authorization decisions are needed): `AuthorizationService.authorize` /
  `authorizeForOrganization` (`/auth` barrel) — user → organization membership
  → role → permission → project access. WORK-064 makes no authorization
  decision of its own; admission is a DOMAIN policy check (EffectPolicy ×
  Environment), not a permission check.

## Authority 2 — verification/evidence (consumed, never duplicated)

- **The ONE verification/evidence authority**: the frozen `/verification`
  module (WORK-015). Public surface: `VerificationService`
  (`createRun`, `findRun`, `attachEvidence`, `attachCiEvidence`,
  `mapEvidenceToCriterion`, `evaluateCriterion`, `evaluateForRun`,
  `persistEvaluations`) + `Evidence` / `CreateEvidenceInput` /
  `EvidenceRepository` types (`src/modules/verification/index.ts`).
- **Authority semantics (load-bearing)**: `authority` is determined
  SERVER-SIDE by the trusted source path. `attachEvidence` (the public/manual
  path) ALWAYS produces `authority: 'claim'`; only `attachCiEvidence` (CI
  ingested through `/github`) produces `'authoritative'`. A validation run is
  synthetic product validation — agent-produced, NOT CI-ingested — so
  validation-originated evidence enters as **`claim` evidence through
  `attachEvidence`**, exactly the honest classification the authority
  dictates. WORK-064 creates NO `validation_evidence` table/store: the
  `ValidationEvidenceReference` returned by the mapper REFENCES the
  `/verification` Evidence row it created (or maps to an existing one) and
  preserves the upstream run/journey/step provenance in the evidence metadata.

## Authority 3 — persistence (the honest gap; no migration)

- **The existing persistence boundary**: `DatabaseClient`
  (`src/platform/postgres/database-client.ts`, pg + pglite fallback) + SQL
  migrations under `src/platform/postgres/migrations/` (currently 0001..0058)
  + repository classes per aggregate (`Pg*Repository` in module `internal/`
  dirs). PostgreSQL is authoritative; Redis is non-authoritative.
- **Repository truth**: NO existing table represents validation journeys,
  runs, observations, or outcomes (grep over migrations 0001..0058 — the
  closest are verification runs/evidence, workflow states, agent runs; none is
  a validation-run store, and reusing them would corrupt their semantics).
- **The design ruling** (`docs/superpowers/specs/2026-08-30-work-064-continuous-product-validation-design.md`
  §8, mirrored by the plan Task 8 Step 1): **NO schema migration is
  authorized by WORK-064's current scope.** The implementation therefore
  keeps the domain model at the existing persistence boundary: a
  `ValidationRunRepository` PORT (the plan's interface) with an IN-MEMORY
  implementation for domain/composition tests and future wiring. Durable
  validation state requires either an ACR or an architect-authorized scope
  extension (a future Work Order); this is recorded here as the authority gap,
  NOT silently solved with a new table. No parallel evidence/journey store is
  invented.

## Authority 4 — application composition (consumed, never redesigned)

- **The composition root**: `buildApp(config)` in `src/app.ts` constructs
  every service/repository when a database is configured and exposes them on
  `AppDeps` (optional fields). The orchestration precedent (WORK-062):
  construct the substrate before its consumer, inject through constructor
  ports, expose on `AppDeps` only what later consumers need.
- **WORK-064 composes**: `buildApp` constructs the
  `ContinuousValidationService` from its ports (in-memory run repository +
  the existing `VerificationService` when a database is configured) and
  exposes it on `AppDeps` as `continuousValidationService?` for FUTURE
  consumers (WORK-065 browser agent, WORK-066 scheduler). No route is
  registered in this Work Order (the domain service is the contract; HTTP
  exposure is a future consumer's concern).

## Authority 5 — release (absent; honest ruling)

- **Repository truth**: NO release authority exists (grep for
  `releaseRecord|ReleaseAuthority|recordRelease` finds nothing; "release" hits
  are the unrelated WORK-035 workspace-release relay and docker-compose tags).
- **Ruling for Task 5**: `POST_RELEASE` admission requires an explicit
  `releaseRef` supplied by the caller (the future WORK-066/069 consumers), and
  the domain records it. The domain does NOT validate the releaseRef against
  a release authority (none exists to consult) and does NOT invent one; the
  plan's "when the repository exposes that authority" condition is FALSE
  today, so the check is: POST_RELEASE without an explicit releaseRef is
  rejected (fail-closed), and the reference is preserved for the future
  authority to bind. Same for CONTINUOUS: admitted only with explicit
  `continuous: true` configuration on the admission input (no autonomous
  scheduling — WORK-066 owns triggers).

## Static-architecture enforcement precedent

`tests/architecture/static-architecture.test.ts` carries one `describe` per
work order. WORK-064 adds its own describe block pinning: the domain files
exist under `src/continuous-validation/`; the module imports only allowed
surfaces (`@platform/*`, `@modules/auth`, `@modules/verification` barrels —
never `internal/`); NO new migration/table; NO `validation_evidence` store;
NO browser/scheduler/signal/progressive-release vocabulary or runtime (the
WORK-065..070 exclusions); error vocabulary disjointness where applicable.

## Baseline results (base commit 4018f42, before any change)

- `bun run typecheck` — 0 errors.
- `bun run lint` — 0 errors (2 pre-existing warnings in
  `tests/e2e-browser/work-032-benchmark.spec.ts`, untouched).
- `bun run governance:status` — exit 0; 54 work orders complete; nothing in
  flight; merged finalized 9/9; activeHandoffs `[]`.
- `bun run arch:check` — 791/791 passed.
- `bun run test` (full backend suite) — 2485 passed / 44 skipped / 0 failed
  (112 files passed / 4 skipped).

Governance/frontier confirmation: WORK-064 is dependency-eligible
(WORK-048 + WORK-050 + WORK-063 all complete) and NOT yet activated in
`program-state.json` (no workOrders record) — the architect's authorization
for this implementation is the merged plan (4018f42) + this work directive;
the in-flight activation record is committed by the worker on this branch per
the established WORK-046..062 precedent, and completion is recorded only
through the architect's merge + §34.8 finalization.
