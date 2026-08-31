/**
 * WORK-065 — the browser action effect classification.
 *
 * THE CONTRACT (spec/architecture/v1.1/validation-model.md §9.4): before
 * performing any action, the agent classifies the action's effect (read vs.
 * mutation) and checks it against the run's declared EffectPolicy. A read
 * action observes state and performs no mutation; a mutation action changes
 * DOM/process state (click, type).
 *
 * The classification is DETERMINISTIC and CLOSED: every action kind maps to
 * exactly one effect class. There is no "ambiguous" action — an unknown
 * action kind is rejected at plan construction (a foreign kind never reaches
 * the classifier).
 */
import type { BrowserAction, BrowserActionEffect } from '../types.js';

/**
 * Classify a browser action's effect. Pure, deterministic, total over the
 * closed {@link BrowserAction} kind set:
 *
 *   - navigate   → read   (loads a page; observes the response, mutates no
 *                           target-app state);
 *   - extract   → read    (reads DOM text);
 *   - screenshot → read   (captures a picture);
 *   - click     → mutation (clicks an element — may submit a form, delete a
 *                            record, trigger a network mutation);
 *   - type      → mutation (enters text into a form field — mutates form
 *                            state).
 *
 * The classification is the load-bearing input to the effect-policy
 * enforcement gate (effect-policy-enforcement.ts). Removing it (or
 * misclassifying a mutation as read) makes the enforcement test FAIL
 * (discrimination-proven).
 */
export function classifyActionEffect(action: BrowserAction): BrowserActionEffect {
  switch (action.kind) {
    case 'navigate':
    case 'extract':
    case 'screenshot':
      return 'read';
    case 'click':
    case 'type':
      return 'mutation';
    default:
      // Exhaustiveness check — a foreign kind never reaches here (the plan
      // constructor rejects it). The runtime guard is defense in depth.
      return 'mutation';
  }
}

/** Human-readable action description for evidence records. */
export function describeAction(action: BrowserAction): string {
  switch (action.kind) {
    case 'navigate':
      return `navigate(${action.url})`;
    case 'click':
      return `click(${action.selector})`;
    case 'type':
      return `type(${action.selector}, <${action.text.length} chars>)`;
    case 'extract':
      return `extract(${action.selector})`;
    case 'screenshot':
      return 'screenshot()';
    default:
      return `<unknown action>`;
  }
}
