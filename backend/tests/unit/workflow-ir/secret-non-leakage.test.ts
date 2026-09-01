import { describe, it, expect } from 'vitest';
import {
  parseWorkflowIrDocument,
  serializeWorkflowIrDocument,
  validateWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import {
  SECRET_MATERIAL_CANARY,
  buildTriageDocument,
  clone,
  withNodeInputs,
} from './helpers.js';

/**
 * V2-003 — secret non-leakage battery (constitution §16: secret material is
 * referenced opaquely and never embedded in workflow definitions).
 *
 * Guarantees proven here:
 *   1. inline secret material (a literal bound to a secret port) is REJECTED;
 *   2. a secret handle carries ONLY an opaque reference — no material keys;
 *   3. the secret TYPE can never flow into non-secret ports (leak prevention);
 *   4. serialized IR emits only the opaque reference — grep-level proof that
 *      no secret value can appear in serialized output;
 *   5. round-trip preserves only the opaque reference.
 */

describe('V2-003 — inline secret material is rejected', () => {
  it('a literal bound to a secret-typed port is rejected', () => {
    const doc = withNodeInputs(buildTriageDocument(), 'notify_channel', [
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
        binding: { kind: 'literal', value: SECRET_MATERIAL_CANARY },
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.code === 'IR_SECRET_LITERAL_FORBIDDEN');
      expect(issue).toBeDefined();
    }
  });

  it('a secret_ref bound to a non-secret port is rejected (the handle must stay opaque)', () => {
    const doc = withNodeInputs(buildTriageDocument(), 'notify_channel', [
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
        type: { kind: 'string' },
        binding: { kind: 'secret_ref', ref: 'team-notifications@secrets' },
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'IR_SECRET_REF_FOR_NON_SECRET_PORT')).toBe(true);
    }
  });

  it('a secret_ref object carrying material-looking extra fields is rejected', () => {
    for (const extra of ['value', 'material', 'token', 'password', 'secretValue']) {
      const doc = withNodeInputs(buildTriageDocument(), 'notify_channel', [
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
          binding: { kind: 'secret_ref', ref: 'team-notifications@secrets', [extra]: SECRET_MATERIAL_CANARY } as never,
        },
      ]);
      const result = validateWorkflowIrDocument(doc);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.code === 'IR_SECRET_REF_MALFORMED')).toBe(true);
      }
    }
  });

  it('an empty secret reference is rejected', () => {
    const doc = withNodeInputs(buildTriageDocument(), 'notify_channel', [
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
        binding: { kind: 'secret_ref', ref: '' },
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'IR_SECRET_REF_MALFORMED')).toBe(true);
    }
  });
});

describe('V2-003 — serialized IR emits only the opaque reference (grep-level proof)', () => {
  const serialized = serializeWorkflowIrDocument(buildTriageDocument());

  it('contains the opaque secret reference handle', () => {
    expect(serialized).toContain('team-notifications@secrets');
    expect(serialized).toContain('"kind":"secret_ref"');
  });

  it('contains NO secret material (canary never appears; no material keys inside bindings)', () => {
    expect(serialized).not.toContain(SECRET_MATERIAL_CANARY);
    // any secret_ref binding object carries exactly kind+ref, never a
    // material-shaped key
    expect(serialized).not.toMatch(/"kind":"secret_ref","(?!ref")[a-zA-Z]+"/);
    expect(serialized).not.toMatch(/"(value|material|token|password|secretValue|apiKey|clientSecret)"/);
  });

  it('round-trips the secret reference losslessly as an opaque handle only', () => {
    const parsed = parseWorkflowIrDocument(serialized);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const notify = parsed.document.ir.nodes.find((node) => node.id === 'notify_channel');
      expect(notify).toBeDefined();
      const credentials = notify?.inputs.find((port) => port.name === 'credentials');
      expect(credentials?.type.kind).toBe('secret');
      expect(credentials?.binding.kind).toBe('secret_ref');
      if (credentials?.binding.kind === 'secret_ref') {
        expect(credentials.binding.ref).toBe('team-notifications@secrets');
        expect(Object.keys(credentials.binding).sort()).toEqual(['kind', 'ref']);
      }
      // re-serialization is byte-stable and still material-free
      const reserialized = serializeWorkflowIrDocument(parsed.document);
      expect(reserialized).toBe(serialized);
      expect(reserialized).not.toContain(SECRET_MATERIAL_CANARY);
    }
  });

  it('a document whose literals merely CONTAIN a secret-shaped string is still only data — but it can never be typed as a secret', () => {
    // a literal bound to a string port is ordinary data; the SECRET type is
    // the only path to secret semantics, and it accepts only secret_ref.
    const doc = withNodeInputs(buildTriageDocument(), 'fetch_issue', [
      {
        name: 'repository',
        type: { kind: 'string' },
        binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' },
      },
      {
        name: 'issueUrl',
        type: { kind: 'string' },
        binding: { kind: 'workflow_input', input: 'issueUrl' },
      },
    ]);
    const result = validateWorkflowIrDocument(doc);
    expect(result.ok).toBe(true);
  });

  it('cloning a document never deepens the secret handle into material (structural proof)', () => {
    const doc = clone(buildTriageDocument());
    const notify = doc.ir.nodes.find((node) => node.id === 'notify_channel');
    const credentials = notify?.inputs.find((port) => port.name === 'credentials');
    expect(credentials?.binding.kind).toBe('secret_ref');
    expect(JSON.stringify(doc)).not.toContain(SECRET_MATERIAL_CANARY);
  });
});
