import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXECUTION_PROOF_GRAPH_OBJECT_TYPE,
  EXECUTION_PROOF_UPDATED_EVENT_NAME,
} from '../../src/execution-proof-graph/index.js';

/**
 * V2-015 — module boundary regressions (static, deterministic; the W1
 * module-boundary pattern, mirrored from V2-014's battery).
 *
 *   1. CANONICAL LAYOUT: types.ts + internal/ + index.ts (the V2-014
 *      application-layer domain-module precedent; NOT a src/modules/ member
 *      — PLAT-AC-01's frozen 17 stay untouched).
 *   2. PUBLIC-SURFACE-ONLY CONSUMPTION: the module imports ONLY node
 *      builtins, module-internal relative paths, and the merged PUBLIC
 *      BARRELS of consumed siblings (execution-attestation). Importing any
 *      sibling `internal/` path or non-index file is a violation.
 *   3. NO COMPETING AUTHORITIES:
 *      - workflow-ir (V2-003 semantics) is NEVER imported — the semantic
 *        digest is opaque binding data (invariant 1 + 12);
 *      - computer-agent / workflow-runs / workflow-deployments /
 *        node-capability are absent from the PURE CORE (composition types
 *        land in dedicated coordination files only — never execution,
 *        persistence, or placement engines);
 *      - the module NEVER calls the V2-014 verifier or signer (no
 *        verification re-implementation).
 *   4. NO SIBLING DEPENDENCY: V2-012 (marketplace/collaboration/economics)
 *      and V2-013 concepts are absent — parallel-no-rebase, disjoint
 *      surfaces.
 *   5. DETERMINISM: no Math.random / Date.now / new Date / fetch / timers /
 *      process.env in the module source.
 *   6. REGISTRY NO-DRIFT: the module's object type and event name are
 *      exactly the frozen registry values.
 *   7. NO ROUTES / NO MIGRATIONS: V2-015 owns no route or migration surface
 *      (the frozen work order requires none; the graph is a deterministic
 *      composition over existing evidence).
 */

const MODULE_URL = new URL('../../src/execution-proof-graph/', import.meta.url);
const MODULE_DIR = fileURLToPath(MODULE_URL);
const BACKEND_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REGISTRY_JSON_PATH = fileURLToPath(
  new URL('../../../spec/architecture/v2/V2-CTRL-003-protocol-registry.json', import.meta.url),
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

/** Extract import specifiers from a source file (static imports only). */
function extractSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  const importPattern = /import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(importPattern)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

describe('V2-015 module boundary (canonical layout, public-surface-only consumption)', () => {
  it('scans a non-empty module with the canonical layout', () => {
    expect(MODULE_FILES.length).toBeGreaterThanOrEqual(3);
    const files = MODULE_FILES.map((f) => relative(MODULE_DIR, f)).sort();
    expect(files).toContain('index.ts');
    expect(files).toContain('types.ts');
    expect(files).toContain(join('internal', 'validation.ts'));
    expect(existsSync(join(MODULE_DIR, 'internal'))).toBe(true);
  });

  it('imports only node builtins, module-internal paths, and the consumed PUBLIC barrels', () => {
    const violations: string[] = [];
    const ALLOWED_BARRELS = /(\.\.\/)+(execution-attestation|workflow-runs|computer-agent|workflow-deployments|node-capability)\/index\.js$/;
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      for (const specifier of extractSpecifiers(code)) {
        const isNodeBuiltin = specifier.startsWith('node:');
        const isModuleInternal = specifier.startsWith('./') || specifier.startsWith('../');
        const isAllowedBarrel = ALLOWED_BARRELS.test(specifier);
        if (!isNodeBuiltin && !isModuleInternal && !isAllowedBarrel) {
          violations.push(`${file} imports "${specifier}"`);
        }
        // module-internal relative paths may only resolve INSIDE this module
        // or to one of the consumed public barrels — never a sibling's
        // internals or non-index file.
        if (specifier.startsWith('../')) {
          const resolved = join(dirname(join(MODULE_DIR, file)), specifier);
          const insideProofGraph = resolved.startsWith(MODULE_DIR);
          if (!insideProofGraph && !isAllowedBarrel) {
            violations.push(`${file} imports outside the module: "${specifier}"`);
          }
          if (specifier.includes('/internal/')) {
            violations.push(`${file} imports a sibling internal path: "${specifier}"`);
          }
          void resolved;
        }
        // every consumed barrel EXCEPT V2-014's must be consumed TYPE-ONLY
        // (data shapes; never a runtime dependency on a sibling engine).
        const isTypeOnlyBarrel = /(\.\.\/)+(workflow-runs|computer-agent|workflow-deployments|node-capability)\/index\.js$/.test(specifier);
        if (isTypeOnlyBarrel) {
          const importStatements = code.match(/import\s+[^;]*?from\s*['"][^'"]+['"];?/g) ?? [];
          for (const statement of importStatements) {
            if (statement.includes(specifier) && !/^import\s+type\s*\{/m.test(statement)) {
              violations.push(`${file} must import "${specifier}" TYPE-ONLY (data shapes, never sibling runtime engines)`);
            }
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('never imports workflow-ir (V2-003 stays the sole workflow-semantics authority)', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (/workflow-ir|WorkflowIr\b/.test(code)) {
        violations.push(`${file} references WorkflowIR (V2-003 authority leak)`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('never calls the V2-014 verifier or signer (V2-014 stays the verification authority)', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (/\bverifyAttestation\b|\bsignExecutionAttestation\b|\bgenerateAttesterKeyPair\b/.test(code)) {
        violations.push(`${file} calls V2-014 verification/signing (authority leak)`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('contains no V2-012 sibling concepts (parallel-no-rebase, disjoint surfaces)', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (/marketplace|collaboration|entitlement|\beconomics?\b/i.test(code)) {
        violations.push(`${file} references V2-012 sibling concepts`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('contains no wall-clock/randomness/network dependence anywhere in the module source', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (/Math\.random|Date\.now|new Date\b|\bfetch\s*\(|setTimeout|setInterval|process\.env/.test(code)) {
        violations.push(`${file} contains a forbidden determinism token`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('owns no route files and no migrations (V2-015 has no route/migration surface)', () => {
    expect(existsSync(join(BACKEND_ROOT, 'src', 'api', 'routes', 'execution-proof-graph.route.ts'))).toBe(false);
    const migrationsDir = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations');
    const proofGraphMigrations = readdirSync(migrationsDir).filter((m) => /proof[-_]?graph/i.test(m));
    expect(proofGraphMigrations, `unexpected V2-015 migrations: ${proofGraphMigrations.join(', ')}`).toEqual([]);
  });

  it('uses only hash primitives from node:crypto (never sign/verify/generateKey)', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (/generateKeyPair|sign\s*\(|verify\s*\(|createPrivateKey|createPublicKey|createSign|createVerify/.test(code)) {
        violations.push(`${file} uses cryptographic primitives beyond sha-256 hashing`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('V2-015 registry conformance (frozen V2-CTRL-003, no drift)', () => {
  const registry = JSON.parse(readFileSync(REGISTRY_JSON_PATH, 'utf8')) as {
    readonly attestationObjectTypes: readonly string[];
    readonly events: readonly string[];
  };

  it('owns exactly the third registry object type', () => {
    expect(EXECUTION_PROOF_GRAPH_OBJECT_TYPE).toBe('workflowos/execution-proof-graph/v1');
    expect(registry.attestationObjectTypes).toContain(EXECUTION_PROOF_GRAPH_OBJECT_TYPE);
  });

  it('emits exactly the registered proof-update event name', () => {
    expect(EXECUTION_PROOF_UPDATED_EVENT_NAME).toBe('execution.proof.updated');
    expect(registry.events).toContain(EXECUTION_PROOF_UPDATED_EVENT_NAME);
  });
});
