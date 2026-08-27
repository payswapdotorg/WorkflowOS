/**
 * WORK-051 — the workflow-transition detector
 * (`detectorKind: 'workflow-transition'`).
 *
 * Asserts that the canonical LEGAL_TRANSITIONS map in the live source still
 * equals the transition graph declared in the assertion's detectorConfig —
 * the machine-checkable guard against introducing new lifecycle states or
 * illegal transitions (design §7 "workflow-transition detector"; issue #51
 * "no new workflow states").
 *
 * detectorConfig:
 *   rootDir: string (required)
 *   transitionsFile: string (required) — path of the file containing
 *     LEGAL_TRANSITIONS, relative to rootDir
 *   expectedTransitions: Record<string, string[]> (required) — the frozen
 *     transition graph as data
 *
 * Deterministic: a pure read + literal parse + deep comparison.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ArchitectureAssertionDetector,
  DetectorInput,
  DetectorResult,
} from '../../types.js';

function parseLegalTransitions(source: string): Record<string, string[]> | null {
  const start = source.indexOf('LEGAL_TRANSITIONS');
  if (start === -1) return null;
  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const body = source.slice(braceStart, end + 1);
  const out: Record<string, string[]> = {};
  const entryRe = /(\w+)\s*:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(body)) !== null) {
    const key = m[1]!;
    const items = (m[2] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s.length > 0);
    out[key] = items;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export class WorkflowTransitionDetector implements ArchitectureAssertionDetector {
  readonly detectorKind = 'workflow-transition';

  async evaluate(input: DetectorInput): Promise<DetectorResult> {
    const cfg = input.assertion.detectorConfig ?? {};
    const rootDir = typeof cfg.rootDir === 'string' ? cfg.rootDir : null;
    const transitionsFile = typeof cfg.transitionsFile === 'string' ? cfg.transitionsFile : null;
    const expected = cfg.expectedTransitions;
    if (!rootDir || !transitionsFile || typeof expected !== 'object' || expected === null) {
      return {
        status: 'inconclusive',
        summary:
          'detectorConfig requires rootDir, transitionsFile, and expectedTransitions',
      };
    }

    const filePath = join(rootDir.replace(/\/+$/, ''), transitionsFile);
    let source: string;
    try {
      source = readFileSync(filePath, 'utf8');
    } catch {
      return {
        status: 'inconclusive',
        summary: `transitions file ${transitionsFile} is unreadable`,
      };
    }

    const actual = parseLegalTransitions(source);
    if (!actual) {
      return {
        status: 'inconclusive',
        summary: `could not parse a LEGAL_TRANSITIONS literal in ${transitionsFile}`,
      };
    }

    const expectedMap = expected as Record<string, string[]>;
    const diffs: string[] = [];
    const allKeys = Array.from(new Set([...Object.keys(expectedMap), ...Object.keys(actual)])).sort();
    for (const key of allKeys) {
      const exp = expectedMap[key];
      const act = actual[key];
      if (exp === undefined) {
        diffs.push(`state '${key}' exists in the live graph but not in the frozen assertion`);
      } else if (act === undefined) {
        diffs.push(`state '${key}' is missing from the live graph`);
      } else {
        const expSet = [...exp].sort().join(',');
        const actSet = [...act].sort().join(',');
        if (expSet !== actSet) {
          diffs.push(
            `state '${key}': live transitions [${actSet}] != frozen [${expSet}]`,
          );
        }
      }
    }

    if (diffs.length > 0) {
      return {
        status: 'fail',
        summary: `the workflow transition graph drifted from the frozen map (${diffs.length} difference(s))`,
        details: { differences: diffs },
      };
    }
    return {
      status: 'pass',
      summary: `the workflow transition graph matches the frozen map (${allKeys.length} states)`,
    };
  }
}
