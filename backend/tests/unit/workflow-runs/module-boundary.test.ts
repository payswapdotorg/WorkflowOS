/**
 * V2-005 — module boundary regressions (static, deterministic; the W1/W2A
 * module-boundary pattern).
 *
 *   1. DETERMINISM: no Math.random / Date.now / new Date / fetch / timers /
 *      process.env in the module source — clocks, ids, epochs are INJECTED.
 *   2. SIBLING SEPARATION: imports are node:crypto, module-internal relative
 *      paths, the merged sibling BARRELS ONLY (workflow-repository,
 *      workflow-ir, execution-attestation — never their internal/), and the
 *      platform DatabaseClient type. No teaching/compiler concepts in code.
 *   3. ATTESTATION BOUNDARY: V2-014's frozen identifiers
 *      (workflowos/execution-statement|attestation|proof-graph/v1) NEVER
 *      appear in code (comments may document the boundary); the module signs
 *      NOTHING (no Ed25519 sign/verify primitives — verification is delegated
 *      to the merged verifier); no second evidence/verification authority is
 *      declared.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_URL = new URL('../../../src/workflow-runs/', import.meta.url);
const MODULE_DIR = fileURLToPath(MODULE_URL);

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

/** Strip // line comments and /* block comments * from TypeScript source. */
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

const DETERMINISM_TOKENS = /Math\.random|Date\.now|new Date\b|\bfetch\s*\(|setTimeout|setInterval|setImmediate|process\.env/;

const ATTESTATION_DOMAIN_LITERALS = [
  /workflowos\/execution-statement\/v1/,
  /workflowos\/execution-attestation\/v1/,
  /workflowos\/execution-proof-graph/,
];

const SIGNING_PRIMITIVES = /generateKeyPairSync|createSign|createVerify|signSync|verifySync|KeyObject/;

const SIBLING_CONCEPT_TOKENS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'teaching-session concepts (V2-006)', pattern: /TeachingSession|\bteaching\b|\blearner\b|\blesson\b/i },
  { label: 'compiler concepts (V2-007)', pattern: /WorkflowCompiler|\bcompiler\b|compiled-workflow/i },
  { label: 'proof-graph concepts (V2-015)', pattern: /ExecutionProofGraph|proof[-_ ]graph/i },
];

const ALLOWED_NON_RELATIVE_IMPORTS = new Set([
  'node:crypto',
  '@platform/index.js',
  '../workflow-repository/index.js',
  '../workflow-ir/index.js',
  '../execution-attestation/index.js',
]);

describe('V2-005 module boundary (determinism, sibling separation, attestation authority)', () => {
  it('scans a non-empty module with the canonical layout', () => {
    expect(MODULE_FILES.length).toBeGreaterThanOrEqual(6);
    const files = MODULE_FILES.map((f) => relative(MODULE_DIR, f)).sort();
    expect(files).toContain('index.ts');
    expect(files).toContain('types.ts');
    expect(files.filter((f) => f.startsWith('internal')).length).toBeGreaterThanOrEqual(5);
  });

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

  for (const { label, pattern } of SIBLING_CONCEPT_TOKENS) {
    it(`contains no ${label} in code`, () => {
      const violations: string[] = [];
      for (const { file, code } of CODE_WITHOUT_COMMENTS) {
        if (pattern.test(code)) {
          violations.push(`${file} matches ${pattern}`);
        }
      }
      expect(violations, violations.join('\n')).toEqual([]);
    });
  }

  it('contains NO V2-014 domain-identifier literals in code (attestation semantics are V2-014\'s)', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      for (const pattern of ATTESTATION_DOMAIN_LITERALS) {
        if (pattern.test(code)) {
          violations.push(`${file} matches ${pattern}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('signs NOTHING: no Ed25519 signing/verification primitives in the module (verification is the merged verifier\'s)', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (SIGNING_PRIMITIVES.test(code)) {
        violations.push(`${file} matches ${SIGNING_PRIMITIVES}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('imports only sanctioned specifiers (node:crypto, module-internal, merged sibling BARRELS, platform types)', () => {
    const violations: string[] = [];
    // Real import/export statements ONLY (the earlier loose `from\s*['"]`
    // alternative false-positived on template literals inside error-message
    // strings, e.g. `legal targets from "${from}"` — not an import).
    const specifierPattern =
      /(?:import\s+[^;]*?from\s*|export\s+(?:type\s+)?\{[^}]*\}\s*from\s*|import\s*['"])['"]([^'"]+)['"]/g;
    // The merged sibling BARREL entry points (resolved from THIS module's
    // directory; internal/ paths are never sanctioned — checked below).
    const SIBLING_BARREL_PATHS = new Set(
      [
        '../workflow-repository/index.ts',
        '../workflow-ir/index.ts',
        '../execution-attestation/index.ts',
      ].map((rel) => join(MODULE_DIR, rel)),
    );
    const resolveCandidates = (from: string, specifier: string): string[] => {
      const resolved = join(from, specifier);
      return [resolved, `${resolved}.ts`, resolved.replace(/\.js$/, '.ts'), join(resolved, 'index.ts')];
    };
    for (const file of MODULE_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(specifierPattern)) {
        const specifier = match[1] as string;
        if (ALLOWED_NON_RELATIVE_IMPORTS.has(specifier)) continue;
        if (specifier === 'node:crypto' || specifier.startsWith('node:')) continue;
        if (specifier.startsWith('.')) {
          const candidates = resolveCandidates(dirname(file), specifier);
          const inside = candidates.some((c) => existsSync(c) && c.startsWith(MODULE_DIR));
          if (inside) continue;
          // merged sibling BARREL entry point only (never their internal/)
          const isSiblingBarrel = candidates.some((c) => SIBLING_BARREL_PATHS.has(c) && existsSync(c));
          if (!isSiblingBarrel) {
            violations.push(`${relative(MODULE_DIR, file)} imports outside the module (not a merged sibling barrel): "${specifier}"`);
          }
          continue;
        }
        violations.push(`${relative(MODULE_DIR, file)} imports unsanctioned "${specifier}"`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('never reaches into a merged sibling\'s internal/ (barrel-only consumption)', () => {
    const violations: string[] = [];
    for (const file of MODULE_FILES) {
      const source = readFileSync(file, 'utf8');
      if (/\/internal\/|internal\/pg-|internal\/statement|internal\/envelope|internal\/signing|internal\/verify/.test(source)) {
        // the module's OWN internal/ imports are fine; sibling internal paths are not
        for (const match of source.matchAll(/['"](\.\.\/[^'"]+)['"]/g)) {
          const specifier = match[1] as string;
          if (/workflow-repository\/internal|workflow-ir\/internal|execution-attestation\/internal|node-capability|teaching-sessions|workflow-compiler/.test(specifier)) {
            violations.push(`${relative(MODULE_DIR, file)} reaches into sibling internals: "${specifier}"`);
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('owns no V2-002 SQL surfaces (runs own ONLY the 0061 tables)', () => {
    // The pg store must never write to the repository's tables.
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (/wfos_v2_workflows|wfos_v2_workflow_versions|wfos_v2_workflow_installations/.test(code)) {
        violations.push(`${file} mutates/references V2-002 tables directly`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
