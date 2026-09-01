/**
 * V2-007 — the deterministic WorkflowIR compiler.
 *
 * Compilation is a PURE derived transformation: canonical WorkflowIR →
 * executable compiled plan + provenance, with NO wall-clock, randomness,
 * network or environment dependence. Same source document + same compiler
 * version + same declared options → byte-identical artifact.
 *
 * The compiler is fail-closed in LAYERS, each load-bearing:
 *
 *   1. OPTIONS validation — the declared request is checked first (closed
 *      option surface; unsupported compiler versions are rejected, never
 *      guessed forward).
 *   2. INPUT re-validation — the merged V2-003 `validateWorkflowIrDocument`
 *      runs on the source because the compiler RELIES on the IR's
 *      guarantees; every underlying IR issue is carried into a typed
 *      compiler diagnostic (capability / graph / policy / input classes).
 *   3. COMPILER-LAYER checks — the checks the IR deliberately does not make
 *      (verified against the merged validator): duplicate capability
 *      requirements (ambiguous input), invoked-capability-declared
 *      coherence, placement conflicts (constitution §12: locality is a
 *      correctness constraint), human-pause-point failure policies, and
 *      cyclic control (IR-valid but compiler-v1-unrepresentable).
 *
 * Rejections are TOTAL: no partial artifact is ever returned alongside
 * diagnostics.
 */
import {
  computeWorkflowVersionSemanticDigest,
  validateWorkflowIrDocument,
} from '../../workflow-ir/index.js';
import type { ValidationIssue, WorkflowIR, WorkflowIrDocument, WorkflowNode } from '../../workflow-ir/index.js';
import { createHash } from 'node:crypto';
import type {
  CompileDiagnostic,
  CompileResult,
  CompiledUnit,
  CompiledWorkflowPlan,
  CompiledWorkflowProvenance,
} from '../types.js';
import { COMPILED_WORKFLOW_OBJECT_TYPE, SUPPORTED_WORKFLOW_COMPILER_VERSIONS, WORKFLOW_COMPILER_ID, WORKFLOW_COMPILER_VERSION } from '../types.js';
import { canonicalJsonStringify, isPlainObject } from './canonical-json.js';
import {
  canonicalFailurePolicy,
  canonicalPortBinding,
  canonicalPortDeclaration,
  canonicalOutputBinding,
  canonicalSpec,
  compareStrings,
} from './canonicalize.js';
import { isCanonicalCapability, placementsCompatible } from './vocabulary.js';
import { artifactPreimage } from './artifact.js';

// ============================================================================
// §1  The public compile entry point
// ============================================================================

/**
 * Compile a WorkflowIR document into a deterministic compiled-workflow
 * artifact. `source` and `options` are untrusted input: everything is
 * validated fail-closed, and every rejection is a typed diagnostic.
 */
export function compileWorkflow(source: unknown, options?: object): CompileResult {
  // ---- layer 1: the declared compile request ----
  const optionDiagnostics = validateCompileOptions(options);
  if (optionDiagnostics.length > 0) {
    return { ok: false, diagnostics: optionDiagnostics };
  }

  // ---- layer 2: fail-closed input re-validation (merged V2-003) ----
  const validation = validateWorkflowIrDocument(source);
  if (!validation.ok) {
    return { ok: false, diagnostics: validation.issues.map(mapIrIssue) };
  }
  const document = source as WorkflowIrDocument;

  // ---- layer 3: compiler-layer semantic checks ----
  const diagnostics: CompileDiagnostic[] = [];
  checkCompilerLayer(document, diagnostics);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  // ---- the pure transformation ----
  const plan = buildPlan(document);
  const provenance = buildProvenance(document, options);
  const artifactDigest = createHash('sha-256')
    .update(artifactPreimage(plan, provenance), 'utf8')
    .digest('hex');
  return {
    ok: true,
    artifact: {
      artifactDigest,
      objectType: COMPILED_WORKFLOW_OBJECT_TYPE,
      plan,
      provenance,
    },
  };
}

// ============================================================================
// §2  Layer 1 — compile options validation (closed surface, fail-closed)
// ============================================================================

function validateCompileOptions(options: object | undefined): CompileDiagnostic[] {
  if (options === undefined) return [];
  const diagnostics: CompileDiagnostic[] = [];
  if (!isPlainObject(options)) {
    diagnostics.push(
      diagnostic('WORKFLOW_COMPILER_INPUT_INVALID', '$.options', 'compile options must be an object'),
    );
    return diagnostics;
  }
  for (const key of Object.keys(options).sort(compareStrings)) {
    if (key !== 'compilerVersion') {
      diagnostics.push(
        diagnostic(
          'WORKFLOW_COMPILER_INPUT_INVALID',
          `$.options.${key}`,
          `unknown compile option "${key}" (closed option surface — no guessed semantics)`,
        ),
      );
    }
  }
  const version = options['compilerVersion'];
  if (version !== undefined) {
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      diagnostics.push(
        diagnostic(
          'WORKFLOW_COMPILER_INPUT_INVALID',
          '$.options.compilerVersion',
          'compilerVersion must be an integer ≥ 1',
        ),
      );
    } else if (!SUPPORTED_WORKFLOW_COMPILER_VERSIONS.includes(version)) {
      diagnostics.push(
        diagnostic(
          'WORKFLOW_COMPILER_VERSION_UNSUPPORTED',
          '$.options.compilerVersion',
          `compiler version ${version} is not supported by this build (supported: ${SUPPORTED_WORKFLOW_COMPILER_VERSIONS.join(', ')}) — fail closed, never guess forward`,
        ),
      );
    }
  }
  return diagnostics;
}

// ============================================================================
// §3  Layer 2 — mapping underlying WorkflowIR issues to typed diagnostics
// ============================================================================

const CAPABILITY_IR_ISSUE_CODES = new Set([
  'IR_CAPABILITY_NON_CANONICAL',
  'IR_CAPABILITY_REQUIREMENT_NON_CANONICAL',
  'IR_SUBWORKFLOW_CAPABILITY_REQUIRED',
]);

const GRAPH_IR_ISSUE_CODES = new Set([
  'IR_NODES_REQUIRED',
  'IR_NODE_ID_DUPLICATE',
  'IR_START_UNKNOWN',
  'IR_EDGE_NODE_UNKNOWN',
  'IR_EDGE_SELF_LOOP',
  'IR_EDGE_INTO_START',
  'IR_EDGE_DUPLICATE',
  'IR_NODE_UNREACHABLE',
  'IR_BINDING_NODE_UNKNOWN',
  'IR_BINDING_OUTPUT_UNKNOWN',
  'IR_BINDING_WORKFLOW_INPUT_UNKNOWN',
]);

const POLICY_IR_ISSUE_CODES = new Set([
  'IR_FAILURE_POLICY_EDGE_REQUIRED',
  'IR_FAILURE_POLICY_EDGE_CONFLICT',
  'IR_HUMAN_OUTPUT_CONTRACT',
  'IR_HUMAN_OPTION_DUPLICATE',
  'IR_HUMAN_OUTCOME_UNCOVERED',
  'IR_HUMAN_OUTCOME_UNDECLARED',
  'IR_HUMAN_SUCCESS_EDGE_FORBIDDEN',
  'IR_HUMAN_FAILURE_EDGE_FORBIDDEN',
  'IR_SUBWORKFLOW_DEPENDENCY_INVALID',
]);

function mapIrIssue(issue: ValidationIssue): CompileDiagnostic {
  const code = CAPABILITY_IR_ISSUE_CODES.has(issue.code)
    ? 'WORKFLOW_COMPILER_CAPABILITY_UNSUPPORTED'
    : GRAPH_IR_ISSUE_CODES.has(issue.code)
      ? 'WORKFLOW_COMPILER_GRAPH_INVALID'
      : POLICY_IR_ISSUE_CODES.has(issue.code)
        ? 'WORKFLOW_COMPILER_POLICY_VIOLATION'
        : 'WORKFLOW_COMPILER_INPUT_INVALID';
  return {
    code,
    path: issue.path,
    message: issue.message,
    irIssue: { code: issue.code, path: issue.path, message: issue.message },
  };
}

// ============================================================================
// §4  Layer 3 — the compiler's own semantic checks (IR-valid documents only)
// ============================================================================

function checkCompilerLayer(document: WorkflowIrDocument, diagnostics: CompileDiagnostic[]): void {
  const nodes = [...document.ir.nodes].sort((a, b) => compareStrings(a.id, b.id));
  const defaultPlacement = document.ir.defaultPlacement;

  for (const node of nodes) {
    checkDuplicateCapabilityRequirements(node, diagnostics);
    checkCapabilityVocabulary(node, diagnostics);
    checkInvokedCapabilityDeclared(node, diagnostics);
    checkPlacementConflict(node, defaultPlacement, diagnostics);
    checkHumanFailurePolicy(node, diagnostics);
  }

  checkAcyclic(document.ir, diagnostics);
}

/** Duplicate capability requirements are ambiguous input — never silently normalized. */
function checkDuplicateCapabilityRequirements(node: WorkflowNode, diagnostics: CompileDiagnostic[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const requirement of node.capabilityRequirements) {
    if (seen.has(requirement)) duplicates.add(requirement);
    seen.add(requirement);
  }
  for (const duplicate of [...duplicates].sort(compareStrings)) {
    diagnostics.push(
      diagnostic(
        'WORKFLOW_COMPILER_AMBIGUOUS_INPUT',
        `$.ir.nodes.${node.id}.capabilityRequirements`,
        `duplicate capability requirement "${duplicate}" on node "${node.id}" — ambiguous input is never silently normalized`,
      ),
    );
  }
}

/**
 * Defense-in-depth capability vocabulary re-check on the IR-valid document
 * (the IR already validates canonical names; this layer fails closed if the
 * compiler's frozen registry snapshot ever disagrees — no silent drift).
 */
function checkCapabilityVocabulary(node: WorkflowNode, diagnostics: CompileDiagnostic[]): void {
  for (const requirement of node.capabilityRequirements) {
    if (!isCanonicalCapability(requirement)) {
      diagnostics.push(
        diagnostic(
          'WORKFLOW_COMPILER_CAPABILITY_UNSUPPORTED',
          `$.ir.nodes.${node.id}.capabilityRequirements`,
          `"${requirement}" is not a canonical registry capability name (aliases and platform SDK names are forbidden)`,
        ),
      );
    }
  }
  if (node.spec.class === 'deterministic_api' && !isCanonicalCapability(node.spec.capability)) {
    diagnostics.push(
      diagnostic(
        'WORKFLOW_COMPILER_CAPABILITY_UNSUPPORTED',
        `$.ir.nodes.${node.id}.spec.capability`,
        `"${node.spec.capability}" is not a canonical registry capability name (aliases and platform SDK names are forbidden)`,
      ),
    );
  }
}

/**
 * A deterministic step must declare its invoked capability in its
 * capability requirements: execution may never invoke a capability that was
 * not declared for matching (constitution §5 — no silent substitution).
 */
function checkInvokedCapabilityDeclared(node: WorkflowNode, diagnostics: CompileDiagnostic[]): void {
  if (node.spec.class !== 'deterministic_api') return;
  if (!node.capabilityRequirements.includes(node.spec.capability)) {
    diagnostics.push(
      diagnostic(
        'WORKFLOW_COMPILER_CAPABILITY_UNSUPPORTED',
        `$.ir.nodes.${node.id}.spec.capability`,
        `invoked capability "${node.spec.capability}" is not declared in capabilityRequirements of node "${node.id}" — execution must never invoke an undeclared capability`,
      ),
    );
  }
}

/** The workflow default placement and a node placement must share a location class. */
function checkPlacementConflict(
  node: WorkflowNode,
  defaultPlacement: WorkflowIR['defaultPlacement'],
  diagnostics: CompileDiagnostic[],
): void {
  if (!placementsCompatible(node.placement, defaultPlacement)) {
    diagnostics.push(
      diagnostic(
        'WORKFLOW_COMPILER_PLACEMENT_CONFLICT',
        `$.ir.nodes.${node.id}.placement`,
        `node "${node.id}" requires placement ${node.placement} while the workflow default placement is ${defaultPlacement} (no location class satisfies both — locality is a correctness constraint, constitution §12)`,
      ),
    );
  }
}

/**
 * A human pause point (approval/decision/information) can only fail the
 * workflow: retry budgets, ignore-and-continue and failover would let
 * machinery decide a human pause point's continuation — the person decides
 * (constitution §6/§8).
 */
function checkHumanFailurePolicy(node: WorkflowNode, diagnostics: CompileDiagnostic[]): void {
  if (node.executionClass !== 'human') return;
  if (node.failurePolicy.strategy !== 'fail_workflow') {
    diagnostics.push(
      diagnostic(
        'WORKFLOW_COMPILER_POLICY_VIOLATION',
        `$.ir.nodes.${node.id}.failurePolicy`,
        `human pause point "${node.id}" declares failure policy "${node.failurePolicy.strategy}" — a human pause point cannot be retried, ignored or failed over by machinery (the person decides; constitution §6/§8)`,
      ),
    );
  }
}

/**
 * Cyclic control is IR-VALID (the merged V2-003 validator has no acyclicity
 * rule — verified) but compiler-v1-unrepresentable: this compiler produces
 * acyclic executable plans. The rejection is typed and deterministic; loop
 * semantics require a governed later compiler version.
 */
function checkAcyclic(ir: WorkflowIR, diagnostics: CompileDiagnostic[]): void {
  const cyclicNodes = findCyclicNodeIds(ir);
  if (cyclicNodes.length > 0) {
    diagnostics.push(
      diagnostic(
        'WORKFLOW_COMPILER_GRAPH_INVALID',
        '$.ir.edges',
        `cyclic control graph involving nodes ${cyclicNodes.join(', ')} — compiler v1 compiles acyclic executable plans; cyclic control is IR-valid but unrepresentable here (a governed later compiler version must introduce loop semantics)`,
      ),
    );
  }
}

/** The node ids that lie on a control cycle (deterministic, sorted). */
function findCyclicNodeIds(ir: WorkflowIR): string[] {
  const adjacency = new Map<string, Set<string>>();
  for (const node of ir.nodes) adjacency.set(node.id, new Set<string>());
  for (const edge of ir.edges) {
    const targets = adjacency.get(edge.from);
    if (targets !== undefined && adjacency.has(edge.to)) {
      targets.add(edge.to);
    }
  }
  const cyclic: string[] = [];
  for (const node of ir.nodes) {
    if (reachable(adjacency, node.id, node.id)) {
      cyclic.push(node.id);
    }
  }
  return cyclic.sort(compareStrings);
}

/** Is `target` reachable from `source` over ≥ 1 edge? */
function reachable(adjacency: Map<string, Set<string>>, source: string, target: string): boolean {
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const direct of adjacency.get(source) ?? []) {
    queue.push(direct);
  }
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      queue.push(next);
    }
  }
  return false;
}

// ============================================================================
// §5  The plan builder (deterministic breadth-first unit emission)
// ============================================================================

function buildPlan(document: WorkflowIrDocument): CompiledWorkflowPlan {
  const ir = document.ir;
  const nodesById = new Map<string, WorkflowNode>(ir.nodes.map((node) => [node.id, node]));
  const successors = new Map<string, string[]>();
  for (const node of ir.nodes) successors.set(node.id, []);
  for (const edge of ir.edges) {
    const targets = successors.get(edge.from);
    if (targets !== undefined && successors.has(edge.to)) {
      targets.push(edge.to);
    }
  }
  for (const [id, targets] of successors) {
    successors.set(id, [...new Set(targets)].sort(compareStrings));
  }

  // deterministic breadth-first order from the entry (every node is
  // reachable from start — guaranteed by the re-validated IR)
  const order: string[] = [];
  const visited = new Set<string>([ir.start]);
  const queue: string[] = [ir.start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    order.push(current);
    for (const target of successors.get(current) ?? []) {
      if (!visited.has(target)) {
        visited.add(target);
        queue.push(target);
      }
    }
  }

  const units: CompiledUnit[] = order.flatMap((id) => {
    const node = nodesById.get(id);
    if (node === undefined) return [];
    const outgoing = ir.edges.filter((edge) => edge.from === id);
    const successTargets = outgoing
      .filter((edge) => edge.on === 'success')
      .map((edge) => edge.to)
      .sort(compareStrings);
    const failureTargets = outgoing
      .filter((edge) => edge.on === 'failure')
      .map((edge) => edge.to);
    const outcomeContinuations = outgoing
      .filter((edge) => edge.on !== 'success' && edge.on !== 'failure')
      .map((edge) => ({
        outcome: (edge.on as { outcome: string }).outcome,
        to: edge.to,
      }))
      .sort((a, b) =>
        compareStrings(a.outcome, b.outcome) !== 0
          ? compareStrings(a.outcome, b.outcome)
          : compareStrings(a.to, b.to),
      );
    const unit: CompiledUnit = {
      unit: node.id,
      executionClass: node.executionClass,
      spec: canonicalSpec(node.spec),
      capabilityRequirements: [...node.capabilityRequirements].sort(compareStrings),
      placement: node.placement,
      inputs: node.inputs.map(canonicalPortBinding).sort((a, b) => compareStrings(a.name, b.name)),
      outputs: node.outputs.map(canonicalPortDeclaration).sort((a, b) => compareStrings(a.name, b.name)),
      failurePolicy: canonicalFailurePolicy(node.failurePolicy),
      ...(node.completionEvidence !== undefined ? { completionEvidence: node.completionEvidence } : {}),
      onSuccess: successTargets,
      onFailure: failureTargets.length === 1 ? (failureTargets[0] as string) : null,
      onOutcomes: outcomeContinuations,
    };
    return [unit];
  });

  return {
    entry: ir.start,
    units,
    inputs: ir.inputs.map(canonicalPortDeclaration).sort((a, b) => compareStrings(a.name, b.name)),
    outputs: ir.outputs.map(canonicalOutputBinding).sort((a, b) => compareStrings(a.name, b.name)),
    defaultPlacement: ir.defaultPlacement,
  };
}

// ============================================================================
// §6  The provenance builder (compiler + source + options identity)
// ============================================================================

function buildProvenance(
  document: WorkflowIrDocument,
  options: object | undefined,
): CompiledWorkflowProvenance {
  const sourceDigest = computeWorkflowVersionSemanticDigest(document);
  const sourceRefs = document.ir.provenance.sourceRefs;
  const optionsDigest = createHash('sha-256')
    .update(canonicalJsonStringify(normalizeDeclaredOptions(options)), 'utf8')
    .digest('hex');
  return {
    compiler: { id: WORKFLOW_COMPILER_ID, version: WORKFLOW_COMPILER_VERSION },
    optionsDigest,
    source: {
      digestAlgorithm: 'sha-256',
      digestDomain: sourceDigest.domain,
      irSchemaVersion: document.irSchemaVersion,
      objectType: document.objectType,
      origin: document.ir.provenance.origin,
      semanticDigest: sourceDigest.digest,
      ...(sourceRefs !== undefined && sourceRefs.length > 0
        ? { sourceRefs: [...sourceRefs].sort(compareStrings) }
        : {}),
    },
  };
}

/**
 * The normalized DECLARED options (the exact request the caller made —
 * absent options and explicitly defaulted options are different requests and
 * produce different options-digest commitments).
 */
function normalizeDeclaredOptions(options: object | undefined): Record<string, unknown> {
  if (options === undefined) return {};
  const record: Record<string, unknown> = {};
  const version = isPlainObject(options) ? options['compilerVersion'] : undefined;
  if (version !== undefined) {
    record['compilerVersion'] = version;
  }
  return record;
}

// ============================================================================
// §7  Shared diagnostic helper
// ============================================================================

function diagnostic(code: CompileDiagnostic['code'], path: string, message: string): CompileDiagnostic {
  return { code, path, message };
}
