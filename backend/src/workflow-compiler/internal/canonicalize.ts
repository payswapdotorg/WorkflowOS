/**
 * V2-007 — semantic canonicalization of IR constructs into the compiled plan.
 *
 * The compiled plan is built ONLY from set-normalized semantics (the same
 * discipline as the merged V2-003 canonical projection): every collection
 * the WorkflowIR schema declares as a set is sorted here, so authoring
 * order can never affect the compiled artifact. The canonicalizers are
 * idempotent and shared by compilation (plan building) and the semantic
 * projection (equivalence checking).
 */
import type {
  NodeSpec,
  PortDeclaration,
  PortBinding,
  PortType,
  StepFailurePolicy,
  WorkflowOutputBinding,
} from '../../workflow-ir/index.js';

// ============================================================================
// Deterministic comparison helpers
// ============================================================================

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byName(a: { name: string }, b: { name: string }): number {
  return compareStrings(a.name, b.name);
}

function byId(a: { unit: string }, b: { unit: string }): number {
  return compareStrings(a.unit, b.unit);
}

/** The canonical sort key of a control edge trigger. */
export function triggerSortKey(trigger: unknown): string {
  if (trigger === 'success' || trigger === 'failure') return trigger;
  if (typeof trigger === 'object' && trigger !== null && 'outcome' in trigger) {
    const outcome = (trigger as { outcome: unknown }).outcome;
    return `outcome:${typeof outcome === 'string' ? outcome : String(outcome)}`;
  }
  return String(trigger);
}

/** Sort a compiled-unit list by unit id (canonical node order). */
export function sortUnitsByUnit<T extends { unit: string }>(units: readonly T[]): T[] {
  return [...units].sort(byId);
}

// ============================================================================
// Port type / declaration / binding canonicalization
// ============================================================================

/** Canonicalize a port type (object fields sorted by name, recursively). */
export function canonicalPortType(type: PortType): PortType {
  switch (type.kind) {
    case 'object':
      return {
        kind: 'object',
        fields: type.fields
          .map((field) => ({
            name: field.name,
            type: canonicalPortType(field.type),
            ...(field.optional ? { optional: true } : {}),
          }))
          .sort(byName),
      };
    case 'array':
      return { kind: 'array', element: canonicalPortType(type.element) };
    default:
      return { kind: type.kind };
  }
}

/** Canonicalize a port declaration (canonical type, name-sorted position). */
export function canonicalPortDeclaration(port: {
  name: string;
  type: PortType;
  optional?: boolean;
}): PortDeclaration {
  return {
    name: port.name,
    type: canonicalPortType(port.type),
    ...(port.optional ? { optional: true } : {}),
  };
}

/** Canonicalize a port binding (canonical declaration + verbatim binding). */
export function canonicalPortBinding(port: {
  name: string;
  type: PortType;
  optional?: boolean;
  binding: PortBinding['binding'];
}): PortBinding {
  return { ...canonicalPortDeclaration(port), binding: port.binding };
}

/** Canonicalize a workflow output binding (canonical type + verbatim source). */
export function canonicalOutputBinding(output: {
  name: string;
  type: PortType;
  from: WorkflowOutputBinding['from'];
}): WorkflowOutputBinding {
  return { name: output.name, type: canonicalPortType(output.type), from: output.from };
}

// ============================================================================
// Node spec / failure policy canonicalization
// ============================================================================

/** Canonicalize a node spec (decision options sorted, port types canonical). */
export function canonicalSpec(spec: NodeSpec): NodeSpec {
  switch (spec.class) {
    case 'deterministic_api':
      return { class: spec.class, capability: spec.capability };
    case 'agentic_computer_use':
      return { class: spec.class, task: spec.task };
    case 'human': {
      if (spec.human.kind === 'decision') {
        return {
          class: spec.class,
          human: {
            kind: 'decision',
            instruction: spec.human.instruction,
            options: [...spec.human.options].sort(compareStrings),
          },
        };
      }
      if (spec.human.kind === 'information') {
        return {
          class: spec.class,
          human: {
            kind: 'information',
            instruction: spec.human.instruction,
            provides: canonicalPortDeclaration(spec.human.provides),
          },
        };
      }
      return { class: spec.class, human: { kind: 'approval', instruction: spec.human.instruction } };
    }
    case 'subworkflow':
      return {
        class: spec.class,
        subworkflow: {
          workflowId: spec.subworkflow.workflowId,
          versionRef: spec.subworkflow.versionRef,
        },
      };
  }
}

/** Canonicalize a failure policy (stable field presence). */
export function canonicalFailurePolicy(policy: StepFailurePolicy): StepFailurePolicy {
  if (policy.strategy === 'retry_then_fail_workflow') {
    return { strategy: policy.strategy, maxAttempts: policy.maxAttempts };
  }
  return { strategy: policy.strategy };
}
