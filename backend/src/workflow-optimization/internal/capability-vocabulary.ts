/**
 * V2-011 — the capability classification consumed from the merged barrels.
 *
 * The UI-automation set is the fixed closed list of canonical registry
 * capabilities that drive a computer-use surface (browser navigation and
 * interaction, raw screen/application observation and interaction). Every
 * OTHER canonical registry capability is API-stable: a declared
 * deterministic API exists for it. The split is validated against the
 * merged V2-003 registry vocabulary (fail-closed: an unknown name is
 * never classified) and pinned by the unit battery (no drift).
 *
 * The unsafe rule comes from the merged V2-008 computer-agent barrel:
 * substituting a node whose declared requirements intersect the SENSITIVE
 * set is rejected — the substitution would move the capability from the
 * computer-use path (per-capability grants + human takeover boundaries)
 * to an unattended deterministic path.
 */
import { WORKFLOW_IR_REGISTRY_VOCABULARY } from '../../workflow-ir/index.js';
import { sensitiveCapabilities } from '../../computer-agent/index.js';

/** The canonical registry capability names (the merged V2-003 snapshot, verbatim). */
const CANONICAL_CAPABILITIES: readonly string[] = WORKFLOW_IR_REGISTRY_VOCABULARY.capabilities;

/**
 * The UI-automation capabilities: computer-use surface manipulation. An
 * `agentic_computer_use` node declaring ONLY these genuinely needs the
 * agent loop (there is no stable API for clicking through a page).
 */
const UI_AUTOMATION_CAPABILITY_NAMES: readonly string[] = [
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.select',
  'browser.observe',
  'screen.observe',
  'ui.inspect',
  'ui.click',
  'ui.type',
  'application.open',
  'application.observe',
  'application.interact',
];

const CANONICAL_SET = new Set<string>(CANONICAL_CAPABILITIES);
const UI_AUTOMATION_SET = new Set<string>(UI_AUTOMATION_CAPABILITY_NAMES);
const SENSITIVE_SET = new Set<string>(sensitiveCapabilities());

// fail-closed self-check: the UI-automation split only names canonical
// registry capabilities (a registry change requires a governed update —
// never a silent drift).
for (const name of UI_AUTOMATION_CAPABILITY_NAMES) {
  if (!CANONICAL_SET.has(name)) {
    throw new Error(
      `workflow-optimization: UI-automation capability "${name}" is not in the canonical V2-003 registry vocabulary`,
    );
  }
}

/** The frozen UI-automation set (verbatim canonical names). */
export function uiAutomationCapabilities(): readonly string[] {
  return UI_AUTOMATION_CAPABILITY_NAMES;
}

/** Is `capability` a canonical registry capability? (fail-closed on unknowns). */
export function isCanonicalCapability(capability: string): boolean {
  return CANONICAL_SET.has(capability);
}

/** Is `capability` a UI-automation capability (the agent loop is REQUIRED)? */
export function isUiAutomationCapability(capability: string): boolean {
  return UI_AUTOMATION_SET.has(capability);
}

/** Is `capability` API-stable (a declared deterministic API exists)? */
export function isApiStableCapability(capability: string): boolean {
  return CANONICAL_SET.has(capability) && !UI_AUTOMATION_SET.has(capability);
}

/** Is `capability` in the merged V2-008 sensitive set? */
export function isSensitiveCapability(capability: string): boolean {
  return SENSITIVE_SET.has(capability);
}

/**
 * The requirements are ALL API-stable (every declared capability has a
 * deterministic API — the agentic loop is not required by any of them).
 */
export function allRequirementsApiStable(requirements: readonly string[]): boolean {
  return requirements.length > 0 && requirements.every((name) => isApiStableCapability(name));
}

/**
 * The requirements intersect the merged V2-008 sensitive set (the unsafe
 * substitution rule: those capabilities must keep the computer-use
 * runtime's grants and takeover boundaries).
 */
export function sensitiveRequirementsOf(requirements: readonly string[]): readonly string[] {
  return requirements.filter((name) => isSensitiveCapability(name));
}
