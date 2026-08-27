/**
 * WORK-051 — the authority-ownership detector
 * (`detectorKind: 'authority-ownership'`).
 *
 * Asserts that a named domain authority interface is implemented ONLY inside
 * its owning frozen module — the machine-checkable form of "no second
 * authority" (design §7 "authority-ownership detector").
 *
 * detectorConfig:
 *   rootDir: string (required)
 *   modulesDir: string (default 'src/modules')
 *   ownerModule: string (required) — the single module allowed to implement it
 *   authorityInterface: string (required) — e.g. 'WorkflowEngine',
 *     'VerificationService', 'ArchitectureService'
 *
 * Deterministic: violations in (relativePath) order.
 */

import type {
  ArchitectureAssertionDetector,
  DetectorInput,
  DetectorResult,
} from '../../types.js';
import { stripCodeComments, walkFiles } from './file-tree.js';

export class AuthorityOwnershipDetector implements ArchitectureAssertionDetector {
  readonly detectorKind = 'authority-ownership';

  async evaluate(input: DetectorInput): Promise<DetectorResult> {
    const cfg = input.assertion.detectorConfig ?? {};
    const rootDir = typeof cfg.rootDir === 'string' ? cfg.rootDir : null;
    const ownerModule = typeof cfg.ownerModule === 'string' ? cfg.ownerModule : null;
    const authorityInterface =
      typeof cfg.authorityInterface === 'string' ? cfg.authorityInterface : null;
    if (!rootDir || !ownerModule || !authorityInterface) {
      return {
        status: 'inconclusive',
        summary:
          'detectorConfig requires rootDir, ownerModule, and authorityInterface',
      };
    }
    const modulesDir = typeof cfg.modulesDir === 'string' ? cfg.modulesDir : 'src/modules';
    const modulesRoot = `${rootDir.replace(/\/+$/, '')}/${modulesDir}`;

    const files = walkFiles(modulesRoot, '.ts');
    const implementsRe = new RegExp(`implements\\s+[\\w<>,\\s]*\\b${authorityInterface}\\b`);

    const violations: string[] = [];
    for (const file of files) {
      const ownModule = file.relativePath.split('/')[0] ?? '';
      if (ownModule === ownerModule) continue;
      if (implementsRe.test(stripCodeComments(file.source))) {
        violations.push(
          `${file.relativePath}: implements ${authorityInterface} outside the owning module /${ownerModule}`,
        );
      }
    }

    if (violations.length > 0) {
      return {
        status: 'fail',
        summary: `${authorityInterface} has ${violations.length} implementation(s) outside /${ownerModule}`,
        details: { violations },
      };
    }
    return {
      status: 'pass',
      summary: `${authorityInterface} is implemented only by /${ownerModule}`,
    };
  }
}
