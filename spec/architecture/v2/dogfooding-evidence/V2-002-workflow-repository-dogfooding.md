# V2-002 Dogfooding Evidence — Workflow Repository + Immutable Versioning

**Work Order ID:** V2-002 — Workflow Repository + Immutable Versioning (W1, task 2-a)
**Classification of this record:** required real-system feature-boundary experiment (dogfooding-protocol.md)
**Experiment date:** 2026-09-01 (repo clock)
**Implementation under test:** commit `2afe931d9cfd7a332e47405939b7f235359e380d` (green implementation; red battery `dce6d28`)
**Status:** PASS (all 17 experiment assertions held; 0 failures)

## Workflow / version under test

- Workflow: `wfw_7628065bb0d0125ba002aa10bf70e515` (slug `on-call-triage`, org A "publisher" tenant, born private → published public during the experiment)
- Immutable versions:
  - v1 `wfwv_67f880bb8bad0612ee26df14553ebba1` (number 1, CONTENT digest `ef393a27ed77dab10d07bb7dd98a99b2d3a9eaba95017a3fa3f1a4dd8fea788d`)
  - v2 `wfwv_a024bef7b50c44684ad2ea29c6b7ce09` (number 2, digest `1dbe9ff930f3e8fae8b12ff2ca054eea6de6e02191b8974a94c7bb5af1cb2673`)
  - v3 `wfwv_a5e77c074f07f234e4ff0ee9e1d8195f` (number 3, created AFTER both installs)
- Installation (the pin): `wfin_5397a582f9c8d21b2110613363f30a31` (org A, pins v1, `enabled`)
- Fork: `wfw_3bfb08ad3ddf63bf6810e6221d246519` (slug `on-call-triage-fork`, org B "customer" tenant, forked from v2)

The version content is an OPAQUE JSON document ("On-call triage" steps). The digest above is the CONTENT digest (SHA-256 over canonical JSON, sorted keys, no whitespace) — an immutability/convergence proof, explicitly NOT the semantic digest (V2-003 owns that).

## Surface / host

- REAL application: `buildServer()` (backend/src/api/server.ts) with the V2-002 route registered through the ordinary additive registration path (`deps.auth && deps.workflowRepository`), the real auth plugin (API-key provider + user resolution), and the real `DefaultWorkflowRepositoryService`.
- REAL persistence: `createPgliteDatabaseClient()` (backend/src/platform/postgres/pglite-database-client.ts — actual PostgreSQL compiled to WASM; the same single `DatabaseClient` boundary as production `pg`) + `runMigrations()` (backend/src/platform/postgres/migration-runner.ts) applying all 60 migrations including `0060_workflow_repository_v2.sql` (the experiment log records `0060 ... migrations.applied`).
- REAL identity stack: `PgUserRepository` / `PgOrganizationRepository` / `PgMembershipRepository` / `ApiKeyAuthProvider` + `EnvSecretStore` / `ApiKeyCredentialProvisioner`; two tenants (publisher org A, customer org B) with raw API keys.
- Transport: `app.inject()` — Fastify's real request pipeline (routing, hooks, auth, serialization) exercised in-process (no socket). Mocks used: NONE for anything in this Work Order's control boundary; the in-memory `InMemoryQueue` (a real platform queue implementation) satisfies the pre-existing `/jobs` route dependency and is unrelated to the experiment path.
- Host: local dev sandbox, Node 24 via `bunx tsx`, PGlite in-memory. (CI equivalent: real PostgreSQL behind `WORKFLOWOS_DATABASE_URL` — the same test battery gates on it; unset in this environment, recorded honestly.)
- Reproducible experiment path: `backend/tests/integration/workflow-repository/workflow-repository.dogfooding.ts` (`bunx tsx tests/integration/workflow-repository/workflow-repository.dogfooding.ts` from `backend/`).

## Exact task (the Work Order's required experiment)

Create a real workflow, edit it (a new immutable version), install/pin BOTH versions, fork it, and execute/inspect the installation path. Verify old installations remain pinned.

## Starting state

Empty fresh database (all migrations applied), two empty tenants, two provisioned users/API keys. No workflow, version, installation, or fork rows exist.

## Expected outcome

1. A workflow is created born with immutable version 1 (deterministic identity, CONTENT digest over the opaque document).
2. An edit creates a NEW immutable version (number 2, parent v1); v1 is byte-identical afterwards.
3. BOTH versions can be installed/pinned (one installation per exact version).
4. After a NEWER version (v3) exists, the v1 installation STILL pins v1 (id + digest).
5. Publishing (private → public) then forking across tenants yields a NEW independent workflow identity with preserved provenance whose first version carries the source content as a NEW version identity; the source's installations do NOT transfer; a private workflow remains invisible/unforkable/uninstallable cross-tenant with a uniform 404 (no existence leak).
6. Raw SQL tampering (UPDATE/DELETE of a version, pin move, installation erase) is rejected by PostgreSQL itself; no HTTP route can mutate or delete a version (404 fail-closed).

## Observed outcome (all held — run `dogfood-mtiq47ch`)

```
[PASS] infra.migrations :: real PGlite + migration-runner applied 60 migrations (0060 present: true)
[PASS] 1.create-workflow :: POST 201 — workflow wfw_7628065bb0d0125ba002aa10bf70e515 born with v1 wfwv_67f880bb8bad0612ee26df14553ebba1 (number 1, head=true)
[PASS] 1.content-digest :: v1 CONTENT digest = ef393a27ed77dab10d07bb7dd98a99b2d3a9eaba95017a3fa3f1a4dd8fea788d (matches the pure derivation over canonical JSON)
[PASS] 2.read-v1 :: GET v1 → 200 (507 bytes)
[PASS] 3.edit-new-version :: POST versions 201 — v2 wfwv_a024bef7b50c44684ad2ea29c6b7ce09 (number 2, parent v1, digest 1dbe9ff930f3e8fae8b12ff2ca054eea6de6e02191b8974a94c7bb5af1cb2673)
[PASS] 4.R1-old-version-immutable :: GET v1 after edit → 200, response body BYTE-IDENTICAL to the pre-edit snapshot
[PASS] 5.install-v1 :: POST installations 201 — installation wfin_5397a582f9c8d21b2110613363f30a31 PINS v1 (status enabled)
[PASS] 5.install-v2 :: POST installations 201 — installation wfin_e79dd6ac9d78e525a05709b9d1b1691d PINS v2
[PASS] 6.newer-version-v3 :: POST versions 201 — v3 wfwv_a5e77c074f07f234e4ff0ee9e1d8195f (number 3) exists AFTER both installs
[PASS] 7.R2-installation-still-pinned :: GET installation → pins v1 (id wfwv_67f880bb8bad0612ee26df14553ebba1, number 1, digest ef393a27…fea788d) — NOT v3
[PASS] 8.R5-no-cross-tenant-leak :: tenant B read/fork/install of the private workflow → 404/404/404 (uniform workflow-not-found, no existence leak); rejected fork left 0 durable rows
[PASS] 9.publish :: PATCH visibility → public (200)
[PASS] 10.R3-fork-independent-identity-and-provenance :: fork 201 — NEW identity wfw_3bfb08ad3ddf63bf6810e6221d246519 in org B; provenance preserved (forkedFrom workflow wfw_7628065b…, version wfwv_a024bef…); first version wfwv_ef0d05a7c5bb867789ad0d56b2315708 carries v2's content+digest as a NEW identity
[PASS] 11.R3-no-private-state-transfer :: org B has 0 installations of the source; the fork's versions have 0 installations (source private state never transfers)
[PASS] 12.R2-pin-survives-fork :: after the fork, installation wfin_5397a582f9c8d21b2110613363f30a31 STILL pins v1 (digest ef393a27…fea788d)
[PASS] 13.R3-provenance-stable :: after source v4, the fork still records forkedFrom(v2) and holds exactly 1 version — source edits never mutate the fork
[PASS] 14.R6-database-rejects-tampering :: UPDATE version rejected ("WorkflowVersion … is immutable…"); DELETE version rejected ("…immutable…"); pin move rejected ("WorkflowInstallation … pins version …"); installation erase rejected ("…pin is immutable…")
[PASS] 15.version-untouched-after-tampering :: after all tamper attempts, v1 digest is still ef393a27…fea788d
[PASS] 16.R6-no-mutation-route :: PUT/PATCH/DELETE on a version path → 404/404/404 (fail-closed 404 — no such routes exist)
```

Run summary line: `runId=dogfood-mtiq47ch workflow=wfw_7628065bb0d0125ba002aa10bf70e515 v1=wfwv_67f880bb8bad0612ee26df14553ebba1 v2=wfwv_a024bef7b50c44684ad2ea29c6b7ce09 v3=wfwv_a5e77c074f07f234e4ff0ee9e1d8195f fork=wfw_3bfb08ad3ddf63bf6810e6221d246519 installation=wfin_5397a582f9c8d21b2110613363f30a31 digestV1=ef393a27ed77dab10d07bb7dd98a99b2d3a9eaba95017a3fa3f1a4dd8fea788d durationMs=3360 failures=0`

## Evidence references

- Run ID: `dogfood-mtiq47ch` (2026-09-01, experiment script output, exit code 0)
- Content digests (SHA-256 over canonical JSON of the opaque version documents): v1 `ef393a27ed77dab10d07bb7dd98a99b2d3a9eaba95017a3fa3f1a4dd8fea788d`, v2 `1dbe9ff930f3e8fae8b12ff2ca054eea6de6e02191b8974a94c7bb5af1cb2673`
- Commit SHAs: red battery `dce6d286d37825eb2b7631a1bc95cf06a7e6a2cf`; implementation under test `2afe931d9cfd7a332e47405939b7f235359e380d` (head at experiment time); evidence commit: this file's commit.
- Scoped test battery at the same head: `bunx vitest run tests/unit/workflow-repository tests/integration/workflow-repository` → **4 files / 57 tests, all passed** (24 unit + 33 integration incl. the route-level API suite).
- Migration log evidence: `{"filename":"0060_workflow_repository_v2.sql","msg":"migrations.applied"}` from the real migration runner.

## Duration / cost

3360 ms wall-clock for the full experiment (infra + 60 migrations + 17 assertions) on the local sandbox host.

## Failure classification

**PASS** — no contract failure, no UX failure, no operational failure. Every required regression of the Work Order was observed through the real product path (repository + HTTP + database boundary).

## Explicit observations (recorded honestly, none silently)

1. **Execution is not attempted (scope boundary, not a failure):** WorkflowRun is owned by V2-005 and does not exist yet. The dogfooding-protocol row for V2-002 asks to "execute it" — the execute/inspect path of the installation is deliberately absent; installations are PINNED but not EXECUTED. This is an explicit observation for the next execution-capable boundary (V2-005 must consume this result per the anti-repeat rule), not a failure of V2-002's owned surface.
2. **Transport is `app.inject()` (in-process) rather than a network socket.** Fastify's inject drives the REAL routing/hook/auth/serialization pipeline; no handler, service, or database path is substituted. A socket-level run is redundant for this boundary and remains available to later integration gates (IG-001/IG-005).
3. **Persistence ran on PGlite (real PostgreSQL compiled to WASM) rather than a networked PostgreSQL** because `WORKFLOWOS_DATABASE_URL` is unset in this environment. The same suite is written to run against real networked PostgreSQL when the variable is set (exactly like the existing DB-backed suites). PGlite enforces the same relational semantics (triggers, FKs, transactions) that the R6 raw-SQL proof exercises.
4. **Test-isolation mechanism (harness note):** the deterministic red battery resets the V2 repository tables between tests with `TRUNCATE` (a maintenance operation that does not fire the row-level UPDATE/DELETE immutability triggers). The runtime immutability contract (constitution §19) guards UPDATE/DELETE — which the R6 regressions prove are rejected — while schema-maintenance operations remain available to operators. Recorded so the architect can judge whether a TRUNCATE guard is wanted later (out of scope here; adding one would break sanctioned test isolation without an alternative reset path).
5. **Deterministic identities depend on the tenant UUIDs**, which are allocated by the pre-existing identity stack (randomUUID) — the identity derivation itself is deterministic over its authoritative inputs (proven by the pure unit battery: convergence, load-bearing mutations, noise-insensitivity, kind discrimination).

## Resulting action

- V2-002's owned surface (repository identity, Workflow, immutable WorkflowVersion persistence, ancestry/fork identity, permissions/visibility, install/version pinning) is implemented, green on its deterministic battery, and validated through the real product path. No corrective Work Order is required within this scope.
- Hand-off notes for siblings/next boundaries (no code consumed, contracts only): V2-003 owns WorkflowIR semantics + the SEMANTIC digest (the digest persisted here is the CONTENT digest); V2-005 will pin runs to these same immutable version identities; IG-001 may consolidate canonical-JSON serialization (currently internal to this module — deliberate, no shared util was invented).
- Work Order state remains **implemented / pending architect merge** — COMPLETE is not marked by agents.
