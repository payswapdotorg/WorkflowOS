import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalSemanticJson,
  computeWorkflowVersionSemanticDigest,
  serializeWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import {
  buildMinimalDocument,
  buildTriageDocument,
  buildTriageDocumentAltOrder,
  clone,
  withCompatibility,
  withEdge,
  withNode,
  withNodeInputs,
  withNodeOutputs,
  withPresentation,
} from './helpers.js';
import type { VersionAffectingCompatibility } from '../../../src/workflow-ir/index.js';

/**
 * V2-003 — the deterministic WorkflowVersion semantic digest battery.
 *
 * Same semantics → same digest. Presentation-only changes (display labels,
 * layout coordinates, key insertion order, whitespace) → SAME digest. Any
 * semantic change → DIFFERENT digest. The digest includes EXACTLY the
 * version-affecting compatibility metadata the schema declares and excludes
 * repository/marketplace/UX/deployment metadata.
 */

describe('V2-003 — same semantics → same digest', () => {
  it('repeated computation over the same document is byte-identical', () => {
    const doc = buildTriageDocument();
    const a = computeWorkflowVersionSemanticDigest(doc);
    const b = computeWorkflowVersionSemanticDigest(doc);
    expect(a.digest).toBe(b.digest);
    expect(a).toEqual(b);
  });

  it('an independently re-authored identical workflow yields the same digest', () => {
    const a = computeWorkflowVersionSemanticDigest(buildTriageDocument());
    const b = computeWorkflowVersionSemanticDigest(buildTriageDocumentAltOrder());
    expect(a.digest).toBe(b.digest);
  });

  it('the digest equals sha-256 over the exported canonical semantic preimage', () => {
    const doc = buildTriageDocument();
    const preimage = canonicalSemanticJson(doc);
    const expected = createHash('sha-256').update(preimage, 'utf8').digest('hex');
    expect(computeWorkflowVersionSemanticDigest(doc).digest).toBe(expected);
  });
});

describe('V2-003 — presentation-only changes keep the digest (registry: presentationExcluded)', () => {
  it('node display labels do not change the digest', () => {
    const base = buildTriageDocument();
    const relabeled = withPresentation(base, {
      title: 'Triage inbound GitHub issue',
      nodeLabels: { review_gate: 'A DIFFERENT display label', fetch_issue: 'Fetch it' },
      nodePositions: base.presentation?.nodePositions,
    });
    expect(computeWorkflowVersionSemanticDigest(relabeled).digest).toBe(
      computeWorkflowVersionSemanticDigest(base).digest,
    );
  });

  it('layout coordinates do not change the digest', () => {
    const base = buildTriageDocument();
    const moved = withPresentation(base, {
      title: 'Triage inbound GitHub issue',
      nodeLabels: base.presentation?.nodeLabels,
      nodePositions: { fetch_issue: { x: 9999, y: -12 }, draft_summary: { x: 0, y: 0 } },
    });
    expect(computeWorkflowVersionSemanticDigest(moved).digest).toBe(
      computeWorkflowVersionSemanticDigest(base).digest,
    );
  });

  it('removing the presentation entirely does not change the digest', () => {
    const base = buildTriageDocument();
    const stripped = withPresentation(base, undefined);
    expect(computeWorkflowVersionSemanticDigest(stripped).digest).toBe(
      computeWorkflowVersionSemanticDigest(base).digest,
    );
  });

  it('key insertion order and whitespace do not change the digest (canonical serialization)', () => {
    const a = computeWorkflowVersionSemanticDigest(buildTriageDocument());
    const b = computeWorkflowVersionSemanticDigest(buildTriageDocumentAltOrder());
    expect(a.digest).toBe(b.digest);
    // canonical serialization has no insignificant whitespace and no newlines
    const serialized = serializeWorkflowIrDocument(buildTriageDocument());
    expect(serialized).not.toContain('\n');
    expect(serializeWorkflowIrDocument(buildTriageDocument())).toBe(
      serializeWorkflowIrDocument(buildTriageDocumentAltOrder()),
    );
  });
});

describe('V2-003 — semantic changes change the digest (mutation discrimination)', () => {
  const baseline = buildTriageDocument();
  const baselineDigest = computeWorkflowVersionSemanticDigest(baseline).digest;

  it('adding an edge changes the digest', () => {
    const mutated = withEdge(baseline, { from: 'log_rejection', to: 'sync_backlog', on: 'success' });
    expect(computeWorkflowVersionSemanticDigest(mutated).digest).not.toBe(baselineDigest);
  });

  it('removing an edge changes the digest', () => {
    const mutated = clone(baseline);
    mutated.ir.edges = mutated.ir.edges.filter((edge) => !(edge.from === 'review_gate' && edge.to === 'log_rejection'));
    // careful: removing the rejected outcome makes the graph invalid, but the
    // digest is defined over the semantic object regardless of validity —
    // mutation discrimination must not depend on validation
    expect(computeWorkflowVersionSemanticDigest(mutated).digest).not.toBe(baselineDigest);
  });

  it('changing a binding source type changes the digest', () => {
    const mutated = withNodeInputs(baseline, 'notify_channel', [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'draft_summary', output: 'severity' },
      },
      {
        name: 'channel',
        type: { kind: 'string' },
        optional: true,
        binding: { kind: 'workflow_input', input: 'channel' },
      },
      {
        name: 'credentials',
        type: { kind: 'secret' },
        binding: { kind: 'secret_ref', ref: 'team-notifications@secrets' },
      },
    ]);
    expect(computeWorkflowVersionSemanticDigest(mutated).digest).not.toBe(baselineDigest);
  });

  it('changing an input port type changes the digest', () => {
    const mutated = withNodeInputs(baseline, 'sync_backlog', [
      {
        name: 'summary',
        type: { kind: 'json' },
        binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
      },
    ]);
    expect(computeWorkflowVersionSemanticDigest(mutated).digest).not.toBe(baselineDigest);
  });

  it('changing a capability requirement changes the digest', () => {
    const mutated = withNode(baseline, 'fetch_issue', {
      capabilityRequirements: ['github.repository.read', 'github.pull_request.create'],
    });
    expect(computeWorkflowVersionSemanticDigest(mutated).digest).not.toBe(baselineDigest);
  });

  it('changing the invoked capability changes the digest', () => {
    const mutated = withNode(baseline, 'log_rejection', {
      spec: { class: 'deterministic_api', capability: 'filesystem.read' },
      capabilityRequirements: ['filesystem.read'],
    });
    expect(computeWorkflowVersionSemanticDigest(mutated).digest).not.toBe(baselineDigest);
  });

  it('changing an execution class changes the digest', () => {
    const mutated = withNode(baseline, 'draft_summary', {
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
    });
    expect(computeWorkflowVersionSemanticDigest(mutated).digest).not.toBe(baselineDigest);
  });

  it('changing a failure policy changes the digest', () => {
    const mutated = withNode(baseline, 'log_rejection', {
      failurePolicy: { strategy: 'fail_workflow' },
    });
    expect(computeWorkflowVersionSemanticDigest(mutated).digest).not.toBe(baselineDigest);
  });

  it('changing a human approval instruction changes the digest', () => {
    const mutated = withNode(baseline, 'review_gate', {
      spec: {
        class: 'human',
        human: {
          kind: 'approval',
          instruction: 'Approve something entirely different.',
        },
      },
    });
    expect(computeWorkflowVersionSemanticDigest(mutated).digest).not.toBe(baselineDigest);
  });

  it('changing a placement constraint changes the digest', () => {
    const mutated = withNode(baseline, 'review_gate', { placement: 'cloud_allowed' });
    expect(computeWorkflowVersionSemanticDigest(mutated).digest).not.toBe(baselineDigest);
  });

  it('changing a secret reference changes the digest', () => {
    const mutated = withNodeInputs(baseline, 'notify_channel', [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
      },
      {
        name: 'channel',
        type: { kind: 'string' },
        optional: true,
        binding: { kind: 'workflow_input', input: 'channel' },
      },
      {
        name: 'credentials',
        type: { kind: 'secret' },
        binding: { kind: 'secret_ref', ref: 'other-vault-handle' },
      },
    ]);
    expect(computeWorkflowVersionSemanticDigest(mutated).digest).not.toBe(baselineDigest);
  });

  it('changing node outputs changes the digest', () => {
    const mutated = withNodeOutputs(baseline, 'draft_summary', [
      { name: 'summary', type: { kind: 'string' } },
      { name: 'severity', type: { kind: 'number' } },
    ]);
    expect(computeWorkflowVersionSemanticDigest(mutated).digest).not.toBe(baselineDigest);
  });

  it('changing provenance changes the digest (provenance is IR semantics per the work order)', () => {
    const mutated = clone(baseline);
    mutated.ir.provenance = { origin: 'compiled', sourceRefs: ['demo-session-1'] };
    expect(computeWorkflowVersionSemanticDigest(mutated).digest).not.toBe(baselineDigest);
  });
});

describe('V2-003 — the digest includes EXACTLY the declared version-affecting metadata', () => {
  it('changing the declared compatibility metadata changes the digest', () => {
    const base = buildMinimalDocument();
    const baseDigest = computeWorkflowVersionSemanticDigest(base).digest;
    const variants: VersionAffectingCompatibility[] = [
      { compatibilityLevel: 'compatible', inputSurfaceChange: 'none', outputSurfaceChange: 'none' },
      { compatibilityLevel: 'equivalent', inputSurfaceChange: 'additive', outputSurfaceChange: 'none' },
      { compatibilityLevel: 'equivalent', inputSurfaceChange: 'none', outputSurfaceChange: 'additive' },
      { compatibilityLevel: 'incompatible', inputSurfaceChange: 'breaking', outputSurfaceChange: 'none' },
    ];
    for (const compatibility of variants) {
      const mutated = withCompatibility(base, compatibility);
      expect(computeWorkflowVersionSemanticDigest(mutated).digest).not.toBe(baseDigest);
    }
  });

  it('the canonical preimage contains the compatibility metadata and excludes presentation', () => {
    const preimage = canonicalSemanticJson(buildTriageDocument());
    expect(preimage).toContain('"compatibilityLevel":"equivalent"');
    expect(preimage).toContain('"inputSurfaceChange":"none"');
    expect(preimage).toContain('"outputSurfaceChange":"none"');
    expect(preimage).not.toContain('Triage inbound GitHub issue');
    expect(preimage).not.toContain('nodeLabels');
    expect(preimage).not.toContain('nodePositions');
    expect(preimage).not.toContain('presentation');
  });

  it('the preimage carries no repository/marketplace/UX/deployment vocabulary', () => {
    const preimage = canonicalSemanticJson(buildTriageDocument());
    for (const forbidden of [
      '"ownerId"',
      '"forkCount"',
      '"stars"',
      '"pricing"',
      '"marketplace"',
      '"installedAt"',
      '"deployment"',
      '"repositoryMetadata"',
      '"tenantId"',
    ]) {
      expect(preimage).not.toContain(forbidden);
    }
  });

  it('changing only the serialization context (no semantic field) cannot change the digest', () => {
    // the digest input is the semantic projection; adding presentation never
    // leaks into it even when presentation carries long free text
    const base = buildMinimalDocument();
    const decorated = withPresentation(base, {
      title: 'x'.repeat(5000),
      notes: 'y'.repeat(5000),
      nodeLabels: { observe: 'z'.repeat(5000) },
    });
    expect(computeWorkflowVersionSemanticDigest(decorated).digest).toBe(
      computeWorkflowVersionSemanticDigest(base).digest,
    );
  });
});
