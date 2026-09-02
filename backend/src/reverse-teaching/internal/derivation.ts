/**
 * V2-010 — the reverse-teaching derivation: a deterministic manual-task VIEW
 * over one pinned WorkflowIR document.
 *
 * HARD RULES (constitution §3/§8 + the teaching model + the V2-006 lesson
 * derivation this builds on):
 *   - the reverse-teaching lesson is DERIVED, never a second lesson format,
 *     never a second workflow format and never an execution authority;
 *   - the base lesson is the MERGED V2-006 derivation, composed verbatim
 *     (implementation dependency — never re-derived here, never mutated);
 *   - teaching NEVER invents procedural facts: every manual instruction is a
 *     FIXED template interpolating ONLY a declared IR value (the verbatim
 *     human instruction, the declared agent task, the canonical capability
 *     name, or the declared subworkflow reference); every missing
 *     manual-teaching fact becomes a typed disclosure;
 *   - MANUAL safety classification consumes the merged V2-008
 *     computer-agent runtime's sensitive-capability vocabulary read-only
 *     (the unsafe-instruction gate basis); the classification is honestly
 *     module-scoped policy, exactly as V2-008 itself scopes it;
 *   - derivation is pure: it never mutates the input document, and its
 *     output is deep-frozen.
 */
import type { WorkflowIrDocument, WorkflowNode } from '../../workflow-ir/index.js';
import { capabilitySensitivityOf } from '../../computer-agent/index.js';
import {
  deriveLessonFromIrDocument,
  type DerivedLesson,
  type LessonStep,
} from '../../teaching-sessions/index.js';
import type {
  ExpectedOutcome,
  ManualActionability,
  ManualInstructionBasis,
  ManualSafetyClassification,
  ReverseTeachingDisclosure,
  ReverseTeachingDisclosureField,
  ReverseTeachingLesson,
  ReverseTeachingPurpose,
  ReverseTeachingStep,
} from '../types.js';
import { ReverseTeachingError } from '../types.js';
import { deepFreeze } from './immutable.js';

// ============================================================================
// Disclosure message templates (fixed prose — the manual dimension)
// ============================================================================

const DISCLOSURE_MESSAGES: Readonly<Record<ReverseTeachingDisclosureField, string>> = {
  manual_equivalent: 'The workflow does not declare how a person performs this step by hand.',
  subworkflow_manual_procedure: 'The workflow does not declare the manual procedure of the referenced subworkflow "{reference}".',
  expected_outcome_observation: 'The workflow does not declare how this step\u2019s expected outcome is observed.',
};

function manualDisclosure(
  field: ReverseTeachingDisclosureField,
  subjectPath: string,
  interpolations: Readonly<Record<string, string>> = {},
): ReverseTeachingDisclosure {
  let message = DISCLOSURE_MESSAGES[field];
  for (const [key, value] of Object.entries(interpolations)) {
    message = message.replace(`{${key}}`, value);
  }
  return { kind: 'NOT_SPECIFIED_BY_WORKFLOW', subjectPath, field, message };
}

// ============================================================================
// Fixed instruction templates (the ONLY rendered manual instruction prose)
// ============================================================================

/**
 * Render the manual instruction from the declared fact. FIXED templates —
 * the value is interpolated verbatim, never paraphrased, never extended.
 */
function renderManualInstruction(node: WorkflowNode): {
  actionability: ManualActionability;
  basis: ManualInstructionBasis;
  instruction: string;
} {
  const spec = node.spec;
  switch (spec.class) {
    case 'human':
      // the workflow declares the instruction the person performs verbatim
      return { actionability: 'human_declared', basis: 'declared_human_instruction', instruction: spec.human.instruction };
    case 'agentic_computer_use':
      // the person learns to perform the computer task the agent would
      // perform; the declared task is the ONLY instruction basis
      return { actionability: 'agent_task', basis: 'declared_agent_task', instruction: spec.task };
    case 'deterministic_api':
      // the WORKFLOW executes this step itself; the workflow declares no
      // manual equivalent — the bare capability name is the whole instruction
      return { actionability: 'system_performed', basis: 'declared_capability_name', instruction: spec.capability };
    case 'subworkflow':
      // the manual procedure lives in the referenced version (opaque)
      return {
        actionability: 'subworkflow_reference',
        basis: 'declared_subworkflow_reference',
        instruction: `${spec.subworkflow.workflowId}@${spec.subworkflow.versionRef}`,
      };
  }
}

/** The fixed safety notice template for safety-gated manual steps. */
function renderSafetyNotice(sensitive: readonly string[]): string {
  return (
    `This step's manual performance involves sensitive capabilities (${sensitive.join(', ')}). ` +
    'Review what they touch before you perform it, and acknowledge this notice explicitly.'
  );
}

// ============================================================================
// Per-step derivation
// ============================================================================

/**
 * The manual actionability of one step. Only steps the PERSON performs by
 * hand (human + agentic steps) can be safety-gated: system_performed steps
 * carry no manual instruction to gate, and a subworkflow reference delegates
 * its own safety to the referenced version's own teaching.
 */
function actionabilityOf(node: WorkflowNode): ManualActionability {
  switch (node.spec.class) {
    case 'human':
      return 'human_declared';
    case 'agentic_computer_use':
      return 'agent_task';
    case 'deterministic_api':
      return 'system_performed';
    case 'subworkflow':
      return 'subworkflow_reference';
  }
}

function sensitiveRequirementsOf(node: WorkflowNode): string[] {
  return node.capabilityRequirements.filter((capability) => capabilitySensitivityOf(capability) === 'sensitive');
}

function safetyOf(node: WorkflowNode): ManualSafetyClassification {
  const manual = actionabilityOf(node);
  if (manual !== 'human_declared' && manual !== 'agent_task') {
    return 'ordinary';
  }
  return sensitiveRequirementsOf(node).length > 0 ? 'safety_gated' : 'ordinary';
}

function stepUncertainty(node: WorkflowNode): ReverseTeachingDisclosure[] {
  const path = `$.ir.nodes.${node.id}`;
  const disclosures: ReverseTeachingDisclosure[] = [];
  if (node.spec.class === 'deterministic_api') {
    disclosures.push(manualDisclosure('manual_equivalent', path));
  }
  if (node.spec.class === 'subworkflow') {
    disclosures.push(
      manualDisclosure('subworkflow_manual_procedure', path, {
        reference: `${node.spec.subworkflow.workflowId}@${node.spec.subworkflow.versionRef}`,
      }),
    );
  }
  if (node.completionEvidence === undefined) {
    disclosures.push(manualDisclosure('expected_outcome_observation', path));
  }
  return disclosures;
}

// ============================================================================
// Section derivations
// ============================================================================

function derivePurpose(document: WorkflowIrDocument, base: DerivedLesson): ReverseTeachingPurpose {
  const ir = document.ir;
  const inputNames = base.intent.inputNames;
  const outputNames = base.intent.outputNames;
  const statement =
    `TEACH ME: perform the task of this workflow manually. The workflow starts at step "${ir.start}", ` +
    `takes ${inputNames.length} declared input(s) (${inputNames.join(', ')}) and produces ` +
    `${outputNames.length} workflow output(s) (${outputNames.join(', ')}); its provenance origin is ` +
    `"${ir.provenance.origin}". You are learning to perform this task by hand — the workflow executing ` +
    `it is a separate mode (AUTOMATE ME), and completing this lesson does not execute it. ` +
    base.intent.disclosures.map((d) => d.message).join(' ');
  return { intent: base.intent, statement };
}

function deriveExpectedOutcomes(base: DerivedLesson): ExpectedOutcome[] {
  const outcomes: ExpectedOutcome[] = [];
  for (const criterion of base.completionCriteria) {
    outcomes.push({
      kind: criterion.kind === 'workflow_output' ? 'workflow_output' : 'terminal_step',
      value: criterion.value,
      sourcePath: criterion.sourcePath,
    });
  }
  for (const observation of base.observations) {
    if (observation.kind === 'step_output') {
      outcomes.push({ kind: 'step_output', value: observation.value, sourcePath: observation.sourcePath });
    } else if (observation.kind === 'step_completion_evidence') {
      outcomes.push({
        kind: 'step_completion_evidence',
        value: observation.value,
        sourcePath: observation.sourcePath,
      });
    }
  }
  return outcomes;
}

function deriveSteps(document: WorkflowIrDocument, base: DerivedLesson): ReverseTeachingStep[] {
  const nodesById = new Map(document.ir.nodes.map((node) => [node.id, node]));
  const stepsById = new Map(base.steps.map((step) => [step.nodeId, step]));
  return base.stepOrder.map((nodeId, index) => {
    const node = nodesById.get(nodeId)!;
    const lessonStep: LessonStep = stepsById.get(nodeId)!;
    const rendered = renderManualInstruction(node);
    const sensitive = sensitiveRequirementsOf(node);
    const safety = safetyOf(node);
    return {
      nodeId,
      position: index + 1,
      executionClass: lessonStep.executionClass,
      actionability: rendered.actionability,
      manualInstructionBasis: rendered.basis,
      manualInstruction: rendered.instruction,
      safety,
      sensitiveCapabilities: sensitive,
      safetyNotice: safety === 'safety_gated' ? renderSafetyNotice(sensitive) : null,
      uncertainty: stepUncertainty(node),
      lessonStep,
    };
  });
}

// ============================================================================
// The public derivation
// ============================================================================

/**
 * Derive the reverse-teaching lesson from one pinned WorkflowIR document —
 * a pure, deterministic, order-independent projection composed over the
 * merged V2-006 lesson derivation. The output is deep-frozen (teaching never
 * mutates the source artifact). Throws a typed IR_GRAPH_CYCLE error when the
 * base derivation rejects a cyclic control graph (fail closed).
 */
export function deriveReverseTeachingLesson(document: WorkflowIrDocument): ReverseTeachingLesson {
  let base: DerivedLesson;
  try {
    base = deriveLessonFromIrDocument(document);
  } catch (error) {
    // The base derivation's cyclic-graph rejection is surfaced through THIS
    // module's typed error surface (fail closed; never swallowed).
    if (
      error instanceof Error &&
      (error as { code?: unknown }).code === 'IR_GRAPH_CYCLE'
    ) {
      throw new ReverseTeachingError(
        'IR_GRAPH_CYCLE',
        'the workflow control graph contains a cycle — no deterministic manual lesson order can be derived from declared control flow',
        { cause: String(error) },
      );
    }
    throw error;
  }

  const purpose = derivePurpose(document, base);
  const steps = deriveSteps(document, base);
  const expectedOutcomes = deriveExpectedOutcomes(base);
  const uncertainty: ReverseTeachingDisclosure[] = steps.flatMap((step) => step.uncertainty);

  const lesson: ReverseTeachingLesson = {
    base,
    stepOrder: base.stepOrder,
    purpose,
    prerequisites: base.prerequisites,
    steps,
    decisionPoints: base.decisionPoints,
    expectedOutcomes,
    uncertainty,
  };
  return deepFreeze(lesson);
}
