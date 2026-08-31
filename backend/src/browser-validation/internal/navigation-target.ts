/**
 * WORK-065 — the navigation target safety boundary (the AUTHORITATIVE model).
 *
 * THE DEFECT HISTORY THIS MODULE CLOSES (PR #97 architect review rounds):
 *
 *   - first correction: a per-action `targetPolicy` field verified against
 *     the URL structure — but a plain-path GET like `/delete/123` with
 *     `targetPolicy: 'read_only_safe'` was still admitted under READ_ONLY,
 *     and the per-action policy was an executor-supplied assertion;
 *   - second correction: the allowlist moved to the executor-constructed
 *     `BrowserJourneyPlan` — the executor could manufacture safe targets;
 *   - third correction: the allowlist moved to a separate caller-constructed
 *     `JourneyNavigationSafetyDeclaration` — but `defineJourneyNavigationSafety`
 *     accepted an ARBITRARY target list and merely bound it to `journey.id`:
 *     the journeyId check proved identity correlation, NOT the provenance of
 *     the declaration;
 *   - fourth correction (CURRENT): the allowlist is PART OF THE JOURNEY
 *     ITSELF — `ValidationJourney.readonlySafeNavigationTargets`, declared
 *     and validated under WORK-064's authority at `defineValidationJourney`.
 *     The executor input and the plan carry NO declaration: the executor
 *     cannot create, replace, or expand the trusted set.
 *
 * THE INVARIANT (the architect's ruling):
 *
 *   > The browser executor must not turn an executor-supplied assertion into
 *   > authoritative safety — and the safety proof must originate from the
 *   > journey's canonical state, never from a second caller-provided object.
 *
 * THE AUTHORITATIVE MODEL (the fix):
 *
 *   A navigation is `read_only_safe` ONLY when the URL is in the JOURNEY's
 *   AUTHORITATIVE `readonlySafeNavigationTargets` allowlist — the trusted
 *   declaration OWNED by the WORK-064 journey authority (declared on the
 *   canonical ValidationJourney record, validated at the declaration
 *   boundary). The enforcement gate receives that allowlist FROM THE JOURNEY
 *   (the agent reads `journey.readonlySafeNavigationTargets`; there is no
 *   other channel). There is NO per-action safety assertion and NO executor
 *   input field — the executor cannot assert safety OR supply a declaration;
 *   the journey declares it.
 *
 * Classification:
 *
 *   - `forbidden` — the URL has a non-http(s) scheme or embedded userinfo
 *     (categorically rejected under EVERY policy, regardless of the allowlist
 *     — syntactic safety, defense in depth);
 *   - `read_only_safe` — the URL is http(s), no userinfo, AND is in the
 *     journey's allowlist (the journey authority declared it read-only-safe);
 *   - `unverified` — the URL is http(s), no userinfo, but NOT in the journey's
 *     allowlist (no authoritative proof of safety). Under READ_ONLY it is
 *     REJECTED (no proof of safety); under SAFE_MUTATION / ISOLATED_MUTATION
 *     it is admitted (the run has a mutation policy, so a potentially-mutating
 *     navigation is within policy).
 *
 * An empty allowlist means NO navigation is proven read-only-safe (the safe
 * default — every navigate under READ_ONLY is rejected).
 *
 * This is discrimination-proven: the attack shape `GET /delete/123` under
 * READ_ONLY is REJECTED because `/delete/123` is not in the journey's
 * allowlist (unverified). The corresponding test FAILS if the allowlist check
 * is removed — and a caller who smuggles a forged `journeyNavigationSafety`
 * object onto the execution input is rejected by the agent BEFORE admission
 * and browser execution (see agent.ts §0).
 */
/** The closed navigation-target safety classification. */
export type NavigationTargetClass =
  | 'read_only_safe'
  | 'unverified'
  | 'forbidden';

/** The deterministic classification decision (explicit, never inferred). */
export interface NavigationTargetDecision {
  readonly targetClass: NavigationTargetClass;
  readonly reason: string;
}

/**
 * Classify a navigation target against the JOURNEY's authoritative allowlist.
 * Pure, deterministic, side-effect free. Fail closed: every ambiguous or
 * unverified case produces `unverified` (admitted only under a mutation
 * policy); every syntactically-unsafe case produces `forbidden` (rejected
 * under every policy).
 *
 * THE AUTHORITATIVE BOUNDARY: a navigation is `read_only_safe` ONLY when the
 * URL is in the allowlist — the journey authority's trusted declaration
 * (`ValidationJourney.readonlySafeNavigationTargets`, validated at
 * `defineValidationJourney`; the agent is the ONLY caller and passes the
 * journey's canonical field). The URL structure (scheme/userinfo) is a
 * defense-in-depth syntactic check — it cannot prove safety on its own (a
 * plain-path GET may still mutate).
 *
 * (The declaration-side entry validation — `validateSafeNavigationTargetEntry`
 * — lives in WORK-064's continuous-validation domain, at the journey
 * declaration boundary where the allowlist is declared.)
 *
 * @param url the navigate action's target URL
 * @param allowlist the journey's authoritative readonlySafeNavigationTargets
 */
export function classifyNavigationTarget(
  url: string,
  allowlist: readonly string[],
): NavigationTargetDecision {
  if (typeof url !== 'string' || url.trim() === '') {
    return {
      targetClass: 'forbidden',
      reason: 'navigation url must be a non-empty string',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      targetClass: 'forbidden',
      reason: `navigation url is not parseable: ${JSON.stringify(url)}`,
    };
  }
  // 1. Non-http(s) scheme → forbidden (categorically rejected under every
  //    policy, regardless of the allowlist — syntactic safety).
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      targetClass: 'forbidden',
      reason: `navigation url scheme '${parsed.protocol}' is not http(s) — the browser agent rejects unsupported schemes before page.goto()`,
    };
  }
  // 2. Embedded userinfo → forbidden (a navigation must not carry credentials).
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      targetClass: 'forbidden',
      reason: 'navigation url must not embed userinfo (username:password@) — the browser agent rejects userinfo before page.goto()',
    };
  }
  // 3. THE AUTHORITATIVE CHECK: the URL must be in the JOURNEY's
  //    readonlySafeNavigationTargets allowlist (the WORK-064 journey
  //    authority's trusted declaration) to be proven read-only-safe.
  //    The executor CANNOT assert safety and CANNOT supply a declaration —
  //    the journey declares it. A URL not in the allowlist is `unverified`
  //    (no authoritative proof of safety): under READ_ONLY it is REJECTED;
  //    under SAFE_MUTATION / ISOLATED_MUTATION it is admitted (the run has
  //    a mutation policy).
  const allowlistSet = new Set(allowlist);
  if (allowlistSet.has(url)) {
    return {
      targetClass: 'read_only_safe',
      reason: 'navigation target is in the journey\'s authoritative readonlySafeNavigationTargets allowlist (the WORK-064 journey authority\'s trusted declaration of read-only-safe targets)',
    };
  }
  return {
    targetClass: 'unverified',
    reason: `navigation target ${JSON.stringify(url)} is NOT in the journey's readonlySafeNavigationTargets allowlist — the agent has no authoritative proof that this GET does not mutate server state; under READ_ONLY it is rejected (the executor cannot assert safety; the journey must declare the target read-only-safe)`,
  };
}
