/**
 * V2-013 — internal/self-hosting permission boundary.
 *
 * The typed, fail-closed gate that keeps first-party workflows inside the
 * governance boundary:
 *
 *   - the boundary MODEL is supplied read-only (the governance authority
 *     owns it); the evaluation FAILS CLOSED when the model is absent,
 *     malformed, or weaker than the CODE-PINNED core self-hosting
 *     prohibitions (ADR-0004 — a weakened boundary file is a validation
 *     failure, never a silent pass; the code-pinned floor is consumed from
 *     the merged architecture-checkpoints public barrel);
 *   - the MERGE GATE: `github.pull_request.merge` is the canonical MAY-NOT
 *     (a self-hosted worker never merges its own governing PR) — a
 *     dedicated typed violation, never a generic capability denial;
 *   - the CAPABILITY ALLOWLIST: a first-party development workflow may
 *     declare ONLY the frozen allowlisted canonical capabilities;
 *   - the GOVERNANCE-PROTECTED SURFACES: no step may bind a literal input
 *     to (or declare an agentic task referencing) a governance-authoritative
 *     repository path — changes there flow only through the
 *     architecture-change/governance authorities.
 *
 * Pure and deterministic: no clock, no randomness, no network, no state.
 */

import { CORE_SELF_HOSTING_PROHIBITIONS } from '../../architecture-checkpoints/index.js';
import type { WorkflowIrDocument } from '../../workflow-ir/index.js';
import {
  FIRST_PARTY_ALLOWED_CAPABILITIES,
  GOVERNANCE_PROTECTED_SURFACES,
} from '../types.js';
import type {
  SelfHostingBoundaryFailure,
  SelfHostingBoundaryPolicyInput,
  SelfHostingBoundaryVerdict,
} from '../types.js';

const ALLOWED_CAPABILITY_SET = new Set<string>(FIRST_PARTY_ALLOWED_CAPABILITIES);
/** The canonical merge-gate capability (the one MAY-NOT with its own code). */
const MERGE_GATE_CAPABILITY = 'github.pull_request.merge';

/**
 * Evaluate the self-hosting permission boundary for one WorkflowIR
 * document under one supplied governance boundary model. Fail-closed:
 * ANY weakness in the model, ANY out-of-boundary capability claim, and
 * ANY governance-protected surface binding is a typed denial.
 */
export function evaluateSelfHostingBoundary(
  document: WorkflowIrDocument,
  boundary: SelfHostingBoundaryPolicyInput | undefined | null,
): SelfHostingBoundaryVerdict {
  // ------------------------------------------------------------------
  // 1. the boundary model itself (fail-closed against weakening)
  // ------------------------------------------------------------------
  const modelFailure = validateBoundaryModel(boundary);
  if (modelFailure) {
    return { allowed: false, failure: modelFailure };
  }
  // validateBoundaryModel returned null: the boundary is present and
  // well-formed (the cast is the validated narrowing).
  const model = boundary as SelfHostingBoundaryPolicyInput;

  // ------------------------------------------------------------------
  // 2. per node, in canonical document order: capabilities, then the
  //    protected-surface bindings (deterministic first-failure)
  // ------------------------------------------------------------------
  const declared: string[] = [];
  for (const node of document.ir.nodes) {
    for (const capability of node.capabilityRequirements) {
      declared.push(capability);
      if (capability === MERGE_GATE_CAPABILITY) {
        return {
          allowed: false,
          failure: {
            code: 'SELF_HOSTING_MERGE_GATE_VIOLATION',
            detail: `step "${node.id}" claims the merge capability "${MERGE_GATE_CAPABILITY}" — a self-hosted worker never merges its own governing PR (PR review by the architect is the only merge gate)`,
            stepId: node.id,
            offending: capability,
          },
        };
      }
      if (!ALLOWED_CAPABILITY_SET.has(capability)) {
        return {
          allowed: false,
          failure: {
            code: 'SELF_HOSTING_CAPABILITY_NOT_ALLOWED',
            detail: `step "${node.id}" declares capability "${capability}", outside the first-party allowlist (the frozen canonical set first-party development workflows may claim)`,
            stepId: node.id,
            offending: capability,
          },
        };
      }
    }

    // protected surfaces: literal input bindings AND agentic task prose
    for (const binding of node.inputs) {
      if (binding.binding.kind === 'literal' && typeof binding.binding.value === 'string') {
        const surfaceFailure = protectedSurfaceFailure(node.id, binding.binding.value);
        if (surfaceFailure) {
          return { allowed: false, failure: surfaceFailure };
        }
      }
    }
    if (node.spec.class === 'agentic_computer_use') {
      const surfaceFailure = protectedSurfaceFailure(node.id, node.spec.task);
      if (surfaceFailure) {
        return { allowed: false, failure: surfaceFailure };
      }
    }
  }

  return {
    allowed: true,
    coreProhibitions: [...model.coreProhibitions],
    declaredCapabilities: [...new Set(declared)].sort(),
  };
}

// ============================================================================
// The boundary model validation (the code-pinned floor — anti-weakening)
// ============================================================================

/**
 * Validate the supplied boundary model against the CODE-PINNED core
 * self-hosting prohibitions (the architecture-checkpoints substrate's
 * ADR-0004 discipline, consumed read-only): every pinned prohibition MUST
 * appear verbatim; the lists MUST be well-formed. A weakened or absent
 * model is a typed failure — the gate never opens on governance weakening.
 */
export function validateBoundaryModel(
  boundary: SelfHostingBoundaryPolicyInput | undefined | null,
): SelfHostingBoundaryFailure | null {
  if (boundary === undefined || boundary === null) {
    return {
      code: 'SELF_HOSTING_BOUNDARY_MODEL_INVALID',
      detail: 'no self-hosting boundary model was supplied (fail-closed: the governance boundary is REQUIRED input)',
    };
  }
  const isStringArray = (value: unknown): value is readonly string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string');
  if (!isStringArray(boundary.may) || boundary.may.length === 0) {
    return {
      code: 'SELF_HOSTING_BOUNDARY_MODEL_INVALID',
      detail: 'the boundary model\'s may list is absent/malformed (fail-closed)',
    };
  }
  if (!isStringArray(boundary.mayNot) || boundary.mayNot.length === 0) {
    return {
      code: 'SELF_HOSTING_BOUNDARY_MODEL_INVALID',
      detail: 'the boundary model\'s mayNot list is absent/malformed (fail-closed)',
    };
  }
  if (!isStringArray(boundary.coreProhibitions) || boundary.coreProhibitions.length === 0) {
    return {
      code: 'SELF_HOSTING_BOUNDARY_MODEL_INVALID',
      detail: 'the boundary model\'s coreProhibitions list is absent/malformed (fail-closed)',
    };
  }
  for (const pinned of CORE_SELF_HOSTING_PROHIBITIONS) {
    if (!boundary.coreProhibitions.includes(pinned)) {
      return {
        code: 'SELF_HOSTING_BOUNDARY_MODEL_INVALID',
        detail: `the supplied boundary model REMOVED a code-pinned core prohibition — "${pinned.slice(0, 80)}…" (ADR-0004: weakening the boundary is a validation failure, never a silent pass)`,
        offending: pinned,
      };
    }
  }
  return null;
}

// ============================================================================
// Protected-surface scan (deterministic substring match on fixed prefixes)
// ============================================================================

function protectedSurfaceFailure(stepId: string, text: string): SelfHostingBoundaryFailure | null {
  for (const surface of GOVERNANCE_PROTECTED_SURFACES) {
    if (text.includes(surface)) {
      return {
        code: 'SELF_HOSTING_GOVERNANCE_SURFACE_PROTECTED',
        detail: `step "${stepId}" binds the governance-authoritative surface "${surface}" — changes there flow only through the architecture-change/governance authorities (the frozen MAY-NOTs)`,
        stepId,
        offending: surface,
      };
    }
  }
  return null;
}
