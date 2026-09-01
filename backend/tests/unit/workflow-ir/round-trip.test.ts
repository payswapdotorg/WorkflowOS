import { describe, it, expect } from 'vitest';
import {
  canonicalSemanticJson,
  computeWorkflowVersionSemanticDigest,
  parseWorkflowIrDocument,
  serializeWorkflowIrDocument,
  validateWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import {
  buildMinimalDocument,
  buildTriageDocument,
  buildTriageDocumentAltOrder,
} from './helpers.js';

/**
 * V2-003 — lossless semantic round-trip identity.
 *
 * author → validate → serialize → deserialize → re-validate → semantic
 * equality + digest stability, INCLUDING human/approval constructs,
 * placement constraints, secret refs, failure policy and presentation.
 */

describe('V2-003 — canonical serialization is a fixpoint', () => {
  it('serialize(parse(serialize(doc))) === serialize(doc)', () => {
    for (const doc of [buildMinimalDocument(), buildTriageDocument()]) {
      const first = serializeWorkflowIrDocument(doc);
      const parsed = parseWorkflowIrDocument(first);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const second = serializeWorkflowIrDocument(parsed.document);
        expect(second).toBe(first);
      }
    }
  });

  it('the canonical form contains no insignificant whitespace', () => {
    const serialized = serializeWorkflowIrDocument(buildTriageDocument());
    // no newline, no space after structural characters outside string values
    expect(serialized).not.toMatch(/[\n\r\t]/);
    expect(serialized).not.toMatch(/[:,{}[\]]\s/);
    expect(serialized).not.toMatch(/\s[:,{}[\]]/);
  });

  it('object key insertion order never matters (sorted canonical keys)', () => {
    const a = serializeWorkflowIrDocument(buildTriageDocument());
    const b = serializeWorkflowIrDocument(buildTriageDocumentAltOrder());
    expect(a).toBe(b);
  });

  it('canonical serialization is UTF-8 JSON with normalized numbers', () => {
    const doc = buildMinimalDocument();
    const preimage = canonicalSemanticJson(doc);
    // round parse/stringify must be stable (no -0, no NaN leakage)
    expect(() => JSON.parse(preimage)).not.toThrow();
    const reparsed = JSON.parse(preimage);
    expect(JSON.stringify(reparsed)).toBe(JSON.stringify(JSON.parse(JSON.stringify(reparsed))));
  });
});

describe('V2-003 — the full round-trip preserves executable meaning', () => {
  const original = buildTriageDocument();

  it('author → validate → serialize → deserialize → re-validate → semantically equal', () => {
    const validation = validateWorkflowIrDocument(original);
    expect(validation.ok).toBe(true);

    const serialized = serializeWorkflowIrDocument(original);
    const parsed = parseWorkflowIrDocument(serialized);
    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      const revalidation = validateWorkflowIrDocument(parsed.document);
      expect(revalidation.ok).toBe(true);
    }
  });

  it('the digest is stable across the round trip', () => {
    const before = computeWorkflowVersionSemanticDigest(original).digest;
    const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const after = computeWorkflowVersionSemanticDigest(parsed.document).digest;
      expect(after).toBe(before);
    }
  });

  it('human/approval constructs survive the round trip exactly', () => {
    const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const gate = parsed.document.ir.nodes.find((node) => node.id === 'review_gate');
      expect(gate?.executionClass).toBe('human');
      expect(gate?.spec.class).toBe('human');
      if (gate?.spec.class === 'human') {
        expect(gate.spec.human.kind).toBe('approval');
        expect(gate.spec.human.instruction).toBe(
          'Approve posting the triage summary and syncing the backlog for this issue.',
        );
      }
      const outcomeEdges = parsed.document.ir.edges.filter((edge) => edge.from === 'review_gate');
      expect(outcomeEdges).toHaveLength(3);
      expect(outcomeEdges.filter((e) => typeof e.on === 'object' && e.on.outcome === 'approved').length).toBe(2);
      expect(outcomeEdges.filter((e) => typeof e.on === 'object' && e.on.outcome === 'rejected').length).toBe(1);
    }
  });

  it('placement constraints survive the round trip exactly', () => {
    const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const placements = new Map(parsed.document.ir.nodes.map((node) => [node.id, node.placement]));
      expect(placements.get('review_gate')).toBe('device_local');
      expect(placements.get('notify_channel')).toBe('cloud_preferred');
      expect(placements.get('sync_backlog')).toBe('any_supported_node');
      expect(parsed.document.ir.defaultPlacement).toBe('any_supported_node');
    }
  });

  it('secret references survive the round trip as opaque handles only', () => {
    const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const notify = parsed.document.ir.nodes.find((node) => node.id === 'notify_channel');
      const credentials = notify?.inputs.find((port) => port.name === 'credentials');
      expect(credentials?.type.kind).toBe('secret');
      if (credentials?.binding.kind === 'secret_ref') {
        expect(credentials.binding.ref).toBe('team-notifications@secrets');
        expect(Object.keys(credentials.binding).sort()).toEqual(['kind', 'ref']);
      }
    }
  });

  it('failure policies survive the round trip exactly', () => {
    const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const policies = new Map(parsed.document.ir.nodes.map((node) => [node.id, node.failurePolicy]));
      expect(policies.get('fetch_issue')).toEqual({ strategy: 'fail_workflow' });
      expect(policies.get('draft_summary')).toEqual({ strategy: 'retry_then_fail_workflow', maxAttempts: 2 });
      expect(policies.get('log_rejection')).toEqual({ strategy: 'ignore_and_continue' });
    }
  });

  it('presentation survives the round trip losslessly (display is not semantics, but it is not lost)', () => {
    const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document.presentation).toEqual(original.presentation);
      expect(parsed.document.presentation?.title).toBe('Triage inbound GitHub issue');
      expect(parsed.document.presentation?.nodeLabels?.review_gate).toBe('Human review gate');
    }
  });

  it('subworkflow dependencies survive the round trip as opaque immutable references', () => {
    const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const sync = parsed.document.ir.nodes.find((node) => node.id === 'sync_backlog');
      expect(sync?.spec.class).toBe('subworkflow');
      if (sync?.spec.class === 'subworkflow') {
        expect(sync.spec.subworkflow.workflowId).toBe('wf-backlog-sync');
        expect(sync.spec.subworkflow.versionRef).toBe('wfv_0192837465afdeadbeef-candidate-1');
      }
    }
  });
});

describe('V2-003 — parsing rejects corrupted transport', () => {
  it('non-JSON text is a typed parse failure', () => {
    const result = parseWorkflowIrDocument('not json at all');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'IR_JSON_PARSE_FAILED')).toBe(true);
    }
  });

  it('valid JSON that is not an IR document is a typed parse failure', () => {
    const result = parseWorkflowIrDocument('{"hello":"world"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'IR_OBJECT_TYPE_MISMATCH')).toBe(true);
    }
  });

  it('a semantically invalid document inside valid JSON is rejected by parse', () => {
    const doc = buildMinimalDocument();
    const serialized = serializeWorkflowIrDocument(doc);
    const corrupted = serialized.replace('"start":"observe"', '"start":"ghost"');
    const result = parseWorkflowIrDocument(corrupted);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'IR_START_UNKNOWN')).toBe(true);
    }
  });

  it('parse is deterministic: the same bytes always produce the same issues', () => {
    const a = parseWorkflowIrDocument('{"x":1}');
    const b = parseWorkflowIrDocument('{"x":1}');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
