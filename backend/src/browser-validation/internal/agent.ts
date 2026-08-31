/**
 * WORK-065 — the default {@link BrowserValidationAgent} implementation.
 *
 * THE EXECUTION PATH (spec/architecture/v1.1/validation-model.md §9.3):
 *
 *   admit validation run         (WORK-064 admission — the agent never admits
 *                                 itself; it calls the service boundary)
 *     → enforce EffectPolicy       (before every action — fail closed on
 *                                 FORBIDDEN / mutation-under-READ_ONLY /
 *                                 cross-tenant ISOLATED_MUTATION)
 *     → launch synthetic browser   (the BrowserDriver port — fail closed
 *                                 when no driver is configured:
 *                                 environment_error)
 *     → perform declared journey   (navigate/click/type/extract/screenshot)
 *     → capture observations       (full run→journey→step→environment→time
 *                                 provenance)
 *     → finalize validation run    (WORK-064 finalization derives the typed
 *                                 outcome; the agent never determines health)
 *     → map into /verification     (the EXISTING authority — no parallel
 *                                 store; the agent never creates verification
 *                                 runs)
 *
 * The agent CONSUMES the WORK-064 {@link ContinuousValidationService} for
 * admission, finalization, and evidence mapping. It CONSUMES the existing
 * {@link BrowserDriver} port (WORK-036). It enforces the declared
 * EffectPolicy at execution time. It NEVER mutates code, merges PRs,
 * approves reviews, or transitions workflow state (static-architecture
 * invariant).
 *
 * FAILURE SEMANTICS (never silent):
 *   - rejected admission           → admitted: false, run: null (NO evidence);
 *   - driver unavailable           → environment_error (typed, provenance
 *                                    preserved);
 *   - effect-policy violation      → effect_policy_violation (typed);
 *   - driver timeout/throw          → environment_error (typed);
 *   - selector miss (matched: false) → validation_failure (actual: null);
 *   - missing expected observation  → validation_failure (actual: null);
 *   - partial execution             → completed with captured observations +
 *                                    failures for every unmet expectation.
 */
import type { ContinuousValidationService, ValidationRun, ExecutionError } from '../../continuous-validation/index.js';
import type { BrowserDriver } from '@platform/tools/browser-tool-executor.js';
import type {
  BrowserValidationOutcome,
  ExecuteValidationRunInput,
} from '../types.js';
import type { Logger } from '@platform/logger.js';
import { enforceEffectPolicy } from './effect-policy-enforcement.js';
import {
  executeActionAndCapture,
  buildObservationResults,
  type CapturedObservation,
  type ObservationContext,
} from './observation-capture.js';

/** The default agent's dependencies (all supplied by existing modules). */
export interface DefaultBrowserValidationAgentDeps {
  /** The WORK-064 domain service (admission + finalization + evidence mapping). */
  readonly continuousValidationService: ContinuousValidationService;
  /** The provider browser driver (optional — absent fails closed per call). */
  readonly driver?: BrowserDriver;
  /** The logger (observability — never authority). */
  readonly logger: Logger;
}

/** The default {@link BrowserValidationAgent} implementation. */
export class DefaultBrowserValidationAgent {
  constructor(private readonly deps: DefaultBrowserValidationAgentDeps) {}

  async executeValidationRun(input: ExecuteValidationRunInput): Promise<BrowserValidationOutcome> {
    // 0. THE NAVIGATION-SAFETY PROVENANCE GATE (PR #97 fourth architect
    //    review correction): the input contract is CLOSED. The authoritative
    //    navigation-safety declaration is OWNED BY THE WORK-064 JOURNEY
    //    AUTHORITY — it travels ONLY inside `input.journey`
    //    (`ValidationJourney.readonlySafeNavigationTargets`, declared and
    //    validated at `defineValidationJourney`). There is NO
    //    `journeyNavigationSafety` field on this input, and a runtime caller
    //    who shape-smuggles one past the type system is REJECTED HERE —
    //    BEFORE the admission boundary and BEFORE any browser execution.
    //    A caller-supplied navigation-safety object is a provenance violation
    //    REGARDLESS of its content (even one that "matches" the journey): the
    //    journeyId correlation the third correction checked proved identity,
    //    not provenance — a caller could bind ANY target list to a real
    //    journey id. The only legitimate provenance is the journey itself.
    if ('journeyNavigationSafety' in input) {
      const smuggled = (input as { journeyNavigationSafety?: unknown }).journeyNavigationSafety;
      const smuggledId =
        smuggled !== null && typeof smuggled === 'object' && 'journeyId' in (smuggled as Record<string, unknown>)
          ? String((smuggled as { journeyId?: unknown }).journeyId)
          : String(smuggled);
      return {
        admitted: false,
        admissionReason: `journey ${input.journey.id}: the execution input carries a caller-supplied journeyNavigationSafety object (${smuggledId}) — navigation-safety provenance violation: the declaration is OWNED by the WORK-064 journey authority (ValidationJourney.readonlySafeNavigationTargets) and the executor input has no such field; the run is rejected before admission and the browser is never called (the proof must originate from the journey's canonical state, never from a second caller-provided object)`,
        run: null,
        evidenceReference: null,
      };
    }

    // 1. ADMIT the run through the WORK-064 service boundary. The agent never
    //    admits itself — a rejected admission returns NO run and NO evidence.
    const admission = await this.deps.continuousValidationService.admitRun({
      journey: input.journey,
      identitySource: input.identitySource,
      environment: input.environment,
      mode: input.mode,
      trigger: input.trigger,
      releaseRef: input.releaseRef,
      continuousConfigured: input.continuousConfigured,
      runId: input.runId,
      now: input.now,
    });
    if (!admission.admitted || admission.run === null) {
      return {
        admitted: false,
        admissionReason: admission.reason,
        run: null,
        evidenceReference: null,
      };
    }

    const run = admission.run;
    const identity = admission.identity;
    // admission.identity is non-null when admitted (the admission boundary
    // binds it). The runtime guard is defense in depth.
    if (identity === null) {
      // Should be unreachable (admission binds identity before admitting).
      return {
        admitted: false,
        admissionReason: `run ${run.id} was admitted without a bound identity (unreachable — the admission boundary binds identity before admitting)`,
        run: null,
        evidenceReference: null,
      };
    }

    // 2. EXECUTE the journey's plan: enforce the EffectPolicy before every
    //    action, capture observations with full provenance.
    //    THE AUTHORITATIVE NAVIGATION-SAFETY ALLOWLIST (PR #97 fourth
    //    architect review correction): read from the JOURNEY's CANONICAL
    //    STATE — `journey.readonlySafeNavigationTargets` (declared under
    //    WORK-064's authority, validated at the declaration boundary, frozen
    //    on the immutable journey record). NOT a plan field, NOT an executor
    //    input: the executor constructs the plan (choosing navigate actions)
    //    but CANNOT create, replace, or expand the trusted safe-target set.
    //    Defense in depth: a runtime-crafted journey object that smuggles a
    //    non-array value here fails CLOSED to the empty allowlist (no
    //    navigation is proven read-only-safe).
    const readonlySafeNavigationTargets = Array.isArray(input.journey?.readonlySafeNavigationTargets)
      ? input.journey.readonlySafeNavigationTargets
      : [];
    const now = input.now ?? (() => new Date());
    const ctx: ObservationContext = {
      runId: run.id,
      journeyId: run.journeyId,
      environmentId: run.environmentId,
      now,
    };

    const captured: CapturedObservation[] = [];
    let executionError: ExecutionError | undefined;

    // Fail closed when no browser driver is configured: the run is an
    // explicit environment_error (never a silent no-op, never healthy).
    const driver = this.deps.driver;
    if (!driver) {
      executionError = {
        kind: 'environment_error',
        reason: 'no browser driver is configured — the browser validation capability requires a driver adapter behind the BrowserDriver port (fail closed: never a silent no-op)',
      };
    } else {
      // Execute the plan step by step. The first effect-policy violation or
      // environment error STOPS execution (the run is finalized with the
      // captured observations + the typed execution error). A selector miss
      // (matched: false) does NOT stop execution — it records the satisfying
      // observation as null and continues (partial execution).
      outer: for (const planStep of input.plan.steps) {
        for (const action of planStep.actions) {
          // 2a. Enforce the EffectPolicy BEFORE execution.
          const decision = enforceEffectPolicy(action, run.effectPolicy, identity, input.environment, readonlySafeNavigationTargets);
          if (!decision.admitted && decision.executionError !== null) {
            executionError = decision.executionError;
            this.deps.logger.warn(
              'browser-validation: effect-policy violation — action rejected before execution',
              { runId: run.id, action: action.kind, policy: run.effectPolicy },
            );
            break outer;
          }
          // 2b. Execute the action + capture its observation.
          const result = await executeActionAndCapture(action, planStep.stepId, driver, ctx);
          if (result.kind === 'error') {
            // A driver throw/timeout is an environment_error (the browser
            // environment failed). Stop execution; finalize with the error.
            executionError = { kind: 'environment_error', reason: result.reason };
            this.deps.logger.warn(
              'browser-validation: browser action failed — environment_error',
              { runId: run.id, action: action.kind, reason: result.reason },
            );
            break outer;
          }
          if (result.kind === 'captured') {
            captured.push(result.captured);
          }
          // result.kind === 'no-observation' → the action drove the journey
          // but satisfied no declared expectation (e.g. a navigate that opens
          // a page for a later extract). No observation captured.
        }
      }
    }

    // 3. BUILD the ObservationResult[] for EVERY expected observation. A
    //    captured observation (matched or null) becomes the result's `actual`;
    //    a never-captured expected observation becomes `actual: null,
    //    matched: false` (an explicit failure — never silently dropped).
    const results = buildObservationResults(input.journey, captured, ctx);

    // 4. FINALIZE the run through the WORK-064 service boundary. The agent
    //    never determines health — the finalization boundary derives the
    //    typed outcome from the declared success criteria + the derived
    //    matches + the execution error (when present).
    const completedRun: ValidationRun = await this.deps.continuousValidationService.completeRun({
      run,
      journey: input.journey,
      results,
      executionError,
      completedAt: now().toISOString(),
    });

    // 5. MAP the completed run's outcome into the EXISTING /verification
    //    authority. The agent never creates verification runs — the caller
    //    supplies the verificationRunId. A failed mapping is explicit (the
    //    error propagates; the run is still returned completed).
    let evidenceReference: BrowserValidationOutcome['evidenceReference'] = null;
    try {
      evidenceReference = await this.deps.continuousValidationService.mapOutcomeToVerification({
        run: completedRun,
        projectId: input.projectId,
        verificationRunId: input.verificationRunId,
      });
    } catch (err) {
      // The mapping failed (e.g. the verification run does not exist, or the
      // /verification authority rejected the evidence). The run is still
      // completed (its outcome is preserved); the evidence reference is null.
      // The error is explicit — never a silent pass.
      this.deps.logger.warn(
        'browser-validation: mapping the outcome into /verification failed — the evidence reference is null (the run outcome is preserved)',
        { runId: completedRun.id, err: (err as Error).message },
      );
    }

    return {
      admitted: true,
      admissionReason: admission.reason,
      run: completedRun,
      evidenceReference,
    };
  }
}
