/**
 * V2-006 — the lesson derivation: a deterministic VIEW over one WorkflowIR
 * document.
 *
 * HARD RULES (constitution §3/§8 + the teaching model):
 *   - the lesson is DERIVED, never a second workflow format and never an
 *     execution authority;
 *   - teaching NEVER invents procedural facts: every stated fact is a
 *     verbatim IR value or a canonical rendering of a declared structural
 *     field, traced by `sourcePath`; every missing fact becomes a typed
 *     NOT_SPECIFIED_BY_WORKFLOW disclosure;
 *   - every rendered sentence is a FIXED template interpolating only those
 *     facts (the refusal-to-invent battery proves this mechanically);
 *   - derivation is pure: it never mutates the input document and its output
 *     is deep-frozen.
 */
import type {
  ControlEdge,
  EdgeTrigger,
  PortBinding,
  PortType,
  WorkflowIrDocument,
  WorkflowNode,
} from '../../workflow-ir/index.js';
import type {
  DerivedLesson,
  EdgeCondition,
  LessonCompletionCriterion,
  LessonDecisionPoint,
  LessonIntent,
  LessonObservation,
  LessonPrerequisite,
  LessonStep,
  LessonStepInput,
  LessonStepOutput,
  StepSemantics,
  TeachingDisclosure,
  TeachingDisclosureField,
  TeachingFact,
} from '../types.js';
import { TeachingSessionError } from '../types.js';
import { deepFreeze } from './immutable.js';

// ============================================================================
// Disclosure message templates (fixed prose — the only fixed prose besides
// the step/intent explanation templates below)
// ============================================================================

const DISCLOSURE_MESSAGES: Readonly<Record<TeachingDisclosureField, string>> = {
  workflow_goal: 'The workflow does not declare its goal in natural language.',
  step_human_readable_semantics: 'The workflow does not declare a human-readable rationale for this step.',
  subworkflow_semantics: 'The workflow does not declare what the referenced subworkflow does.',
  step_completion_evidence: 'The workflow does not declare how completion of this step is established.',
};

function disclosure(field: TeachingDisclosureField, subjectPath: string): TeachingDisclosure {
  return {
    kind: 'NOT_SPECIFIED_BY_WORKFLOW',
    subjectPath,
    field,
    message: DISCLOSURE_MESSAGES[field]!,
  };
}

// ============================================================================
// Canonical helpers (order-independent: the IR is a set-semantics object)
// ============================================================================

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function triggerKey(trigger: EdgeTrigger): string {
  if (trigger === 'success' || trigger === 'failure') return trigger;
  return `outcome:${trigger.outcome}`;
}

function portTypeKind(type: PortType): string {
  return type.kind;
}

/** Canonical rendering of a declared binding (structural, not prose). */
function bindingRendering(binding: PortBinding['binding']): string {
  switch (binding.kind) {
    case 'workflow_input':
      return `workflow_input:${binding.input}`;
    case 'node_output':
      return `node_output:${binding.node}.${binding.output}`;
    case 'literal':
      return `literal:${JSON.stringify(binding.value)}`;
    case 'secret_ref':
      return `secret_ref:${binding.ref}`;
  }
}

/** Canonical rendering of a declared failure policy (structural). */
function failurePolicyRendering(node: WorkflowNode): string {
  const policy = node.failurePolicy;
  if (policy.strategy === 'retry_then_fail_workflow') {
    return `retry_then_fail_workflow(maxAttempts=${policy.maxAttempts})`;
  }
  return policy.strategy;
}

/** The declared semantic text of a step (practice/assessment answer basis). */
export function stepDeclaredSemanticText(step: LessonStep): string {
  const semantics = step.semantics;
  switch (semantics.class) {
    case 'deterministic_api':
      return semantics.capability;
    case 'agentic_computer_use':
      return semantics.task;
    case 'human':
      return semantics.instruction;
    case 'subworkflow':
      return `${semantics.workflowId}@${semantics.versionRef}`;
  }
}

// ============================================================================
// The canonical checkpoint order (deterministic topological traversal)
// ============================================================================

/**
 * The canonical teaching order: a Kahn topological sort over the declared
 * control edges with a sorted ready set (deterministic tie-break). Cycles
 * are rejected fail-closed — no honest linear lesson order exists for a
 * cyclic control graph.
 */
export function canonicalStepOrder(document: WorkflowIrDocument): readonly string[] {
  const nodes = document.ir.nodes;
  const ids = nodes.map((node) => node.id);
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const successors = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of document.ir.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    successors.get(edge.from)?.push(edge.to);
  }
  // Only the declared start node has indegree 0 in a validated document;
  // collect any others (defensive) into the initial sorted ready set.
  const ready = ids
    .filter((id) => (indegree.get(id) ?? 0) === 0)
    .sort(compareStrings);
  const order: string[] = [];
  const visited = new Set<string>();
  while (ready.length > 0) {
    // Deterministic tie-break: process the ready set in sorted order.
    ready.sort(compareStrings);
    const current = ready.shift() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    order.push(current);
    for (const next of successors.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  if (order.length !== ids.length) {
    throw new TeachingSessionError(
      'IR_GRAPH_CYCLE',
      'the workflow control graph contains a cycle — no deterministic lesson order can be derived from declared control flow',
      { nodeCount: ids.length, orderedCount: order.length },
    );
  }
  return order;
}

// ============================================================================
// Per-step derivation
// ============================================================================

function stepSemanticsOf(node: WorkflowNode): StepSemantics {
  const spec = node.spec;
  switch (spec.class) {
    case 'deterministic_api':
      return { class: 'deterministic_api', capability: spec.capability };
    case 'agentic_computer_use':
      return { class: 'agentic_computer_use', task: spec.task };
    case 'human':
      return {
        class: 'human',
        kind: spec.human.kind,
        instruction: spec.human.instruction,
        ...(spec.human.kind === 'decision' ? { options: [...spec.human.options].sort(compareStrings) } : {}),
        ...(spec.human.kind === 'information' ? { provides: spec.human.provides.name } : {}),
      };
    case 'subworkflow':
      return {
        class: 'subworkflow',
        workflowId: spec.subworkflow.workflowId,
        versionRef: spec.subworkflow.versionRef,
      };
  }
}

function stepFacts(node: WorkflowNode): TeachingFact[] {
  const path = `$.ir.nodes.${node.id}`;
  const facts: TeachingFact[] = [{ kind: 'execution_class', value: node.executionClass, sourcePath: `${path}.executionClass` }];
  const spec = node.spec;
  switch (spec.class) {
    case 'deterministic_api':
      facts.push({ kind: 'capability', value: spec.capability, sourcePath: `${path}.spec.capability` });
      break;
    case 'agentic_computer_use':
      facts.push({ kind: 'task', value: spec.task, sourcePath: `${path}.spec.task` });
      break;
    case 'human':
      facts.push({ kind: 'human_kind', value: spec.human.kind, sourcePath: `${path}.spec.human.kind` });
      facts.push({ kind: 'human_instruction', value: spec.human.instruction, sourcePath: `${path}.spec.human.instruction` });
      if (spec.human.kind === 'decision') {
        for (const option of [...spec.human.options].sort(compareStrings)) {
          facts.push({ kind: 'decision_options', value: option, sourcePath: `${path}.spec.human.options` });
        }
      }
      if (spec.human.kind === 'information') {
        facts.push({ kind: 'provided_port', value: spec.human.provides.name, sourcePath: `${path}.spec.human.provides.name` });
      }
      break;
    case 'subworkflow':
      facts.push({
        kind: 'subworkflow_reference',
        value: `${spec.subworkflow.workflowId}@${spec.subworkflow.versionRef}`,
        sourcePath: `${path}.spec.subworkflow`,
      });
      break;
  }
  facts.push({ kind: 'placement', value: node.placement, sourcePath: `${path}.placement` });
  facts.push({ kind: 'failure_policy', value: failurePolicyRendering(node), sourcePath: `${path}.failurePolicy` });
  const sortedInputs = [...node.inputs].sort((a, b) => compareStrings(a.name, b.name));
  for (const input of sortedInputs) {
    facts.push({ kind: 'input_binding', value: bindingRendering(input.binding), sourcePath: `${path}.inputs.${input.name}` });
  }
  const sortedOutputs = [...node.outputs].sort((a, b) => compareStrings(a.name, b.name));
  for (const output of sortedOutputs) {
    facts.push({ kind: 'output_port', value: output.name, sourcePath: `${path}.outputs.${output.name}` });
  }
  if (node.completionEvidence !== undefined) {
    facts.push({ kind: 'completion_evidence', value: node.completionEvidence, sourcePath: `${path}.completionEvidence` });
  }
  return facts;
}

function stepInputsOutputs(node: WorkflowNode): { inputs: LessonStepInput[]; outputs: LessonStepOutput[] } {
  const inputs: LessonStepInput[] = [...node.inputs]
    .sort((a, b) => compareStrings(a.name, b.name))
    .map((input) => ({
      port: input.name,
      typeKind: portTypeKind(input.type),
      binding: bindingRendering(input.binding),
    }));
  const outputs: LessonStepOutput[] = [...node.outputs]
    .sort((a, b) => compareStrings(a.name, b.name))
    .map((output) => ({ port: output.name, typeKind: portTypeKind(output.type) }));
  return { inputs, outputs };
}

function stepConditionalOn(nodeId: string, edges: readonly ControlEdge[]): EdgeCondition[] {
  return edges
    .filter((edge) => edge.to === nodeId)
    .map((edge) => ({ from: edge.from, trigger: triggerKey(edge.on) }))
    .sort((a, b) => compareStrings(`${a.from}|${a.trigger}`, `${b.from}|${b.trigger}`));
}

function stepDisclosures(node: WorkflowNode): TeachingDisclosure[] {
  const path = `$.ir.nodes.${node.id}`;
  const disclosures: TeachingDisclosure[] = [];
  if (node.spec.class === 'deterministic_api') {
    disclosures.push(disclosure('step_human_readable_semantics', path));
  }
  if (node.spec.class === 'subworkflow') {
    disclosures.push(disclosure('subworkflow_semantics', path));
  }
  if (node.completionEvidence === undefined) {
    disclosures.push(disclosure('step_completion_evidence', path));
  }
  return disclosures;
}

/** Render the step explanation from facts + disclosures with FIXED templates. */
function renderStepExplanation(
  node: WorkflowNode,
  position: number,
  conditionalOn: readonly EdgeCondition[],
  disclosures: readonly TeachingDisclosure[],
): string {
  const parts: string[] = [];
  for (const condition of conditionalOn) {
    parts.push(`Runs after ${condition.trigger} of step ${condition.from}.`);
  }
  const spec = node.spec;
  switch (spec.class) {
    case 'deterministic_api':
      parts.push(
        `Step ${position} (${node.id}) executes the canonical capability "${spec.capability}" as deterministic_api.`,
      );
      break;
    case 'agentic_computer_use':
      parts.push(
        `Step ${position} (${node.id}) is executed as agentic_computer_use with the declared task: "${spec.task}".`,
      );
      break;
    case 'human': {
      let sentence = `Step ${position} (${node.id}) is a human ${spec.human.kind} step with the declared instruction: "${spec.human.instruction}".`;
      if (spec.human.kind === 'decision') {
        const options = [...spec.human.options].sort(compareStrings).join(', ');
        sentence += ` The person selects one of the declared options: ${options}.`;
      }
      if (spec.human.kind === 'information') {
        sentence += ` The person provides the declared port ${spec.human.provides.name}.`;
      }
      parts.push(sentence);
      break;
    }
    case 'subworkflow':
      parts.push(
        `Step ${position} (${node.id}) invokes subworkflow "${spec.subworkflow.workflowId}" at version reference "${spec.subworkflow.versionRef}".`,
      );
      break;
  }
  parts.push(`Its declared placement is ${node.placement}.`);
  parts.push(`Its declared failure policy is ${failurePolicyRendering(node)}.`);
  if (node.completionEvidence !== undefined) {
    parts.push(`Its completion is established by ${node.completionEvidence} (declared).`);
  }
  for (const stepDisclosure of disclosures) {
    parts.push(stepDisclosure.message);
  }
  return parts.join(' ');
}

// ============================================================================
// Section derivations
// ============================================================================

function deriveIntent(document: WorkflowIrDocument): LessonIntent {
  const ir = document.ir;
  const inputNames = ir.inputs.map((input) => input.name).sort(compareStrings);
  const outputNames = ir.outputs.map((output) => output.name).sort(compareStrings);
  const disclosures = [disclosure('workflow_goal', '$.ir')];
  const statement =
    `This workflow starts at step "${ir.start}", takes ${inputNames.length} declared input(s) ` +
    `(${inputNames.join(', ')}) and produces ${outputNames.length} workflow output(s) ` +
    `(${outputNames.join(', ')}); its provenance origin is "${ir.provenance.origin}". ` +
    DISCLOSURE_MESSAGES['workflow_goal'];
  return {
    startNodeId: ir.start,
    inputNames,
    outputNames,
    provenanceOrigin: ir.provenance.origin,
    disclosures,
    statement,
  };
}

function derivePrerequisites(document: WorkflowIrDocument): LessonPrerequisite[] {
  const prerequisites: LessonPrerequisite[] = [];
  const sortedInputs = [...document.ir.inputs].sort((a, b) => compareStrings(a.name, b.name));
  for (const input of sortedInputs) {
    prerequisites.push({
      kind: 'workflow_input',
      value: `${input.name} (type ${portTypeKind(input.type)}, ${input.optional === true ? 'optional' : 'required'})`,
      sourcePath: `$.ir.inputs.${input.name}`,
    });
  }
  const capabilities = new Set<string>();
  for (const node of document.ir.nodes) {
    for (const capability of node.capabilityRequirements) capabilities.add(capability);
  }
  for (const capability of [...capabilities].sort(compareStrings)) {
    prerequisites.push({
      kind: 'required_capability',
      value: `required capability ${capability}`,
      sourcePath: '$.ir.nodes[*].capabilityRequirements',
    });
  }
  prerequisites.push({
    kind: 'placement',
    value: `default placement ${document.ir.defaultPlacement}`,
    sourcePath: '$.ir.defaultPlacement',
  });
  const sortedNodes = [...document.ir.nodes].sort((a, b) => compareStrings(a.id, b.id));
  for (const node of sortedNodes) {
    if (node.placement !== document.ir.defaultPlacement) {
      prerequisites.push({
        kind: 'placement',
        value: `step ${node.id} requires placement ${node.placement}`,
        sourcePath: `$.ir.nodes.${node.id}.placement`,
      });
    }
  }
  return prerequisites;
}

function deriveDecisionPoints(document: WorkflowIrDocument, stepOrder: readonly string[]): LessonDecisionPoint[] {
  const decisionPoints: LessonDecisionPoint[] = [];
  for (const nodeId of stepOrder) {
    const node = document.ir.nodes.find((candidate) => candidate.id === nodeId)!;
    if (node.executionClass !== 'human' || node.spec.class !== 'human') continue;
    const human = node.spec.human;
    const outcomeEdges = document.ir.edges.filter(
      (edge) => edge.from === nodeId && typeof edge.on === 'object' && edge.on !== null && 'outcome' in edge.on,
    );
    const outcomeGroups = new Map<string, string[]>();
    for (const edge of outcomeEdges) {
      const outcome = (edge.on as { outcome: string }).outcome;
      const bucket = outcomeGroups.get(outcome) ?? [];
      bucket.push(edge.to);
      outcomeGroups.set(outcome, bucket);
    }
    let outcomes: string[];
    if (human.kind === 'decision') {
      outcomes = [...new Set([...human.options, ...outcomeGroups.keys()])].sort(compareStrings);
    } else {
      outcomes = [...outcomeGroups.keys()].sort(compareStrings);
    }
    const leadsTo = [...outcomeGroups.entries()]
      .map(([outcome, targets]) => ({
        outcome,
        nextNodeIds: [...targets].sort(compareStrings),
      }))
      .sort((a, b) => compareStrings(a.outcome, b.outcome));
    decisionPoints.push({
      nodeId,
      humanKind: human.kind,
      instruction: human.instruction,
      outcomes,
      leadsTo,
    });
  }
  return decisionPoints;
}

function deriveObservations(document: WorkflowIrDocument, steps: readonly LessonStep[]): LessonObservation[] {
  const observations: LessonObservation[] = [];
  for (const step of steps) {
    for (const output of step.outputs) {
      observations.push({
        kind: 'step_output',
        value: `${step.nodeId} declares output port ${output.port}`,
        sourcePath: `$.ir.nodes.${step.nodeId}.outputs.${output.port}`,
      });
    }
    if (step.completionEvidence !== null) {
      observations.push({
        kind: 'step_completion_evidence',
        value: `${step.nodeId} completion is established by ${step.completionEvidence}`,
        sourcePath: `$.ir.nodes.${step.nodeId}.completionEvidence`,
      });
    }
  }
  const sortedOutputs = [...document.ir.outputs].sort((a, b) => compareStrings(a.name, b.name));
  for (const output of sortedOutputs) {
    observations.push({
      kind: 'workflow_output',
      value: `workflow output ${output.name}`,
      sourcePath: `$.ir.outputs.${output.name}`,
    });
  }
  return observations;
}

function deriveCompletionCriteria(document: WorkflowIrDocument): LessonCompletionCriterion[] {
  const criteria: LessonCompletionCriterion[] = [];
  const sortedOutputs = [...document.ir.outputs].sort((a, b) => compareStrings(a.name, b.name));
  for (const output of sortedOutputs) {
    criteria.push({
      kind: 'workflow_output',
      value: `workflow produces output ${output.name}`,
      sourcePath: `$.ir.outputs.${output.name}`,
    });
  }
  const terminal = document.ir.nodes
    .filter((node) => !document.ir.edges.some((edge) => edge.from === node.id))
    .map((node) => node.id)
    .sort(compareStrings);
  for (const nodeId of terminal) {
    criteria.push({
      kind: 'terminal_step',
      value: `${nodeId} is a terminal step`,
      sourcePath: `$.ir.nodes.${nodeId}`,
    });
  }
  return criteria;
}

// ============================================================================
// The public derivation
// ============================================================================

/**
 * Derive the lesson from one WorkflowIR document — a pure, deterministic,
 * order-independent projection. The output is deep-frozen (teaching never
 * mutates the source artifact). Throws typed IR_GRAPH_CYCLE for cyclic
 * control graphs (fail closed).
 */
export function deriveLessonFromIrDocument(document: WorkflowIrDocument): DerivedLesson {
  const stepOrder = canonicalStepOrder(document);
  const nodesById = new Map(document.ir.nodes.map((node) => [node.id, node]));

  const steps: LessonStep[] = stepOrder.map((nodeId, index) => {
    const node = nodesById.get(nodeId)!;
    const conditionalOn = stepConditionalOn(nodeId, document.ir.edges);
    const disclosures = stepDisclosures(node);
    const { inputs, outputs } = stepInputsOutputs(node);
    return {
      nodeId,
      position: index + 1,
      executionClass: node.executionClass,
      semantics: stepSemanticsOf(node),
      facts: stepFacts(node),
      disclosures,
      inputs,
      outputs,
      placement: node.placement,
      failurePolicy: failurePolicyRendering(node),
      completionEvidence: node.completionEvidence ?? null,
      conditionalOn,
      explanation: renderStepExplanation(node, index + 1, conditionalOn, disclosures),
    };
  });

  const intent = deriveIntent(document);
  const prerequisites = derivePrerequisites(document);
  const decisionPoints = deriveDecisionPoints(document, stepOrder);
  const observations = deriveObservations(document, steps);
  const completionCriteria = deriveCompletionCriteria(document);
  const disclosures: TeachingDisclosure[] = [
    ...intent.disclosures,
    ...steps.flatMap((step) => step.disclosures),
  ];

  const lesson: DerivedLesson = {
    stepOrder,
    intent,
    prerequisites,
    steps,
    decisionPoints,
    observations,
    completionCriteria,
    disclosures,
  };
  return deepFreeze(lesson);
}
