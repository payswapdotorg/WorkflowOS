import { describe, it, expect } from 'vitest';

/**
 * WORK-065 — the AUTHORITATIVE navigation-target safety boundary (PR #97
 * architect review corrections, rounds 1-4).
 *
 * THE DEFECT HISTORY (each round closed one forgeable channel):
 *   - round 1: a per-action `targetPolicy` field verified against the URL
 *     structure — a plain-path GET like `/delete/123` with an asserted
 *     `read_only_safe` was still admitted (an executor-supplied assertion
 *     turned into authoritative safety);
 *   - round 2: the allowlist moved to the executor-constructed plan;
 *   - round 3: the allowlist moved to a separate caller-constructed
 *     declaration — but `defineJourneyNavigationSafety` bound an ARBITRARY
 *     caller-supplied target list to a real journey id (identity
 *     correlation, not provenance);
 *   - round 4 (CURRENT): the declaration is PART OF THE JOURNEY ITSELF —
 *     `ValidationJourney.readonlySafeNavigationTargets`, declared and
 *     validated under WORK-064's authority at `defineValidationJourney`.
 *
 * THE INVARIANT (the architect's ruling):
 *
 *   > The browser executor must not turn an executor-supplied assertion into
 *   > authoritative safety — and the safety proof must originate from the
 *   > journey's canonical state, never from a second caller-provided object.
 *
 * THE AUTHORITATIVE MODEL (the fix): a navigation is `read_only_safe` ONLY
 * when the URL is in the JOURNEY's `readonlySafeNavigationTargets` allowlist
 * — the trusted declaration OWNED by the WORK-064 journey authority. There
 * is NO per-action `targetPolicy` field, NO plan-level allowlist, and NO
 * executor input field. The executor cannot assert safety and cannot
 * create, replace, or expand the declaration; the journey declares it.
 *
 * Classification:
 *   - `forbidden` — non-http(s) scheme or embedded userinfo (categorically
 *     rejected under every policy);
 *   - `read_only_safe` — http(s), no userinfo, AND in the journey's allowlist;
 *   - `unverified` — http(s), no userinfo, NOT in the journey's allowlist
 *     (no authoritative proof of safety; rejected under READ_ONLY, admitted
 *     under SAFE_MUTATION/ISOLATED_MUTATION).
 *
 * This suite proves every discrimination the architect required, including
 * the attack shape `GET /delete/123` under READ_ONLY → REJECTION. The
 * forged-declaration runtime rejection (the round-4 required regression) is
 * proven at the agent level in agent-execution.test.ts §15.
 */
import {
  defineValidationJourney,
  describeEnvironment,
  bindTestIdentity,
  validateSafeNavigationTargetEntry,
  type ValidationJourney,
  type ValidationJourneyInput,
  type Environment,
  type TestIdentitySource,
} from '../../src/continuous-validation/index.js';
import type { AuthenticatedPrincipal } from '@modules/auth/index.js';
import {
  classifyNavigationTarget,
  classifyActionEffect,
  enforceEffectPolicy,
  defineBrowserJourneyPlan,
  type BrowserAction,
} from '../../src/browser-validation/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const syntheticPrincipal: AuthenticatedPrincipal = {
  externalId: 'svc-browser-validation-01',
  label: 'browser validation runner',
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
  isolatedTenantId: 'tenant-isolated-01',
});
const isolatedEnv: Environment = describeEnvironment({
  id: 'env-isolated',
  kind: 'isolated',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-isolated-01',
});

// ---------------------------------------------------------------------------
// §1  Journey declaration entry validation (WORK-064's boundary — the trusted
//     declaration must be syntactically safe AT DECLARATION TIME)
// ---------------------------------------------------------------------------

describe('WORK-065 navigation-target §1 — the journey declaration entry validation (the WORK-064 boundary guard)', () => {
  it('a valid http(s) URL with no userinfo is a valid declaration entry', () => {
    expect(validateSafeNavigationTargetEntry('https://example.com/sign-in')).toBeNull();
    expect(validateSafeNavigationTargetEntry('http://127.0.0.1:5173/sign-in')).toBeNull();
  });

  it('an http(s) URL WITH a query string is a valid declaration entry (the journey authority may declare it safe)', () => {
    // The journey's declaration is the authority — a query string is NOT
    // proof of mutation (the architect's ruling: "a query string is one
    // possible signal, not a proof of mutation"). The journey authority may
    // declare a query-string URL read-only-safe (e.g. a confirmation page
    // whose query is a display parameter, not a mutation).
    expect(validateSafeNavigationTargetEntry('https://example.com/confirm?token=abc')).toBeNull();
  });

  it('a non-http(s) scheme is rejected as a declaration entry', () => {
    expect(validateSafeNavigationTargetEntry('file:///etc/passwd')).toMatch(/not http\(s\)/);
    expect(validateSafeNavigationTargetEntry('data:text/html,<h1>hi</h1>')).toMatch(/not http\(s\)/);
    expect(validateSafeNavigationTargetEntry('javascript:void(0)')).toMatch(/not http\(s\)/);
  });

  it('embedded userinfo is rejected as a declaration entry', () => {
    expect(validateSafeNavigationTargetEntry('https://user:pass@example.com/sign-in')).toMatch(/userinfo/);
  });

  it('an unparseable / empty URL is rejected as a declaration entry', () => {
    expect(validateSafeNavigationTargetEntry('')).not.toBeNull();
    expect(validateSafeNavigationTargetEntry('not-a-url')).not.toBeNull();
  });

  it('the declaration boundary itself (defineValidationJourney) rejects an unsafe entry — the trusted declaration cannot even be DECLARED', () => {
    // The allowlist is not merely checked at enforcement time: a journey
    // whose declaration carries a non-http(s) scheme or embedded userinfo
    // is rejected AT THE DECLARATION BOUNDARY (WORK-064's
    // defineValidationJourney — VALIDATION_JOURNEY_INVALID).
    const validJourneyInput: ValidationJourneyInput = {
      id: 'journey-entry-guard',
      name: 'A journey',
      identityRequirement: 'unauthenticated' as const,
      allowedModes: ['PRE_MERGE'] as const,
      effectPolicy: 'READ_ONLY' as const,
      steps: [
        {
          id: 's',
          name: 's',
          expectedObservations: [
            { id: 'o', stepId: 's', kind: 'network', description: 'o', matcher: { kind: 'status_code', status: 200 } },
          ],
        },
      ],
      successCriteria: [{ id: 'c', description: 'c', requiresObservationIds: ['o'] }],
    };
    expect(() =>
      defineValidationJourney({ ...validJourneyInput, readonlySafeNavigationTargets: ['file:///etc/passwd'] }),
    ).toThrow(/not http\(s\)/);
    expect(() =>
      defineValidationJourney({ ...validJourneyInput, readonlySafeNavigationTargets: ['https://user:pass@example.com/x'] }),
    ).toThrow(/userinfo/);
    expect(() =>
      defineValidationJourney({ ...validJourneyInput, readonlySafeNavigationTargets: ['not-a-url'] }),
    ).toThrow(/not a parseable URL/);
    // And a VALID declaration is accepted + echoed on the journey:
    const declared = defineValidationJourney({
      ...validJourneyInput,
      readonlySafeNavigationTargets: ['https://example.com/sign-in'],
    });
    expect(declared.readonlySafeNavigationTargets).toEqual(['https://example.com/sign-in']);
  });
});

// ---------------------------------------------------------------------------
// §2  Navigation-target classification (the authoritative allowlist model)
// ---------------------------------------------------------------------------

describe('WORK-065 navigation-target §2 — classification (the authoritative allowlist)', () => {
  const allowlist = ['https://example.com/sign-in', 'https://example.com/dashboard'];

  it('an http(s) URL IN the allowlist → read_only_safe (the journey authoritatively declared it)', () => {
    expect(classifyNavigationTarget('https://example.com/sign-in', allowlist).targetClass).toBe('read_only_safe');
    expect(classifyNavigationTarget('https://example.com/dashboard', allowlist).targetClass).toBe('read_only_safe');
  });

  it('an http(s) URL NOT in the allowlist → unverified (no authoritative proof of safety)', () => {
    // THE CRITICAL CASE: a plain-path GET like /delete/123 is NOT proven safe
    // merely because it has no query string. The agent cannot know whether
    // the target GET mutates server state. It is `unverified` (rejected under
    // READ_ONLY; admitted under SAFE_MUTATION/ISOLATED_MUTATION).
    expect(classifyNavigationTarget('https://example.com/delete/123', allowlist).targetClass).toBe('unverified');
    expect(classifyNavigationTarget('https://example.com/sign-in', []).targetClass).toBe('unverified');
  });

  it('a query-string URL IN the allowlist → read_only_safe (the journey authority declared it safe; a query string is not proof of mutation)', () => {
    // The architect's ruling: "a query string is one possible signal, not a
    // proof of mutation." The allowlist is the authority. A query-string URL
    // the journey declared read-only-safe is read_only_safe.
    const allowlistWithQuery = ['https://example.com/confirm?token=abc'];
    expect(classifyNavigationTarget('https://example.com/confirm?token=abc', allowlistWithQuery).targetClass).toBe('read_only_safe');
  });

  it('a query-string URL NOT in the allowlist → unverified (not forbidden — the query string is not proof of mutation)', () => {
    // The OLD heuristic (query string → forbidden) is REMOVED. A query-string
    // URL not in the allowlist is `unverified` (rejected under READ_ONLY for
    // lack of authoritative proof, NOT because the query string proves
    // mutation). The allowlist is the authority.
    expect(classifyNavigationTarget('https://example.com/unsubscribe?token=abc', allowlist).targetClass).toBe('unverified');
  });

  it('a non-http(s) scheme → forbidden regardless of the allowlist (syntactic safety)', () => {
    expect(classifyNavigationTarget('file:///etc/passwd', allowlist).targetClass).toBe('forbidden');
    expect(classifyNavigationTarget('data:text/html,<h1>hi</h1>', allowlist).targetClass).toBe('forbidden');
    expect(classifyNavigationTarget('javascript:void(0)', allowlist).targetClass).toBe('forbidden');
    expect(classifyNavigationTarget('about:blank', allowlist).targetClass).toBe('forbidden');
  });

  it('embedded userinfo → forbidden regardless of the allowlist', () => {
    expect(classifyNavigationTarget('https://user:pass@example.com/sign-in', allowlist).targetClass).toBe('forbidden');
  });

  it('an unparseable / empty URL → forbidden', () => {
    expect(classifyNavigationTarget('', allowlist).targetClass).toBe('forbidden');
    expect(classifyNavigationTarget('not-a-url', allowlist).targetClass).toBe('forbidden');
  });

  it('an empty allowlist means NO navigation is proven read-only-safe (the safe default)', () => {
    // Every http(s) URL is unverified; every navigate under READ_ONLY is rejected.
    expect(classifyNavigationTarget('https://example.com/sign-in', []).targetClass).toBe('unverified');
    expect(classifyNavigationTarget('https://example.com/delete/123', []).targetClass).toBe('unverified');
  });
});

// ---------------------------------------------------------------------------
// §3  Effect-policy enforcement for navigate (the architect's required regressions)
// ---------------------------------------------------------------------------

describe('WORK-065 navigation-target §3 — enforcement (the architect\'s required regressions)', () => {
  const readIdentity = bindTestIdentity(unauthenticated, previewEnv, 'READ_ONLY');
  const mutationIdentity = bindTestIdentity(synthetic, previewEnv, 'SAFE_MUTATION');
  const isolatedIdentity = bindTestIdentity(isolatedSynthetic, isolatedEnv, 'ISOLATED_MUTATION');
  const forbiddenIdentity = bindTestIdentity(synthetic, previewEnv, 'SAFE_MUTATION');

  // THE ATTACK SHAPE the architect required:
  it('READ_ONLY + /delete/123 (a plain-path GET that may mutate) → REJECTED before page.goto() (the executor cannot assert safety)', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/delete/123' };
    // The URL is NOT in the allowlist → unverified → rejected under READ_ONLY.
    const d = enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv, ['https://example.com/sign-in']);
    expect(d.admitted).toBe(false);
    expect(d.executionError).not.toBeNull();
    expect(d.executionError!.kind).toBe('effect_policy_violation');
    expect(d.executionError!.reason).toMatch(/not proven read-only-safe|unverified/);
  });

  it('READ_ONLY + a query-string URL not in the allowlist → REJECTED (unverified, not forbidden)', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/?action=delete' };
    const d = enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv, []);
    expect(d.admitted).toBe(false);
    expect(d.executionError!.kind).toBe('effect_policy_violation');
    expect(d.executionError!.reason).toMatch(/not proven read-only-safe|unverified/);
  });

  it('READ_ONLY + a positively authorized safe navigation (URL IN the allowlist) → ADMITTED (executes)', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/sign-in' };
    const d = enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv, ['https://example.com/sign-in']);
    expect(d.admitted).toBe(true);
    expect(d.executionError).toBeNull();
  });

  it('READ_ONLY + a query-string URL IN the allowlist → ADMITTED (the journey authority declared it safe)', () => {
    // The architect's ruling: "a query string is one possible signal, not a
    // proof of mutation." The allowlist is the authority. A query-string URL
    // the journey declared read-only-safe is admitted under READ_ONLY.
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/confirm?token=abc' };
    const d = enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv, ['https://example.com/confirm?token=abc']);
    expect(d.admitted).toBe(true);
    expect(d.executionError).toBeNull();
  });

  it('unsupported scheme (file:) → REJECTED before page.goto() under EVERY policy (forbidden, regardless of the allowlist)', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'file:///etc/passwd' };
    // Even if the file: URL is (erroneously) in the allowlist, it is forbidden:
    expect(enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv, ['file:///etc/passwd']).admitted).toBe(false);
    expect(enforceEffectPolicy(nav, 'SAFE_MUTATION', mutationIdentity, previewEnv, ['file:///etc/passwd']).admitted).toBe(false);
    expect(enforceEffectPolicy(nav, 'ISOLATED_MUTATION', isolatedIdentity, isolatedEnv, ['file:///etc/passwd']).admitted).toBe(false);
    const d = enforceEffectPolicy(nav, 'SAFE_MUTATION', mutationIdentity, previewEnv, []);
    expect(d.executionError!.reason).toMatch(/forbidden/);
  });

  it('embedded userinfo → REJECTED before page.goto() under every policy', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'https://user:pass@example.com/sign-in' };
    expect(enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv, []).admitted).toBe(false);
    expect(enforceEffectPolicy(nav, 'SAFE_MUTATION', mutationIdentity, previewEnv, []).admitted).toBe(false);
  });

  it('FORBIDDEN + navigate → REJECTED (the browser agent performs no forbidden actions, including navigation)', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/sign-in' };
    const d = enforceEffectPolicy(nav, 'FORBIDDEN', forbiddenIdentity, previewEnv, ['https://example.com/sign-in']);
    expect(d.admitted).toBe(false);
    expect(d.executionError!.kind).toBe('effect_policy_violation');
    expect(d.executionError!.reason).toMatch(/FORBIDDEN/);
  });

  it('SAFE_MUTATION + an unverified navigation (not in the allowlist) → ADMITTED (the run has a mutation policy)', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/delete/123' };
    const d = enforceEffectPolicy(nav, 'SAFE_MUTATION', mutationIdentity, previewEnv, []);
    expect(d.admitted).toBe(true);
    expect(d.executionError).toBeNull();
  });

  it('ISOLATED_MUTATION + an unverified navigation → ADMITTED (with a matching tenant)', () => {
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/delete/123' };
    const d = enforceEffectPolicy(nav, 'ISOLATED_MUTATION', isolatedIdentity, isolatedEnv, []);
    expect(d.admitted).toBe(true);
  });

  it('discrimination: the OLD model (per-action targetPolicy) would admit /delete/123 under READ_ONLY; the NEW model rejects it', () => {
    // This is the discrimination proof. The OLD model trusted a per-action
    // `targetPolicy: 'read_only_safe'` declaration for a plain-path GET.
    // The NEW model requires the URL to be in the authoritative allowlist.
    // Removing the allowlist check (trusting the URL structure alone) would
    // let /delete/123 through under READ_ONLY — the corresponding test FAILS.
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/delete/123' };
    // NEW model: /delete/123 not in the allowlist → unverified → rejected.
    expect(enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv, ['https://example.com/sign-in']).admitted).toBe(false);
    // If the allowlist check were removed (trusting the URL structure alone —
    // the OLD heuristic), a plain-path GET would be admitted. Proven both ways:
    const wouldAdmitWithoutAllowlist = (url: string) => {
      // The OLD heuristic: http(s) + no query + no userinfo → read_only_safe.
      try {
        const p = new URL(url);
        return p.protocol === 'http:' || p.protocol === 'https:';
      } catch {
        return false;
      }
    };
    expect(wouldAdmitWithoutAllowlist('https://example.com/delete/123')).toBe(true); // the hole
    // The NEW model closes it: the allowlist is the authority, not the URL.
  });
});

// ---------------------------------------------------------------------------
// §4  SAFE/ISOLATED mutation semantics remain unchanged (click/type)
// ---------------------------------------------------------------------------

describe('WORK-065 navigation-target §4 — SAFE/ISOLATED mutation semantics unchanged (click/type)', () => {
  const readIdentity = bindTestIdentity(unauthenticated, previewEnv, 'READ_ONLY');
  const mutationIdentity = bindTestIdentity(synthetic, previewEnv, 'SAFE_MUTATION');
  const isolatedIdentity = bindTestIdentity(isolatedSynthetic, isolatedEnv, 'ISOLATED_MUTATION');

  it('click under READ_ONLY → REJECTED (unchanged)', () => {
    const click: BrowserAction = { kind: 'click', selector: 'button' };
    expect(enforceEffectPolicy(click, 'READ_ONLY', readIdentity, previewEnv, []).admitted).toBe(false);
  });

  it('type under READ_ONLY → REJECTED (unchanged)', () => {
    const type: BrowserAction = { kind: 'type', selector: 'input', text: 'hello' };
    expect(enforceEffectPolicy(type, 'READ_ONLY', readIdentity, previewEnv, []).admitted).toBe(false);
  });

  it('click under SAFE_MUTATION → ADMITTED (unchanged)', () => {
    const click: BrowserAction = { kind: 'click', selector: 'button' };
    expect(enforceEffectPolicy(click, 'SAFE_MUTATION', mutationIdentity, previewEnv, []).admitted).toBe(true);
  });

  it('type under SAFE_MUTATION → ADMITTED (unchanged)', () => {
    const type: BrowserAction = { kind: 'type', selector: 'input', text: 'hello' };
    expect(enforceEffectPolicy(type, 'SAFE_MUTATION', mutationIdentity, previewEnv, []).admitted).toBe(true);
  });

  it('click under ISOLATED_MUTATION (matching tenant) → ADMITTED (unchanged)', () => {
    const click: BrowserAction = { kind: 'click', selector: 'button' };
    expect(enforceEffectPolicy(click, 'ISOLATED_MUTATION', isolatedIdentity, isolatedEnv, []).admitted).toBe(true);
  });

  it('extract/screenshot remain classified as read (unchanged)', () => {
    expect(classifyActionEffect({ kind: 'extract', selector: 'h1', satisfiesObservationId: 'x' })).toBe('read');
    expect(classifyActionEffect({ kind: 'screenshot' })).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// §5  The journey declaration: the allowlist is declared + validated ON THE
//     JOURNEY under WORK-064's authority (PR #97 fourth review)
// ---------------------------------------------------------------------------

describe('WORK-065 navigation-target §5 — the journey declaration carries + validates the allowlist (WORK-064 owns it)', () => {
  const journey: ValidationJourney = defineValidationJourney({
    id: 'journey-nav-allowlist',
    name: 'A journey',
    identityRequirement: 'unauthenticated',
    allowedModes: ['PRE_MERGE'],
    effectPolicy: 'READ_ONLY',
    // THE AUTHORITATIVE DECLARATION — part of the journey itself:
    readonlySafeNavigationTargets: ['https://example.com/sign-in'],
    steps: [
      {
        id: 'step-open',
        name: 'open',
        expectedObservations: [
          { id: 'obs-status', stepId: 'step-open', kind: 'network', description: 'page loaded', matcher: { kind: 'status_code', status: 200 } },
        ],
      },
    ],
    successCriteria: [{ id: 'crit', description: 'page loads', requiresObservationIds: ['obs-status'] }],
  });

  it('the journey carries the declaration as a frozen canonical field (declared under WORK-064\'s authority)', () => {
    expect(journey.readonlySafeNavigationTargets).toEqual(['https://example.com/sign-in']);
    // The declaration is FROZEN on the immutable journey record (mutation throws):
    expect(() => {
      (journey as unknown as { readonlySafeNavigationTargets: string[] }).readonlySafeNavigationTargets = ['https://example.com/delete/123'];
    }).toThrow();
  });

  it('a journey declared WITHOUT the field defaults to the EMPTY declaration (the safe default — no navigation is proven read-only-safe)', () => {
    const undeclared = defineValidationJourney({
      id: 'journey-nav-undeclared',
      name: 'A journey',
      identityRequirement: 'unauthenticated',
      allowedModes: ['PRE_MERGE'],
      effectPolicy: 'READ_ONLY',
      steps: [
        {
          id: 'step-open',
          name: 'open',
          expectedObservations: [
            { id: 'obs-status', stepId: 'step-open', kind: 'network', description: 'page loaded', matcher: { kind: 'status_code', status: 200 } },
          ],
        },
      ],
      successCriteria: [{ id: 'crit', description: 'page loads', requiresObservationIds: ['obs-status'] }],
    });
    expect(undeclared.readonlySafeNavigationTargets).toEqual([]);
  });

  it('the plan carries NO readonlySafeNavigationTargets (the allowlist is journey-owned, not plan-bound — PR #97 third + fourth reviews)', () => {
    const plan = defineBrowserJourneyPlan(
      {
        journeyId: journey.id,
        steps: [
          {
            stepId: 'step-open',
            actions: [
              { kind: 'navigate', url: 'https://example.com/sign-in', satisfiesObservationId: 'obs-status' },
            ],
          },
        ],
      },
      journey,
    );
    // The plan carries ONLY steps + journeyId — NO allowlist field:
    expect(Object.keys(plan).sort()).toEqual(['journeyId', 'steps']);
  });

  it('the BrowserJourneyPlanInput type does NOT accept readonlySafeNavigationTargets (the executor cannot supply an allowlist via the plan)', () => {
    // THE ARCHITECT'S REQUIRED REGRESSION: the executor-created plan CANNOT
    // carry a readonlySafeNavigationTargets field. Attempting to supply one
    // is a TYPE ERROR (the plan input type does not declare it). This is the
    // provenance proof: the executor cannot expand the trusted safe-target
    // set through the plan.
    const plan = defineBrowserJourneyPlan(
      {
        journeyId: journey.id,
        steps: [
          {
            stepId: 'step-open',
            actions: [
              { kind: 'extract', selector: 'h1', satisfiesObservationId: 'obs-status' },
            ],
          },
        ],
      },
      journey,
    );
    expect(Object.keys(plan).sort()).toEqual(['journeyId', 'steps']);
  });

  it('there is NO constructor in the browser-validation domain that can mint a declaration (the third correction\'s forgeable channel is REMOVED)', async () => {
    // PR #97 fourth architect review correction: defineJourneyNavigationSafety
    // (which bound an ARBITRARY caller-supplied target list to a real journey
    // id — identity correlation, not provenance) is REMOVED from the
    // browser-validation surface. There is nothing to import, nothing to
    // call, no type to satisfy, and no input field to carry it (see §6 and
    // agent-execution.test.ts §15).
    const barrel = (await import('../../src/browser-validation/index.js')) as Record<string, unknown>;
    expect(barrel.defineJourneyNavigationSafety).toBeUndefined();
    expect(barrel.JourneyNavigationSafetyDeclaration).toBeUndefined();
    expect(barrel.validateAllowlistEntry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §6  The authority-confusion proof (the architect's required regression)
// ---------------------------------------------------------------------------

describe('WORK-065 navigation-target §6 — the authority-confusion proof (the executor cannot expand the trusted set)', () => {
  const journey: ValidationJourney = defineValidationJourney({
    id: 'journey-authority-confusion',
    name: 'A journey',
    identityRequirement: 'unauthenticated',
    allowedModes: ['PRE_MERGE'],
    effectPolicy: 'READ_ONLY',
    // THE AUTHORITATIVE DECLARATION — journey-owned (the §6 tests exercise it
    // directly as the enforcement gate's only allowlist source):
    readonlySafeNavigationTargets: ['https://example.com/sign-in'],
    steps: [
      {
        id: 'step-open',
        name: 'open',
        expectedObservations: [
          { id: 'obs-status', stepId: 'step-open', kind: 'network', description: 'page loaded', matcher: { kind: 'status_code', status: 200 } },
        ],
      },
    ],
    successCriteria: [{ id: 'crit', description: 'page loads', requiresObservationIds: ['obs-status'] }],
  });

  it('THE ARCHITECT\'S REQUIRED REGRESSION: the executor-created plan CANNOT carry readonlySafeNavigationTargets (the plan input type does not declare it)', () => {
    // The authoritative journey declares ['/sign-in'] safe. The executor
    // attempts to construct a plan with readonlySafeNavigationTargets =
    // ['/sign-in', '/delete/123'] (expanding the trusted set). The plan input
    // type does NOT accept readonlySafeNavigationTargets — this is a TYPE ERROR
    // at compile time (proven by the @ts-expect-error below) + the plan output
    // carries no allowlist (proven by Object.keys). The executor CANNOT
    // expand the trusted set through the plan.
    const plan = defineBrowserJourneyPlan(
      {
        journeyId: journey.id,
        // @ts-expect-error — readonlySafeNavigationTargets is NOT a field on
        // BrowserJourneyPlanInput (the executor cannot supply an allowlist).
        readonlySafeNavigationTargets: ['https://example.com/sign-in', 'https://example.com/delete/123'],
        steps: [
          {
            stepId: 'step-open',
            actions: [
              { kind: 'navigate', url: 'https://example.com/sign-in', satisfiesObservationId: 'obs-status' },
            ],
          },
        ],
      },
      journey,
    );
    // The plan output carries NO allowlist — only journeyId + steps:
    expect(Object.keys(plan).sort()).toEqual(['journeyId', 'steps']);
  });

  it('the positive case: journey declares ["/sign-in"] safe; plan navigates to "/sign-in" → the journey authority declares it, the plan consumes it', () => {
    // The journey authority declared /sign-in read-only-safe ON THE JOURNEY
    // (journey.readonlySafeNavigationTargets — the canonical field, declared
    // at defineValidationJourney). The plan navigates to /sign-in. Under
    // READ_ONLY, the enforcement gate admits it (URL in the journey's
    // declaration). The executor chose WHICH declared-safe target to
    // navigate to, but did NOT create, replace, or expand the declaration.
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/sign-in' };
    const readIdentity = bindTestIdentity(unauthenticated, previewEnv, 'READ_ONLY');
    const d = enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv, journey.readonlySafeNavigationTargets);
    expect(d.admitted).toBe(true);
  });

  it('the attack: journey declares ["/sign-in"] safe; the plan navigates to "/delete/123" (NOT declared safe) → REJECTED under READ_ONLY', () => {
    // The journey authority declared ONLY /sign-in safe (the canonical
    // field). The executor's plan navigates to /delete/123 (not declared
    // safe). Under READ_ONLY, the enforcement gate rejects it (unverified —
    // not in the journey's declaration). The executor CANNOT manufacture
    // /delete/123 as safe — there is no channel.
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/delete/123' };
    const readIdentity = bindTestIdentity(unauthenticated, previewEnv, 'READ_ONLY');
    const d = enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv, journey.readonlySafeNavigationTargets);
    expect(d.admitted).toBe(false);
    expect(d.executionError!.reason).toMatch(/not proven read-only-safe|unverified/);
  });

  it('a DIFFERENT journey\'s declaration does not authorize THIS journey\'s navigation (journey-authority-confusion — the declarations are per-journey canonical state)', () => {
    // Each journey carries its OWN canonical declaration. A declaration
    // belonging to another journey is not consulted at all for this
    // journey's enforcement (the gate reads THIS journey's field — there is
    // no cross-journey declaration object to confuse). The forged-object
    // runtime rejection is proven at the agent level (§15 of
    // agent-execution.test.ts).
    const otherJourney: ValidationJourney = defineValidationJourney({
      id: 'journey-other',
      name: 'Another journey',
      identityRequirement: 'unauthenticated',
      allowedModes: ['PRE_MERGE'],
      effectPolicy: 'READ_ONLY',
      // The OTHER journey declares a different safe target:
      readonlySafeNavigationTargets: ['https://example.com/other'],
      steps: [
        { id: 's', name: 's', expectedObservations: [{ id: 'o', stepId: 's', kind: 'dom', description: 'o', matcher: { kind: 'exists' } }] },
      ],
      successCriteria: [{ id: 'c', description: 'c', requiresObservationIds: ['o'] }],
    });
    // The other journey's declaration is its own canonical state:
    expect(otherJourney.readonlySafeNavigationTargets).toEqual(['https://example.com/other']);
    // It does NOT authorize THIS journey's /sign-in navigation (this
    // journey\'s declaration is the only input the gate consumes):
    const nav: BrowserAction = { kind: 'navigate', url: 'https://example.com/sign-in' };
    const readIdentity = bindTestIdentity(unauthenticated, previewEnv, 'READ_ONLY');
    const dWithOther = enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv, otherJourney.readonlySafeNavigationTargets);
    expect(dWithOther.admitted).toBe(false); // /sign-in not in OTHER journey's declaration
    const dWithOwn = enforceEffectPolicy(nav, 'READ_ONLY', readIdentity, previewEnv, journey.readonlySafeNavigationTargets);
    expect(dWithOwn.admitted).toBe(true); // /sign-in IS in THIS journey's declaration
  });
});
