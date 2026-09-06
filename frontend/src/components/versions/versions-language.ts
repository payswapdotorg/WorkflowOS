/**
 * V2-017 T11 - the versions/updates/improvements vocabulary (Issue #202).
 *
 * PURE presentation functions over the V2-011/V2-002 transport wire
 * shapes. This module NEVER re-derives analysis, comparisons, proposals
 * or version facts - it renders the authority's own facts in consumer
 * language (UX 19/20 + 29: "Optimization proposal -> Improvement",
 * "Maintenance update -> Update available"). Internal node IDs never
 * render (the V2-003 presentation labels are the step names - F-T4-001);
 * the modeled rubric deltas are presented as ESTIMATES, never
 * measurements (UX 20: "each proposal explains what trade-offs exist").
 */

import type {
  ProductVersionComparison,
  ProductCriterionDelta,
} from '../../api/client';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const IR_OBJECT_TYPE = 'workflowos/workflow-ir/v1';

/** The nodeLabels map from the authoritative V2-003 presentation layer. */
export function nodeLabelsFromContent(content: unknown): Record<string, string> | null {
  if (!isRecord(content)) return null;
  const objectType = content.objectType;
  if (typeof objectType !== 'string' || objectType !== IR_OBJECT_TYPE) return null;
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

/** The consumer step name for a node id (fail-closed to null - F-T4-001). */
export function stepLabel(labels: Record<string, string> | null, nodeId: string): string | null {
  const label = labels?.[nodeId];
  return typeof label === 'string' && label.trim() !== '' ? label : null;
}

/** The 20-recommendation headline for one opportunity kind. */
export function improvementHeadline(kind: string): string {
  if (kind === 'api_substitution') return 'Make it more reliable and faster';
  if (kind === 'workflow_reuse') return 'Reuse the duplicated steps';
  return 'Improvement';
}

/** The 20-recommendation detail for one opportunity (declared facts only). */
export function improvementDetail(opportunity: {
  kind: string;
  apiCapability?: string;
}): string {
  if (opportunity.kind === 'api_substitution' && opportunity.apiCapability) {
    return `Replace the agent-driven step with the direct ${opportunity.apiCapability} API call.`;
  }
  return 'Reference one shared version instead of duplicating the steps.';
}

/**
 * The correctness verdict line (19/20 - correctness FIRST, verbatim honest).
 *
 * REALITY-REPAIR-009 (F-010): the verdict stays the authority's own word —
 * the raw firstDivergence transport string is NO LONGER embedded here (it
 * rendered as `Not equivalent: node collect_posts inputs: [{…}] != [{…}]`);
 * the WHERE-the-versions-differ detail is carried by versionDiffSummary
 * below, which re-presents the SAME payload readably.
 */
export function correctnessLine(comparison: ProductVersionComparison): string {
  if (comparison.correctness?.equivalent) {
    return 'Task-for-task equivalent - verified';
  }
  return 'Not equivalent';
}

/** The compatibility line from the V2-003 negotiation decision. */
export function compatibilityLine(comparison: ProductVersionComparison): string {
  const decision = comparison.negotiation?.decision;
  if (decision === 'accept') return 'No change to what the workflow does';
  if (decision === 'upgrade') return 'Adds behavior without changing what it does';
  if (decision === 'reject') return 'Incompatible change - rejected';
  return 'Compatibility not classified';
}

function scoreLine(name: string, delta: ProductCriterionDelta | undefined): string | null {
  if (!delta || typeof delta.baseline !== 'number' || typeof delta.candidate !== 'number') {
    return null;
  }
  return `${name} estimated score ${delta.baseline} to ${delta.candidate}`;
}

/**
 * The trade-off lines from the modeled rubric (20: "what trade-offs
 * exist"). Lower is better for every criterion; a WORSE candidate score
 * renders verbatim (the honest trade-off - reliability can honestly
 * worsen for reuse).
 */
export function tradeOffLines(comparison: ProductVersionComparison): string[] {
  const lines: string[] = [];
  const push = (line: string | null) => {
    if (line) lines.push(line);
  };
  push(scoreLine('Speed', comparison.latency));
  push(scoreLine('Cost', comparison.cost));
  push(scoreLine('Reliability', comparison.reliability));
  push(scoreLine('Maintenance', comparison.maintenance));
  return lines;
}

/** The single honest estimates note (modeled rubric - never measurements). */
export const ESTIMATES_NOTE =
  'Lower scores are better - these are modeled estimates, not measurements.';

// ----------------------------------------------------------------------------
// REALITY-REPAIR-009 (F-010) — the human-readable version diff
//
// The V2-011 comparison payload is THE input; this presentation layer NEVER
// re-derives, re-scores or re-classifies the comparison. The payload's own
// firstDivergence string is emitted deterministically by the comparison
// authority (backend workflow-optimization/internal/comparison.ts
// firstTaskSurfaceDivergence) in exactly one grammar:
//
//     <surface>: <baseline JSON> != <candidate JSON>
//
// with the surface being one of: `start`, `workflow inputs`,
// `workflow outputs`, `node ids`, `node <id> <field>`, `node <id>`,
// `edges`, `human node <id> spec`, `human nodes`. The functions below PARSE
// that grammar (the payload's own structure is the source of truth; render
// it) and re-present it as consumer words: node/field names through the
// V2-003 presentation labels, values as readable names-and-values — never
// the raw internal JSON envelope. A divergence the grammar does not carry
// degrades honestly (undescribed), and equivalence stays the payload's own
// boolean.
// ----------------------------------------------------------------------------

/** The outcome of re-presenting the payload's divergence for §19/§20. */
export type VersionDiffSummary =
  /** nothing to describe (equivalent, or the payload carries no divergence) */
  | { readonly kind: 'none' }
  | {
      readonly kind: 'described';
      /** where the versions differ, in consumer words */
      readonly headline: string;
      /** the baseline value, readable */
      readonly baseline: string;
      /** the candidate value, readable */
      readonly candidate: string;
    }
  /** the payload's divergence string is not describable against its own grammar */
  | { readonly kind: 'undescribed' };

/** The per-node task-surface fields the comparison authority reports. */
type DivergenceField =
  | 'inputs'
  | 'outputs'
  | 'failurePolicy'
  | 'placement'
  | 'completionEvidence';

/** The field word for one divergent per-node field (consumer vocabulary). */
const FIELD_WORDS: Record<DivergenceField, string> = {
  inputs: 'its inputs',
  outputs: 'its outputs',
  failurePolicy: 'its failure policy',
  placement: 'its placement',
  completionEvidence: 'its completion evidence',
};

/** One head form of the payload's divergence grammar (in match order). */
interface DivergenceHead {
  readonly re: RegExp;
  readonly kind:
    | 'start'
    | 'workflow-inputs'
    | 'workflow-outputs'
    | 'node-ids'
    | 'node-field'
    | 'node-whole'
    | 'edges'
    | 'human-node-spec'
    | 'human-nodes';
  readonly nodeGroup: 1 | null;
  readonly fieldGroup: 2 | null;
}

/**
 * The payload's own head grammar (backend firstTaskSurfaceDivergence), with
 * node ids matching the IR identifier pattern (workflow-ir validate.ts).
 * Longest/most-specific forms first: `node <id> <field>:` before `node <id>:`.
 */
const DIVERGENCE_HEADS: readonly DivergenceHead[] = [
  { re: /^start: /, kind: 'start', nodeGroup: null, fieldGroup: null },
  { re: /^workflow inputs: /, kind: 'workflow-inputs', nodeGroup: null, fieldGroup: null },
  { re: /^workflow outputs: /, kind: 'workflow-outputs', nodeGroup: null, fieldGroup: null },
  { re: /^node ids: /, kind: 'node-ids', nodeGroup: null, fieldGroup: null },
  {
    re: /^node ([A-Za-z][A-Za-z0-9_-]*) (inputs|outputs|failurePolicy|placement|completionEvidence): /,
    kind: 'node-field',
    nodeGroup: 1,
    fieldGroup: 2,
  },
  { re: /^node ([A-Za-z][A-Za-z0-9_-]*): /, kind: 'node-whole', nodeGroup: 1, fieldGroup: null },
  { re: /^edges: /, kind: 'edges', nodeGroup: null, fieldGroup: null },
  {
    re: /^human node ([A-Za-z][A-Za-z0-9_-]*) spec: /,
    kind: 'human-node-spec',
    nodeGroup: 1,
    fieldGroup: null,
  },
  { re: /^human nodes: /, kind: 'human-nodes', nodeGroup: null, fieldGroup: null },
];

/** The payload's own separator between the baseline and candidate values. */
const SEPARATOR = ' != ';

/** The parsed halves of the payload's divergence string. */
interface ParsedDivergence {
  readonly kind: DivergenceHead['kind'];
  readonly nodeId: string | null;
  readonly field: DivergenceField | null;
  readonly baseline: unknown;
  readonly candidate: unknown;
}

/**
 * The first ` != ` outside any JSON string (the payload's own separator —
 * a ` != ` inside a JSON string value stays inside the value). Node ids and
 * field words cannot contain the separator (the IR identifier pattern).
 */
function findSeparator(text: string): number {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (text.startsWith(SEPARATOR, i)) return i;
  }
  return -1;
}

/**
 * Parse the payload's own divergence string. Returns null when the string
 * does not match its own grammar or its values are not the JSON the
 * authority serializes — the honest undescribed state (never a guess).
 */
function parseDivergence(text: string): ParsedDivergence | null {
  for (const head of DIVERGENCE_HEADS) {
    const match = head.re.exec(text);
    if (!match) continue;
    const rest = text.slice(match[0].length);
    const sep = findSeparator(rest);
    if (sep < 0) return null;
    const baselineText = rest.slice(0, sep);
    const candidateText = rest.slice(sep + SEPARATOR.length);
    if (head.kind === 'start') {
      // the start surface carries bare node ids, not JSON — they render
      // through the presentation labels downstream
      return {
        kind: head.kind,
        nodeId: null,
        field: null,
        baseline: baselineText,
        candidate: candidateText,
      };
    }
    try {
      return {
        kind: head.kind,
        nodeId: head.nodeGroup !== null ? (match[head.nodeGroup] ?? null) : null,
        field:
          head.fieldGroup !== null
            ? ((match[head.fieldGroup] as DivergenceField | undefined) ?? null)
            : null,
        baseline: JSON.parse(baselineText) as unknown,
        candidate: JSON.parse(candidateText) as unknown,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** One JSON value's entries in consumer words (recursively readable). */
function readableEntries(value: Record<string, unknown>): string {
  const entries = Object.entries(value);
  if (entries.length === 0) return 'empty';
  return entries
    .map(([name, entry]) => {
      if (isRecord(entry)) return `${name} (${readableEntries(entry)})`;
      return `${name}: ${readableValue(entry)}`;
    })
    .join(', ');
}

/**
 * One JSON value in consumer words — names and values, never the raw
 * internal JSON envelope (no quote-braced blobs, no `!=` separators).
 */
function readableValue(value: unknown): string {
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    return value.map((entry) => readableValue(entry)).join(' · ');
  }
  if (isRecord(value)) return readableEntries(value);
  return String(value);
}

/** The consumer step name for a node id (an unresolvable id degrades honestly). */
function stepWord(labels: Record<string, string> | null, nodeId: unknown): string {
  if (typeof nodeId === 'string') return stepLabel(labels, nodeId) ?? 'an unnamed step';
  return readableValue(nodeId);
}

/** One control edge of the payload (`from->to on "success"`) in consumer words. */
function edgeWord(labels: Record<string, string> | null, entry: unknown): string {
  if (typeof entry !== 'string') return readableValue(entry);
  const match = /^(\S+)->(\S+) on (.+)$/.exec(entry);
  if (!match) return entry;
  let trigger = match[3]!;
  if (trigger.startsWith('"') || trigger.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trigger);
      if (typeof parsed === 'string') trigger = parsed;
      else if (isRecord(parsed) && typeof parsed.outcome === 'string') trigger = parsed.outcome;
    } catch {
      // not the payload's JSON — keep its own text
    }
  }
  return `${stepWord(labels, match[1])} → ${stepWord(labels, match[2])} (on ${trigger})`;
}

/**
 * The §19/§20 "Where the versions differ" summary: a derivation OVER the
 * V2-011 comparison payload (its own firstDivergence string is parsed, its
 * own values are re-presented) — the comparison result itself is never
 * recomputed, re-scored or re-classified here.
 */
export function versionDiffSummary(
  comparison: ProductVersionComparison,
  labels: Record<string, string> | null,
): VersionDiffSummary {
  if (comparison.correctness?.equivalent) return { kind: 'none' };
  const firstDivergence = comparison.correctness?.firstDivergence;
  if (typeof firstDivergence !== 'string' || firstDivergence === '') {
    return { kind: 'none' };
  }
  const parsed = parseDivergence(firstDivergence);
  if (parsed === null) return { kind: 'undescribed' };
  switch (parsed.kind) {
    case 'start':
      return {
        kind: 'described',
        headline: 'where the workflow starts',
        baseline: stepWord(labels, parsed.baseline),
        candidate: stepWord(labels, parsed.candidate),
      };
    case 'workflow-inputs':
      return {
        kind: 'described',
        headline: "the workflow's inputs",
        baseline: readableValue(parsed.baseline),
        candidate: readableValue(parsed.candidate),
      };
    case 'workflow-outputs':
      return {
        kind: 'described',
        headline: "the workflow's outputs",
        baseline: readableValue(parsed.baseline),
        candidate: readableValue(parsed.candidate),
      };
    case 'node-ids': {
      const stepList = (value: unknown): string =>
        Array.isArray(value) ? value.map((id) => stepWord(labels, id)).join(', ') : readableValue(value);
      return {
        kind: 'described',
        headline: 'the set of steps',
        baseline: stepList(parsed.baseline),
        candidate: stepList(parsed.candidate),
      };
    }
    case 'node-field':
      return {
        kind: 'described',
        headline: `the step "${stepWord(labels, parsed.nodeId)}" — ${
          parsed.field !== null ? FIELD_WORDS[parsed.field] : 'its definition'
        }`,
        baseline: readableValue(parsed.baseline),
        candidate: readableValue(parsed.candidate),
      };
    case 'node-whole':
      return {
        kind: 'described',
        headline: `the step "${stepWord(labels, parsed.nodeId)}" — its definition`,
        baseline: readableValue(parsed.baseline),
        candidate: readableValue(parsed.candidate),
      };
    case 'edges': {
      const edgeList = (value: unknown): string =>
        Array.isArray(value) ? value.map((entry) => edgeWord(labels, entry)).join(', ') : readableValue(value);
      return {
        kind: 'described',
        headline: 'the connections between the steps',
        baseline: edgeList(parsed.baseline),
        candidate: edgeList(parsed.candidate),
      };
    }
    case 'human-node-spec':
      return {
        kind: 'described',
        headline: `the human step "${stepWord(labels, parsed.nodeId)}" — its instructions`,
        baseline: readableValue(parsed.baseline),
        candidate: readableValue(parsed.candidate),
      };
    case 'human-nodes':
      return {
        kind: 'described',
        headline: 'the human steps',
        baseline: readableValue(parsed.baseline),
        candidate: readableValue(parsed.candidate),
      };
  }
}

/** The proposal status word (20: the approval gate state). */
export function proposalStatusWord(status: string): string {
  if (status === 'proposed') return 'Proposed';
  if (status === 'approved') return 'Approved - not created yet';
  if (status === 'rejected') return 'Rejected';
  if (status === 'materialized') return 'Created as a new version';
  return status;
}
