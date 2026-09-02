/**
 * V2-007 — Workflow Compiler public barrel.
 *
 * The domain lives at `src/workflow-compiler/` (application-layer pure
 * domain module — workflow-ir / node-capability precedent). It owns the
 * deterministic compilation of merged V2-003 WorkflowIR documents into
 * executable compiled plans, the typed compile diagnostics, compile-time
 * capability/placement checks, compiled-artifact provenance (source
 * WorkflowVersion semantic digest + compiler identity + schema identity),
 * deterministic artifact identity, export/import with verification, and the
 * semantic-equivalence projection.
 *
 * Boundaries (V2-007):
 *   - the compiler is a DERIVED TRANSFORMATION — never a replacement
 *     workflow representation, never a second authority (constitution §3);
 *   - NO repository persistence/version lifecycle (V2-002);
 *   - NO WorkflowIR semantics (V2-003 — consumed as the declared
 *     implementation dependency, never redefined);
 *   - NO node/capability matching semantics (V2-004 — requirements are data);
 *   - NO run/evidence persistence (V2-005), NO teaching (V2-006), NO
 *     computer-agent execution (V2-008), NO scheduling/marketplace;
 *   - NO execution-attestation concepts (V2-014 domain
 *     workflowos/execution-statement/v1 — the compiled-artifact digest here
 *     is a DIFFERENT, domain-separated commitment);
 *   - the artifact contains no execution status/result fields: compiling a
 *     plan (authored or model-generated) executes NOTHING and proves
 *     NOTHING about execution.
 */
import { computeWorkflowVersionSemanticDigest } from '../workflow-ir/index.js';
import type { WorkflowIrDocument } from '../workflow-ir/index.js';
import { WorkflowCompilerError } from './types.js';
import type { CompiledWorkflowArtifact } from './types.js';
import { compileWorkflow } from './internal/compile.js';

export {
  // §0 compiler + artifact identity
  COMPILED_WORKFLOW_OBJECT_TYPE,
  WORKFLOW_COMPILER_ID,
  WORKFLOW_COMPILER_VERSION,
  SUPPORTED_WORKFLOW_COMPILER_VERSIONS,
  // §1 typed diagnostics
  WORKFLOW_COMPILER_ERROR_CODES,
  WorkflowCompilerError,
} from './types.js';
export type {
  WorkflowCompilerErrorCode,
  IrIssueReference,
  CompileDiagnostic,
  CompileOptions,
  CompileResult,
  CompiledUnit,
  CompiledWorkflowPlan,
  CompiledWorkflowSourceProvenance,
  CompiledWorkflowProvenance,
  CompiledWorkflowArtifact,
  CompiledWorkflowDigest,
  CompiledArtifactParseResult,
  CompiledArtifactVerification,
  BindingSource,
  CompletionEvidenceClass,
  ExecutionClass,
  NodeSpec,
  PlacementId,
  PortDeclaration,
  PortBinding,
  PortType,
  StepFailurePolicy,
  WorkflowIrDocument,
  WorkflowOutputBinding,
} from './types.js';

export { compileWorkflow } from './internal/compile.js';
export {
  canonicalArtifactPreimage,
  computeCompiledWorkflowDigest,
  serializeCompiledWorkflowArtifact,
  parseCompiledWorkflowArtifact,
  verifyCompiledWorkflowArtifact,
} from './internal/artifact.js';
export { projectCompiledPlanSemantics } from './internal/projection.js';

// ============================================================================
// Throwing / boolean convenience surface
// ============================================================================

/**
 * Throwing compilation helper (fail-closed): throws `WorkflowCompilerError`
 * carrying every diagnostic when compilation is rejected (the error code is
 * the first diagnostic's code); returns the artifact payload otherwise.
 */
export function assertCompileWorkflow(
  source: unknown,
  options?: object,
): { readonly artifact: CompiledWorkflowArtifact } {
  const result = compileWorkflow(source, options);
  if (!result.ok) {
    const first = result.diagnostics[0];
    const code = first !== undefined ? first.code : 'WORKFLOW_COMPILER_INPUT_INVALID';
    const summary = result.diagnostics
      .map((diagnostic) => `${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`)
      .join('; ');
    throw new WorkflowCompilerError(code, `workflow compilation failed: ${summary}`, result.diagnostics);
  }
  return { artifact: result.artifact };
}

/**
 * Verify that a compiled artifact is bound to the EXACT source
 * WorkflowVersion semantics: the artifact's recorded source digest must
 * equal the merged V2-003 semantic digest of the given document (algorithm,
 * domain, object type and IR schema version included). Presentation-only
 * variants of the same version semantics verify true; any semantic change
 * verifies false.
 */
export function verifySourceVersionBinding(
  artifact: CompiledWorkflowArtifact,
  document: WorkflowIrDocument,
): boolean {
  const sourceDigest = computeWorkflowVersionSemanticDigest(document);
  const source = artifact.provenance.source;
  return (
    source.semanticDigest === sourceDigest.digest &&
    source.digestAlgorithm === sourceDigest.algorithm &&
    source.digestDomain === sourceDigest.domain &&
    source.objectType === document.objectType &&
    source.irSchemaVersion === document.irSchemaVersion
  );
}
