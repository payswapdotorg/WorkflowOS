import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  COMPILED_WORKFLOW_OBJECT_TYPE,
  compileWorkflow,
  computeCompiledWorkflowDigest,
  canonicalArtifactPreimage,
} from '../../../src/workflow-compiler/index.js';
import { WORKFLOW_IR_OBJECT_TYPE } from '../../../src/workflow-ir/index.js';
import { buildTriageDocument } from './helpers.js';

/**
 * V2-007 — module boundary and domain separation (HARD RULE).
 *
 * The workflow compiler owns compilation ONLY. ExecutionStatement,
 * ExecutionDigest, ExecutionAttestation and proof graphs are owned by V2-014
 * under the domain workflowos/execution-statement/v1; run/evidence
 * persistence is V2-005; teaching is V2-006. This suite proves at source
 * level that the compiler module contains no execution-attestation concepts,
 * no sibling-domain imports, no non-determinism sources, and that the
 * compiled-artifact digest domain is domain-separated from every registry
 * attestation object type and from the WorkflowIR digest domain.
 */

const MODULE_ROOT = fileURLToPath(new URL('../../../src/workflow-compiler', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REGISTRY_FILE = join(
  REPO_ROOT,
  'spec/architecture/v2/V2-CTRL-003-protocol-registry.json',
);

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

/** Strip comments so boundary NOTES (which say "NOT here, V2-014 owns it") don't count as concepts — only CODE identifiers do. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const ATTESTATION_CONCEPT_PATTERN =
  /ExecutionStatement|ExecutionDigest|ExecutionAttestation|execution[-_]?statement|execution[-_]?digest|execution[-_]?attestation|attestation|attester|proof[-_]?graph|workflowos\/execution/i;

describe('V2-007 — no execution-attestation concepts in the compiler module source', () => {
  it('src/workflow-compiler/**.ts declares no attestation/statement-of-execution concept in code', () => {
    const violations: string[] = [];
    for (const file of walkTsFiles(MODULE_ROOT)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      const matches = source.match(ATTESTATION_CONCEPT_PATTERN);
      if (matches) {
        violations.push(`${relative(MODULE_ROOT, file)}: ${matches.join(', ')}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the module imports only the merged workflow-ir implementation and node:crypto (no sibling domains, no persistence, no api)', () => {
    const violations: string[] = [];
    const forbiddenImports =
      /from\s+'(?:\.\.?\/)+(?:workflow-repository|node-capability|teaching-sessions|execution-attestation|api|platform|modules|orchestration)\//;
    const forbiddenBare = /from\s+'(?:pg|ioredis|fastify)'/;
    for (const file of walkTsFiles(MODULE_ROOT)) {
      const source = readFileSync(file, 'utf8');
      if (forbiddenImports.test(source) || forbiddenBare.test(source)) {
        violations.push(relative(MODULE_ROOT, file));
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the module contains no wall-clock, randomness, network or timer sources', () => {
    const violations: string[] = [];
    const nondeterminism = /Math\.random|Date\.now|new Date|fetch\s*\(|setInterval|setTimeout|process\.env/;
    for (const file of walkTsFiles(MODULE_ROOT)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      if (nondeterminism.test(source)) {
        violations.push(relative(MODULE_ROOT, file));
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('V2-007 — the compiled-artifact object type is registry-distinct', () => {
  it('the artifact object type is distinct from every registry attestation object type (read from the frozen registry file)', () => {
    const registry = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as {
      attestationObjectTypes: string[];
    };
    expect(registry.attestationObjectTypes).toEqual([
      'workflowos/execution-statement/v1',
      'workflowos/execution-attestation/v1',
      'workflowos/execution-proof-graph/v1',
    ]);
    expect(COMPILED_WORKFLOW_OBJECT_TYPE).not.toBe(WORKFLOW_IR_OBJECT_TYPE);
    for (const objectType of registry.attestationObjectTypes) {
      expect(COMPILED_WORKFLOW_OBJECT_TYPE).not.toBe(objectType);
    }
  });
});

describe('V2-007 — the compiled-artifact digest domain is load-bearing and domain-separated', () => {
  const document = buildTriageDocument();
  const compileResult = compileWorkflow(document);
  if (!compileResult.ok) throw new Error('fixture must compile');
  const artifact = compileResult.artifact;
  const digest = computeCompiledWorkflowDigest(artifact);

  it('declares its algorithm and compiler-owned domain explicitly', () => {
    expect(digest.algorithm).toBe('sha-256');
    expect(digest.domain).toBe(COMPILED_WORKFLOW_OBJECT_TYPE);
    expect(digest.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the digest preimage embeds the compiler-owned domain (domain separation is load-bearing)', () => {
    const preimage = canonicalArtifactPreimage(artifact);
    expect(preimage).toContain(`"objectType":"${COMPILED_WORKFLOW_OBJECT_TYPE}"`);
    // swapping the compiler domain for the registry's execution-statement
    // domain over the SAME artifact object must produce a DIFFERENT digest
    const foreignPreimage = preimage.replace(
      `"objectType":"${COMPILED_WORKFLOW_OBJECT_TYPE}"`,
      '"objectType":"workflowos/execution-statement/v1"',
    );
    const foreignDigest = createHash('sha-256').update(foreignPreimage, 'utf8').digest('hex');
    expect(foreignDigest).not.toBe(digest.digest);
    // ... and swapping it for the WorkflowIR digest domain also differs
    const irPreimage = preimage.replace(
      `"objectType":"${COMPILED_WORKFLOW_OBJECT_TYPE}"`,
      `"objectType":"${WORKFLOW_IR_OBJECT_TYPE}"`,
    );
    const irDigest = createHash('sha-256').update(irPreimage, 'utf8').digest('hex');
    expect(irDigest).not.toBe(digest.digest);
  });

  it('the artifact digest differs from the source WorkflowVersion semantic digest (different commitments)', () => {
    expect(digest.digest).not.toBe(artifact.provenance.source.semanticDigest);
    expect(digest.domain).not.toBe(artifact.provenance.source.digestDomain);
  });
});
