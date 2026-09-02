import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEACHING_EVIDENCE_CLASS } from '../../../src/teaching-sessions/index.js';

/**
 * V2-006 — the module source boundary (HARD RULE).
 *
 * V2-006 owns TeachingSession identity/state, explanations, checkpoints,
 * learner progress, practice, pause/resume and TEACHING evidence only. The
 * execution-attestation protocol objects (V2-014) and every run/execution
 * concept (V2-005) are absent from this module's CODE: those words may appear
 * only in boundary-documentation comments. The module imports exactly one
 * sibling domain — the merged, frozen V2-003 workflow-ir barrel — and no
 * platform/provider packages.
 */
const MODULE_ROOT = fileURLToPath(new URL('../../../src/teaching-sessions', import.meta.url));
const TESTS_ROOT = fileURLToPath(new URL('.', import.meta.url));

function walkTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Strip comments so boundary NOTES (which say "NOT owned here") never count
 * as concepts — only CODE identifiers do.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

// The frozen registry's execution-protocol object types, quoted ONLY inside
// this boundary test to prove separation (the V2-003 precedent).
const EXECUTION_PROTOCOL_OBJECT_TYPES = [
  'workflowos/execution-statement/v1',
  'workflowos/execution-attestation/v1',
  'workflowos/execution-proof-graph/v1',
];

describe('V2-006 — no execution-attestation concepts in the module source code', () => {
  it('src/teaching-sessions/**.ts declares no statement/digest/attestation/proof-graph concept in code', () => {
    const violations: string[] = [];
    for (const file of walkTsFiles(MODULE_ROOT)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      const pattern = /ExecutionStatement|ExecutionDigest|workflowos\/execution|attestation|proof[-_]?graph/i;
      const matches = source.match(pattern);
      if (matches) {
        violations.push(`${relative(MODULE_ROOT, file)}: ${matches.join(', ')}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the teaching evidence class is structurally distinct from every execution protocol object type', () => {
    for (const objectType of EXECUTION_PROTOCOL_OBJECT_TYPES) {
      expect(TEACHING_EVIDENCE_CLASS).not.toBe(objectType);
    }
  });
});

describe('V2-006 — the module consumes ONLY the merged workflow-ir barrel (read-only)', () => {
  it('src/teaching-sessions imports no other sibling domain, persistence or provider package', () => {
    const violations: string[] = [];
    const forbiddenImports =
      /from\s+'(\.\.\/(\.\.\/)?(workflow-repository|node-capability|api|modules|platform|onboarding|repository-intelligence|development-planner|maintenance)\/|pg|pglite|ioredis|@api|@platform|@modules)/;
    for (const file of walkTsFiles(MODULE_ROOT)) {
      const source = readFileSync(file, 'utf8');
      if (forbiddenImports.test(source)) {
        violations.push(relative(MODULE_ROOT, file));
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('src/teaching-sessions is deterministic: no Math.random / Date.now / new Date / fetch / timers', () => {
    const violations: string[] = [];
    const forbidden = /Math\.random|Date\.now|new Date|fetch\(|setTimeout|setInterval|process\.env/;
    for (const file of walkTsFiles(MODULE_ROOT)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      if (forbidden.test(source)) {
        violations.push(relative(MODULE_ROOT, file));
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the only import reaching outside the module is the merged workflow-ir public barrel', () => {
    const violations: string[] = [];
    for (const file of walkTsFiles(MODULE_ROOT)) {
      const source = readFileSync(file, 'utf8');
      const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
      for (const specifier of specifiers) {
        const reachesOutside = specifier.startsWith('..') && !specifier.startsWith('../types.js') &&
          !specifier.startsWith('../internal/') &&
          specifier !== '../workflow-ir/index.js' &&
          specifier !== '../../workflow-ir/index.js';
        const isBarePackage = !specifier.startsWith('.') && !specifier.startsWith('node:');
        if (reachesOutside || isBarePackage) {
          violations.push(`${relative(MODULE_ROOT, file)}: ${specifier}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('V2-006 — the unit battery itself is deterministic', () => {
  it('no wall clock / randomness / network in the unit test sources', () => {
    const violations: string[] = [];
    const forbidden = /Math\.random|Date\.now|new Date\(|fetch\(/;
    for (const file of walkTsFiles(TESTS_ROOT)) {
      if (file.endsWith('module-boundary.test.ts')) continue; // this file itself
      const source = stripComments(readFileSync(file, 'utf8'));
      if (forbidden.test(source)) {
        violations.push(relative(TESTS_ROOT, file));
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
