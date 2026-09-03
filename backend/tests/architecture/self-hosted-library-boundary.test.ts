import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * V2-013 — module boundary regressions (static, deterministic; the V2-014/
 * V2-015 module-boundary pattern).
 *
 *   1. CANONICAL LAYOUT: types.ts + internal/ + index.ts (the application-
 *      layer domain-module precedent; NOT a src/modules/ member).
 *   2. PUBLIC-SURFACE-ONLY CONSUMPTION: the module imports ONLY node
 *      builtins, module-internal relative paths, and the merged PUBLIC
 *      BARRELS of consumed authorities. Importing any sibling `internal/`
 *      path or non-index file is a violation.
 *   3. NO COMPETING AUTHORITIES:
 *      - workflow-ir (V2-003) is consumed through its public barrel ONLY
 *        (artifacts are authored with the merged builder — V2-003 stays the
 *        sole workflow-semantics authority);
 *      - workflow-repository (V2-002) is consumed TYPE-ONLY (the install
 *        port is a structural type satisfied by the real service in
 *        composition — this module never imports the service and never
 *        re-implements repository/version/install semantics);
 *      - workflow-runs (V2-005) is consumed TYPE-ONLY (evidence
 *        reconstruction reads run-history data shapes; no runs are created
 *        here);
 *      - execution-proof-graph (V2-015) is the ONLY proof-composition
 *        consumption (evaluateProofAdmission — never a re-implementation);
 *      - architecture-checkpoints (WORK-051/052 governance substrate) is
 *        consumed read-only for the code-pinned self-hosting prohibitions;
 *      - computer-agent (V2-008) is NEVER imported (packaging produces
 *        typed preconditions, never executes);
 *      - the module NEVER calls the V2-014 verifier or signer.
 *   4. NO SIBLING DEPENDENCY: V2-012 (marketplace/collaboration/economics)
 *      concepts are absent — parallel-no-rebase, disjoint surfaces.
 *   5. DETERMINISM: no Math.random / Date.now / new Date / fetch / timers /
 *      process.env in the module source.
 *   6. REGISTRY NO-DRIFT: V2-013 owns NO new protocol-visible identifiers —
 *      every capability the first-party artifacts declare is an EXISTING
 *      canonical registry capability name.
 *   7. NO ROUTES / NO MIGRATIONS: V2-013 owns no route or migration
 *      surface (installation composes the real V2-002 routes in
 *      composition; the module is a pure library + packaging layer).
 */

const MODULE_URL = new URL('../../src/self-hosted-library/', import.meta.url);
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

describe('V2-013 module boundary (canonical layout, public-surface-only consumption)', () => {
  it('scans a non-empty module with the canonical layout', () => {
    expect(MODULE_FILES.length).toBeGreaterThanOrEqual(4);
    const files = MODULE_FILES.map((f) => relative(MODULE_DIR, f)).sort();
    expect(files).toContain('index.ts');
    expect(files).toContain('types.ts');
    expect(existsSync(join(MODULE_DIR, 'internal'))).toBe(true);
  });

  it('imports only node builtins, module-internal paths, and the consumed PUBLIC barrels', () => {
    const violations: string[] = [];
    const RUNTIME_ALLOWED_BARRELS = /(\.\.\/)+(workflow-ir|execution-proof-graph|architecture-checkpoints)\/index\.js$/;
    const TYPE_ONLY_BARRELS = /(\.\.\/)+(workflow-repository|workflow-runs)\/index\.js$/;
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      for (const specifier of extractSpecifiers(code)) {
        const isNodeBuiltin = specifier.startsWith('node:');
        const isModuleInternal = specifier.startsWith('./') || specifier.startsWith('../');
        const isAllowedBarrel = RUNTIME_ALLOWED_BARRELS.test(specifier) || TYPE_ONLY_BARRELS.test(specifier);
        if (!isNodeBuiltin && !isModuleInternal && !isAllowedBarrel) {
          violations.push(`${file} imports "${specifier}"`);
        }
        // module-internal relative paths may only resolve INSIDE this module
        // or to one of the consumed public barrels — never a sibling's
        // internals or non-index file.
        if (specifier.startsWith('../')) {
          const resolved = join(dirname(join(MODULE_DIR, file)), specifier);
          const insideModule = resolved.startsWith(MODULE_DIR);
          if (!insideModule && !isAllowedBarrel) {
            violations.push(`${file} imports outside the module: "${specifier}"`);
          }
          if (specifier.includes('/internal/')) {
            violations.push(`${file} imports a sibling internal path: "${specifier}"`);
          }
        }
        // V2-002/V2-005 are consumed TYPE-ONLY (data shapes; never a
        // runtime dependency on the repository or run engines).
        if (TYPE_ONLY_BARRELS.test(specifier)) {
          const importStatements = code.match(/import\s+[^;]*?from\s*['"][^'"]+['"];?/g) ?? [];
          for (const statement of importStatements) {
            if (statement.includes(specifier) && !/^import\s+type\s*\{/m.test(statement)) {
              violations.push(`${file} must import "${specifier}" TYPE-ONLY (data shapes, never sibling engines)`);
            }
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('never imports the marketplace sibling or the computer-agent runtime (V2-008 execution stays external)', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (/marketplace|collaboration|entitlement|subscription|refund/i.test(code)) {
        violations.push(`${file} references V2-012 sibling concepts`);
      }
      if (/computer-agent|ComputerAgentRuntime|registerComputerHost/.test(code)) {
        violations.push(`${file} references the V2-008 computer-agent runtime`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('never calls the V2-014 verifier/signer or re-implements admission (V2-014/V2-015 stay the authorities)', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (/\bverifyAttestation\b|\bsignExecutionAttestation\b|\bgenerateAttesterKeyPair\b/.test(code)) {
        violations.push(`${file} calls V2-014 verification/signing (authority leak)`);
      }
      // admission is CONSUMED from V2-015 (evaluateProofAdmission); a local
      // re-implementation is the second-verification-authority defect.
      if (/function\s+evaluateProofAdmission|function\s+evaluateAdmission/.test(code)) {
        violations.push(`${file} re-implements admission (V2-015 authority leak)`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('creates no runs and no work items (V2-005/V2-008/Work-Item authorities stay external)', () => {
    const violations: string[] = [];
    for (const { file, code } of CODE_WITHOUT_COMMENTS) {
      if (/\brequestRun\b|\bstartRun\b|\bcompleteRun\b|\bfailRun\b|\bcreateWorkItem\b|\bmergePullRequest\b/.test(code)) {
        violations.push(`${file} drives a run/Work-Item lifecycle (second engine leak)`);
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

  it('owns no route files and no migrations (V2-013 has no route/migration surface)', () => {
    expect(existsSync(join(BACKEND_ROOT, 'src', 'api', 'routes', 'self-hosted-library.route.ts'))).toBe(false);
    const migrationsDir = join(BACKEND_ROOT, 'src', 'platform', 'postgres', 'migrations');
    const selfHostMigrations = readdirSync(migrationsDir).filter((m) => /self[-_]?host|first[-_]?party/i.test(m));
    expect(selfHostMigrations, `unexpected V2-013 migrations: ${selfHostMigrations.join(', ')}`).toEqual([]);
  });
});

describe('V2-013 registry conformance (frozen V2-CTRL-003, no new protocol-visible identifiers)', () => {
  const registry = JSON.parse(readFileSync(REGISTRY_JSON_PATH, 'utf8')) as {
    readonly capabilities: Record<string, readonly string[]>;
    readonly events: readonly string[];
  };
  const canonicalCapabilities = new Set<string>(
    Object.values(registry.capabilities).flatMap((names) => [...names]),
  );

  it('owns no new registry object type or event (V2-013 reuses the universal protocol only)', async () => {
    // The module's public barrel must not export any NEW objectType/event
    // constant: first-party workflows are ORDINARY WorkflowOS workflows.
    const moduleIndex = await import('../../src/self-hosted-library/index.js') as Record<string, unknown>;
    for (const [key, value] of Object.entries(moduleIndex)) {
      if (/OBJECT_TYPE|EVENT_NAME|_EVENT\b/.test(key) && typeof value === 'string') {
        const known =
          registry.events.includes(value) ||
          Object.values(registry).some(
            (section) => Array.isArray(section) && (section as readonly string[]).includes(value),
          );
        expect(known, `export ${key}=${value} introduces a non-registry protocol identifier`).toBe(true);
      }
    }
  });

  it('every capability the first-party artifacts declare is an existing canonical registry name', async () => {
    const { FIRST_PARTY_WORKFLOW_ARTIFACTS } = await import('../../src/self-hosted-library/index.js');
    const violations: string[] = [];
    for (const artifact of FIRST_PARTY_WORKFLOW_ARTIFACTS) {
      for (const node of artifact.document.ir.nodes) {
        for (const capability of node.capabilityRequirements) {
          if (!canonicalCapabilities.has(capability)) {
            violations.push(`${artifact.kind}/${node.id} declares non-canonical capability "${capability}"`);
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the first-party capability allowlist contains ONLY canonical registry names (no invented identifiers)', async () => {
    const { FIRST_PARTY_ALLOWED_CAPABILITIES } = await import('../../src/self-hosted-library/index.js');
    for (const capability of FIRST_PARTY_ALLOWED_CAPABILITIES) {
      expect(
        canonicalCapabilities.has(capability),
        `allowlist entry "${capability}" is not a canonical registry capability`,
      ).toBe(true);
    }
  });
});
