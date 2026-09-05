/**
 * V2-017 T7 — the failure/recovery vocabulary (Issue #197).
 *
 * PURE presentation functions over the V2-005 run history wire shapes
 * (the crash-recovery projection). This module NEVER derives "why it
 * failed" beyond the recorded facts (the timeline's failure reason, the
 * step outcomes, the attempt count), NEVER fabricates recovery
 * guarantees, and NEVER surfaces internal step identifiers — the ✓/✕
 * lines carry the V2-003 presentation labels (F-T4-001 discipline);
 * unlabeled steps degrade to honest generic lines.
 *
 * UX §18 contract: failures answer what is known, what is unknown, and
 * what the user can do next — "we do not know" is never replaced by
 * "nothing happened" (§2.5).
 */

export const RECOVERY_FAILED_SENTENCE = 'I couldn\u2019t finish this.';
export const RECOVERY_CANCELLED_SENTENCE = 'It was cancelled.';
export const RECOVERY_NO_REASON_SENTENCE = 'What made it stop isn\u2019t recorded yet.';
export const RECOVERY_HISTORY_UNAVAILABLE =
  'What happened is unavailable — the execution history couldn\u2019t be loaded.';

const CHECK = '\u2713';
const CROSS = '\u2717';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The nodeLabels map from the authoritative V2-003 presentation layer
 * (document top level). null = no usable presentation (the caller
 * degrades honestly — never internal IDs).
 */
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

interface TimelineEntryShape {
  eventName?: unknown;
  sequence?: unknown;
  detail?: unknown;
}

/**
 * The recorded failure reason: the latest `workflow.run.failed`
 * timeline entry's detail.reason (the executor-reported reason — the
 * ONLY authoritative "why"; null = honestly unknown).
 */
export function failureReasonFromHistory(history: {
  timeline?: unknown;
}): string | null {
  return reasonFromTimeline(history, 'workflow.run.failed');
}

/** The recorded cancel reason (the `run.cancelled` timeline entry). */
export function cancelReasonFromHistory(history: { timeline?: unknown }): string | null {
  return reasonFromTimeline(history, 'run.cancelled');
}

function reasonFromTimeline(history: { timeline?: unknown }, eventName: string): string | null {
  if (!Array.isArray(history.timeline)) return null;
  const entries = history.timeline
    .filter((e): e is TimelineEntryShape => isRecord(e) && e.eventName === eventName)
    .sort((a, b) =>
      (typeof a.sequence === 'number' ? a.sequence : 0) -
      (typeof b.sequence === 'number' ? b.sequence : 0),
    );
  const last = entries[entries.length - 1];
  if (!last || !isRecord(last.detail)) return null;
  const reason = last.detail.reason;
  return typeof reason === 'string' && reason.trim() !== '' ? reason : null;
}

interface StepShape {
  stepId?: unknown;
  status?: unknown;
}

/**
 * The §18 "What I know" facts: the recorded step outcomes, in the
 * history's order — ✓ finished / ✕ failed, labeled from the V2-003
 * presentation layer. Only RECORDED outcomes appear (never a guess);
 * an unlabeled step degrades to an honest generic line (never the
 * internal step ID).
 */
export function knownFactsFromHistory(
  history: { steps?: unknown },
  labels: Record<string, string> | null,
): { text: string; outcome: 'completed' | 'failed' }[] {
  if (!Array.isArray(history.steps)) return [];
  const facts: { text: string; outcome: 'completed' | 'failed' }[] = [];
  for (const step of history.steps) {
    if (!isRecord(step)) continue;
    const record = step as StepShape;
    if (record.status !== 'completed' && record.status !== 'failed') continue;
    const stepId = typeof record.stepId === 'string' ? record.stepId : null;
    const label = stepId !== null ? labels?.[stepId] ?? null : null;
    const name =
      label ?? (record.status === 'completed' ? 'A step that finished' : 'A step that failed');
    facts.push({
      text: `${record.status === 'completed' ? CHECK : CROSS} ${name}`,
      outcome: record.status,
    });
  }
  return facts;
}

/**
 * The §18 "What we don't know yet" lines — ONLY honest unknowns:
 * steps that started but never recorded an outcome, and which step
 * failed when no failed step is recorded. Never fabricated specifics;
 * empty = the section is omitted (an honest absence of unknowns).
 */
export function unknownLinesFromHistory(
  history: { steps?: unknown; timeline?: unknown },
  labels: Record<string, string> | null,
): string[] {
  const lines: string[] = [];
  if (Array.isArray(history.steps)) {
    for (const step of history.steps) {
      if (!isRecord(step)) continue;
      const record = step as StepShape;
      if (record.status !== 'started') continue;
      const stepId = typeof record.stepId === 'string' ? record.stepId : null;
      const label = stepId !== null ? labels?.[stepId] ?? null : null;
      lines.push(`Whether ${label ?? 'a step'} finished`);
    }
  }
  if (Array.isArray(history.steps) && history.steps.length > 0) {
    const anyFailed = history.steps.some(
      (step) => isRecord(step) && (step as StepShape).status === 'failed',
    );
    if (!anyFailed) lines.push('Which step failed');
  }
  return lines;
}

/**
 * The expert-only recovery facts (Advanced details): the raw state
 * word, the run id, the attempt count, the trigger type, the start
 * instant — Level 3/4, never the primary language.
 */
export function advancedRecoveryFacts(
  run: { state: string; id: string; createdAt: string; trigger?: unknown },
  history: { attempts?: unknown },
): string[] {
  const trigger = isRecord(run.trigger) && typeof run.trigger.type === 'string' ? run.trigger.type : 'unknown';
  const attempts = Array.isArray(history.attempts) ? history.attempts.length : 0;
  return [
    `Run state: ${run.state}`,
    `Run id: ${run.id}`,
    `Attempts: ${attempts}`,
    `Trigger: ${trigger}`,
    `Started: ${run.createdAt}`,
  ];
}
