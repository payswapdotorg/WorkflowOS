/**
 * WORK-051 — the static repository structure/import detector
 * (`detectorKind: 'repository-structure'`).
 *
 * Evaluates the frozen module-boundary rules (spec/architecture.md §1, §3;
 * PLAT-AC-01/02) over the EXACT-REVISION repository snapshot (PR #52 round
 * 1, BLOCKER 1 — no working-tree reads):
 *
 *   rule 'no-internal-cross-imports' — no module file may import another
 *     module's `internal/` area.
 *   rule 'barrel-only-imports' — cross-module imports must go through the
 *     module's public barrel (`@modules/<name>/index.js`), never a
 *     non-index file.
 *
 * detectorConfig:
 *   modulesDir: string (default 'src/modules') — repository-relative
 *     location of the frozen modules (must EXIST at the bound revision,
 *     otherwise the result is inconclusive — fail closed)
 *   rules: string[] (default both rules)
 *
 * Deterministic: violations are collected in (path, specifier) order. A
 * snapshot must be bound (revision-bound checkpoint); without one the
 * assertion is not_applicable at this checkpoint kind — it can never fall
 * back to reading the current working tree.
 */

import type {
  ArchitectureAssertionDetector,
  DetectorInput,
  DetectorResult,
} from '../../types.js';
import {
  extractImportSpecifiers,
  snapshotFailureMessage,
  stripCodeComments,
  walkSnapshotFiles,
} from './snapshot-tree.js';

const DEFAULT_RULES = ['no-internal-cross-imports', 'barrel-only-imports'] as const;

export class RepositoryStructureDetector implements ArchitectureAssertionDetector {
  readonly detectorKind = 'repository-structure';

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
    const modulesDir = typeof cfg.modulesDir === 'string' ? cfg.modulesDir : 'src/modules';
    const rules = Array.isArray(cfg.rules) && cfg.rules.length > 0
      ? (cfg.rules as string[])
      : ([...DEFAULT_RULES] as string[]);

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

    const violations: string[] = [];
    // Paths are REPOSITORY-relative; the importing file's own module is the
    // first segment UNDER the modules root (e.g. 'agents' for
    // 'src/modules/agents/internal/x.ts' when modulesDir='src/modules').
    const modulesPrefix = `${modulesDir.replace(/^\/+|\/+$/g, '')}/`;
    const relativeToModules = (path: string): string =>
      path.startsWith(modulesPrefix) ? path.slice(modulesPrefix.length) : path;
    for (const file of files) {
      const ownModule = relativeToModules(file.path).split('/')[0] ?? '';
      const code = stripCodeComments(file.source);
      for (const spec of extractImportSpecifiers(code)) {
        const m = /^@modules\/([^/]+)(\/.*)?$/.exec(spec);
        if (!m) continue;
        const targetModule = m[1]!;
        const targetPath = m[2] ?? '';
        if (targetModule === ownModule) continue; // intra-module import
        if (
          rules.includes('no-internal-cross-imports') &&
          targetPath.startsWith('/internal/')
        ) {
          violations.push(
            `${file.path}: imports ${spec} (cross-module internal/ access)`,
          );
        }
        if (
          rules.includes('barrel-only-imports') &&
          targetPath !== '' &&
          !/\/index(\.js)?$/.test(targetPath)
        ) {
          violations.push(
            `${file.path}: imports ${spec} (non-barrel cross-module import)`,
          );
        }
      }
    }

    if (violations.length > 0) {
      const shown = violations.slice(0, 3).join(' | ');
      return {
        status: 'fail',
        summary: `${violations.length} module-boundary violation(s): ${shown}${
          violations.length > 3 ? ' | …' : ''
        }`,
        details: { violations: violations.slice(0, 50), total: violations.length },
      };
    }
    return {
      status: 'pass',
      summary: `module boundaries hold at revision ${snapshot.revision} (${files.length} files, rules: ${rules.join(', ')})`,
    };
  }
}
