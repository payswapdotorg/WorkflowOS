/**
 * V2-003 — WorkflowIR public barrel.
 *
 * The domain lives at `src/workflow-ir/` (application-layer pure domain
 * module — orchestration / engineering-signals precedent). It owns the
 * WorkflowIR schema, graph/control/data semantics, deterministic canonical
 * serialization and the WorkflowVersion SEMANTIC digest, validation,
 * compatibility/version negotiation and the dedicated IR test
 * specification (SCHEMA.md).
 *
 * Boundaries (V2-003):
 *   - NO repository persistence/version lifecycle (V2-002);
 *   - NO Node/Capability matching semantics (V2-004 — capability references
 *     are canonical registry names only);
 *   - NO run/evidence persistence (V2-005), teaching, compiler, runtime,
 *     scheduling, marketplace;
 *   - NO execution-attestation concepts (V2-014 domain
 *     workflowos/execution-statement/v1 — the WorkflowVersion semantic
 *     digest here is a DIFFERENT, domain-separated digest);
 *   - NO platform SDK concepts (canonical registry capability names only).
 */
import { WorkflowIrError } from './types.js';
import type { WorkflowIrDocument } from './types.js';
import { validateWorkflowIrDocument } from './internal/validate.js';

export {
  // §0 domain identity
  WORKFLOW_IR_OBJECT_TYPE,
  IR_SCHEMA_VERSION,
  SUPPORTED_IR_SCHEMA_VERSIONS,
  // §1 vocabularies (frozen registry identifiers)
  EXECUTION_CLASSES,
  PLACEMENT_IDS,
  COMPLETION_EVIDENCE_CLASSES,
  // §11 typed error surface
  WORKFLOW_IR_ERROR_CODES,
  WorkflowIrError,
} from './types.js';
export type {
  ExecutionClass,
  PlacementId,
  CompletionEvidenceClass,
  CapabilityName,
  JsonValue,
  PortType,
  PortField,
  PortDeclaration,
  BindingSource,
  PortBinding,
  EdgeTrigger,
  ControlEdge,
  StepFailurePolicy,
  HumanStepSpec,
  SubworkflowDependency,
  NodeSpec,
  WorkflowNode,
  WorkflowProvenance,
  WorkflowOutputBinding,
  WorkflowIR,
  VersionAffectingCompatibility,
  PresentationMetadata,
  WorkflowIrDocument,
  ValidationIssue,
  ValidationResult,
  ParseResult,
  WorkflowVersionSemanticDigest,
  IrSchemaMigration,
  IrSchemaNegotiationResult,
  WorkflowSurfaceSnapshot,
  WorkflowVersionUpdateDecision,
  WorkflowIrErrorCode,
} from './types.js';

export { WORKFLOW_IR_REGISTRY_VOCABULARY } from './internal/registry-vocabulary.js';

export { validateWorkflowIrDocument } from './internal/validate.js';
export { parseWorkflowIrDocument, serializeWorkflowIrDocument } from './internal/serialize.js';
export {
  canonicalSemanticJson,
  computeWorkflowVersionSemanticDigest,
  semanticallyEqual,
} from './internal/semantic.js';
export { isPortTypeAssignable } from './internal/type-system.js';
export {
  negotiateIrSchemaVersion,
  negotiateWorkflowVersionUpdate,
} from './internal/negotiate.js';
export { createWorkflowIrBuilder } from './internal/builder.js';
export type { WorkflowIrBuilder } from './internal/builder.js';

/**
 * Throwing validation helper (fail-closed): throws `WorkflowIrError` with
 * every issue when the document is invalid; returns the document otherwise.
 */
export function assertValidWorkflowIrDocument(document: WorkflowIrDocument): WorkflowIrDocument {
  const result = validateWorkflowIrDocument(document);
  if (!result.ok) {
    const summary = result.issues.map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`).join('; ');
    throw new WorkflowIrError('WORKFLOW_IR_INVALID', `invalid WorkflowIR document: ${summary}`, result.issues);
  }
  return document;
}
