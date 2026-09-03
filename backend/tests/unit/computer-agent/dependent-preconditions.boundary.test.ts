/**
 * V2-016 — the static architecture constraints of the dependent-precondition
 * composition hooks (work order "Static architecture constraints"):
 *
 *   1. all new composition types/helpers live behind the V2-008 public
 *      barrel (compile-time import + source-level export pins);
 *   2. consumers never reach into V2-008 internals (file-walk over every
 *      TypeScript file outside src/computer-agent: no deep-import specifier);
 *   3. V2-008 never imports V2-015 implementation code (no 'proof-graph'
 *      module specifier anywhere in the module — prospective, V2-015 is
 *      frozen but unimplemented and remains BLOCKED until IG-006 completes);
 *   4. no second verification/signing authority: the admission module
 *      (internal/preconditions.ts) is PURE STRUCTURE — type-only sibling
 *      imports, no crypto, no canonical-verifier call (V2-014 owns
 *      verification; the precondition currency is its VerifiedExecutionFact);
 *   5. the V2-005 recorder boundary is preserved (the recorder port stays
 *      the exact structural Pick of the merged run service — the admission
 *      path added ZERO new V2-005 command surface);
 *   6. the authorization boundary is preserved (SafeActionPolicy/SafeActionGrant
 *      shapes unchanged — admission never becomes a grant);
 *   7. the causal-parent field reaches V2-014's canonical statement (the
 *      production AND the verification-binding mapping are pinned at the
 *      source level; behavioral proof lives in the causal battery);
 *   8. the public precondition contract's key surface is pinned exactly
 *      (the seven-field typed composition precondition — self-invalidating
 *      against accidental surface drift).
 */
import { describe, it, expect } from 'vitest';
import { expectTypeOf } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DependentStepPrecondition,
  ComputerAgentPolicy,
  ComputerAgentRunRecorder,
  SafeActionGrant,
  SafeActionPolicy,
  StepAttestationMaterial,
} from '../../../src/computer-agent/index.js';
import { admitDependentPreconditions, causalParentsForStep } from '../../../src/computer-agent/index.js';
import type { WorkflowRunService } from '../../../src/workflow-runs/index.js';
import type { ExecutionStatement, VerifiedExecutionFact } from '../../../src/execution-attestation/index.js';

const BACKEND_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MODULE_DIR = join(BACKEND_ROOT, 'src', 'computer-agent');

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkTs(full);
    } else if (entry.endsWith('.ts')) {
      yield full;
    }
  }
}

/** All TypeScript files under backend/ EXCEPT the module's own sources. */
function filesOutsideModule(): string[] {
  return [...walkTs(BACKEND_ROOT)].filter(
    (file) => !file.startsWith(MODULE_DIR),
  );
}

const importSpecifierPattern =
  /(?:import\s+[^;]*?from\s*|export\s+(?:type\s+)?\{[^}]*\}\s+from\s*|import\s*['"])['"]([^'"]+)['"]/g;

function specifiersOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(importSpecifierPattern)].map((match) => match[1] as string);
}

describe('V2-016 static architecture constraints (barrel, consumers, V2-015 separation, verification authority, preserved boundaries)', () => {
  it('1. the new composition symbols are exported behind the public barrel (compile-time + source pins)', () => {
    // compile-time: importing them from the barrel is the ONLY sanctioned way
    expect(typeof admitDependentPreconditions).toBe('function');
    expect(typeof causalParentsForStep).toBe('function');
    expectTypeOf<DependentStepPrecondition>().not.toBeNever();
    // source pin: the barrel really re-exports them:
    const barrel = readFileSync(join(MODULE_DIR, 'index.ts'), 'utf8');
    expect(barrel).toContain('DependentStepPrecondition');
    expect(barrel).toContain('admitDependentPreconditions');
    expect(barrel).toContain('causalParentsForStep');
    expect(barrel).toContain('preconditions.js');
    // and the runtime drive inputs carry the precondition field:
    const runtimeSource = readFileSync(join(MODULE_DIR, 'internal', 'runtime.ts'), 'utf8');
    expect(runtimeSource).toContain('preconditions?: readonly DependentStepPrecondition[]');
    expect(runtimeSource).toContain('COMPUTER_AGENT_PRECONDITION_REJECTED');
    expect(runtimeSource).toContain('AGENT_PRECONDITION_REJECTED');
  });

  it('2. no consumer outside the module reaches into V2-008 internals', () => {
    const violations: string[] = [];
    for (const file of filesOutsideModule()) {
      for (const specifier of specifiersOf(file)) {
        if (specifier.includes('computer-agent/internal') || /computer-agent\/(?!index\.js$)[^/]*\.js/.test(specifier)) {
          violations.push(`${relative(BACKEND_ROOT, file)} imports "${specifier}" (barrel-only consumption)`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('3. V2-008 imports no V2-015 implementation code (no proof-graph module specifier)', () => {
    const violations: string[] = [];
    for (const file of [...walkTs(MODULE_DIR)]) {
      for (const specifier of specifiersOf(file)) {
        if (/proof-graph/i.test(specifier)) {
          violations.push(`${relative(MODULE_DIR, file)} imports "${specifier}" (V2-015 is frozen, unimplemented, and blocked — V2-008 must not depend on it)`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('4. no second verification authority: the admission module is pure structure', () => {
    const admissionPath = join(MODULE_DIR, 'internal', 'preconditions.ts');
    const source = readFileSync(admissionPath, 'utf8');
    // no cryptographic or canonical-verifier calls — V2-014 owns verification:
    expect(source).not.toContain('verifyAttestation(');
    expect(source).not.toContain('node:crypto');
    expect(source).not.toContain('generateKeyPair');
    expect(source).not.toContain('signStatement');
    // sibling imports are TYPE-ONLY (the fact is consumed as data):
    for (const line of source.split('\n')) {
      if (/from\s+['"]\.\.[^'"]+['"]/.test(line)) {
        expect(line, `sibling import must be type-only: ${line.trim()}`).toMatch(/^\s*import\s+type\b/);
      }
    }
  });

  it('5. the V2-005 recorder boundary is preserved (no new command surface for admission)', () => {
    // the recorder port remains EXACTLY the structural Pick of the merged
    // run service this module always held (12 commands — nothing added):
    expectTypeOf<ComputerAgentRunRecorder>().toEqualTypeOf<
      Pick<
        WorkflowRunService,
        | 'startRun'
        | 'pauseRun'
        | 'resumeRun'
        | 'completeRun'
        | 'failRun'
        | 'recordStepStarted'
        | 'recordStepCompleted'
        | 'recordInvocationRequested'
        | 'recordInvocationCompleted'
        | 'recordEvidence'
        | 'attachAttestation'
        | 'getRun'
        | 'getRunHistory'
      >
    >();
  });

  it('6. the authorization boundary is preserved (admission is never a grant)', () => {
    expectTypeOf<SafeActionGrant>().toEqualTypeOf<{
      readonly capability: string;
      readonly scope: 'run' | 'step';
      readonly stepId?: string;
    }>();
    expectTypeOf<SafeActionPolicy>().toEqualTypeOf<{ readonly grants: readonly SafeActionGrant[] }>();
    // the admission failure is a DISTINCT typed code, never an authorization
    // code (the two vocabularies stay disjoint dimensions):
    const typesSource = readFileSync(join(MODULE_DIR, 'types.ts'), 'utf8');
    expect(typesSource).toContain("'AGENT_PRECONDITION_REJECTED'");
    expect(typesSource).toContain("'AGENT_CAPABILITY_UNAUTHORIZED'");
  });

  it('7. the causal-parent field reaches V2-014 canonical statement production AND verification binding', () => {
    const attestingSource = readFileSync(join(MODULE_DIR, 'internal', 'attesting.ts'), 'utf8');
    // production: the built statement maps the material's declared parents:
    expect(attestingSource).toContain('causalParents: canonicalCausalParents(material)');
    // verification: the independent-verification binding expects the SAME
    // declared set (the no-silent-fallback machine check):
    const verifySection = attestingSource.slice(attestingSource.indexOf('export function verifyStepAttestationIndependently'));
    expect(verifySection).toContain('causalParents: canonicalCausalParents(material)');
    // the field is on the MATERIAL (V2-008's production contract):
    expect(attestingSource).toContain('readonly causalParents?: readonly string[];');
    // and the material's carrier type is the canonical V2-014 statement's
    // carrier type (typed compat — the field is the MERGED contract's, not
    // a test-metadata sidecar):
    expectTypeOf<NonNullable<StepAttestationMaterial['causalParents']>>().toEqualTypeOf<ExecutionStatement['causalParents']>();
  });

  it('8. the public precondition contract surface is pinned exactly (seven fields)', () => {
    expectTypeOf<DependentStepPrecondition>().toEqualTypeOf<{
      readonly dependentStepId: string;
      readonly predecessorAttestationId: string;
      readonly verifiedPredecessor: VerifiedExecutionFact;
      readonly causalParentDigests: readonly string[];
      readonly runId: string;
      readonly workflowVersionId: string;
      readonly workflowVersionSemanticDigest: string;
    }>();
    // the runtime policy carries the dependent-admission configuration as
    // an OPTIONAL flat field (zero behavior change when absent):
    expectTypeOf<ComputerAgentPolicy['dependentStepIds']>().toEqualTypeOf<readonly string[] | undefined>();
  });

  it('9. the admission gate precedes host routing in the step execution path (source-order discipline)', () => {
    // The dependent-admission gate must sit BEFORE routeHost in executeUnit:
    // its rejection produces a step report with nodeId: null and zero
    // invocations (behavioral proof in the admission battery); this pin
    // keeps the structural order honest against refactors that would move
    // host routing ahead of admission.
    const source = readFileSync(join(MODULE_DIR, 'internal', 'runtime.ts'), 'utf8');
    const gateIndex = source.indexOf("dependentStepsOf(this.policy).has(unit.unit) && !state.admitted.has(unit.unit)");
    const routeIndex = source.indexOf('const host = this.routeHost(state, unit);');
    expect(gateIndex).toBeGreaterThan(0);
    expect(routeIndex).toBeGreaterThan(0);
    expect(gateIndex).toBeLessThan(routeIndex);
  });

  it('10. existsSync sanity: the module layout the walk relies on', () => {
    expect(existsSync(join(MODULE_DIR, 'internal', 'preconditions.ts'))).toBe(true);
    expect(existsSync(join(MODULE_DIR, 'index.ts'))).toBe(true);
  });
});
