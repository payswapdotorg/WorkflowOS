import { describe, it, expect } from 'vitest';
import { compileWorkflow, serializeCompiledWorkflowArtifact } from '../../../src/workflow-compiler/index.js';
import { buildTriageDocument, SECRET_MATERIAL_CANARY, TRIAGE_SECRET_REF, clone } from './helpers.js';

/**
 * V2-007 — secret non-leakage battery (constitution §16).
 *
 * Compiled artifacts must never embed secret material. IR port bindings pass
 * through as opaque `secret_ref` references only — the compiler carries the
 * reference handle and nothing else. The canary proves the serialized bytes
 * never leak material; a structural walk proves every secret-typed port in
 * the plan is bound by an opaque reference with exactly {kind, ref}.
 */

const AUTHORED = buildTriageDocument();

function okArtifact() {
  const result = compileWorkflow(AUTHORED);
  if (!result.ok) throw new Error('fixture must compile');
  return result.artifact;
}

describe('V2-007 — secret material never enters the compiled artifact', () => {
  it('the serialized artifact contains the opaque secret reference', () => {
    const bytes = serializeCompiledWorkflowArtifact(okArtifact());
    expect(bytes).toContain(TRIAGE_SECRET_REF);
  });

  it('the serialized artifact NEVER contains the secret-material canary', () => {
    const bytes = serializeCompiledWorkflowArtifact(okArtifact());
    expect(bytes).not.toContain(SECRET_MATERIAL_CANARY);
    expect(bytes).not.toContain('ghp_live');
    expect(bytes).not.toContain('DEADBEEF');
  });

  it('a source document that smuggled a secret VALUE cannot compile (IR rejects literals on secret ports)', () => {
    const document = clone(AUTHORED);
    const notify = document.ir.nodes.find((node) => node.id === 'notify_channel');
    if (!notify) throw new Error('fixture node missing');
    notify.inputs = notify.inputs.map((input) =>
      input.name === 'credentials'
        ? { ...input, binding: { kind: 'literal', value: SECRET_MATERIAL_CANARY } }
        : input,
    );
    const result = compileWorkflow(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('recompilation never widens the secret surface (bytes stable, canary absent both times)', () => {
    const first = serializeCompiledWorkflowArtifact(okArtifact());
    const second = serializeCompiledWorkflowArtifact(okArtifact());
    expect(first).toBe(second);
    expect(first).not.toContain(SECRET_MATERIAL_CANARY);
    expect(second).not.toContain(SECRET_MATERIAL_CANARY);
  });
});

describe('V2-007 — secret ports pass through as opaque references only', () => {
  it('the notify unit carries a secret-typed port bound by an opaque secret_ref', () => {
    const notify = okArtifact().plan.units.find((unit) => unit.unit === 'notify_channel');
    const credentials = notify?.inputs.find((input) => input.name === 'credentials');
    expect(credentials?.type).toEqual({ kind: 'secret' });
    expect(credentials?.binding).toEqual({ kind: 'secret_ref', ref: TRIAGE_SECRET_REF });
  });

  it('every secret_ref binding in the whole plan carries exactly {kind, ref} (no material keys)', () => {
    const artifact = okArtifact();
    const secretBindings: unknown[] = [];
    for (const unit of artifact.plan.units) {
      for (const input of unit.inputs) {
        if (input.binding.kind === 'secret_ref') {
          secretBindings.push(input.binding);
        }
      }
    }
    expect(secretBindings.length).toBe(1);
    for (const binding of secretBindings) {
      expect(Object.keys(binding as object).sort()).toEqual(['kind', 'ref']);
    }
  });

  it('the opaque reference handle is carried verbatim (identity preserved)', () => {
    const sourceBinding = AUTHORED.ir.nodes
      .find((node) => node.id === 'notify_channel')
      ?.inputs.find((input) => input.name === 'credentials')?.binding;
    const compiledBinding = okArtifact().plan.units
      .find((unit) => unit.unit === 'notify_channel')
      ?.inputs.find((input) => input.name === 'credentials')?.binding;
    expect(compiledBinding).toEqual(sourceBinding);
  });

  it('no literal binding anywhere in the plan feeds a secret-typed port', () => {
    for (const unit of okArtifact().plan.units) {
      for (const input of unit.inputs) {
        if (input.type.kind === 'secret') {
          expect(input.binding.kind).toBe('secret_ref');
        }
      }
    }
  });
});
