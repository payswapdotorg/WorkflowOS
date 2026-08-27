/**
 * WORK-051 — the authority-ownership detector
 * (`detectorKind: 'authority-ownership'`).
 *
 * Asserts that a named domain authority interface is implemented ONLY inside
 * its owning frozen module — the machine-checkable form of "no second
 * authority" (design §7 "authority-ownership detector").
 *
 * detectorConfig:
 *   modulesDir: string (default 'src/modules') — repository-relative modules
 *     root (must EXIST at the bound revision, else inconclusive — fail closed)
 *   ownerModule: string (required) — the single module allowed to implement it
 *   authorityInterface: string (required) — e.g. 'WorkflowEngine',
 *     'VerificationService', 'ArchitectureService'
 *
 * Deterministic: violations in (path) order. Reads EXCLUSIVELY through the
 * revision-bound snapshot (PR #52 round 1, BLOCKER 1).
 */

import type {
  ArchitectureAssertionDetector,
  DetectorInput,
  DetectorResult,
} from '../../types.js';
import {
  snapshotFailureMessage,
  stripCodeComments,
  walkSnapshotFiles,
} from './snapshot-tree.js';

export class AuthorityOwnershipDetector implements ArchitectureAssertionDetector {
  readonly detectorKind = 'authority-ownership';

  async evaluate(input: DetectorInput): Promise<DetectorResult> {
    const snapshot = input.snapshot;
    if (!snapshot) {
      return {
        status: 'not_applicable',
        summary:
          `no implementation snapshot is bound at the ${input.checkpointKind} checkpoint — ` +
          'this assertion applies to revision-bound checkpoints only',
      };
    }
    const cfg = input.assertion.detectorConfig ?? {};
    const ownerModule = typeof cfg.ownerModule === 'string' ? cfg.ownerModule : null;
    const authorityInterface =
      typeof cfg.authorityInterface === 'string' ? cfg.authorityInterface : null;
    if (!ownerModule || !authorityInterface) {
      return {
        status: 'inconclusive',
        summary: 'detectorConfig requires ownerModule and authorityInterface',
      };
    }
    const modulesDir = typeof cfg.modulesDir === 'string' ? cfg.modulesDir : 'src/modules';

    let files;
    try {
      files = await walkSnapshotFiles(snapshot, modulesDir, '.ts');
    } catch (err) {
      return {
        status: 'inconclusive',
        summary:
          `the governed tree could not be inspected — ${snapshotFailureMessage(err, modulesDir, snapshot.revision)}`,
      };
    }
    const implementsRe = new RegExp(`implements\\s+[\\w<>,\\s]*\\b${authorityInterface}\\b`);

    const violations: string[] = [];
    // Paths are REPOSITORY-relative; the file's own module is the first
    // segment UNDER the modules root (e.g. 'workflows' for
    // 'src/modules/workflows/internal/workflow-engine.ts').
    const modulesPrefix = `${modulesDir.replace(/^\/+|\/+$/g, '')}/`;
    const relativeToModules = (path: string): string =>
      path.startsWith(modulesPrefix) ? path.slice(modulesPrefix.length) : path;
    for (const file of files) {
      const ownModule = relativeToModules(file.path).split('/')[0] ?? '';
      if (ownModule === ownerModule) continue;
      if (implementsRe.test(stripCodeComments(file.source))) {
        violations.push(
          `${file.path}: implements ${authorityInterface} outside the owning module /${ownerModule}`,
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
      summary: `${authorityInterface} is implemented only by /${ownerModule} (revision ${snapshot.revision})`,
    };
  }
}
