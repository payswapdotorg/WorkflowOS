/**
 * V2-017 T9 — the Teach Me vocabulary (Issue #200).
 *
 * PURE presentation functions over the V2-006/V2-010 transport wire
 * shapes. This module NEVER re-derives lessons, progress, or evidence —
 * it renders the authority's own facts in consumer language (UX §12/
 * §13/§2.6: "TeachingSession → Lesson"). Internal node IDs never render
 * (the V2-003 presentation labels are the step names — F-T4-001);
 * workflow-declared gaps render as honest "the workflow doesn't
 * specify" disclosures (§13: disclose missing information, never invent
 * procedural facts).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The nodeLabels map from the authoritative V2-003 presentation layer. */
export function nodeLabelsFromContent(content: unknown): Record<string, string> | null {
  if (!isRecord(content)) return null;
  if (content.objectType !== 'workflowos/workflow-ir/v1') return null;
  const presentation = content.presentation;
  if (!isRecord(presentation)) return null;
  const nodeLabels = presentation.nodeLabels;
  if (!isRecord(nodeLabels)) return null;
  const labels: Record<string, string> = {};
  for (const [id, label] of Object.entries(nodeLabels)) {
    if (typeof label === 'string' && label.trim() !== '') labels[id] = label;
  }
  return labels;
}

/** The consumer status word (§29: TeachingSession → Lesson). */
export function lessonStatusWord(status: string): string {
  switch (status) {
    case 'not_started':
      return 'Not started';
    case 'in_progress':
      return 'In lesson';
    case 'paused':
      return 'Paused';
    case 'completed':
      return 'Lesson complete';
    default:
      return status;
  }
}

/** The injected-clock ms timestamp → a plain date string (no wall clock). */
export function formatLessonTime(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

interface StepShape {
  nodeId?: unknown;
  position?: unknown;
  explanation?: unknown;
  disclosures?: unknown;
  manualInstruction?: unknown;
  uncertainty?: unknown;
  safety?: unknown;
  safetyNotice?: unknown;
  actionability?: unknown;
}

/** One lesson step's view (the authoritative derived lesson, read-only). */
export interface LessonStepView {
  nodeId: string;
  position: number;
  explanation: string;
  hasHumanSemanticsDisclosure: boolean;
}

/** The steps from the derived lesson, in the lesson's own order. */
export function lessonStepsFromSession(session: { lesson?: unknown }): LessonStepView[] {
  if (!isRecord(session.lesson) || !Array.isArray(session.lesson.steps)) return [];
  const steps: LessonStepView[] = [];
  for (const step of session.lesson.steps) {
    if (!isRecord(step)) continue;
    const s = step as StepShape;
    if (typeof s.nodeId !== 'string') continue;
    steps.push({
      nodeId: s.nodeId,
      position: typeof s.position === 'number' ? s.position : steps.length + 1,
      explanation: typeof s.explanation === 'string' ? s.explanation : '',
      hasHumanSemanticsDisclosure:
        Array.isArray(s.disclosures) &&
        s.disclosures.some(
          (d) =>
            isRecord(d) &&
            (d as { field?: unknown }).field === 'step_human_readable_semantics',
        ),
    });
  }
  return steps;
}

/**
 * The step's display name: the V2-003 presentation label, honestly
 * degraded to "Step N" — NEVER the internal node ID (F-T4-001).
 */
export function stepLabel(labels: Record<string, string> | null, nodeId: string, position: number): string {
  return labels?.[nodeId] ?? `Step ${position}`;
}

/** The reverse-teaching step view (the manual-task framing, read-only). */
export interface ReverseStepView {
  nodeId: string;
  position: number;
  manualInstruction: string;
  safetyGated: boolean;
  safetyNotice: string | null;
  /** The authority's actionability — decides the expected manual mode. */
  actionability: string;
}

export function reverseStepsFromSession(session: { lesson?: unknown }): ReverseStepView[] {
  if (!isRecord(session.lesson) || !Array.isArray(session.lesson.steps)) return [];
  const steps: ReverseStepView[] = [];
  for (const step of session.lesson.steps) {
    if (!isRecord(step)) continue;
    const s = step as StepShape;
    if (typeof s.nodeId !== 'string') continue;
    steps.push({
      nodeId: s.nodeId,
      position: typeof s.position === 'number' ? s.position : steps.length + 1,
      manualInstruction: typeof s.manualInstruction === 'string' ? s.manualInstruction : '',
      safetyGated: s.safety === 'safety_gated',
      safetyNotice: typeof s.safetyNotice === 'string' ? s.safetyNotice : null,
      actionability: typeof s.actionability === 'string' ? s.actionability : '',
    });
  }
  return steps;
}

/**
 * The expected manual mode (the authority's own rule, mirrored for
 * presentation): system_performed / subworkflow_reference steps are
 * acknowledged (the workflow does them); human_declared / agent_task
 * steps are performed by the learner.
 */
export function expectedManualModeOf(step: ReverseStepView): 'performed' | 'acknowledged_disclosure' {
  return step.actionability === 'system_performed' || step.actionability === 'subworkflow_reference'
    ? 'acknowledged_disclosure'
    : 'performed';
}

/**
 * The honest disclosure phrasing for the authority's own
 * NOT_SPECIFIED gaps (§13 — disclose, never invent).
 */
export const SEMANTICS_DISCLOSURE_PHRASE =
  "the workflow doesn't specify this step's readable semantics — the lesson shows what it declares";
