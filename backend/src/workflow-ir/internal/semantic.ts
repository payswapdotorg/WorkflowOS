/**
 * V2-003 — the semantic projection, canonical normalization and the
 * WorkflowVersion semantic digest.
 *
 * The digest is SHA-256 over canonical JSON of the SEMANTIC object:
 *
 *   { domain: 'workflowos/workflow-ir/v1',
 *     irSchemaVersion,
 *     compatibility,   ← the version-affecting metadata the schema declares
 *     ir }             ← the canonical (set-normalized) WorkflowIR
 *
 * Presentation is EXCLUDED (registry: presentationExcluded). Repository,
 * marketplace, UX and deployment metadata are not part of the input at all.
 *
 * DOMAIN SEPARATION (hard V2-003/V2-014 boundary): this digest commits to
 * workflow MEANING only. It never hashes execution facts and shares no
 * domain with the execution-statement digest owned by V2-014.
 */
import { createHash } from 'node:crypto';
import type {
  EdgeTrigger,
  PresentationMetadata,
  PortType,
  WorkflowIrDocument,
  WorkflowIR,
  WorkflowNode,
  WorkflowVersionSemanticDigest,
} from '../types.js';
import { WORKFLOW_IR_OBJECT_TYPE } from '../types.js';
import { canonicalJsonStringify } from './canonical-json.js';

/**
 * The canonical (set-normalized) semantic projection of a document.
 *
 * Every collection the SCHEMA declares as a set is sorted here, so that
 * array order can never affect the digest or semantic equality:
 * nodes by id, edges by (from, to, trigger), input/output ports by name,
 * capability requirements, object-type fields, decision options and
 * provenance source references.
 */
export function semanticProjection(document: WorkflowIrDocument): Record<string, unknown> {
  return {
    domain: WORKFLOW_IR_OBJECT_TYPE,
    irSchemaVersion: document.irSchemaVersion,
    compatibility: canonicalCompatibility(document),
    ir: canonicalIr(document.ir),
  };
}

/** The canonical JSON preimage of the WorkflowVersion semantic digest. */
export function canonicalSemanticJson(document: WorkflowIrDocument): string {
  return canonicalJsonStringify(semanticProjection(document));
}

/**
 * The WorkflowVersion semantic digest (registry digest rule). Deterministic:
 * same semantics → same digest; presentation-only changes → same digest.
 */
export function computeWorkflowVersionSemanticDigest(
  document: WorkflowIrDocument,
): WorkflowVersionSemanticDigest {
  const digest = createHash('sha-256').update(canonicalSemanticJson(document), 'utf8').digest('hex');
  return { algorithm: 'sha-256', domain: WORKFLOW_IR_OBJECT_TYPE, digest };
}

/** Semantic equality: identical canonical semantic projections. */
export function semanticallyEqual(a: WorkflowIrDocument, b: WorkflowIrDocument): boolean {
  return canonicalSemanticJson(a) === canonicalSemanticJson(b);
}

// ============================================================================
// Canonical normalization helpers
// ============================================================================

function canonicalCompatibility(document: WorkflowIrDocument): Record<string, unknown> {
  return {
    compatibilityLevel: document.compatibility.compatibilityLevel,
    inputSurfaceChange: document.compatibility.inputSurfaceChange,
    outputSurfaceChange: document.compatibility.outputSurfaceChange,
  };
}

function canonicalIr(ir: WorkflowIR): Record<string, unknown> {
  return {
    start: ir.start,
    inputs: ir.inputs.map(canonicalPortDeclaration).sort(byName),
    outputs: ir.outputs.map(canonicalOutputBinding).sort(byName),
    nodes: ir.nodes.map(canonicalNode).sort(byId),
    edges: ir.edges.map(canonicalEdge).sort((a, b) => {
      const aKey = `${a['from']}|${a['to']}|${triggerSortKey(a['on'])}`;
      const bKey = `${b['from']}|${b['to']}|${triggerSortKey(b['on'])}`;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    }),
    defaultPlacement: ir.defaultPlacement,
    provenance: canonicalProvenance(ir),
  };
}

function canonicalProvenance(ir: WorkflowIR): Record<string, unknown> {
  const result: Record<string, unknown> = { origin: ir.provenance.origin };
  if (ir.provenance.sourceRefs !== undefined && ir.provenance.sourceRefs.length > 0) {
    result['sourceRefs'] = [...ir.provenance.sourceRefs].sort();
  }
  return result;
}

function canonicalNode(node: WorkflowNode): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: node.id,
    executionClass: node.executionClass,
    spec: canonicalSpec(node),
    capabilityRequirements: [...node.capabilityRequirements].sort(),
    placement: node.placement,
    inputs: node.inputs.map(canonicalPortBinding).sort(byName),
    outputs: node.outputs.map(canonicalPortDeclaration).sort(byName),
    failurePolicy: canonicalFailurePolicy(node),
  };
  if (node.completionEvidence !== undefined) {
    result['completionEvidence'] = node.completionEvidence;
  }
  return result;
}

function canonicalFailurePolicy(node: WorkflowNode): Record<string, unknown> {
  const policy: Record<string, unknown> = { strategy: node.failurePolicy.strategy };
  if (node.failurePolicy.strategy === 'retry_then_fail_workflow') {
    policy['maxAttempts'] = node.failurePolicy.maxAttempts;
  }
  return policy;
}

function canonicalSpec(node: WorkflowNode): Record<string, unknown> {
  const spec = node.spec;
  switch (spec.class) {
    case 'deterministic_api':
      return { class: spec.class, capability: spec.capability };
    case 'agentic_computer_use':
      return { class: spec.class, task: spec.task };
    case 'human': {
      const human: Record<string, unknown> = {
        kind: spec.human.kind,
        instruction: spec.human.instruction,
      };
      if (spec.human.kind === 'decision') {
        human['options'] = [...spec.human.options].sort();
      }
      if (spec.human.kind === 'information') {
        human['provides'] = canonicalPortDeclaration(spec.human.provides);
      }
      return { class: spec.class, human };
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

function canonicalPortDeclaration(port: { name: string; type: PortType; optional?: boolean }): Record<string, unknown> {
  const result: Record<string, unknown> = { name: port.name, type: canonicalPortType(port.type) };
  if (port.optional) result['optional'] = true;
  return result;
}

function canonicalPortBinding(port: {
  name: string;
  type: PortType;
  optional?: boolean;
  binding: Record<string, unknown>;
}): Record<string, unknown> {
  const result = canonicalPortDeclaration(port);
  result['binding'] = port.binding;
  return result;
}

function canonicalOutputBinding(output: {
  name: string;
  type: PortType;
  from: Record<string, unknown>;
}): Record<string, unknown> {
  return { name: output.name, type: canonicalPortType(output.type), from: output.from };
}

function canonicalPortType(type: PortType): Record<string, unknown> {
  switch (type.kind) {
    case 'object':
      return {
        kind: type.kind,
        fields: type.fields.map(canonicalPortDeclaration).sort(byName),
      };
    case 'array':
      return { kind: type.kind, element: canonicalPortType(type.element) };
    default:
      return { kind: type.kind };
  }
}

function canonicalEdge(edge: { from: string; to: string; on: EdgeTrigger }): Record<string, unknown> {
  return { from: edge.from, to: edge.to, on: edge.on };
}

function byName(a: { [key: string]: unknown }, b: { [key: string]: unknown }): number {
  return compareStrings(String(a['name']), String(b['name']));
}

function byId(a: { [key: string]: unknown }, b: { [key: string]: unknown }): number {
  return compareStrings(String(a['id']), String(b['id']));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function triggerSortKey(trigger: unknown): string {
  if (trigger === 'success' || trigger === 'failure') return trigger;
  if (typeof trigger === 'object' && trigger !== null && 'outcome' in trigger) {
    const outcome = (trigger as { outcome: unknown }).outcome;
    return `outcome:${typeof outcome === 'string' ? outcome : String(outcome)}`;
  }
  return String(trigger);
}

/**
 * Presentation normalization for full-document serialization (NOT part of
 * the semantic projection): canonical JSON already orders keys; this helper
 * only drops undefined members deterministically.
 */
export function canonicalPresentation(presentation: PresentationMetadata | undefined): Record<string, unknown> | undefined {
  if (presentation === undefined) return undefined;
  const result: Record<string, unknown> = {};
  if (presentation.title !== undefined) result['title'] = presentation.title;
  if (presentation.nodeLabels !== undefined) {
    result['nodeLabels'] = { ...presentation.nodeLabels };
  }
  if (presentation.nodePositions !== undefined) {
    result['nodePositions'] = { ...presentation.nodePositions };
  }
  if (presentation.notes !== undefined) result['notes'] = presentation.notes;
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * The canonical FULL-document form (semantic + presentation) used for
 * transport serialization: set-normalized IR, canonical-ordered keys,
 * presentation preserved (lossless round-trip, digest-excluded).
 */
export function normalizeDocumentForSerialization(document: WorkflowIrDocument): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    objectType: document.objectType,
    irSchemaVersion: document.irSchemaVersion,
    compatibility: canonicalCompatibility(document),
    ir: canonicalIr(document.ir),
  };
  const presentation = canonicalPresentation(document.presentation);
  if (presentation !== undefined) {
    normalized['presentation'] = presentation;
  }
  return normalized;
}
