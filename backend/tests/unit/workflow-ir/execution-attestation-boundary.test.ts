import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  WORKFLOW_IR_OBJECT_TYPE,
  computeWorkflowVersionSemanticDigest,
  canonicalSemanticJson,
} from '../../../src/workflow-ir/index.js';
import { buildMinimalDocument } from './helpers.js';

/**
 * V2-003 — the execution-attestation boundary (HARD RULE).
 *
 * V2-003 owns ONLY the WorkflowVersion semantic digest. ExecutionStatement,
 * ExecutionDigest and ExecutionAttestation are owned by V2-014 (domain
 * workflowos/execution-statement/v1). This suite proves, at source level,
 * that this module contains no execution-attestation concepts and that the
 * two digest domains are structurally separated.
 */

const MODULE_ROOT = fileURLToPath(new URL('../../../src/workflow-ir', import.meta.url));

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

const ATTESTATION_CONCEPT_PATTERN =
  /ExecutionStatement|ExecutionDigest|ExecutionAttestation|execution[-_]?statement|execution[-_]?digest|execution[-_]?attestation|attestation|attester|proof[-_]?graph|workflowos\/execution/i;

/** Strip comments so boundary NOTES (which say "NOT here, V2-014 owns it") don't count as concepts — only CODE identifiers do. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('V2-003 — no execution-attestation concepts in the module source', () => {
  it('src/workflow-ir/**.ts declares no attestation/statement/digest-of-execution concept in code', () => {
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

  it('the module does not import sibling domains or the repository/persistence layers', () => {
    const violations: string[] = [];
    const forbiddenImports = /from\s+'\.\.\/(workflow-repository|node-capability|api|platform|modules)\//;
    for (const file of walkTsFiles(MODULE_ROOT)) {
      const source = readFileSync(file, 'utf8');
      if (forbiddenImports.test(source)) {
        violations.push(relative(MODULE_ROOT, file));
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('V2-003 — the WorkflowVersion semantic digest is domain-separated from execution digests', () => {
  const document = buildMinimalDocument();
  const semanticDigest = computeWorkflowVersionSemanticDigest(document);

  it('declares the IR digest domain and the sha-256 algorithm explicitly', () => {
    expect(semanticDigest.domain).toBe(WORKFLOW_IR_OBJECT_TYPE);
    expect(semanticDigest.algorithm).toBe('sha-256');
    expect(semanticDigest.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the digest preimage embeds the IR domain (domain separation is load-bearing)', () => {
    const preimage = canonicalSemanticJson(document);
    expect(preimage).toContain(`"domain":"${WORKFLOW_IR_OBJECT_TYPE}"`);
    // swapping the IR domain for the V2-014 execution-statement domain over
    // the SAME semantic object must produce a DIFFERENT digest
    const foreignPreimage = preimage.replace(
      `"domain":"${WORKFLOW_IR_OBJECT_TYPE}"`,
      '"domain":"workflowos/execution-statement/v1"',
    );
    const foreignDigest = createHash('sha-256').update(foreignPreimage, 'utf8').digest('hex');
    expect(foreignDigest).not.toBe(semanticDigest.digest);
  });
});
