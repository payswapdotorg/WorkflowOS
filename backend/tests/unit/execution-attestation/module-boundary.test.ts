import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXECUTION_ATTESTATION_REGISTRY_VOCABULARY } from '../../../src/execution-attestation/index.js';

/**
 * V2-014 — module boundary regressions (static, deterministic; the W1
 * module-boundary pattern).
 *
 *   1. PROOF-GRAPH ABSENCE: `workflowos/execution-proof-graph/v1` /
 *      ExecutionProofGraph belong to V2-015 and MUST NOT be implemented in
 *      this module. Comments may document the boundary; CODE may not contain
 *      any proof-graph concept.
 *   2. NO sibling-domain concepts: teaching sessions (V2-006), the workflow
 *      compiler (V2-007), WorkflowRun persistence (V2-005), the workflow
 *      repository (V2-002) and WorkflowIR semantics (V2-003) are absent from
 *      CODE — this module consumes merged sibling outputs only as opaque
 *      reference DATA (digests/ids as strings).
 *   3. DETERMINISM: no Math.random / Date.now / new Date / fetch / timers in
 *      the module source — clocks, nonces, epochs and keys are injected or
 *      generated through real node:crypto primitives.
 *   4. SELF-CONTAINED: imports are node:crypto + module-internal relative
 *      paths only (no platform/module/sibling imports).
 *   5. REGISTRY NO-DRIFT: the embedded vocabulary snapshot equals the frozen
 *      registry JSON (and deliberately excludes the V2-015 object type).
 */

const MODULE_URL = new URL('../../../src/execution-attestation/', import.meta.url);
const MODULE_DIR = fileURLToPath(MODULE_URL);
const REGISTRY_JSON_PATH = fileURLToPath(
  new URL('../../../../spec/architecture/v2/V2-CTRL-003-protocol-registry.json', import.meta.url),
);

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkTs(full);
    } else if (entry.endsWith('.ts')) {
      yield full;
    }
  }
}

const MODULE_FILES = existsSync(MODULE_DIR) ? [...walkTs(MODULE_DIR)] : [];

/** Strip // line comments and /* block comments *\/ from TypeScript source. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"])\/\/.*$/gm, '$1');
}

const CODE_WITHOUT_COMMENTS = MODULE_FILES.map((file) => ({
  file: relative(MODULE_DIR, file),
  code: stripComments(readFileSync(file, 'utf8')),
}));

const PROOF_GRAPH_TOKENS = [
  /ExecutionProofGraph/,
  /proof[-_ ]graphs?/i,
  /workflowos\/execution-proof-graph/,
];

const SIBLING_CONCEPT_TOKENS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'teaching-session concepts (V2-006)', pattern: /TeachingSession|\bteaching\b|\blesson\b|\blearner\b/i },
  { label: 'compiler concepts (V2-007)', pattern: /WorkflowCompiler|\bcompiler\b|\bcompiled artifact\b/i },
  { label: 'WorkflowRun persistence concepts (V2-005)', pattern: /WorkflowRun|\bpersist\w*|\bpostgres\b|\bpglite\b|\bmigration\b|\bdatabase\b|\bsql\b/i },
  { label: 'workflow-repository internals (V2-002)', pattern: /WorkflowRepository|workflow-repository|fork|installation/i },
  { label: 'WorkflowIR semantics (V2-003)', pattern: /WorkflowIr\b|workflow-ir|workflowos\/workflow-ir/i },
];

const DETERMINISM_TOKENS = /Math\.random|Date\.now|new Date\b|\bfetch\s*\(|setTimeout|setInterval|process\.env/;

describe('V2-014 module boundary (proof-graph absence, sibling separation, determinism)', () => {
  it('scans a non-empty module with the canonical layout', () => {
    expect(MODULE_FILES.length).toBeGreaterThanOrEqual(9);
    const files = MODULE_FILES.map((f) => relative(MODULE_DIR, f)).sort();
    expect(files).toContain('index.ts');
    expect(files).toContain('types.ts');
    expect(files.filter((f) => f.startsWith('internal')).length).toBeGreaterThanOrEqual(7);
  });

  it('contains NO proof-graph concepts in code (V2-015 owns them)', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      for (const pattern of PROOF_GRAPH_TOKENS) {
        if (pattern.test(code)) {
          violations.push(`${file} matches ${pattern}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  for (const { label, pattern } of SIBLING_CONCEPT_TOKENS) {
    it(`contains no ${label} in code`, () => {
      const violations: string[] = [];
      for (const { file, code } of CODE_WITHOUT_COMMENTS) {
        if (pattern.test(code)) {
          violations.push(`${file} matches ${label}`);
        }
      }
      expect(violations, violations.join('\n')).toEqual([]);
    });
  }

  it('contains no wall-clock/randomness/network dependence anywhere in the module source', () => {
    const violations: string[] = [];
    for (const file of MODULE_FILES) {
      const source = readFileSync(file, 'utf8');
      if (DETERMINISM_TOKENS.test(source)) {
        violations.push(`${relative(MODULE_DIR, file)} matches nondeterminism pattern ${DETERMINISM_TOKENS}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('imports only node:crypto and module-internal relative paths (self-contained domain)', () => {
    const violations: string[] = [];
    const specifierPattern = /(?:from\s*|import\s*)['"]([^'"]+)['"]/g;
    for (const file of MODULE_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(specifierPattern)) {
        const specifier = match[1] as string;
        if (specifier === 'node:crypto') continue;
        if (specifier.startsWith('.') || specifier.startsWith('./')) {
          const resolved = join(dirname(file), specifier);
          const candidates = [
            resolved,
            `${resolved}.ts`,
            resolved.replace(/\.js$/, '.ts'),
            join(resolved, 'index.ts'),
          ];
          const inside = candidates.some((c) => existsSync(c) && c.startsWith(MODULE_DIR));
          if (!inside) {
            violations.push(`${relative(MODULE_DIR, file)} imports outside the module: "${specifier}"`);
          }
          continue;
        }
        violations.push(`${relative(MODULE_DIR, file)} imports non-relative "${specifier}"`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('V2-014 registry conformance (frozen V2-CTRL-003, no drift)', () => {
  const registry = JSON.parse(readFileSync(REGISTRY_JSON_PATH, 'utf8')) as {
    capabilities: Record<string, string[]>;
    executionClasses: string[];
    assurance: string[];
    attestationObjectTypes: string[];
    events: string[];
    digest: { algorithm: string; executionDomain: string };
    authorityRules: string[];
  };

  it('mirrors the registry capabilities exactly (canonical capability names only)', () => {
    const expected = Object.values(registry.capabilities).flat().sort();
    expect([...EXECUTION_ATTESTATION_REGISTRY_VOCABULARY.capabilities].sort()).toEqual(expected);
  });

  it('mirrors the registry execution classes exactly', () => {
    expect([...EXECUTION_ATTESTATION_REGISTRY_VOCABULARY.executionClasses]).toEqual(registry.executionClasses);
  });

  it('mirrors the registry assurance identifiers exactly', () => {
    expect([...EXECUTION_ATTESTATION_REGISTRY_VOCABULARY.assurance]).toEqual(registry.assurance);
  });

  it('mirrors the registry execution-domain digest rule exactly', () => {
    expect(EXECUTION_ATTESTATION_REGISTRY_VOCABULARY.digestExecutionDomain).toBe(registry.digest.executionDomain);
    expect(EXECUTION_ATTESTATION_REGISTRY_VOCABULARY.digestExecutionDomain).toBe('workflowos/execution-statement/v1');
  });

  it('owns exactly the two V2-014 object types and NOT the V2-015 proof-graph type', () => {
    expect([...EXECUTION_ATTESTATION_REGISTRY_VOCABULARY.attestationObjectTypes]).toEqual([
      'workflowos/execution-statement/v1',
      'workflowos/execution-attestation/v1',
    ]);
    expect(registry.attestationObjectTypes).toContain('workflowos/execution-proof-graph/v1');
    expect(EXECUTION_ATTESTATION_REGISTRY_VOCABULARY.attestationObjectTypes).not.toContain('workflowos/execution-proof-graph/v1');
  });

  it('exposes exactly the two canonical attestation events from the registry', () => {
    expect([...EXECUTION_ATTESTATION_REGISTRY_VOCABULARY.events]).toEqual([
      'execution.attestation.issued',
      'execution.attestation.verified',
    ]);
    const registryAttestationEvents = registry.events.filter((name) => name.startsWith('execution.attestation.'));
    expect([...EXECUTION_ATTESTATION_REGISTRY_VOCABULARY.events]).toEqual(registryAttestationEvents);
  });

  it('mirrors the registry authority rules verbatim (non-authority discipline)', () => {
    expect([...EXECUTION_ATTESTATION_REGISTRY_VOCABULARY.authorityRules]).toEqual(registry.authorityRules);
  });
});
