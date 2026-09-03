import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * V2-012 — the module source boundary (HARD RULE).
 *
 * V2-012 owns the marketplace listing lifecycle, creator economics
 * (one-time pricing + maintenance subscriptions behind the payment-adapter
 * port), entitlement + version-access rules (content access ONLY), refunds/
 * cancellation/maintenance semantics, abuse reporting and trust metadata.
 *
 * The module CODE imports exactly TWO sibling barrels — the merged V2-003
 * workflow-ir (the parser, the semantic digest and the version-update
 * negotiation that IS the maintenance-update compatibility rule) and the
 * merged V2-008 computer-agent (the sensitive-capability classification for
 * the trust view) — and NOTHING else. No workflow-repository import
 * (version/workflow facts flow ONLY through the MarketplaceVersionReader
 * port — never a second version/installation authority), no workflow-runs
 * import (entitlement NEVER grants execution), no sibling INTERNALS
 * (barrel-only consumption), no persistence, no platform/provider packages,
 * no wall clock, no randomness, no network, NO payment-provider names, and
 * NO run, capability-grant, node-access, secret or execution concept
 * anywhere (the frozen V2-012 entitlement boundary).
 */
const MODULE_ROOT = fileURLToPath(new URL('../../../src/marketplace', import.meta.url));

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

describe('V2-012 — no version-authority, execution, grant or secret concepts in the module source code', () => {
  it('src/marketplace/**.ts declares no repository/run/grant/secret concept in code', () => {
    const violations: string[] = [];
    for (const file of MODULE_FILES) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      // repository/version/installation-authority + execution-authority concepts
      const authorityPattern = /createWorkflow\b|CreateWorkflowInput|forkWorkflow\b|ForkWorkflowInput|createVersion\b|CreateVersionInput|installVersion\b|InstallVersionInput|setInstallationStatus|WorkflowDeployment|deployVersion|activateVersion|requestRun\b|startRun\b|pauseRun\b|resumeRun\b|interruptRunAttempt|cancelRun\b|completeRun\b|failRun\b|RunCommandEnvelope|recordStep|recordInvocation|recordEvidence\b|attachAttestation|RunEvidenceRecord|ExecutionStatement|ExecutionAttestation|workflowos\/execution/;
      const authorityMatches = source.match(authorityPattern);
      if (authorityMatches) {
        violations.push(`${relative(MODULE_ROOT, file)}: ${authorityMatches.join(', ')}`);
      }
      // capability-GRANT / node-access / secret concepts (the entitlement boundary)
      const grantPattern = /grantCapability|CapabilityGrant|capabilityGrant|authorizeCapability|nodeAccess|grantNodeAccess|authorizeNode|authorizeExecution|grantExecution|secretRef|apiKey|api_key|rawKey|bearerToken|password|credential|cookie/;
      const grantMatches = source.match(grantPattern);
      if (grantMatches) {
        violations.push(`${relative(MODULE_ROOT, file)}: ${grantMatches.join(', ')}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('V2-012 — the module consumes ONLY the merged workflow-ir and computer-agent barrels', () => {
  it('src/marketplace imports no other sibling domain, no internals, no persistence, no providers', () => {
    const violations: string[] = [];
    const allowed = /from\s+'\.\.\/(?:\.\.\/)?(workflow-ir|computer-agent)\/index\.js'/;
    const siblingImport = /from\s+'\.\.\/(\.\.\/)?([a-z0-9-]+)\/([a-z0-9./-]*)'/g;
    for (const file of MODULE_FILES) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      const matches = [...source.matchAll(siblingImport)];
      for (const match of matches) {
        if (!allowed.test(match[0])) {
          violations.push(`${relative(MODULE_ROOT, file)}: forbidden sibling import "${match[0]}"`);
        }
        // barrel-only: never a sibling internal path
        if (match[2] === 'workflow-ir' || match[2] === 'computer-agent') {
          if (match[3] !== 'index.js') {
            violations.push(`${relative(MODULE_ROOT, file)}: non-barrel sibling import "${match[0]}"`);
          }
        }
      }
      const forbiddenImports = /from\s+'(pg|pglite|ioredis|@api|@platform|@modules|fastify)/;
      if (forbiddenImports.test(source)) {
        violations.push(`${relative(MODULE_ROOT, file)}: forbidden provider/persistence import`);
      }
      // NO payment-provider names anywhere (provider isolation, fail-closed)
      const providerPattern = /stripe|paypal|braintree|square|adyen|webhook|cardNumber|bankAccount/i;
      const providerMatches = source.match(providerPattern);
      if (providerMatches) {
        violations.push(`${relative(MODULE_ROOT, file)}: provider semantics "${providerMatches.join(', ')}"`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('V2-012 — determinism (no wall clock, no randomness, no timers, no network)', () => {
  it('src/marketplace uses only injected deterministic sources', () => {
    const violations: string[] = [];
    for (const file of MODULE_FILES) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      const nondeterminism = /\bDate\.now\b|\bnew Date\b|\bMath\.random\b|\bsetTimeout\b|\bsetInterval\b|crypto\.randomUUID|\bfetch\(|\brequire\(['"]https?|node:net/;
      const matches = source.match(nondeterminism);
      if (matches) {
        violations.push(`${relative(MODULE_ROOT, file)}: ${matches.join(', ')}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
