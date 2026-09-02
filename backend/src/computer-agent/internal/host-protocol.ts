/**
 * V2-008 — the universal host-protocol discipline helpers.
 *
 * Owns (module-internal): the canonical element digest (wrong-target
 * prevention material), the filesystem absent-target digest, the
 * deterministic host-side id sources, and the host invocation LEDGER that
 * implements duplicate-action suppression (same invocation id ⇒ converge on
 * the recorded result; a repeated delivery NEVER re-executes the effect).
 *
 * Protocol identity: one request/response shape for every host class
 * (constitution §4 — platform differences appear only in capabilities
 * offered, never in protocol semantics).
 */
import { createHash } from 'node:crypto';
import type {
  HostActionOutcome,
  HostFailure,
  HostInvocationRequest,
  HostInvocationResult,
  HostObservation,
  ObservedElement,
} from '../types.js';
import { HOST_ELEMENT_KINDS } from '../types.js';

const KIND_SET = new Set<string>(HOST_ELEMENT_KINDS);

/** sha-256 hex over canonical JSON {elementId, kind, label, state}. */
export function elementDigest(element: Omit<ObservedElement, 'digest'>): string {
  return createHash('sha256')
    .update(canonicalElementJson(element), 'utf8')
    .digest('hex');
}

/** Deterministic canonical JSON for one element (sorted keys, no spaces). */
function canonicalElementJson(element: Omit<ObservedElement, 'digest'>): string {
  return JSON.stringify(
    { elementId: element.elementId, kind: element.kind, label: element.label, state: element.state },
    Object.keys({ elementId: 0, kind: 0, label: 0, state: 0 }).sort(),
  );
}

/**
 * The digest of a filesystem target that does NOT exist. A grounded write
 * against an absent target fails closed when the target EXISTS with any
 * other content (no clobbering), and proceeds when it is still absent —
 * digest equality on the "absent" state is exactly that check.
 */
export const FILE_ABSENT_DIGEST: string = createHash('sha256')
  .update('workflowos/host-protocol/fs-target-absent/v1', 'utf8')
  .digest('hex');

/** Build one observed element (validating the closed kind vocabulary). */
export function observedElement(input: {
  elementId: string;
  kind: (typeof HOST_ELEMENT_KINDS)[number];
  label: string;
  state: string;
}): ObservedElement {
  if (!KIND_SET.has(input.kind)) {
    // fail-closed: an unknown element kind is a host bug, never a guess
    throw new Error(`computer-agent host-protocol: unknown element kind "${input.kind}"`);
  }
  return { ...input, digest: elementDigest(input) };
}

/** A deterministic host-side observation-id source (injected seeds only). */
export function createHostObservationIdSource(nodeId: string): () => string {
  let seq = 0;
  return () => `obs-${nodeId}-${String(++seq).padStart(4, '0')}`;
}

/** A deterministic host-side nonce source (single-use attestation material). */
export function createHostNonceSource(nodeId: string): () => string {
  let seq = 0;
  return () => `nonce-${nodeId}-${String(++seq).padStart(4, '0')}`;
}

/**
 * The host invocation ledger: duplicate-ACTION suppression.
 *
 * Acts are EFFECTFUL: the first delivery of an invocation id executes (via
 * the provided effectful function) and the result is recorded; every
 * subsequent delivery of the same id converges on the recorded result —
 * the effect is NEVER re-executed (at-most-once host discipline; the
 * runtime's crash re-drive relies on it).
 *
 * Observations are READS: they always execute fresh and never enter the
 * ledger — a re-driven observation MUST reflect current reality (an
 * observation frozen by convergence would ground actions on stale state).
 * Duplicate-suppression scope: ACTS ONLY (registry quality rule: duplicate
 * action suppression where required — reads are idempotent by nature).
 */
export class HostInvocationLedger {
  private readonly records = new Map<string, HostInvocationResult>();

  async executeAct(
    invocationId: string,
    effect: () => Promise<HostInvocationResult>,
  ): Promise<HostInvocationResult> {
    const recorded = this.records.get(invocationId);
    if (recorded) {
      return markConverged(recorded);
    }
    const result = await effect();
    this.records.set(invocationId, result);
    return result;
  }

  /** Ledger size (audit/test only). */
  get size(): number {
    return this.records.size;
  }
}

function markConverged(result: HostInvocationResult): HostInvocationResult {
  if (result.ok) {
    return { ...result, converged: true } as HostInvocationResult;
  }
  return result;
}

/** Typed host failure helper (the closed HOST_* taxonomy only). */
export function hostFailure(code: HostFailure['code'], detail: string, actualDigest?: string): HostFailure {
  return { code, detail, ...(actualDigest !== undefined ? { actualDigest } : {}) };
}

/** Typed observation result helper. */
export function observed(observation: HostObservation, converged = false): HostInvocationResult {
  return { ok: true, kind: 'observed', observation, converged };
}

/** Typed action result helper. */
export function acted(outcome: HostActionOutcome, converged = false): HostInvocationResult {
  return { ok: true, kind: 'acted', outcome, converged };
}

/**
 * The closed set of MUTATING capabilities whose acts MUST carry grounding
 * (wrong-target prevention applies); structured deterministic_api
 * invocations (no element target) may act without grounding. Observations
 * never carry grounding by construction.
 */
export const GROUNDING_REQUIRED_CAPABILITIES: readonly string[] = [
  'browser.click',
  'browser.type',
  'browser.select',
  'browser.download',
  'browser.upload',
  'ui.click',
  'ui.type',
  'application.interact',
  'phone.call.answer',
  'phone.call.reject',
  'phone.call.end',
];

/** Is grounding REQUIRED for an act of `capability`? */
export function groundingRequiredFor(capability: string): boolean {
  return GROUNDING_REQUIRED_CAPABILITIES.includes(capability);
}

/** Validate one universal request shape (fail-closed, unknown keys rejected). */
export function validateInvocationRequest(request: HostInvocationRequest): HostFailure | null {
  if (request.kind === 'observe') {
    if (typeof request.subject !== 'string' || request.subject.length === 0) {
      return hostFailure('HOST_PARAMETER_INVALID', 'observe subject must be a non-empty string');
    }
    return null;
  }
  if (request.kind === 'act') {
    if (request.parameters === null || typeof request.parameters !== 'object') {
      return hostFailure('HOST_PARAMETER_INVALID', 'act parameters must be a JSON object');
    }
    if (groundingRequiredFor(request.capability) && request.grounding === null) {
      return hostFailure(
        'HOST_PARAMETER_INVALID',
        `capability ${request.capability} mutates an observed target and requires grounding`,
      );
    }
    return null;
  }
  return hostFailure('HOST_PARAMETER_INVALID', 'unknown request kind');
}
