import { describe, expect, it } from 'vitest';
import type { ProductVersionComparison } from '../../api/client';
import { correctnessLine, tradeOffLines, versionDiffSummary } from './versions-language';

describe('V2-017 T11 — modeled trade-off wording', () => {
  it('labels rubric scores as estimates rather than measurements', () => {
    const comparison = {
      latency: { baseline: 3, candidate: 2 },
    } as ProductVersionComparison;

    expect(tradeOffLines(comparison)).toEqual(['Speed estimated score 3 to 2']);
  });
});

// --- REALITY-REPAIR-009 (F-010): the divergence summary derived OVER the
// V2-011 comparison payload. The payload's own firstDivergence grammar
// (backend comparison.ts firstTaskSurfaceDivergence):
// `<surface>: <baseline JSON> != <candidate JSON>` — every head form
// pinned below, plus the honesty edges (equivalence preserved, unknown
// grammar undescribed, ` != ` inside JSON string values).
//
// These are PURE presentation tests: the comparison result is the input;
// nothing here is re-derived, re-scored or re-classified.

const LABELS: Record<string, string> = {
  collect_posts: 'Collect the posts',
  send_report: 'Email the report',
  approve_report: 'Approve the digest',
};

function nonEquivalent(firstDivergence: string | null): ProductVersionComparison {
  return {
    correctness: { equivalent: firstDivergence === null, firstDivergence },
  } as ProductVersionComparison;
}

describe('REALITY-REPAIR-009 (F-010) — the version diff summary over the V2-011 payload', () => {
  it('correctnessLine keeps the authority verdicts verbatim (no raw transport string)', () => {
    const raw = 'node collect_posts inputs: [{"name":"source"}] != [{"name":"source2"}]';
    expect(correctnessLine({ correctness: { equivalent: true, firstDivergence: null } } as ProductVersionComparison)).toBe(
      'Task-for-task equivalent - verified',
    );
    expect(correctnessLine(nonEquivalent(raw))).toBe('Not equivalent');
    expect(
      correctnessLine({ correctness: { equivalent: false, firstDivergence: null } } as ProductVersionComparison),
    ).toBe('Not equivalent');
  });

  it('a node-field divergence renders the step name (the presentation label) + the field + readable values', () => {
    const summary = versionDiffSummary(
      nonEquivalent(
        'node collect_posts inputs: [{"name":"source","type":{"kind":"string"},"binding":{"kind":"literal","value":"trigger.feed"}}] != [{"name":"source","type":{"kind":"string"},"binding":{"kind":"literal","value":"trigger.feed"}},{"name":"limit","type":{"kind":"number"},"binding":{"kind":"literal","value":10}}]',
      ),
      LABELS,
    );
    expect(summary).toEqual({
      kind: 'described',
      headline: 'the step "Collect the posts" — its inputs',
      baseline: 'name: source, type (kind: string), binding (kind: literal, value: trigger.feed)',
      candidate:
        'name: source, type (kind: string), binding (kind: literal, value: trigger.feed) · name: limit, type (kind: number), binding (kind: literal, value: 10)',
    });
  });

  it('every per-node field word renders (the comparison authority\'s own field set)', () => {
    for (const [field, word] of [
      ['inputs', 'its inputs'],
      ['outputs', 'its outputs'],
      ['failurePolicy', 'its failure policy'],
      ['placement', 'its placement'],
      ['completionEvidence', 'its completion evidence'],
    ] as const) {
      const summary = versionDiffSummary(
        nonEquivalent(`node send_report ${field}: {"a":1} != {"a":2}`),
        LABELS,
      );
      expect(summary).toMatchObject({
        kind: 'described',
        headline: `the step "Email the report" — ${word}`,
      });
    }
  });

  it('a workflow-level divergence renders its surface and readable values', () => {
    const summary = versionDiffSummary(
      nonEquivalent(
        'workflow inputs: [{"name":"topic","type":{"kind":"string"}}] != [{"name":"topic","type":{"kind":"string"}},{"name":"depth","type":{"kind":"number"}}]',
      ),
      null,
    );
    expect(summary).toMatchObject({
      kind: 'described',
      headline: "the workflow's inputs",
      baseline: 'name: topic, type (kind: string)',
      candidate: 'name: topic, type (kind: string) · name: depth, type (kind: number)',
    });

    const outputs = versionDiffSummary(
      nonEquivalent('workflow outputs: [] != [{"name":"digest"}]'),
      null,
    );
    expect(outputs).toMatchObject({
      kind: 'described',
      headline: "the workflow's outputs",
      baseline: 'none',
      candidate: 'name: digest',
    });
  });

  it('the start divergence maps BOTH node ids through the presentation labels', () => {
    const summary = versionDiffSummary(nonEquivalent('start: collect_posts != send_report'), LABELS);
    expect(summary).toEqual({
      kind: 'described',
      headline: 'where the workflow starts',
      baseline: 'Collect the posts',
      candidate: 'Email the report',
    });
  });

  it('a node-set divergence lists the step names (never the raw ids)', () => {
    const summary = versionDiffSummary(
      nonEquivalent('node ids: ["collect_posts","send_report"] != ["collect_posts"]'),
      LABELS,
    );
    expect(summary).toEqual({
      kind: 'described',
      headline: 'the set of steps',
      baseline: 'Collect the posts, Email the report',
      candidate: 'Collect the posts',
    });
  });

  it('an edges divergence renders readable edge lines (the triggers unquoted)', () => {
    // the payload's own serialization (backend jsonOf = JSON.stringify of the
    // edge lines `${from}->${to} on ${JSON.stringify(on)}`)
    const edgeEntry = (from: string, to: string, on: unknown): string =>
      `${from}->${to} on ${JSON.stringify(on)}`;
    const divergence = `edges: ${JSON.stringify([
      edgeEntry('collect_posts', 'send_report', 'success'),
    ])} != ${JSON.stringify([
      edgeEntry('collect_posts', 'approve_report', 'success'),
      edgeEntry('approve_report', 'send_report', { outcome: 'approved' }),
    ])}`;
    const summary = versionDiffSummary(nonEquivalent(divergence), LABELS);
    expect(summary).toEqual({
      kind: 'described',
      headline: 'the connections between the steps',
      baseline: 'Collect the posts → Email the report (on success)',
      candidate:
        'Collect the posts → Approve the digest (on success), Approve the digest → Email the report (on approved)',
    });
  });

  it('a human-step spec divergence renders the instructions surface', () => {
    const summary = versionDiffSummary(
      nonEquivalent(
        'human node approve_report spec: {"kind":"approval","instruction":"Approve v1"} != {"kind":"approval","instruction":"Approve v2"}',
      ),
      LABELS,
    );
    expect(summary).toEqual({
      kind: 'described',
      headline: 'the human step "Approve the digest" — its instructions',
      baseline: 'kind: approval, instruction: Approve v1',
      candidate: 'kind: approval, instruction: Approve v2',
    });
    const fallback = versionDiffSummary(
      nonEquivalent('human nodes: {"a":1} != {"a":2}'),
      null,
    );
    expect(fallback).toMatchObject({ kind: 'described', headline: 'the human steps' });
  });

  it('a ` != ` INSIDE a JSON string value never splits the payload (the separator is outside strings only)', () => {
    const summary = versionDiffSummary(
      nonEquivalent(
        'node collect_posts inputs: [{"name":"query","binding":{"kind":"literal","value":"a != b"}}] != [{"name":"query","binding":{"kind":"literal","value":"a != c"}}]',
      ),
      LABELS,
    );
    expect(summary).toMatchObject({
      kind: 'described',
      baseline: 'name: query, binding (kind: literal, value: a != b)',
      candidate: 'name: query, binding (kind: literal, value: a != c)',
    });
  });

  it('scalar-shaped values render readably (a placement word, a policy object, null)', () => {
    const placement = versionDiffSummary(
      nonEquivalent('node send_report placement: "cloud_allowed" != "cloud_required"'),
      LABELS,
    );
    expect(placement).toMatchObject({
      kind: 'described',
      baseline: 'cloud_allowed',
      candidate: 'cloud_required',
    });
    const evidence = versionDiffSummary(
      nonEquivalent('node send_report completionEvidence: null != "observation"'),
      LABELS,
    );
    expect(evidence).toMatchObject({
      kind: 'described',
      baseline: 'not set',
      candidate: 'observation',
    });
    const policy = versionDiffSummary(
      nonEquivalent(
        'node send_report failurePolicy: {"strategy":"fail_workflow"} != {"strategy":"retry_then_fail_workflow","maxAttempts":2}',
      ),
      LABELS,
    );
    expect(policy).toMatchObject({
      kind: 'described',
      baseline: 'strategy: fail_workflow',
      candidate: 'strategy: retry_then_fail_workflow, maxAttempts: 2',
    });
  });

  it('an unresolvable node id degrades honestly (never the raw id — F-T4-001)', () => {
    const summary = versionDiffSummary(
      nonEquivalent('node unknown_step inputs: [{"name":"a"}] != [{"name":"b"}]'),
      LABELS,
    );
    expect(summary).toMatchObject({
      kind: 'described',
      headline: 'the step "an unnamed step" — its inputs',
    });
  });

  it('a divergence the payload grammar does not describe is UNDESCRIBED — never guessed, never raw', () => {
    expect(versionDiffSummary(nonEquivalent('future-shape: {"x":1} != {"x":2}'), LABELS)).toEqual({
      kind: 'undescribed',
    });
    expect(
      versionDiffSummary(nonEquivalent('node collect_posts inputs: not-json != also-not-json'), LABELS),
    ).toEqual({ kind: 'undescribed' });
  });

  it('equivalence stays equivalence — no divergence summary for an equivalent payload', () => {
    expect(
      versionDiffSummary({ correctness: { equivalent: true, firstDivergence: null } } as ProductVersionComparison, LABELS),
    ).toEqual({ kind: 'none' });
  });
});
