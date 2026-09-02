import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * V2-011 — the module source boundary (HARD RULE).
 *
 * V2-011 owns optimization analysis, opportunity detection, comparison
 * evidence, proposal generation, the owner approval gate, and creation of
 * explicit candidate WorkflowVersions through the materializer port. The
 * module CODE imports exactly three sibling barrels — the merged, frozen
 * V2-003 workflow-ir (contract dependency), the merged V2-005 workflow-runs
 * (implementation dependency — run histories consumed READ-ONLY via
 * `import type` only, never a run command, never an execution/evidence
 * authority) and the merged V2-008 computer-agent (the safe-action
 * sensitive-capability classification) — and NOTHING else. No
 * workflow-repository import (version creation flows ONLY through the
 * materializer port — never a second version authority), no sibling
 * INTERNALS (barrel-only consumption), no persistence, no platform/provider
 * packages, no wall clock, no randomness, no network, and NO activation,
 * installation or deployment concept anywhere (the module never activates
 * optimized versions — that surface belongs to V2-002/V2-009).
 */
const MODULE_ROOT = fileURLToPath(new URL('../../../src/workflow-optimization', import.meta.url));
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

/** Strip comments so boundary NOTES (which say "NOT owned here") never count as concepts — only CODE identifiers do. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const MODULE_FILES = walkTsFiles(MODULE_ROOT);

describe('V2-011 — no version-authority, activation, run-command or attestation concepts in the module source code', () => {
  it('src/workflow-optimization/**.ts declares no repository/activation/run-command concept in code', () => {
    const violations: string[] = [];
    for (const file of MODULE_FILES) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      // repository/version-authority + activation/installation/deployment concepts
      const authorityPattern = /createWorkflow\b|CreateWorkflowInput|WorkflowInstallation|InstallVersionInput|installVersion|WorkflowDeployment|deployVersion|activateVersion|requestRun\b|startRun\b|pauseRun\b|resumeRun\b|cancelRun\b|completeRun\b|failRun\b|RunCommandEnvelope|RecordStepStarted|RecordStepCompleted|RecordInvocationRequested|RecordInvocationCompleted|RecordRunEvidence|AttachRunAttestation|RunEvidenceRecord|ExecutionStatement|ExecutionAttestation|workflowos\/execution/;
      const matches = source.match(authorityPattern);
      if (matches) {
        violations.push(`${relative(MODULE_ROOT, file)}: ${matches.join(', ')}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('V2-005 run histories are consumed READ-ONLY (import type only — never a run command surface)', () => {
    for (const file of MODULE_FILES) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      if (source.includes("from '../workflow-runs/index.js'")) {
        expect(source, `${relative(MODULE_ROOT, file)} must import type only`).toMatch(/import type \{/);
      }
    }
  });
});

describe('V2-011 — the module consumes ONLY the merged workflow-ir, workflow-runs and computer-agent barrels', () => {
  it('src/workflow-optimization imports no other sibling domain, no internals, no persistence, no providers', () => {
    const violations: string[] = [];
    const allowed = /from\s+'\.\.\/(?:\.\.\/)?(workflow-ir|workflow-runs|computer-agent)\/index\.js'/;
    const siblingImport = /from\s+'\.\.\/(\.\.\/)?([a-z-]+)\/([a-z./-]*)'/g;
    for (const file of MODULE_FILES) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      const matches = [...source.matchAll(siblingImport)];
      for (const match of matches) {
        const target = `../${match[1] ?? ''}${match[2]}/${match[3]}`;
        if (!allowed.test(match[0])) {
          violations.push(`${relative(MODULE_ROOT, file)}: forbidden sibling import "${match[0]}" (${target})`);
        }
        // barrel-only: never a sibling internal path
        if (match[2] === 'workflow-ir' || match[2] === 'workflow-runs' || match[2] === 'computer-agent') {
          if (match[3] !== 'index.js') {
            violations.push(`${relative(MODULE_ROOT, file)}: non-barrel sibling import "${match[0]}"`);
          }
        }
      }
      const forbiddenImports = /from\s+'(pg|pglite|ioredis|@api|@platform|@modules|fastify)/;
      if (forbiddenImports.test(source)) {
        violations.push(`${relative(MODULE_ROOT, file)}: forbidden provider import`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the module consumes the V2-003 registry vocabulary (the capability split never invents capabilities)', () => {
    const vocabulary = join(MODULE_ROOT, 'internal', 'capability-vocabulary.ts');
    expect(existsSync(vocabulary), 'internal/capability-vocabulary.ts must exist').toBe(true);
    const source = readFileSync(vocabulary, 'utf-8');
    expect(source).toContain("from '../../workflow-ir/index.js'");
    expect(source).toContain('WORKFLOW_IR_REGISTRY_VOCABULARY');
  });

  it('the module consumes the V2-008 sensitive-capability classification (the unsafe-optimization rule)', () => {
    const vocabulary = join(MODULE_ROOT, 'internal', 'capability-vocabulary.ts');
    const source = readFileSync(vocabulary, 'utf-8');
    expect(source).toContain("from '../../computer-agent/index.js'");
    expect(source).toMatch(/sensitiveCapabilities|capabilitySensitivityOf/);
  });

  it('the module consumes the V2-003 validator + semantic digest + negotiation (contract dependency, not a re-derivation)', () => {
    const analysis = join(MODULE_ROOT, 'internal', 'analysis.ts');
    expect(existsSync(analysis), 'internal/analysis.ts must exist').toBe(true);
    const source = readFileSync(analysis, 'utf-8');
    expect(source).toContain("from '../../workflow-ir/index.js'");
    expect(source).toMatch(/validateWorkflowIrDocument/);
    expect(source).toMatch(/computeWorkflowVersionSemanticDigest/);
    const comparison = join(MODULE_ROOT, 'internal', 'comparison.ts');
    expect(existsSync(comparison), 'internal/comparison.ts must exist').toBe(true);
    expect(readFileSync(comparison, 'utf-8')).toMatch(/negotiateWorkflowVersionUpdate/);
  });
});

describe('V2-011 — determinism discipline in the module source', () => {
  it('no wall clock, no randomness, no network in the module code', () => {
    const violations: string[] = [];
    for (const file of MODULE_FILES) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      const pattern = /\bDate\b|Math\.random|crypto\.random|setTimeout|setInterval|fetch\(|net\.|https?\./;
      const matches = source.match(pattern);
      if (matches) {
        violations.push(`${relative(MODULE_ROOT, file)}: ${matches.join(', ')}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('no wall clock, no randomness, no network in the unit tests (injected deterministic sources only)', () => {
    const violations: string[] = [];
    for (const file of walkTsFiles(TESTS_ROOT)) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      const pattern = /\bnew Date\b|Date\.now|Math\.random|crypto\.random|\bfetch\(/;
      const matches = source.match(pattern);
      if (matches) {
        violations.push(`${relative(TESTS_ROOT, file)}: ${matches.join(', ')}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
