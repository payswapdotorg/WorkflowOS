/**
 * WORK-065 — Synthetic Browser Validation Agent (public barrel).
 *
 * The synthetic browser validation agent lives at `src/browser-validation/`
 * (application-layer capability OUTSIDE src/modules/ — the §34 benchmark /
 * execution-policy / orchestration / agent-roles / continuous-validation
 * precedent; NOT the 18th frozen module) and CONSUMES the existing
 * authorities:
 *
 *   - validation domain: `../continuous-validation/` (admission, finalization,
 *     evidence mapping — the WORK-064 authority this agent executes under);
 *   - browser driver: `@platform/tools/browser-tool-executor.js` (the neutral
 *     BrowserDriver port established by WORK-036 — NO second browser framework);
 *   - verification/evidence: `../continuous-validation/` → `/verification`
 *     (validation evidence references the existing authority's Evidence rows
 *     through the public attachEvidence boundary — no parallel evidence store);
 *   - identity: `/auth` (the TestIdentity is presented, never minted — the
 *     agent binds an already-authenticated AuthenticatedPrincipal via the
 *     WORK-064 admission boundary);
 *   - composition: `buildApp` constructs the agent and exposes it on AppDeps
 *     for FUTURE consumers (WORK-066 scheduler — NOT implemented here).
 *
 * WORK-066 (scheduling), WORK-067 (signals), WORK-068 (feedback conversion),
 * WORK-069 (progressive release), and WORK-070 (architecture fitness) are
 * NOT implemented here. They are future CONSUMERS of these contracts. The
 * customer-product dogfooding experiment is NOT run by this change.
 */
export {
  // §1 the action vocabulary + effect classification
  classifyActionEffect,
  describeAction,
} from './internal/browser-action.js';
export {
  // §3 the effect-policy enforcement gate
  enforceEffectPolicy,
} from './internal/effect-policy-enforcement.js';
export type { EffectEnforcementDecision } from './internal/effect-policy-enforcement.js';
export {
  // §3b the navigation-target safety boundary (the AUTHORITATIVE allowlist
  // model — the allowlist is the JOURNEY's canonical
  // ValidationJourney.readonlySafeNavigationTargets, NOT an executor input)
  classifyNavigationTarget,
} from './internal/navigation-target.js';
export type {
  NavigationTargetClass,
  NavigationTargetDecision,
} from './internal/navigation-target.js';
export {
  // §2 the plan constructor
  defineBrowserJourneyPlan,
} from './internal/plan.js';
export type { BrowserJourneyPlanInput, BrowserPlanStepInput } from './internal/plan.js';
export {
  // §4 the observation capture
  executeActionAndCapture,
  buildObservationResults,
  evaluateObservation,
} from './internal/observation-capture.js';
export type {
  ActionResult,
  CapturedObservation,
  ObservationContext,
} from './internal/observation-capture.js';
export {
  // §5 the default agent implementation
  DefaultBrowserValidationAgent,
} from './internal/agent.js';
export type { DefaultBrowserValidationAgentDeps } from './internal/agent.js';
export {
  // §6 the Playwright-backed BrowserDriver adapter (the boundary — the ONE
  // place browser-automation libraries appear). Implements the existing
  // BrowserDriver port (WORK-036); NO second browser abstraction.
  PlaywrightBrowserDriver,
} from './internal/playwright-browser-driver.js';
export type { PlaywrightBrowserDriverOptions } from './internal/playwright-browser-driver.js';

export {
  // §4 the typed domain error
  BrowserValidationError,
  BROWSER_VALIDATION_ERROR_CODES,
} from './types.js';
export type {
  // §1 the action vocabulary
  BrowserAction,
  BrowserActionEffect,
  // §2 the plan (carries NO allowlist)
  BrowserPlanStep,
  BrowserJourneyPlan,
  // §3 the agent contract (carries NO navigation-safety declaration — the
  // declaration is journey-owned: ValidationJourney.readonlySafeNavigationTargets)
  BrowserValidationAgent,
  ExecuteValidationRunInput,
  BrowserValidationOutcome,
  // §4 the error
  BrowserValidationErrorCode,
  // §6 re-exports of the consumed authority types
  EffectPolicy,
  Environment,
  TestIdentitySource,
  ValidationJourney,
  ValidationMode,
  ValidationRun,
  ValidationTrigger,
  BrowserDriver,
  BrowserDriverCallOptions,
  BrowserNavigationResult,
  BrowserActionResult,
  BrowserExtractionResult,
  BrowserScreenshotResult,
} from './types.js';
// The agent CONSUMES these authority types (WORK-064 + the EXISTING
// BrowserDriver port, WORK-036). Re-export from the source barrels so
// consumers depend on ONE surface (the browser agent's barrel), not two.
export type { ContinuousValidationService, ValidationEvidenceReference } from '../continuous-validation/index.js';
