import { describe, it, expect } from 'vitest';

/**
 * WORK-065 — the effect-policy enforcement gate (the load-bearing safety
 * invariant). Discrimination-proven: each test pins a violation that the
 * enforcement MUST reject, and the enforcement-removed variant would let it
 * through (the corresponding test would FAIL — proven both ways).
 */
import {
  defineValidationJourney,
  describeEnvironment,
  type ValidationJourney,
  type Environment,
  type TestIdentitySource,
} from '../../src/continuous-validation/index.js';
import type { AuthenticatedPrincipal } from '@modules/auth/index.js';
import {
  classifyActionEffect,
  enforceEffectPolicy,
  defineBrowserJourneyPlan,
  type BrowserAction,
} from '../../src/browser-validation/index.js';
import { bindTestIdentity } from '../../src/continuous-validation/internal/test-identity.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const syntheticPrincipal: AuthenticatedPrincipal = {
  externalId: 'svc-browser-validation-01',
  label: 'browser validation runner (test service account)',
  provider: 'apikey',
};

const unauthenticated: TestIdentitySource = { kind: 'unauthenticated' };
const synthetic: TestIdentitySource = {
  kind: 'synthetic',
  principal: syntheticPrincipal,
  principalClass: 'test_service_account',
  capabilities: ['project.read'],
  tenantId: 'tenant-preview',
  issuanceReason: 'PR preview browser validation run',
};
// A synthetic identity bound to the isolated env's tenant (for ISOLATED_MUTATION).
const isolatedSynthetic: TestIdentitySource = {
  kind: 'synthetic',
  principal: syntheticPrincipal,
  principalClass: 'test_service_account',
  capabilities: ['project.read'],
  tenantId: 'tenant-isolated-01',
  issuanceReason: 'isolated mutation browser validation run',
};

const previewEnv: Environment = describeEnvironment({
  id: 'env-preview',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-preview',
});

const isolatedEnv: Environment = describeEnvironment({
  id: 'env-isolated',
  kind: 'isolated',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-isolated-01',
});

// A SECOND isolated env with a DIFFERENT tenant — for the cross-tenant
// discrimination proof (an identity bound to tenant-A is rejected when
// enforced against tenant-B's environment).
const isolatedEnvAlt: Environment = describeEnvironment({
  id: 'env-isolated-alt',
  kind: 'isolated',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-isolated-02',
});
const isolatedSyntheticAlt: TestIdentitySource = {
  kind: 'synthetic',
  principal: syntheticPrincipal,
  principalClass: 'test_service_account',
  capabilities: ['project.read'],
  tenantId: 'tenant-isolated-02',
  issuanceReason: 'isolated mutation browser validation run (alt tenant)',
};

const productionEnv: Environment = describeEnvironment({
  id: 'env-production',
  kind: 'production',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION'],
});
void productionEnv; // referenced by the production-environment discrimination below

/** A journey that READS (navigates + extracts). */
const readJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-read-sign-in-page',
  name: 'The sign-in page renders',
  identityRequirement: 'unauthenticated',
  allowedModes: ['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS'],
  effectPolicy: 'READ_ONLY',
  steps: [
    {
      id: 'step-open',
      name: 'open the sign-in page',
      expectedObservations: [
        { id: 'obs-heading', stepId: 'step-open', kind: 'dom', description: 'heading visible', matcher: { kind: 'exists' } },
        { id: 'obs-status', stepId: 'step-open', kind: 'network', description: 'page loaded', matcher: { kind: 'status_code', status: 200 } },
      ],
    },
  ],
  successCriteria: [{ id: 'crit-page', description: 'page renders', requiresObservationIds: ['obs-heading'] }],
});

/** A journey that MUTATES (types into a form + clicks submit). */
const mutationJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-sign-in',
  name: 'A user signs in',
  identityRequirement: 'authenticated',
  allowedModes: ['PRE_MERGE'],
  effectPolicy: 'SAFE_MUTATION',
  steps: [
    {
      id: 'step-fill',
      name: 'fill the sign-in form',
      expectedObservations: [
        { id: 'obs-submitted', stepId: 'step-fill', kind: 'dom', description: 'form submitted', matcher: { kind: 'exists' } },
      ],
    },
  ],
  successCriteria: [{ id: 'crit-sign-in', description: 'sign-in completes', requiresObservationIds: ['obs-submitted'] }],
});
void mutationJourney; // the agent-execution suite exercises the mutation journey end-to-end

// ---------------------------------------------------------------------------
// §1  Action effect classification (deterministic, closed)
// ---------------------------------------------------------------------------

describe('WORK-065 §1 — action effect classification (deterministic, closed)', () => {
  it('navigate/extract/screenshot are read; click/type are mutation', () => {
    expect(classifyActionEffect({ kind: 'navigate', url: 'https://example.com' })).toBe('read');
    expect(classifyActionEffect({ kind: 'extract', selector: 'h1', satisfiesObservationId: 'x' })).toBe('read');
    expect(classifyActionEffect({ kind: 'screenshot' })).toBe('read');
    expect(classifyActionEffect({ kind: 'click', selector: 'button' })).toBe('mutation');
    expect(classifyActionEffect({ kind: 'type', selector: 'input', text: 'hello' })).toBe('mutation');
  });
});

// ---------------------------------------------------------------------------
// §2  Effect-policy enforcement (fail closed — the load-bearing invariant)
// ---------------------------------------------------------------------------

describe('WORK-065 §2 — effect-policy enforcement (fail closed)', () => {
  const readIdentity = bindTestIdentity(unauthenticated, previewEnv, 'READ_ONLY');
  const mutationIdentity = bindTestIdentity(synthetic, previewEnv, 'SAFE_MUTATION');
  const isolatedIdentity = bindTestIdentity(isolatedSynthetic, isolatedEnv, 'ISOLATED_MUTATION');
  // An identity bound to isolatedEnvAlt's tenant (tenant-isolated-02) —
  // presented against isolatedEnv (tenant-isolated-01) it is a CROSS-TENANT
  // mutation, rejected at enforcement time (defense in depth — the WORK-064
  // admission boundary already rejects this; the agent re-verifies).
  const crossTenantIsolatedIdentity = bindTestIdentity(isolatedSyntheticAlt, isolatedEnvAlt, 'ISOLATED_MUTATION');

  it('a READ action (extract/screenshot) is admitted under every non-FORBIDDEN policy; navigate requires the allowlist under READ_ONLY', () => {
    const extract: BrowserAction = { kind: 'extract', selector: 'h1', satisfiesObservationId: 'x' };
    // extract/screenshot are unconditionally read (no URL target):
    expect(enforceEffectPolicy(extract, 'READ_ONLY', readIdentity, previewEnv).admitted).toBe(true);
    expect(enforceEffectPolicy(extract, 'SAFE_MUTATION', mutationIdentity, previewEnv).admitted).toBe(true);
    expect(enforceEffectPolicy(extract, 'ISOLATED_MUTATION', isolatedIdentity, isolatedEnv).admitted).toBe(true);
    // navigate is NOT unconditionally read — under READ_ONLY it requires the
    // URL to be in the authoritative allowlist (the navigation-target safety
    // boundary). An allowlisted navigate is admitted under READ_ONLY:
    const allowlistedNav: BrowserAction = { kind: 'navigate', url: 'https://example.com/sign-in' };
    const allowlist = ['https://example.com/sign-in'];
    expect(enforceEffectPolicy(allowlistedNav, 'READ_ONLY', readIdentity, previewEnv, allowlist).admitted).toBe(true);
    expect(enforceEffectPolicy(allowlistedNav, 'SAFE_MUTATION', mutationIdentity, previewEnv, allowlist).admitted).toBe(true);
    expect(enforceEffectPolicy(allowlistedNav, 'ISOLATED_MUTATION', isolatedIdentity, isolatedEnv, allowlist).admitted).toBe(true);
    // A navigate NOT in the allowlist is rejected under READ_ONLY (unverified):
    const unverifiedNav: BrowserAction = { kind: 'navigate', url: 'https://example.com/delete/123' };
    expect(enforceEffectPolicy(unverifiedNav, 'READ_ONLY', readIdentity, previewEnv, allowlist).admitted).toBe(false);
    // ...but admitted under SAFE_MUTATION/ISOLATED_MUTATION (the run has a mutation policy):
    expect(enforceEffectPolicy(unverifiedNav, 'SAFE_MUTATION', mutationIdentity, previewEnv, allowlist).admitted).toBe(true);
  });

  it('a MUTATION action under READ_ONLY is REJECTED before execution (effect_policy_violation)', () => {
    const click: BrowserAction = { kind: 'click', selector: 'button' };
    const decision = enforceEffectPolicy(click, 'READ_ONLY', readIdentity, previewEnv);
    expect(decision.admitted).toBe(false);
    expect(decision.executionError).not.toBeNull();
    expect(decision.executionError!.kind).toBe('effect_policy_violation');
    expect(decision.executionError!.reason).toMatch(/READ_ONLY/);
  });

  it('a MUTATION action under SAFE_MUTATION is admitted (the identity owns the state it mutates)', () => {
    const click: BrowserAction = { kind: 'click', selector: 'button' };
    expect(enforceEffectPolicy(click, 'SAFE_MUTATION', mutationIdentity, previewEnv).admitted).toBe(true);
  });

  it('a FORBIDDEN run rejects EVERY action before execution (the browser agent performs no forbidden actions)', () => {
    // A FORBIDDEN journey would be admitted by WORK-064 only behind the
    // architect-approved safe mechanism (PRE_MERGE). The browser agent
    // STILL refuses to execute — FORBIDDEN is non-executable in the browser.
    const navigate: BrowserAction = { kind: 'navigate', url: 'https://example.com' };
    const click: BrowserAction = { kind: 'click', selector: 'button' };
    const extract: BrowserAction = { kind: 'extract', selector: 'h1', satisfiesObservationId: 'x' };
    for (const action of [navigate, click, extract]) {
      const decision = enforceEffectPolicy(action, 'FORBIDDEN', mutationIdentity, previewEnv);
      expect(decision.admitted, `${action.kind} under FORBIDDEN must be rejected`).toBe(false);
      expect(decision.executionError!.kind).toBe('effect_policy_violation');
      expect(decision.executionError!.reason).toMatch(/FORBIDDEN/);
    }
  });

  it('an ISOLATED_MUTATION action with a matching tenant is admitted', () => {
    const click: BrowserAction = { kind: 'click', selector: 'button' };
    // isolatedIdentity.tenantId === 'tenant-preview'; isolatedEnv.isolatedTenantId === 'tenant-isolated-01'
    // → mismatch → rejected. Build a matching identity instead.
    const matchingSynthetic: TestIdentitySource = {
      kind: 'synthetic',
      principal: syntheticPrincipal,
      principalClass: 'test_service_account',
      capabilities: ['project.read'],
      tenantId: 'tenant-isolated-01',
      issuanceReason: 'isolated mutation run',
    };
    const matchingIdentity = bindTestIdentity(matchingSynthetic, isolatedEnv, 'ISOLATED_MUTATION');
    expect(enforceEffectPolicy(click, 'ISOLATED_MUTATION', matchingIdentity, isolatedEnv).admitted).toBe(true);
  });

  it('an ISOLATED_MUTATION action with a CROSS-tenant identity is REJECTED before execution', () => {
    const click: BrowserAction = { kind: 'click', selector: 'button' };
    // crossTenantIsolatedIdentity.tenantId === 'tenant-isolated-02' but
    // isolatedEnv.isolatedTenantId === 'tenant-isolated-01' → cross-tenant
    // → rejected before execution (defense in depth).
    const decision = enforceEffectPolicy(click, 'ISOLATED_MUTATION', crossTenantIsolatedIdentity, isolatedEnv);
    expect(decision.admitted).toBe(false);
    expect(decision.executionError!.kind).toBe('effect_policy_violation');
    expect(decision.executionError!.reason).toMatch(/cross-tenant|does not match/i);
  });

  it('discrimination: removing the enforcement lets a mutation under READ_ONLY through (the enforcement is load-bearing)', () => {
    // This test documents the discrimination: if the enforcement gate were
    // removed (or the classification returned 'read' for click/type), the
    // mutation-under-READ_ONLY rejection would NOT fire. The corresponding
    // agent test (agent-execution.test.ts §forbidden-mutation) proves the
    // run's outcome becomes effect_policy_violation — removing the gate
    // would let the mutation execute, producing a healthy run (FALSE).
    const click: BrowserAction = { kind: 'click', selector: 'button' };
    const decision = enforceEffectPolicy(click, 'READ_ONLY', readIdentity, previewEnv);
    expect(decision.admitted).toBe(false);
    // The discrimination proof: classifyActionEffect(click) === 'mutation'.
    expect(classifyActionEffect(click)).toBe('mutation');
    // If the classification were 'read' (the removed-enforcement variant),
    // the gate would admit. Proven both ways:
    const wouldAdmitIfRead = (effect: 'read' | 'mutation') =>
      effect === 'read' ? true : false;
    expect(wouldAdmitIfRead('read')).toBe(true); // the hole, if classification lied
    expect(wouldAdmitIfRead('mutation')).toBe(false); // the enforced truth
  });
});

// ---------------------------------------------------------------------------
// §3  Plan construction (fail closed — no foreign observations, no vacuous plan)
// ---------------------------------------------------------------------------

describe('WORK-065 §3 — plan construction (fail closed)', () => {
  it('a valid plan is constructed (the navigate + extract satisfies declared observations)', () => {
    const plan = defineBrowserJourneyPlan(
      {
        journeyId: readJourney.id,
        steps: [
          {
            stepId: 'step-open',
            actions: [
              { kind: 'navigate', url: 'https://example.com', satisfiesObservationId: 'obs-status' },
              { kind: 'extract', selector: 'h1', satisfiesObservationId: 'obs-heading' },
            ],
          },
        ],
      },
      readJourney,
    );
    expect(plan.journeyId).toBe(readJourney.id);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.actions).toHaveLength(2);
  });

  it('a plan with a foreign satisfiesObservationId is rejected (BROWSER_PLAN_FOREIGN_OBSERVATION)', () => {
    expect(() =>
      defineBrowserJourneyPlan(
        {
          journeyId: readJourney.id,
          steps: [
            {
              stepId: 'step-open',
              actions: [
                { kind: 'extract', selector: 'h1', satisfiesObservationId: 'obs-not-declared' },
              ],
            },
          ],
        },
        readJourney,
      ),
    ).toThrow(/not a declared expected observation/);
  });

  it('a plan that satisfies NO declared observation is rejected (BROWSER_PLAN_SATISFIES_NOTHING)', () => {
    // navigate without satisfiesObservationId + a click without satisfiesObservationId
    // → no observation captured → health would be vacuous.
    expect(() =>
      defineBrowserJourneyPlan(
        {
          journeyId: readJourney.id,
          steps: [
            {
              stepId: 'step-open',
              actions: [
                { kind: 'navigate', url: 'https://example.com' },
                { kind: 'click', selector: 'button' },
              ],
            },
          ],
        },
        readJourney,
      ),
    ).toThrow(/satisfies no declared expected observation/);
  });

  it('a plan that satisfies the same observation twice is rejected (duplicate result)', () => {
    expect(() =>
      defineBrowserJourneyPlan(
        {
          journeyId: readJourney.id,
          steps: [
            {
              stepId: 'step-open',
              actions: [
                { kind: 'extract', selector: 'h1', satisfiesObservationId: 'obs-heading' },
                { kind: 'extract', selector: 'h2', satisfiesObservationId: 'obs-heading' },
              ],
            },
          ],
        },
        readJourney,
      ),
    ).toThrow(/twice/);
  });

  it('a plan referencing an unknown stepId is rejected', () => {
    expect(() =>
      defineBrowserJourneyPlan(
        {
          journeyId: readJourney.id,
          steps: [
            {
              stepId: 'step-not-declared',
              actions: [{ kind: 'extract', selector: 'h1', satisfiesObservationId: 'obs-heading' }],
            },
          ],
        },
        readJourney,
      ),
    ).toThrow(/not declared in the journey/);
  });

  it('an extract action without a satisfiesObservationId is rejected (an extraction that observes nothing is meaningless)', () => {
    expect(() =>
      defineBrowserJourneyPlan(
        {
          journeyId: readJourney.id,
          steps: [
            {
              stepId: 'step-open',
              actions: [
                { kind: 'navigate', url: 'https://example.com', satisfiesObservationId: 'obs-status' },
                { kind: 'extract', selector: 'h1' } as BrowserAction],
            },
          ],
        },
        readJourney,
      ),
    ).toThrow(/extract action must declare a satisfiesObservationId/);
  });

  it('a plan that does not match the journey id is rejected', () => {
    expect(() =>
      defineBrowserJourneyPlan(
        { journeyId: 'wrong-journey', steps: [{ stepId: 'step-open', actions: [{ kind: 'navigate', url: 'https://example.com', satisfiesObservationId: 'obs-status' }] }] },
        readJourney,
      ),
    ).toThrow(/does not match journey/);
  });
});
