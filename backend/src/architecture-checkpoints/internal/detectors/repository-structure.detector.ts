/**
 * WORK-051 — the static repository structure/import detector
 * (`detectorKind: 'repository-structure'`).
 *
 * Evaluates the frozen module-boundary rules (spec/architecture.md §1, §3;
 * PLAT-AC-01/02) over a repository tree:
 *
 *   rule 'no-internal-cross-imports' — no module file may import another
 *     module's `internal/` area.
 *   rule 'barrel-only-imports' — cross-module imports must go through the
 *     module's public barrel (`@modules/<name>/index.js`), never a
 *     non-index file.
 *
 * detectorConfig:
 *   rootDir: string (required) — repository root to evaluate
 *   modulesDir: string (default 'src/modules') — where frozen modules live
 *   rules: string[] (default both rules)
 *
 * Deterministic: violations are collected in (relativePath, specifier) order.
 */

import type {
  ArchitectureAssertionDetector,
  DetectorInput,
  DetectorResult,
} from '../../types.js';
import { extractImportSpecifiers, stripCodeComments, walkFiles } from './file-tree.js';

const DEFAULT_RULES = ['no-internal-cross-imports', 'barrel-only-imports'] as const;

export class RepositoryStructureDetector implements ArchitectureAssertionDetector {
  readonly detectorKind = 'repository-structure';

  async evaluate(input: DetectorInput): Promise<DetectorResult> {
    const cfg = input.assertion.detectorConfig ?? {};
    const rootDir = typeof cfg.rootDir === 'string' ? cfg.rootDir : null;
    if (!rootDir) {
      return {
        status: 'inconclusive',
        summary: "detectorConfig.rootDir is missing — cannot evaluate the repository tree",
      };
    }
    const modulesDir = typeof cfg.modulesDir === 'string' ? cfg.modulesDir : 'src/modules';
    const rules = Array.isArray(cfg.rules) && cfg.rules.length > 0
      ? (cfg.rules as string[])
      : ([...DEFAULT_RULES] as string[]);

    const modulesRoot = `${rootDir.replace(/\/+$/, '')}/${modulesDir}`;
    const files = walkFiles(modulesRoot, '.ts');

    const violations: string[] = [];
    for (const file of files) {
      // The importing file's own module: the first path segment under the
      // modules dir (e.g. 'agents' for 'agents/internal/x.ts').
      const ownModule = file.relativePath.split('/')[0] ?? '';
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
            `${file.relativePath}: imports ${spec} (cross-module internal/ access)`,
          );
        }
        if (
          rules.includes('barrel-only-imports') &&
          targetPath !== '' &&
          !/\/index(\.js)?$/.test(targetPath)
        ) {
          violations.push(
            `${file.relativePath}: imports ${spec} (non-barrel cross-module import)`,
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
      summary: `module boundaries hold (${files.length} files, rules: ${rules.join(', ')})`,
    };
  }
}
