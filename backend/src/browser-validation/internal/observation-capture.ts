/**
 * WORK-065 — the observation capture: maps {@link BrowserDriver} results into
 * {@link ValidationObservation} records with the full run→journey→step→
 * environment→time provenance chain, and builds the {@link ObservationResult}[]
 * the WORK-064 finalization boundary consumes.
 *
 * THE CONTRACT (spec/architecture/v1.1/validation-model.md §9.5;
 * evidence-provenance-model.md §5): every observation records its source
 * (run, journey, step, environment, timestamp). The agent never produces
 * free-floating observations. A missing observation (no action satisfied it,
 * or the action produced `matched: false`) is an EXPLICIT failure —
 * `actual: null`, `matched: false` — never a silent pass.
 *
 * The agent does NOT determine health: it computes `matched` via the
 * WORK-064 deterministic evaluator (`evaluateObservation`) so the asserted
 * value is always consistent with the derivation. The finalization boundary
 * RE-derives the match and REJECTS any contradiction (PR #86 correction 3)
 * — the agent can fabricate neither a false healthy nor a false failure.
 */
import type {
  BrowserActionResult,
  BrowserDriver,
  BrowserExtractionResult,
  BrowserNavigationResult,
  BrowserScreenshotResult,
} from '@platform/tools/browser-tool-executor.js';
import type {
  ObservationProvenance,
  ObservationResult,
  ValidationJourney,
  ValidationObservation,
} from '../../continuous-validation/index.js';
import { recordObservation, evaluateObservation } from '../../continuous-validation/index.js';
import type { BrowserAction } from '../types.js';
import { describeAction } from './browser-action.js';

/** The minimal context every captured observation carries. */
export interface ObservationContext {
  readonly runId: string;
  readonly journeyId: string;
  readonly environmentId: string;
  /** A monotonic clock the agent supplies (deterministic in tests). */
  readonly now: () => Date;
}

/**
 * A captured observation keyed by the expected observation id it satisfies.
 * `actual` is null when the action ran but produced no observation (e.g. a
 * selector miss returns `matched: false` — the observation is explicitly
 * MISSING, never silently dropped).
 */
export interface CapturedObservation {
  readonly satisfiesObservationId: string;
  readonly stepId: string;
  readonly actual: ValidationObservation | null;
}

// ---------------------------------------------------------------------------
// The action → observation mapping (one captured observation per satisfied id)
// ---------------------------------------------------------------------------

/**
 * Execute a browser action through the driver and capture its observation
 * (if it declares a `satisfiesObservationId`). Returns:
 *   - `{ kind: 'captured', ... }` when the action produced an observation
 *     (the value may still indicate a selector miss — captured as null);
 *   - `{ kind: 'no-observation' }` when the action declares no
 *     satisfiesObservationId (e.g. a navigate that opens a page for a later
 *     extract, or a click that drives the journey but satisfies nothing);
 *   - `{ kind: 'error', reason }` when the driver threw (a timeout, a browser
 *     crash, a network failure) — the agent records an environment_error.
 *
 * NEVER throws — every failure is an explicit outcome.
 */
export type ActionResult =
  | { readonly kind: 'captured'; readonly captured: CapturedObservation }
  | { readonly kind: 'no-observation' }
  | { readonly kind: 'error'; readonly reason: string };

/**
 * Execute a single browser action and capture its observation (when it
 * satisfies a declared expectation). The driver call is bounded by the
 * action's `timeoutMs` (the driver enforces the bound; a timeout surfaces
 * as `{ kind: 'error', reason }` — the agent records environment_error).
 */
export async function executeActionAndCapture(
  action: BrowserAction,
  stepId: string,
  driver: BrowserDriver,
  ctx: ObservationContext,
): Promise<ActionResult> {
  const satisfiesId = (action as { satisfiesObservationId?: string }).satisfiesObservationId;
  const opts = { timeoutMs: action.timeoutMs ?? 30_000 };

  const provenance: ObservationProvenance = {
    runId: ctx.runId,
    journeyId: ctx.journeyId,
    stepId,
    environmentId: ctx.environmentId,
    observedAt: ctx.now().toISOString(),
  };

  try {
    switch (action.kind) {
      case 'navigate': {
        const nav: BrowserNavigationResult = await driver.open(action.url, opts);
        if (!satisfiesId) return { kind: 'no-observation' };
        // A navigation produces a network observation: the page's main resource
        // status code, final URL, and title. The status_code matcher reads
        // `.status` from the value object.
        const observation = recordObservation({
          id: `actual:${satisfiesId}`,
          kind: 'network',
          value: { status: nav.status, finalUrl: nav.finalUrl, title: nav.title },
          provenance,
        });
        return { kind: 'captured', captured: { satisfiesObservationId: satisfiesId, stepId, actual: observation } };
      }
      case 'click': {
        const act: BrowserActionResult = await driver.click(action.selector, opts);
        if (!satisfiesId) return { kind: 'no-observation' };
        if (!act.matched) {
          // The selector did not match — the click did not happen. The
          // observation is EXPLICITLY MISSING (actual: null) — never a
          // silent pass. The finalization boundary records the
          // validation_failure.
          return { kind: 'captured', captured: { satisfiesObservationId: satisfiesId, stepId, actual: null } };
        }
        const observation = recordObservation({
          id: `actual:${satisfiesId}`,
          kind: 'dom',
          value: { matched: true, finalUrl: act.finalUrl },
          provenance,
        });
        return { kind: 'captured', captured: { satisfiesObservationId: satisfiesId, stepId, actual: observation } };
      }
      case 'type': {
        const act: BrowserActionResult = await driver.type(action.selector, action.text, opts);
        if (!satisfiesId) return { kind: 'no-observation' };
        if (!act.matched) {
          return { kind: 'captured', captured: { satisfiesObservationId: satisfiesId, stepId, actual: null } };
        }
        const observation = recordObservation({
          id: `actual:${satisfiesId}`,
          kind: 'dom',
          value: { matched: true, finalUrl: act.finalUrl },
          provenance,
        });
        return { kind: 'captured', captured: { satisfiesObservationId: satisfiesId, stepId, actual: observation } };
      }
      case 'extract': {
        const ext: BrowserExtractionResult = await driver.extract(action.selector, opts);
        // extract ALWAYS declares a satisfiesObservationId (the plan
        // constructor enforces it).
        if (!ext.matched) {
          // The selector did not match — the extraction observed nothing.
          // The observation is EXPLICITLY MISSING (actual: null).
          return {
            kind: 'captured',
            captured: { satisfiesObservationId: satisfiesId!, stepId, actual: null },
          };
        }
        const observation = recordObservation({
          id: `actual:${satisfiesId}`,
          kind: 'dom',
          value: ext.text,
          provenance,
        });
        return { kind: 'captured', captured: { satisfiesObservationId: satisfiesId!, stepId, actual: observation } };
      }
      case 'screenshot': {
        const shot: BrowserScreenshotResult = await driver.screenshot(opts);
        if (!satisfiesId) return { kind: 'no-observation' };
        const observation = recordObservation({
          id: `actual:${satisfiesId}`,
          kind: 'dom',
          value: { screenshotBase64: shot.base64, finalUrl: shot.finalUrl },
          provenance,
        });
        return { kind: 'captured', captured: { satisfiesObservationId: satisfiesId, stepId, actual: observation } };
      }
      default:
        return { kind: 'error', reason: `unknown action kind ${JSON.stringify((action as { kind?: unknown }).kind)}` };
    }
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError') {
      return { kind: 'error', reason: `action ${describeAction(action)} exceeded its ${opts.timeoutMs}ms timeout bound` };
    }
    return { kind: 'error', reason: `action ${describeAction(action)} failed: ${e.message ?? String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// The captured → ObservationResult[] builder (every expected observation)
// ---------------------------------------------------------------------------

/**
 * Build the {@link ObservationResult}[] for EVERY expected observation in the
 * journey. A captured observation (matched or null) becomes the result's
 * `actual`; a never-captured expected observation becomes `actual: null,
 * matched: false` (an explicit failure — never silently dropped).
 *
 * The `matched` field is the DETERMINISTIC derivation
 * (`evaluateObservation(canonicalExpected, actual)`) — never the agent's
 * assertion. The finalization boundary re-derives and verifies it.
 */
export function buildObservationResults(
  journey: ValidationJourney,
  captured: readonly CapturedObservation[],
  ctx: ObservationContext,
): ObservationResult[] {
  const capturedById = new Map<string, CapturedObservation>();
  for (const c of captured) {
    capturedById.set(c.satisfiesObservationId, c);
  }

  const results: ObservationResult[] = [];
  for (const step of journey.steps) {
    for (const expected of step.expectedObservations) {
      const cap = capturedById.get(expected.id);
      const actual = cap?.actual ?? null;
      const provenance: ObservationProvenance = {
        runId: ctx.runId,
        journeyId: journey.id,
        stepId: step.id,
        environmentId: ctx.environmentId,
        observedAt: cap?.actual?.provenance.observedAt ?? ctx.now().toISOString(),
      };
      // The deterministic derivation — the agent never asserts a match the
      // evaluator does not derive. The finalization boundary RE-derives and
      // REJECTS any contradiction (PR #86 correction 3).
      const matched = evaluateObservation(expected, actual);
      results.push({
        expected,
        actual,
        matched,
        provenance,
      });
    }
  }
  return results;
}

/** Re-export the deterministic evaluator (consumed by tests). */
export { evaluateObservation } from '../../continuous-validation/index.js';
