/**
 * WORK-051 — the runtime configuration detector
 * (`detectorKind: 'runtime-configuration'`).
 *
 * Asserts that forbidden runtime patterns stay absent from the governed
 * tree — e.g. scheduler-driven checkpoint execution in the initial increment
 * (issue #51: "No scheduler/cron/setInterval in this initial increment").
 *
 * detectorConfig:
 *   rootDir: string (required)
 *   forbiddenPatterns: Array<{
 *     pathIncludes: string,   // files whose path contains this are checked
 *     pattern: string,        // regex source applied to file contents
 *     description: string,    // human-readable rule name
 *   }> (required)
 *
 * Deterministic: violations in (rule, relativePath) order.
 */

import type {
  ArchitectureAssertionDetector,
  DetectorInput,
  DetectorResult,
} from '../../types.js';
import { byRelativePath, stripCodeComments, walkFiles } from './file-tree.js';

interface ForbiddenPattern {
  pathIncludes: string;
  pattern: string;
  description: string;
}

export class RuntimeConfigurationDetector implements ArchitectureAssertionDetector {
  readonly detectorKind = 'runtime-configuration';

  async evaluate(input: DetectorInput): Promise<DetectorResult> {
    const cfg = input.assertion.detectorConfig ?? {};
    const rootDir = typeof cfg.rootDir === 'string' ? cfg.rootDir : null;
    const raw = cfg.forbiddenPatterns;
    if (!rootDir || !Array.isArray(raw) || raw.length === 0) {
      return {
        status: 'inconclusive',
        summary: 'detectorConfig requires rootDir and a non-empty forbiddenPatterns list',
      };
    }
    const rules: ForbiddenPattern[] = [];
    for (const r of raw) {
      if (
        typeof r === 'object' && r !== null &&
        typeof (r as ForbiddenPattern).pathIncludes === 'string' &&
        typeof (r as ForbiddenPattern).pattern === 'string'
      ) {
        rules.push({
          pathIncludes: (r as ForbiddenPattern).pathIncludes,
          pattern: (r as ForbiddenPattern).pattern,
          description:
            typeof (r as ForbiddenPattern).description === 'string'
              ? (r as ForbiddenPattern).description
              : 'forbidden runtime pattern',
        });
      }
    }
    if (rules.length === 0) {
      return {
        status: 'inconclusive',
        summary: 'forbiddenPatterns did not contain any well-formed rule',
      };
    }

    const files = walkFiles(rootDir, '.ts').sort(byRelativePath);
    const violations: string[] = [];
    for (const file of files) {
      for (const rule of rules) {
        if (!file.relativePath.includes(rule.pathIncludes)) continue;
        let re: RegExp;
        try {
          re = new RegExp(rule.pattern);
        } catch {
          return {
            status: 'inconclusive',
            summary: `forbiddenPatterns rule '${rule.description}' has an invalid regex`,
          };
        }
        // Detectors evaluate CODE, not prose (comments are stripped — the
        // static-architecture precedent).
        if (re.test(stripCodeComments(file.source))) {
          violations.push(
            `${file.relativePath}: ${rule.description} (matches /${rule.pattern}/)`,
          );
        }
      }
    }

    if (violations.length > 0) {
      return {
        status: 'fail',
        summary: `${violations.length} forbidden runtime pattern(s) present`,
        details: { violations: violations.slice(0, 50), total: violations.length },
      };
    }
    return {
      status: 'pass',
      summary: `no forbidden runtime patterns (${rules.length} rule(s), ${files.length} files checked)`,
    };
  }
}
