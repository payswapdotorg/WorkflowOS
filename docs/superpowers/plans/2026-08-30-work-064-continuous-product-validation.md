# WORK-064 Continuous Product Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement WORK-064 as the domain/model authority for continuous product validation, with deterministic persistence, fail-closed policy admission, provenance-preserving outcomes, and integration with the existing WorkflowOS authorities without creating a second identity, verification, workflow, or evidence authority.

**Architecture:** WORK-064 owns validation-domain semantics: journeys, runs, synthetic test identities, environments, effect policies, expected observations, and typed validation outcomes. It must consume existing identity, verification, project/organization, release, and governance authorities rather than duplicating them. Browser execution belongs to WORK-065; scheduling belongs to WORK-066; signal correlation belongs to WORK-067; governed Work Item creation belongs to WORK-068; progressive release binding belongs to WORK-069.

**Tech Stack:** TypeScript strict mode, Bun, Vitest, existing WorkflowOS backend/module conventions, PostgreSQL/Prisma only where repository inspection proves durable storage is required, existing API/service composition, existing verification/evidence authority.

**Spec:** `docs/superpowers/specs/2026-08-30-work-064-continuous-product-validation-design.md` and `spec/architecture/v1.1/validation-model.md`.

## Global Constraints

- Repository truth is authoritative; do not trust prior reports, proposed interfaces, or this plan when they contradict the actual repository.
- v1.0 remains frozen; WORK-064 is a v1.1 proposed evolution and must not rewrite frozen architecture.
- WORK-064 owns the validation domain/model only; execution is WORK-065 and scheduling is WORK-066.
- The existing `/verification` authority remains the single verification/evidence authority.
- The existing WORK-063 identity layer remains the single identity authority; TestIdentity must not mint credentials or impersonate human users.
- Validation failures are typed outcomes and may never be silently dropped or converted into healthy state.
- EffectPolicy admission is fail-closed; FORBIDDEN is never executable merely because a caller requests it.
- Production synthetic validation must never perform uncontrolled destructive side effects.
- Browser agents do not mutate code, merge PRs, approve reviews, or transition workflow state.
- Validation-originated failures must preserve run/journey/step/environment provenance for downstream WORK-067/068 consumption.
- No second signal store, Work Item store, workflow engine, release authority, or evidence authority may be introduced.
- Do not add a database migration unless repository inspection demonstrates that durable WORK-064 state cannot be represented through an existing persistence authority; if a migration is necessary, stop at an architectural checkpoint and document the exact authority boundary before implementing it.
- Do not activate WORK-065, WORK-066, WORK-067, WORK-068, WORK-069, or WORK-070 as part of this work.

---

## Repository Mapping

Before implementation, map the design contracts to the actual repository. The executor must not invent a parallel module because the spec uses conceptual names.

**Files to inspect:**
- `backend/src/index.ts`
- `backend/src/app.ts`
- `backend/src/execution-policy/index.ts`
- `backend/src/execution-policy/types.ts`
- `backend/src/execution-policy/internal/*`
- `backend/src/development-governance/*`
- existing verification/evidence module discovered under `backend/src/**`
- existing identity/auth module discovered under `backend/src/**`
- existing project/organization authority discovered under `backend/src/**`
- existing persistence/schema files under `backend/**`
- existing module-level tests under `backend/tests/**`

**Required mapping result:** a short implementation note in the first commit identifying the actual existing interfaces used for identity validation, authorization/capability checks, verification evidence, persistence, and module registration. If an expected authority does not exist, do not create a substitute inside WORK-064; raise the missing-authority finding before proceeding.

### Task 1: Establish the existing authority boundaries

**Files:**
- Create: `docs/superpowers/notes/2026-08-30-work-064-repository-mapping.md`
- Test: existing governance/static checks plus the targeted module test command discovered during inspection

- [ ] **Step 1: Inspect existing identity and authorization boundaries**

Run:
```bash
cd backend
grep -R "organization\|project\|principal\|service account\|authorization\|capability" src tests --exclude-dir=node_modules | head -n 200
```
Record the exact service/types that establish caller identity and authorization. WORK-064 may consume them but may not duplicate them.

- [ ] **Step 2: Inspect existing verification/evidence authority**

Run:
```bash
cd backend
grep -R "verification\|evidence" src tests --exclude-dir=node_modules | head -n 250
```
Record the exact write/read boundary for formal verification evidence. The validation model must reference this authority rather than introduce `validation_evidence` as a competing store.

- [ ] **Step 3: Inspect persistence conventions**

Run:
```bash
cd backend
grep -R "PrismaClient\|prisma\.\|repository interface\|Repository" src --exclude-dir=node_modules | head -n 250
```
Record whether existing domain state can be represented through an existing repository or whether a new WORK-064 persistence boundary is actually required.

- [ ] **Step 4: Inspect module registration/export conventions**

Run:
```bash
cd backend
sed -n '1,240p' src/index.ts
sed -n '1,240p' src/app.ts
```
Use the repository's established module pattern; do not introduce a new registration architecture.

- [ ] **Step 5: Write the mapping note**

The note must contain the exact existing symbols/files selected for each authority and explicitly state why no authority is duplicated.

- [ ] **Step 6: Run baseline tests**

Run the repository's backend typecheck, lint, governance checks, and full backend suite before modifying runtime code. Record the baseline result in the mapping note.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/notes/2026-08-30-work-064-repository-mapping.md
git commit -m "docs: map WORK-064 onto existing authorities"
```

---

## Task 2: Define the validation-domain types and invariants

**Files:**
- Create: `backend/src/continuous-validation/types.ts`
- Create: `backend/src/continuous-validation/index.ts`
- Test: `backend/tests/continuous-validation/validation-domain.test.ts`

**Interfaces:**
- Produces `ValidationJourney`, `ValidationRun`, `TestIdentity`, `Environment`, `EffectPolicy`, `ExpectedObservation`, `ValidationOutcome`, `ValidationMode`, `ValidationTrigger`, and provenance types for later tasks.
- `ValidationOutcome` must distinguish `healthy`, `validation_failure`, `effect_policy_violation`, and `environment_error`.

- [ ] **Step 1: Write failing invariant tests**

Cover at minimum:
```text
EffectPolicy = READ_ONLY | SAFE_MUTATION | ISOLATED_MUTATION | FORBIDDEN
ValidationMode = PRE_MERGE | POST_RELEASE | CONTINUOUS
ValidationTrigger = PR | DEPLOYMENT | RELEASE | SCHEDULED | RUNTIME_SIGNAL | ARCHITECTURE_CHANGE | SECURITY_FINDING | DEPENDENCY_CHANGE | USER_FEEDBACK
ValidationOutcome = healthy | validation_failure | effect_policy_violation | environment_error
```
Also assert that a run has journey, identity, environment, policy, observations, mode, trigger, and outcome provenance.

- [ ] **Step 2: Run the focused test and verify failure**

```bash
cd backend
bunx vitest run tests/continuous-validation/validation-domain.test.ts
```
Expected: FAIL because the domain module does not yet exist.

- [ ] **Step 3: Implement immutable domain contracts**

Use discriminated unions and readonly fields. Do not use `any`. Make invalid enum values unrepresentable at the type boundary.

- [ ] **Step 4: Add runtime constructors/guards where the repository convention requires them**

Constructors must reject missing provenance, invalid effect policy, invalid mode/trigger combinations, and empty journey identifiers.

- [ ] **Step 5: Run focused tests**

```bash
cd backend
bunx vitest run tests/continuous-validation/validation-domain.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/continuous-validation backend/tests/continuous-validation/validation-domain.test.ts
git commit -m "feat(work-064): define continuous validation domain"
```

---

## Task 3: Implement fail-closed Environment × EffectPolicy admission

**Files:**
- Create: `backend/src/continuous-validation/internal/effect-policy.ts`
- Modify: `backend/src/continuous-validation/index.ts`
- Test: `backend/tests/continuous-validation/effect-policy.test.ts`

**Interfaces:**
```ts
type EffectPolicy = "READ_ONLY" | "SAFE_MUTATION" | "ISOLATED_MUTATION" | "FORBIDDEN";
type ValidationMode = "PRE_MERGE" | "POST_RELEASE" | "CONTINUOUS";

interface EffectPolicyDecision {
  admitted: boolean;
  reason: string;
}

function admitEffectPolicy(
  environment: Environment,
  policy: EffectPolicy,
  mode: ValidationMode,
): EffectPolicyDecision;
```

- [ ] **Step 1: Write the failing matrix test**

Pin these rules:
- PRE_MERGE preview/isolated: READ_ONLY, SAFE_MUTATION, ISOLATED_MUTATION may be admitted; FORBIDDEN is rejected unless the explicit safe mechanism represented by the environment contract exists.
- POST_RELEASE production: READ_ONLY and SAFE_MUTATION are admitted; ISOLATED_MUTATION requires an isolated test tenant; FORBIDDEN is rejected.
- CONTINUOUS production: READ_ONLY and SAFE_MUTATION are admitted; ISOLATED_MUTATION requires an isolated test tenant; FORBIDDEN is rejected.
- Unknown/ambiguous environment capability fails closed.

- [ ] **Step 2: Run test to verify failure**

```bash
cd backend
bunx vitest run tests/continuous-validation/effect-policy.test.ts
```

- [ ] **Step 3: Implement the pure admission function**

The function must never infer permission from the caller's requested policy. It must inspect the environment's explicit capabilities and reject anything not explicitly authorized.

- [ ] **Step 4: Add discrimination tests**

Prove that a caller cannot:
- elevate READ_ONLY to SAFE_MUTATION;
- execute FORBIDDEN in production;
- request ISOLATED_MUTATION without an isolated tenant;
- bypass the policy by changing the mode string.

- [ ] **Step 5: Run focused tests**

```bash
cd backend
bunx vitest run tests/continuous-validation/effect-policy.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/continuous-validation backend/tests/continuous-validation/effect-policy.test.ts
git commit -m "feat(work-064): enforce fail-closed effect policy admission"
```

---

## Task 4: Implement TestIdentity binding without creating an identity authority

**Files:**
- Create: `backend/src/continuous-validation/internal/test-identity.ts`
- Modify: `backend/src/continuous-validation/index.ts`
- Test: `backend/tests/continuous-validation/test-identity.test.ts`

**Interfaces:**
```ts
interface TestIdentityBinding {
  principalId: string;
  principalClass: string;
  capabilities: readonly string[];
  tenantId?: string;
  issuer: "WORK-063";
  issuanceReason: string;
}

function bindTestIdentity(
  identity: ExistingIdentityAuthorityResult,
  environment: Environment,
  policy: EffectPolicy,
): TestIdentityBinding;
```

The exact `ExistingIdentityAuthorityResult` name must be replaced by the symbol discovered in Task 1; do not create a second identity service.

- [ ] **Step 1: Write failing tests**

Prove:
- null identity is valid only for unauthenticated journeys;
- authenticated validation requires a synthetic principal issued by WORK-063;
- a human production principal is rejected;
- a test identity cannot self-mint credentials;
- capability scope is preserved exactly;
- tenant binding is mandatory for ISOLATED_MUTATION.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
cd backend
bunx vitest run tests/continuous-validation/test-identity.test.ts
```

- [ ] **Step 3: Implement binding as an adapter to the existing identity authority**

The adapter may validate and bind an already-issued synthetic identity, but it must not issue tokens, create users, impersonate users, or maintain an independent principal store.

- [ ] **Step 4: Run focused tests**

```bash
cd backend
bunx vitest run tests/continuous-validation/test-identity.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/continuous-validation backend/tests/continuous-validation/test-identity.test.ts
git commit -m "feat(work-064): bind synthetic validation identities"
```

---

## Task 5: Implement ValidationJourney declaration and validation-run admission

**Files:**
- Create: `backend/src/continuous-validation/internal/journey.ts`
- Create: `backend/src/continuous-validation/internal/run-admission.ts`
- Modify: `backend/src/continuous-validation/index.ts`
- Test: `backend/tests/continuous-validation/journey-admission.test.ts`

**Interfaces:**
```ts
interface ValidationJourney {
  id: string;
  name: string;
  identityRequirement: IdentityRequirement;
  allowedModes: readonly ValidationMode[];
  effectPolicy: EffectPolicy;
  steps: readonly ValidationStep[];
  successCriteria: readonly SuccessCriterion[];
}

interface ValidationRunAdmission {
  admitted: boolean;
  reason: string;
  journey: ValidationJourney;
  identity: TestIdentityBinding;
  environment: Environment;
  mode: ValidationMode;
  trigger: ValidationTrigger;
}

function admitValidationRun(input: ValidationRunRequest): ValidationRunAdmission;
```

- [ ] **Step 1: Write failing admission tests**

Pin:
- journey mode must include requested mode;
- journey identity requirement must match the supplied TestIdentity;
- effect policy must pass the Task 3 matrix;
- environment must be valid for the mode;
- CONTINUOUS cannot be admitted merely because a caller requests it; it requires explicit configuration from the existing scheduling/configuration authority;
- POST_RELEASE requires an existing recorded release when the repository exposes that authority;
- no journey with FORBIDDEN production behavior can be admitted.

- [ ] **Step 2: Run focused test**

```bash
cd backend
bunx vitest run tests/continuous-validation/journey-admission.test.ts
```

- [ ] **Step 3: Implement admission by composition**

Compose identity binding, environment validation, effect-policy admission, and mode/trigger constraints. Keep the function deterministic and side-effect free.

- [ ] **Step 4: Add cross-product discrimination tests**

At minimum test every production policy, every mode, authenticated and unauthenticated identities, and invalid mode/trigger pairs.

- [ ] **Step 5: Run focused tests**

```bash
cd backend
bunx vitest run tests/continuous-validation/journey-admission.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/continuous-validation backend/tests/continuous-validation/journey-admission.test.ts
git commit -m "feat(work-064): admit validation journeys safely"
```

---

## Task 6: Implement typed observations and validation outcomes with provenance

**Files:**
- Create: `backend/src/continuous-validation/internal/observation.ts`
- Create: `backend/src/continuous-validation/internal/outcome.ts`
- Modify: `backend/src/continuous-validation/types.ts`
- Test: `backend/tests/continuous-validation/outcome-provenance.test.ts`

**Interfaces:**
```ts
interface ObservationProvenance {
  runId: string;
  journeyId: string;
  stepId: string;
  environmentId: string;
  observedAt: string;
}

interface ValidationObservation {
  id: string;
  kind: "dom" | "network" | "persisted_record" | "downstream_event";
  value: unknown;
  provenance: ObservationProvenance;
}

interface ValidationFailure {
  kind: "validation_failure";
  failedStepId: string;
  expected: ExpectedObservation;
  actual?: ValidationObservation;
  provenance: ObservationProvenance;
}
```

- [ ] **Step 1: Write failing provenance tests**

Prove every observation and failure retains run, journey, step, environment, and timestamp provenance. Prove a missing observation is represented as an explicit failure rather than silently becoming healthy.

- [ ] **Step 2: Run focused test**

```bash
cd backend
bunx vitest run tests/continuous-validation/outcome-provenance.test.ts
```

- [ ] **Step 3: Implement typed observation/outcome derivation**

No function may convert an absent/invalid observation into `healthy`.

- [ ] **Step 4: Add negative tests for false-health and silent-drop behavior**

Assert that:
- failed expected DOM observation yields `validation_failure`;
- effect-policy rejection yields `effect_policy_violation`;
- deployment/environment unavailability yields `environment_error`;
- only all declared success criteria produce `healthy`.

- [ ] **Step 5: Run focused tests**

```bash
cd backend
bunx vitest run tests/continuous-validation/outcome-provenance.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/continuous-validation backend/tests/continuous-validation/outcome-provenance.test.ts
git commit -m "feat(work-064): preserve validation outcome provenance"
```

---

## Task 7: Bind validation evidence to the existing verification authority

**Files:**
- Create: `backend/src/continuous-validation/internal/evidence-mapping.ts`
- Modify: `backend/src/continuous-validation/index.ts`
- Test: `backend/tests/continuous-validation/evidence-mapping.test.ts`

**Interfaces:**
```ts
interface ValidationEvidenceReference {
  validationRunId: string;
  validationJourneyId: string;
  observationIds: readonly string[];
  verificationEvidenceId?: string;
}

function mapValidationOutcomeToVerification(
  outcome: ValidationOutcome,
  verificationAuthority: ExistingVerificationAuthority,
): Promise<ValidationEvidenceReference>;
```

The exact verification authority type and call must be taken from Task 1's repository mapping.

- [ ] **Step 1: Write failing integration tests**

Prove:
- healthy and failed validation results retain their validation provenance;
- mapped formal evidence points to the existing verification record;
- no `validation_evidence` repository/table is created;
- the mapper cannot overwrite raw observations;
- a failed mapping is explicit and not converted to healthy.

- [ ] **Step 2: Run focused test**

```bash
cd backend
bunx vitest run tests/continuous-validation/evidence-mapping.test.ts
```

- [ ] **Step 3: Implement the adapter to `/verification`**

Use the existing evidence authority's repository/service and its established transaction/error semantics. Do not bypass its API by writing its storage directly unless that is already the established repository pattern.

- [ ] **Step 4: Add duplicate-authority architecture regression**

Add a static/architecture assertion that WORK-064 contains no new evidence authority and that its evidence type references the existing verification authority.

- [ ] **Step 5: Run focused and architecture tests**

```bash
cd backend
bunx vitest run tests/continuous-validation/evidence-mapping.test.ts
bun run arch:check
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/continuous-validation backend/tests/continuous-validation/evidence-mapping.test.ts
# include the architecture regression test in the repository's established location
git commit -m "feat(work-064): map validation evidence to verification"
```

---

## Task 8: Add durable persistence only if repository mapping proves it necessary

**Files:**
- Create/Modify: the exact repository/schema files identified by Task 1
- Test: `backend/tests/continuous-validation/persistence.test.ts`

**Interfaces:**
```ts
interface ValidationRunRepository {
  create(run: ValidationRun): Promise<ValidationRun>;
  getById(id: string): Promise<ValidationRun | null>;
}
```

- [ ] **Step 1: Prove persistence is required**

If existing authoritative persistence already supports the required records, adapt to it and do not add a migration. If not, stop and document the authority gap before adding a new table/model.

- [ ] **Step 2: Write failing repository tests**

Pin deterministic create/read behavior, provenance preservation, idempotent run identifiers where the existing persistence convention supports idempotency, and no secret/token/cookie storage.

- [ ] **Step 3: Implement the smallest repository adapter**

Persist only domain data required by WORK-064. Credentials, raw tokens, browser session cookies, and human authentication secrets are prohibited.

- [ ] **Step 4: Run focused persistence tests**

```bash
cd backend
bunx vitest run tests/continuous-validation/persistence.test.ts
```

- [ ] **Step 5: Run migration/schema validation if and only if a migration exists**

Use the repository's established migration and test commands; verify the generated schema does not create an identity, verification, workflow, or signal authority.

- [ ] **Step 6: Commit**

```bash
git add backend tests
# include only the actual files changed by the repository's persistence convention
git commit -m "feat(work-064): persist validation runs"
```

---

## Task 9: Expose the WORK-064 domain service through existing application composition

**Files:**
- Modify: `backend/src/index.ts` or the existing module registry identified in Task 1
- Modify: `backend/src/app.ts` only if existing composition requires it
- Modify: `backend/src/continuous-validation/index.ts`
- Test: `backend/tests/continuous-validation/module-composition.test.ts`

- [ ] **Step 1: Write failing composition test**

Assert the application can construct the WORK-064 service using the existing dependency-injection/module pattern and that all required authorities are supplied by existing modules.

- [ ] **Step 2: Run focused test**

```bash
cd backend
bunx vitest run tests/continuous-validation/module-composition.test.ts
```

- [ ] **Step 3: Register the module**

Export only the domain/service interfaces needed by later Work Orders. Do not expose persistence internals or browser execution APIs as public authority.

- [ ] **Step 4: Run focused test**

```bash
cd backend
bunx vitest run tests/continuous-validation/module-composition.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.ts backend/src/app.ts backend/src/continuous-validation backend/tests/continuous-validation/module-composition.test.ts
 git commit -m "feat(work-064): compose continuous validation domain"
```

---

## Task 10: Add architecture and governance regressions for WORK-064 boundaries

**Files:**
- Modify: existing static architecture test file discovered under `backend/tests/**`
- Modify: existing governance validation fixture only if needed to recognize activated WORK-064 state
- Test: existing architecture/governance suites

- [ ] **Step 1: Add no-second-authority assertions**

Pin that WORK-064:
- does not own identity issuance;
- does not own formal verification evidence;
- does not mutate code;
- does not merge/approve PRs;
- does not schedule itself autonomously;
- does not create Engineering Signals or Work Items directly;
- does not implement progressive release decisions.

- [ ] **Step 2: Add effect-policy discrimination assertions**

Pin production FORBIDDEN rejection, isolated-tenant requirements, and no policy escalation.

- [ ] **Step 3: Add provenance assertions**

Pin the complete observation → outcome → verification-reference provenance chain.

- [ ] **Step 4: Run governance and architecture suites**

```bash
cd backend
bun run governance:status
bun run arch:check
bunx vitest run tests/development-governance tests/architecture-governance
```

- [ ] **Step 5: Commit**

```bash
git add backend/tests
 git commit -m "test(work-064): pin validation architecture boundaries"
```

---

## Task 11: Full regression, review, and implementation handoff

**Files:**
- Modify: `spec/work-orders/WORK-064.md` only for implementation evidence/status transition authorized by the governance workflow
- Modify: the existing worklog/state artifacts only through the established finalization mechanism

- [ ] **Step 1: Run focused WORK-064 suite**

```bash
cd backend
bunx vitest run tests/continuous-validation
```
Expected: all WORK-064 tests pass.

- [ ] **Step 2: Run backend typecheck and lint**

```bash
cd backend
bun run typecheck
bun run lint
```

- [ ] **Step 3: Run full backend regression**

```bash
cd backend
bun test
```
Expected: no new failures; any pre-existing failure must be demonstrated against the clean base and documented rather than ignored.

- [ ] **Step 4: Run frontend parity checks**

Run the repository's frontend typecheck and lint commands because CI validates the complete application even though WORK-064 is backend/domain focused.

- [ ] **Step 5: Run all architecture/governance checks**

```bash
bun run governance:status
bun run arch:check
```
Expected: green with no new gaps.

- [ ] **Step 6: Manually inspect the complete diff**

Verify:
- no files implement WORK-065 browser execution;
- no scheduler implementation from WORK-066 exists;
- no Engineering Signal/Work Item implementation from WORK-067/068 exists;
- no progressive-release behavior from WORK-069 exists;
- no second identity/evidence authority exists;
- no secrets/tokens/cookies are persisted;
- every failure path preserves provenance;
- every production policy path fails closed.

- [ ] **Step 7: Update implementation evidence only after all tests pass**

Record exact commit SHAs and test results in the existing governance worklog. Do not mark WORK-064 complete unless the repository's normal architect-finalization process has been satisfied.

- [ ] **Step 8: Commit final implementation evidence**

```bash
git add spec docs backend frontend
 git commit -m "feat(work-064): complete continuous product validation domain"
```

- [ ] **Step 9: Stop for architect review**

Do not merge the implementation PR. Do not activate WORK-065. The architect must review the final diff, provenance chain, effect-policy discrimination, and evidence-authority integration before the next Work Order is activated.

---

## Spec Coverage / Self-Review

- **ValidationJourney:** Tasks 2 and 5.
- **ValidationRun:** Tasks 2, 5, 6, and 8.
- **TestIdentity:** Task 4; consumes WORK-063 without replacing it.
- **Environment:** Tasks 2, 3, and 5.
- **EffectPolicy:** Task 3 with exhaustive discrimination tests.
- **ExpectedObservation:** Tasks 2 and 6.
- **Evidence:** Task 7; existing `/verification` remains authoritative.
- **No-silent-healthy invariant:** Tasks 6 and 10.
- **Provenance chain:** Tasks 6 and 7.
- **Failure downstream semantics:** WORK-067/068 remain consumers; WORK-064 only produces typed/provenanced outcomes.
- **Browser execution:** explicitly excluded; belongs to WORK-065.
- **Scheduling:** explicitly excluded; belongs to WORK-066.
- **Progressive release:** explicitly excluded; belongs to WORK-069.
- **Production safety:** Task 3 and Task 10.
- **No second authority:** Tasks 1, 7, 9, and 10.
- **Durable persistence:** Task 8 is conditional on repository evidence; no speculative migration.

## Execution Boundary

This plan implements WORK-064 only. It does not activate or implement WORK-065, WORK-066, WORK-067, WORK-068, WORK-069, or WORK-070. The browser agent remains a consumer of the ValidationJourney contract; the scheduler remains a future consumer of trigger/mode contracts; Engineering Signals remain downstream; Work Items remain governed by the existing `/work-items` authority.
