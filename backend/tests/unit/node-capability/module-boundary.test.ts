import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * V2-004 — module boundary regressions (static, deterministic).
 *
 *   1. EXECUTION-ATTESTATION BOUNDARY: the node-capability domain must never
 *      define or reference V2-014's concepts (ExecutionStatement /
 *      ExecutionAttestation / ExecutionProofGraph / ExecutionDigest, the
 *      `workflowos/execution-*` object-type domain, execution assurance
 *      identifiers, or signing/attestation vocabulary). Node authentication
 *      here is HMAC message authentication of a registration channel —
 *      nothing about execution truth.
 *
 *   2. NO PLATFORM SDK REFERENCES in domain semantics: canonical registry
 *      capability names only — no webdriver/selenium/webkit/intent/… tokens
 *      and no imports outside `node:crypto` + the module itself.
 */

const MODULE_URL = new URL('../../../src/node-capability/', import.meta.url);
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

const MODULE_FILES = [...walkTs(MODULE_DIR)];

const FORBIDDEN_TOKENS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'execution object-type domain', pattern: /workflowos\/execution-/i },
  { label: 'ExecutionStatement', pattern: /\bExecutionStatement\b/ },
  { label: 'ExecutionAttestation', pattern: /\bExecutionAttestation\b/ },
  { label: 'ExecutionProofGraph', pattern: /\bExecutionProofGraph\b/ },
  { label: 'ExecutionDigest', pattern: /\bExecutionDigest\b/ },
  { label: 'VerifiedExecutionFact', pattern: /\bVerifiedExecutionFact\b/ },
  { label: 'execution assurance identifiers', pattern: /software_signed|hardware_backed|tee_attested|verifiable_computation/ },
  { label: 'attestation vocabulary', pattern: /\battest\w*\b/i },
  { label: 'signing vocabulary', pattern: /\bsignature\w*|\bsigning\b|\bsigned\b|\bsigns\b/i },
  { label: 'proof-graph vocabulary', pattern: /\bproof[ -]graphs?\b/i },
];

const PLATFORM_SDK_MARKERS =
  /webkit|webdriver|selenium|playwright|electron|android\.intent|androidx|com\.apple|NSUserActivity|UIAutomation|chrome\.devtools|page\.goto|NSWorkspace/i;

describe('V2-004 module boundary (execution-truth and platform-SDK discipline)', () => {
  it('scans a non-empty module', () => {
    expect(MODULE_FILES.length).toBeGreaterThanOrEqual(5);
    expect(MODULE_FILES.map((f) => relative(MODULE_DIR, f)).sort()).toContain('index.ts');
    expect(MODULE_FILES.map((f) => relative(MODULE_DIR, f)).sort()).toContain('types.ts');
  });

  for (const { label, pattern } of FORBIDDEN_TOKENS) {
    it(`contains no ${label} concepts`, () => {
      const violations: string[] = [];
      for (const file of MODULE_FILES) {
        const source = readFileSync(file, 'utf8');
        if (pattern.test(source)) {
          violations.push(`${relative(MODULE_DIR, file)} matches ${label} pattern ${pattern}`);
        }
      }
      expect(violations, violations.join('\n')).toEqual([]);
    });
  }

  it('references no platform SDK APIs (canonical registry capability names only)', () => {
    const violations: string[] = [];
    for (const file of MODULE_FILES) {
      const source = readFileSync(file, 'utf8');
      if (PLATFORM_SDK_MARKERS.test(source)) {
        violations.push(`${relative(MODULE_DIR, file)} contains a platform SDK marker`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('imports only node:crypto and module-internal relative paths (self-contained domain, no V1 imports)', () => {
    const violations: string[] = [];
    const specifierPattern = /(?:from\s*|import\s*)['"]([^'"]+)['"]/g;
    for (const file of MODULE_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(specifierPattern)) {
        const specifier = match[1] as string;
        if (specifier === 'node:crypto') continue;
        if (!specifier.startsWith('.') && !specifier.startsWith('./')) {
          violations.push(`${relative(MODULE_DIR, file)} imports non-relative "${specifier}"`);
          continue;
        }
        const resolved = join(dirname(file), specifier);
        const candidates = [resolved, `${resolved}.ts`, join(resolved, 'index.ts')];
        const inside = candidates.some((c) => existsSync(c) && c.startsWith(MODULE_DIR));
        if (!inside) {
          violations.push(`${relative(MODULE_DIR, file)} imports outside the module: "${specifier}"`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('uses domain-separated MAC labels scoped to node registration/session only', () => {
    const authSource = readFileSync(join(MODULE_DIR, 'internal', 'node-auth.ts'), 'utf8');
    expect(authSource).toContain('workflowos/node-registration/v1');
    expect(authSource).toContain('workflowos/node-session/v1');
    expect(authSource).toContain('workflowos/node-key/v1');
  });
});
