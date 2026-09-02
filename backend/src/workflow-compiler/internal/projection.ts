/**
 * V2-007 — the semantic projection of a compiled plan back into the
 * WorkflowIR's canonical form (the semantic-equivalence surface).
 *
 * This is the compiler's conformance instrument: the compiled plan is
 * projected into EXACTLY the set-normalized semantic form the merged V2-003
 * serializer emits for a WorkflowIR document (`serializeWorkflowIrDocument`
 * → canonical `ir`), reconstructing:
 *
 *   - the step set (units → nodes, keyed by the source node ids);
 *   - the ordering semantics (the control-edge set, reconstructed from the
 *     flattened onSuccess/onFailure/onOutcomes successor lists);
 *   - the typed input/output surface;
 *   - per-step execution classes, specs, capability requirements,
 *     placements, failure policies and completion disclosures;
 *   - the workflow default placement and provenance.
 *
 * Deep equality between the projection and the source IR's canonical form
 * PROVES the compiler changed nothing the source version declared. The
 * projection is derived FROM the artifact (never from the source): a
 * mutated artifact projects differently. The compiler is a derived
 * transformation — this projection is how that fact is checked, not an
 * alternative authority.
 */
import type { CompiledWorkflowArtifact } from '../types.js';
import {
  canonicalFailurePolicy,
  canonicalPortBinding,
  canonicalPortDeclaration,
  canonicalOutputBinding,
  canonicalSpec,
  compareStrings,
  sortUnitsByUnit,
  triggerSortKey,
} from './canonicalize.js';

/**
 * Project a compiled workflow artifact's plan back into the WorkflowIR
 * canonical semantic form (a plain JSON record — the same shape as the `ir`
 * member of `JSON.parse(serializeWorkflowIrDocument(document))`).
 */
export function projectCompiledPlanSemantics(
  artifact: CompiledWorkflowArtifact,
): Record<string, unknown> {
  const units = sortUnitsByUnit(artifact.plan.units);

  // ---- step set: units → canonical nodes ----
  const nodes = units.map((unit) => ({
    id: unit.unit,
    executionClass: unit.executionClass,
    spec: canonicalSpec(unit.spec),
    capabilityRequirements: [...unit.capabilityRequirements].sort(compareStrings),
    placement: unit.placement,
    inputs: unit.inputs
      .map(canonicalPortBinding)
      .sort((a, b) => compareStrings(a.name, b.name)),
    outputs: unit.outputs
      .map(canonicalPortDeclaration)
      .sort((a, b) => compareStrings(a.name, b.name)),
    failurePolicy: canonicalFailurePolicy(unit.failurePolicy),
    ...(unit.completionEvidence !== undefined ? { completionEvidence: unit.completionEvidence } : {}),
  }));

  // ---- ordering semantics: flattened successors → the control-edge set ----
  const edges: Array<{ from: string; to: string; on: unknown }> = [];
  for (const unit of artifact.plan.units) {
    for (const target of unit.onSuccess) {
      edges.push({ from: unit.unit, to: target, on: 'success' });
    }
    if (unit.onFailure !== null) {
      edges.push({ from: unit.unit, to: unit.onFailure, on: 'failure' });
    }
    for (const continuation of unit.onOutcomes) {
      edges.push({ from: unit.unit, to: continuation.to, on: { outcome: continuation.outcome } });
    }
  }
  edges.sort((a, b) => {
    const aKey = `${a.from}|${a.to}|${triggerSortKey(a.on)}`;
    const bKey = `${b.from}|${b.to}|${triggerSortKey(b.on)}`;
    return compareStrings(aKey, bKey);
  });

  // ---- workflow surface + provenance ----
  const source = artifact.provenance.source;
  return {
    start: artifact.plan.entry,
    inputs: artifact.plan.inputs
      .map(canonicalPortDeclaration)
      .sort((a, b) => compareStrings(a.name, b.name)),
    outputs: artifact.plan.outputs
      .map(canonicalOutputBinding)
      .sort((a, b) => compareStrings(a.name, b.name)),
    nodes,
    edges,
    defaultPlacement: artifact.plan.defaultPlacement,
    provenance: {
      origin: source.origin,
      ...(source.sourceRefs !== undefined && source.sourceRefs.length > 0
        ? { sourceRefs: [...source.sourceRefs].sort(compareStrings) }
        : {}),
    },
  };
}
